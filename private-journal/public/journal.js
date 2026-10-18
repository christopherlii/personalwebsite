import { searchTerms } from './search-terms.js';
import { markdown } from './markdown.js';
import { createLiveEditor } from './live-editor.js';
import { thoughtLinks, plainThoughtLinks } from './thought-links.js';
import { createReading } from './reading.js';
import { markdownTags, normalizeTag } from './tags.js';

const $ = selector => document.querySelector(selector);
const state = { authenticated: false, view: 'all', query: '', cursor: null, entries: new Map(), generation: 0, controller: null, draft: { version: 0 }, dirty: false, saving: null, conflict: false, posting: false, pendingPost: null, selected: null, publication: null, publicationId: null, publicDirty: false, publicBusy: false, draftTimer: null, searchTimer: null, semanticAvailable: false, semantic: false, timelineHidden: false, renderedQuery: null, renderedView: null, readerGeneration: 0, feedScroll: 0 };
Object.assign(state, { readerEntry: null, readerEditing: false, readerDirty: false, readerSaving: null, readerHistory: null });
state.tag = null;
let readerEditor = null;
let composerEditor = null;
const readingView = createReading({ api, navigateThought });
function navigateThought(id) {
  const current = readerId(); if (id === current) return;
  history.pushState({ journalNavigation: true, previousThought: current || null }, '', `#thought/${id}`);
  showRoute();
}
async function findThoughts(query, signal, exclude = '') {
  const result = await api(`link-suggestions?q=${encodeURIComponent(query)}${exclude ? `&exclude=${exclude}` : ''}`, { signal });
  return result.entries;
}
function clearReaderEditor() { readerEditor?.destroy(); readerEditor = null; $('#live-editor').replaceChildren(); }

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function draftStatus(message) { $('#draft-status').textContent = message; }
function closeMenus(except = null) {
  for (const trigger of document.querySelectorAll('[data-menu][aria-expanded=true]')) {
    if (trigger === except) continue;
    document.getElementById(trigger.getAttribute('aria-controls')).hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-menu]');
  if (trigger) {
    const opening = trigger.getAttribute('aria-expanded') !== 'true';
    closeMenus(trigger);
    trigger.setAttribute('aria-expanded', String(opening));
    document.getElementById(trigger.getAttribute('aria-controls')).hidden = !opening;
  } else closeMenus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('[data-menu][aria-expanded=true]');
  if (!open) return;
  event.preventDefault();
  closeMenus();
  open.focus({ preventScroll: true });
});
function showLogin(message = '') {
  closeMenus();
  if (state.readerDirty && state.readerEntry) history.replaceState(state.readerHistory, '', `#thought/${state.readerEntry.id}`);
  state.authenticated = false;
  state.generation++;
  state.controller?.abort();
  clearTimeout(state.draftTimer);
  clearTimeout(state.searchTimer);
  state.readerGeneration++;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#app').hidden = true;
  $('#reader').hidden = true;
  readingView.hide(); readingView.hideRelated();
  $('#reader-content').replaceChildren();
  $('#login').hidden = false;
  $('#boot-status').hidden = true;
  $('#login-message').textContent = message;
  $('#password').focus();
}

async function api(path, options = {}) {
  const response = await fetch(`./api/${path}`, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'Content-Type': 'application/json', 'X-Journal': '1', ...options.headers }
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The journal is unavailable. Try again later.'); }
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') showLogin('your session ended. unlock to continue.');
    const error = new Error(data.error || 'Something went wrong. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateComposer() {
  composerEditor?.setValue($('#body').value);
  composerEditor?.setReadOnly(state.posting);
  $('#post').disabled = !$('#body').value.trim() || state.posting;
  $('#compose-actions').hidden = !$('#body').value && !$('#title').value && !state.conflict && $('#retry-draft').hidden;
  $('#clear-input').hidden = !$('#body').value && !$('#title').value;
  $('#add-title').hidden = !$('#composer-title').hidden;
  $('#add-title').disabled = state.posting;
  $('#clear-input').disabled = state.posting;
}

const hasDraft = draft => Boolean(draft.title || draft.body);
const entryText = entry => entry.title ? `${entry.title}\n\n${entry.body}` : entry.body;

async function saveDraft() {
  clearTimeout(state.draftTimer);
  if (state.conflict || !state.authenticated) return;
  if (state.saving) {
    await state.saving;
    if (state.dirty) return saveDraft();
    return;
  }
  if (!state.dirty) return;
  state.saving = (async () => {
    while (state.dirty && state.authenticated) {
      const body = $('#body').value;
      const title = $('#title').value;
      state.dirty = false;
      draftStatus('saving…');
      $('#retry-draft').hidden = true;
      try {
        const draft = await api('draft', { method: 'PUT', body: JSON.stringify({ title, body, version: state.draft.version }) });
        state.draft.version = draft.version;
        draftStatus(state.dirty ? 'unsaved' : title || body ? 'draft saved' : '');
      } catch (error) {
        state.dirty = true;
        state.conflict = error.status === 409;
        draftStatus(error.status === 409 ? 'draft changed elsewhere. copy your text or post it.' : 'draft not saved. try again.');
        $('#retry-draft').hidden = state.conflict;
        throw error;
      }
    }
  })();
  try { await state.saving; }
  finally { state.saving = null; updateComposer(); }
}

function changedDraft() {
  state.dirty = true;
  updateComposer();
  searchFromComposer();
  draftStatus(state.conflict ? 'draft changed elsewhere. copy your text or post it.' : 'unsaved');
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => saveDraft().catch(() => {}), 650);
}

async function enter() {
  const unsaved = state.dirty ? { title: $('#title').value, body: $('#body').value } : null;
  const session = await api('session');
  state.semanticAvailable = Boolean(session.semanticSearch);
  const draft = await api('draft');
  state.draft = draft;
  state.conflict = Boolean(unsaved && (draft.body !== unsaved.body || draft.title !== unsaved.title));
  state.dirty = state.conflict;
  $('#body').value = unsaved?.body ?? draft.body;
  $('#title').value = unsaved?.title ?? draft.title ?? '';
  $('#composer-title').hidden = !$('#title').value;
  state.authenticated = true;
  $('#login').hidden = true;
  $('#app').hidden = Boolean(readerId()) || location.hash === '#reading';
  $('#boot-status').hidden = true;
  $('#password').value = '';
  if (!composerEditor) composerEditor = createLiveEditor($('#composer-editor'), {
    value: $('#body').value, nonce: document.querySelector('meta[name=editor-style-nonce]').content,
    emptyText: 'write or search your thoughts…',
    onSubmit() { if (!$('#post').disabled) $('#composer').requestSubmit(); },
    findThoughts: (query, signal) => findThoughts(query, signal), onOpenThought: navigateThought,
    onChange(value) { $('#body').value = value; changedDraft(); },
    onLimit() { notice('Thoughts can contain up to 20,000 characters.'); }
  });
  draftStatus(state.conflict ? 'unsaved text restored. copy your text or post it.' : hasDraft(draft) ? 'draft saved' : '');
  updateComposer();
  if (readerId() || location.hash === '#reading' || routeTag()) await showRoute();
  else await searchFromComposer(true);
  if (state.publicDirty && state.publicationId) { $('#public-dialog').showModal(); $('#public-status').textContent = 'unsaved text restored'; }
}

function button(label, action, entry) {
  const result = document.createElement('button');
  result.type = 'button'; result.textContent = label;
  result.dataset.action = action; result.dataset.id = entry.id;
  return result;
}

function readerId() { return location.hash.match(/^#thought\/([a-f0-9-]{36})$/)?.[1]; }
function routeTag(){try{return location.hash.startsWith('#tag/')?normalizeTag(decodeURIComponent(location.hash.slice(5))):null;}catch{return null;}}
function readerBackTarget(){return history.state?.previousThought?`#thought/${history.state.previousThought}`:state.tag?`#tag/${encodeURIComponent(state.tag)}`:'#';}
function renderReader(entry = state.readerEntry) {
  const content = $('#reader-content'); content.replaceChildren();
  if (!entry) return;
  if (entry.title) {
    const title = document.createElement('h1'); title.className = 'thought-title'; title.append(bodyContent(entry.title,'')); content.append(title);
  }
  const body = document.createElement('div'); body.className = 'thought-body markdown-body'; body.append(markdown(entry.body)); content.append(body);
  readingView.related(entry);
}
function readerControls() {
  const editing = state.readerEditing;
  const busy = Boolean(state.readerSaving);
  $('#reader-edit').hidden = editing || !state.readerEntry;
  $('#reader-menu-toggle').hidden = editing || !state.readerEntry;
  $('#reader-save').hidden = !editing; $('#reader-cancel').hidden = !editing;
  $('#edit-form').hidden = !editing;
  $('#reader-content').hidden = editing;
  readingView.editing(editing);
  readerEditor?.setReadOnly(busy);
  for (const control of document.querySelectorAll('.reader-actions button, #edit-form input, #edit-form textarea')) control.disabled = busy;
  $('#reader-save').disabled = busy || !$('#edit-body').value.trim();
  const bookmarked = Boolean(state.readerEntry?.bookmarked);
  $('#reader-bookmark').textContent = bookmarked ? 'remove bookmark' : 'bookmark';
  $('#reader-bookmark').setAttribute('aria-pressed', String(bookmarked));
  $('#reader-status').replaceChildren(entryStatus(state.readerEntry));
}
function updateEntry(entry) {
  state.readerEntry = entry; state.selected = entry;
  const removedBookmark = state.view === 'saved' && !entry.bookmarked;
  if (removedBookmark) state.entries.delete(entry.id);
  else if (state.entries.has(entry.id)) state.entries.set(entry.id, entry);
  const existing = $(`#feed article[data-id="${entry.id}"]`);
  if (existing) {
    if (removedBookmark) existing.remove();
    else existing.replaceWith(renderEntry(entry));
  }
}
function stopEditing() {
  state.readerEditing = false; state.readerDirty = false; clearReaderEditor();
  $('#reader-error').textContent = ''; renderReader(); readerControls();
}
async function saveReader() {
  if (state.readerSaving) return state.readerSaving;
  if (!state.readerDirty) { stopEditing(); return; }
  const title = $('#edit-thought-title').value, body = $('#edit-body').value;
  if (!body.trim()) throw new Error('A thought needs some text.');
  state.readerSaving = (async () => {
    const { entry } = await api(`thoughts/${state.readerEntry.id}`, { method: 'PATCH', body: JSON.stringify({ title, body, updated_at: state.readerEntry.updated_at }) });
    updateEntry(entry); stopEditing();
  })();
  readerControls();
  try { await state.readerSaving; }
  finally { state.readerSaving = null; readerControls(); }
}
async function showRoute() {
  if (!state.authenticated) return;
  const generation = ++state.readerGeneration;
  const id = readerId();
  readingView.hide();
  $('#reader-back').href = readerBackTarget();
  if (state.readerDirty && id !== state.readerEntry?.id) {
    try { await saveReader(); }
    catch (error) {
      if (generation !== state.readerGeneration) return;
      history.replaceState(state.readerHistory, '', `#thought/${state.readerEntry.id}`);
      $('#reader-back').href = state.readerHistory?.previousThought ? `#thought/${state.readerHistory.previousThought}` : '#';
      $('#reader-error').textContent = error.message; return;
    }
    if (generation !== state.readerGeneration) return;
  }
  if (location.hash === '#reading') {
    $('#app').hidden = true; $('#reader').hidden = true; readingView.hideRelated();
    state.readerEntry = null; state.readerEditing = false; clearReaderEditor();
    closeMenus(); document.title = 'read later'; await readingView.show(); return;
  }
  if (!id) {
    const tag=routeTag(),tagChanged=tag!==state.tag;state.tag=tag;
    if(tagChanged&&tag){state.timelineHidden=false;$('#timeline').hidden=false;$('#toggle-timeline').textContent='hide timeline';$('#toggle-timeline').setAttribute('aria-expanded','true');}
    const wasReading = !$('#reader').hidden;
    $('#reader').hidden = true; $('#reader-content').replaceChildren();
    state.readerEntry = null; state.readerEditing = false; clearReaderEditor();
    state.readerHistory = null;
    readingView.hideRelated();
    $('#app').hidden = false; document.title = 'journal';
    if ((tag || tagChanged || !state.entries.size) && !state.timelineHidden) await searchFromComposer(true);
    updateView();
    if (wasReading || tagChanged) window.scrollTo(0, tagChanged ? 0 : state.feedScroll);
    return;
  }
  if (state.readerDirty && id === state.readerEntry?.id) {
    closeMenus(); $('#app').hidden = true; $('#reader').hidden = false;
    readerControls(); return;
  }
  try {
    const { entry } = await api(`thoughts/${id}`);
    if (generation !== state.readerGeneration || !state.authenticated) return;
    state.readerEntry = entry; state.selected = entry;
    state.readerHistory = history.state;
    state.readerEditing = false; clearReaderEditor();
    renderReader(); readerControls();
    $('#reader-error').textContent = '';
    document.title = 'journal';
  } catch (error) {
    if (generation !== state.readerGeneration || !state.authenticated) return;
    $('#reader-content').replaceChildren(); $('#reader-error').textContent = error.message;
    readingView.hideRelated();
    state.readerEntry = null; state.readerEditing = false; clearReaderEditor(); readerControls();
  }
  if (!$('#app').hidden) state.feedScroll = window.scrollY;
  closeMenus(); $('#app').hidden = true; $('#reader').hidden = false;
  window.scrollTo(0, 0); $('#reader-content').focus({ preventScroll: true });
}
window.addEventListener('hashchange', showRoute);
$('#reader-back').addEventListener('click', event => { if (history.state?.journalNavigation) { event.preventDefault(); history.back(); } });
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-thought-link]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigateThought(link.dataset.thoughtLink);
});

function bodyContent(body, query) {
  const fragment = document.createDocumentFragment();
  const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const matches = searchTerms(query).map(fold).filter(Boolean);
  const terms = matches.length ? new RegExp(matches.join('|'), 'gu') : null;
  const appendText = value => {
    if (!terms) { fragment.append(document.createTextNode(value)); return; }
    let normalized = '', position = 0;
    const starts = [], ends = [];
    for (const point of value) {
      const folded = fold(point);
      for (let i = 0; i < folded.length; i++) { starts.push(position); ends.push(position + point.length); }
      normalized += folded;
      position += point.length;
    }
    let end = 0;
    for (const match of normalized.matchAll(terms)) {
      const start = starts[match.index];
      const stop = ends[match.index + match[0].length - 1];
      if (start < end) continue;
      fragment.append(document.createTextNode(value.slice(end, start)));
      const mark = document.createElement('mark'); mark.textContent = value.slice(start, stop); fragment.append(mark);
      end = stop;
    }
    fragment.append(document.createTextNode(value.slice(end)));
  };
  // The timeline stays a plain-text preview, including search highlights.
  const links = [...body.matchAll(/https?:\/\/[^\s<>]+/gu)].map(match => ({ from: match.index, to: match.index + match[0].length, text: match[0] }));
  links.push(...thoughtLinks(body).map(link => ({ ...link, text: link.label })));
  links.push(...markdownTags(body));
  links.sort((a, b) => a.from - b.from);
  let end = 0;
  for (const link of links) {
    if (link.from < end) continue;
    appendText(body.slice(end, link.from));
    const a = document.createElement('a');
    a.textContent = link.text;
    if(link.tag){a.href=`#tag/${encodeURIComponent(link.tag)}`;a.dataset.tag=link.tag;a.className='thought-tag';}
    else if (link.id) { a.href = `#thought/${link.id}`; a.dataset.thoughtLink = link.id; }
    else { a.href = link.text; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    fragment.append(a); end = link.to;
  }
  appendText(body.slice(end));
  return fragment;
}

function entryStatus(entry) {
  const status = document.createDocumentFragment();
  if (entry?.bookmarked) {
    const heart = document.createElement('span'); heart.className = 'entry-heart'; heart.textContent = '♥';
    heart.setAttribute('role', 'img'); heart.setAttribute('aria-label', 'bookmarked'); heart.title = 'bookmarked'; status.append(heart);
  }
  if (entry?.published_slug) {
    const published = document.createElement('a'); published.className = 'entry-published'; published.textContent = 'published';
    published.href = `https://christopherli.dev/#thought/${encodeURIComponent(entry.published_slug)}`;
    published.target = '_blank'; published.rel = 'noopener noreferrer'; published.setAttribute('aria-label', 'view published thought'); status.append(published);
  }
  return status;
}

function renderEntry(entry) {
  const article = document.createElement('article'); article.className = 'thought'; article.tabIndex = 0; article.dataset.id = entry.id;
  const header = document.createElement('header'); header.className = 'thought-header';
  const time = document.createElement('time'); time.dateTime = entry.source_date || entry.created_at;
  const date = new Date(entry.source_date ? `${entry.source_date}T12:00:00` : entry.created_at);
  time.title = entry.source_date ? date.toLocaleDateString() : date.toLocaleString();
  const day = document.createElement('span'); day.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
  const clock = document.createElement('span'); clock.textContent = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  time.append(day);
  if (!entry.source_date) time.append(clock);
  const dateDetails = document.createElement('span'); dateDetails.className = 'thought-date'; dateDetails.append(time);
  if (entry.updated_at !== entry.created_at) { const edited = document.createElement('span'); edited.textContent = 'edited'; dateDetails.append(edited); }
  header.append(dateDetails);
  const status = document.createElement('span'); status.className = 'entry-state'; status.append(entryStatus(entry)); header.append(status);
  article.append(header);
  if (entry.title) {
    const title = document.createElement('h2'); title.className = 'thought-title';
    title.append(bodyContent(entry.title, state.query)); article.append(title);
  }
  const text = document.createElement('p'); text.className = 'thought-body';
  text.id = `thought-${entry.id}`;
  text.classList.add('collapsed');
  text.append(bodyContent(entry.body, state.query)); article.append(text);
  const footer = document.createElement('div'); footer.className = 'entry-footer';
  const copy = button('copy', 'copy', entry); copy.className = 'copy-thought'; copy.setAttribute('aria-label', 'copy thought'); footer.append(copy);
  const read = document.createElement('a'); read.href = `#thought/${entry.id}`; read.dataset.action = 'read'; read.textContent = 'open'; read.setAttribute('aria-label', 'open thought'); footer.append(read);
  article.append(footer);

  return article;
}

function updateView() {
  $('#tag-filter').hidden=!state.tag;$('#active-tag').textContent=state.tag?`#${state.tag}`:'';
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === state.view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#view-title').textContent = state.view === 'saved' ? 'bookmarks' : 'thoughts';
  $('#view-title').classList.toggle('sr-only', state.view === 'all' || Boolean(state.query));
}

function searchFromComposer(immediate = false) {
  clearTimeout(state.searchTimer);
  if(state.tag){state.query='';if(immediate)return loadFeed(false,false);return;}
  state.query = plainThoughtLinks(entryText({ title: $('#title').value.trim(), body: $('#body').value.trim() })).trim();
  state.controller?.abort();
  state.generation++;
  $('#feed').setAttribute('aria-busy', 'false');
  if (!state.authenticated || state.timelineHidden || (state.posting && !immediate)) return;
  if (!state.query || immediate) return loadFeed(false, Boolean(state.query && state.semanticAvailable));
  // Keep the previous result intact until one complete search is ready.
  state.searchTimer = setTimeout(() => loadFeed(false, state.semanticAvailable), 750);
}

async function loadFeed(append = false, semantic = state.semantic) {
  if (state.timelineHidden) return;
  clearTimeout(state.searchTimer);
  state.controller?.abort();
  const controller = new AbortController(); state.controller = controller;
  const generation = ++state.generation;
  const queryText = state.query;
  const saved = state.view === 'saved';
  let cursor = append ? state.cursor || 0 : 0;
  let semanticMode = Boolean(semantic && queryText && state.semanticAvailable);
  let message = '';
  $('#feed').setAttribute('aria-busy', 'true');
  const search = mode => api('search', {
    method: 'POST', body: JSON.stringify({ query: queryText, saved, cursor, semantic: mode }), signal: controller.signal
  });
  try {
    let data;
    if(state.tag){
      const params=new URLSearchParams({tag:state.tag});if(saved)params.set('saved','1');if(append&&state.cursor!==null)params.set('cursor',state.cursor);
      do{data=await api(`thoughts?${params}`,{signal:controller.signal});}while(data.indexing&&generation===state.generation);
    }else if (queryText && semanticMode) {
      try {
        do { data = await search(true); } while (data.indexing && generation === state.generation);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (generation !== state.generation) return;
        semanticMode = false; append = false; cursor = 0;
        message = 'showing matching words. related search is unavailable.';
        data = await search(false);
      }
    } else if (queryText) data = await search(false);
    else {
      const params = new URLSearchParams();
      if (saved) params.set('saved', '1');
      if (append && state.cursor !== null) params.set('cursor', state.cursor);
      data = await api(`thoughts?${params}`, { signal: controller.signal });
    }
    if (generation !== state.generation || !state.authenticated) return;
    if (!append) {
      closeMenus();
      state.entries.clear();
      const fragment = document.createDocumentFragment();
      for (const entry of data.entries) { state.entries.set(entry.id, entry); fragment.append(renderEntry(entry)); }
      $('#feed').replaceChildren(fragment);
    } else for (const entry of data.entries) {
      if (state.entries.has(entry.id)) continue;
      state.entries.set(entry.id, entry); $('#feed').append(renderEntry(entry));
    }
    state.semantic = semanticMode;
    state.renderedQuery = queryText; state.renderedView = saved ? 'saved' : 'all';
    state.cursor = data.next;
    updateView(); notice(message);
    $('#more').hidden = data.next === null;
    $('#more').textContent = 'load more';
    $('#feed-status').textContent = !state.entries.size ? queryText ? 'no thoughts found.' : saved ? 'no bookmarks yet.' : 'your first thought goes here.' : '';
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.generation) {
      $('#feed-status').textContent = error.message;
      $('#more').hidden = false; $('#more').textContent = 'try again';
    }
  } finally {
    if (generation === state.generation) $('#feed').setAttribute('aria-busy', 'false');
  }
}

async function setView(view) {
  closeMenus();
  state.view = view;
  await searchFromComposer(true);
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#unlock').disabled = true; $('#login-message').textContent = 'unlocking…';
  try { await api('login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); await enter(); }
  catch (error) { $('#login-message').textContent = error.message; }
  finally { $('#unlock').disabled = false; }
});
$('#body').addEventListener('input', changedDraft);
$('#title').addEventListener('input', changedDraft);
$('#add-title').addEventListener('click', () => { $('#composer-title').hidden = false; updateComposer(); $('#title').focus(); });
$('#retry-draft').addEventListener('click', () => saveDraft().catch(() => {}));
$('#composer').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#post').disabled) { event.preventDefault(); $('#composer').requestSubmit(); }
  else if (event.target.id === 'title' && event.key === 'Enter') { event.preventDefault(); composerEditor?.focus(); }
});
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.posting || !$('#body').value.trim()) return;
  state.posting = true; $('#body').disabled = true; $('#title').disabled = true;
  clearTimeout(state.searchTimer); state.controller?.abort(); state.generation++;
  updateComposer(); notice();
  try {
    // If autosave failed, posting still saves the thought. A conflict cannot
    // clear the other device's draft because the version is checked in SQL.
    await saveDraft().catch(() => {});
    const body = $('#body').value;
    const title = $('#title').value;
    if (!state.pendingPost || state.pendingPost.body !== body || state.pendingPost.title !== title) state.pendingPost = { id: crypto.randomUUID(), title, body };
    const data = await api('thoughts', { method: 'POST', body: JSON.stringify({ ...state.pendingPost, draft_version: state.draft.version }) });
    state.pendingPost = null; state.dirty = false; state.conflict = false; state.draft = data.draft;
    $('#body').value = data.draft.body; $('#title').value = data.draft.title || '';
    $('#composer-title').hidden = !$('#title').value; draftStatus(hasDraft(data.draft) ? 'draft saved' : '');
    await setView('all');
  } catch (error) { notice(error.message); }
  finally { state.posting = false; $('#body').disabled = false; $('#title').disabled = false; updateComposer(); }
});
$('#clear-input').addEventListener('click', () => {
  $('#body').value = ''; $('#title').value = ''; $('#composer-title').hidden = true; changedDraft(); composerEditor?.focus();
});
$('#more').addEventListener('click', () => { if ($('#feed').getAttribute('aria-busy') !== 'true' && state.query === state.renderedQuery && state.view === state.renderedView) loadFeed(state.entries.size > 0 && state.cursor !== null); });
$('#toggle-timeline').addEventListener('click', () => {
  state.timelineHidden = !state.timelineHidden;
  $('#timeline').hidden = state.timelineHidden;
  $('#toggle-timeline').textContent = state.timelineHidden ? 'show timeline' : 'hide timeline';
  $('#toggle-timeline').setAttribute('aria-expanded', String(!state.timelineHidden));
  searchFromComposer(true);
});
document.addEventListener('keydown', event => {
  if (state.authenticated && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (state.readerEditing) readerEditor?.focus(); else composerEditor?.focus(); }
});
for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', () => setView(item.dataset.view));
for (const item of document.querySelectorAll('[data-close]')) item.addEventListener('click', () => item.dataset.close === 'public-dialog' ? closePublication() : $(`#${item.dataset.close}`).close());


$('#feed').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const entry = state.entries.get(target.dataset.id);
  if (!entry) return;
  closeMenus();
  const action = target.dataset.action;
  state.selected = entry;
  try {
    if (action === 'copy') {
      await navigator.clipboard.writeText(entryText(entry));
      target.classList.add('is-copied'); target.setAttribute('aria-label', 'thought copied'); $('#copy-status').textContent = 'thought copied';
      setTimeout(() => { target.classList.remove('is-copied'); target.setAttribute('aria-label', 'copy thought'); $('#copy-status').textContent = ''; }, 1200);
    }
  } catch (error) { target.disabled = false; notice(error.message); }
});

$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await saveReader(); }
  catch (error) { $('#reader-error').textContent = error.message; }
});
$('#reader-edit').addEventListener('click', () => {
  if (!state.readerEntry) return;
  closeMenus();
  $('#edit-thought-title').value = state.readerEntry.title || '';
  $('#edit-body').value = state.readerEntry.body;
  state.readerEditing = true; state.readerDirty = false;
  $('#reader-error').textContent = ''; readerControls(); clearReaderEditor();
  readerEditor = createLiveEditor($('#live-editor'), {
    value: state.readerEntry.body,
    nonce: document.querySelector('meta[name=editor-style-nonce]').content,
    findThoughts: (query, signal) => findThoughts(query, signal, state.readerEntry.id), onOpenThought: navigateThought,
    onChange(value) { $('#edit-body').value = value; changedReader(); },
    onLimit() { $('#reader-error').textContent = 'Thoughts can contain up to 20,000 characters.'; }
  });
  readerEditor.focus();
});
function changedReader() {
  state.readerDirty = $('#edit-thought-title').value !== state.readerEntry.title || $('#edit-body').value !== state.readerEntry.body;
  readerControls();
}
$('#edit-form').addEventListener('input', event => {
  if (event.target.id === 'edit-thought-title') changedReader();
});
$('#reader-cancel').addEventListener('click', stopEditing);
$('#reader-bookmark').addEventListener('click', async () => {
  const entry = state.readerEntry; if (!entry) return;
  $('#reader-bookmark').disabled = true;
  try {
    const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ bookmarked: !entry.bookmarked }) });
    if (state.readerEntry?.id === entry.id) { updateEntry(data.entry); readerControls(); }
  } catch (error) { $('#reader-error').textContent = error.message; }
  finally { $('#reader-bookmark').disabled = false; }
});
$('#reader-public').addEventListener('click', async () => {
  if (!state.readerEntry) return;
  state.selected = state.readerEntry;
  try { await openPublication(state.readerEntry); }
  catch (error) { $('#reader-error').textContent = error.message; }
});
$('#reader-delete').addEventListener('click', () => {
  if (!state.readerEntry) return;
  state.selected = state.readerEntry;
  $('#delete-error').textContent = ''; $('#delete-dialog').showModal();
});
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try {
    await api(`thoughts/${state.selected.id}`, { method: 'DELETE' });
    state.entries.delete(state.selected.id);
    $('#delete-dialog').close(); await loadFeed(); location.hash = '';
  } catch (error) { $('#delete-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
function publicInput() {
  const tags = $('#public-tags').value;
  return {
    slug: $('#public-slug').value, title: $('#public-thought-title').value, body: plainThoughtLinks($('#public-body').value),
    date: $('#public-date').value,
    tags: tags === state.publication.draft.tags.join(', ') ? state.publication.draft.tags : tags.split(',').map(tag => tag.trim()).filter(Boolean),
    description: $('#public-description').value, cover: $('#public-cover').value, coverPosition: $('#public-cover-position').value
  };
}
function publicationControls() {
  const published = state.publication?.published;
  $('#unpublish').hidden = !published;
  $('#view-public').hidden = !published;
  if (published) $('#view-public').href = `https://christopherli.dev/#thought/${published.slug}`;
  $('#publish-public').textContent = published ? 'update site ↗' : 'publish to site ↗';
  if (state.readerEntry?.id === state.publicationId) {
    updateEntry({ ...state.readerEntry, published_slug: published?.slug || null });
    readerControls();
  }
}
function publicBusy(value) {
  state.publicBusy = value;
  for (const control of $('#public-dialog').querySelectorAll('input,textarea,button')) control.disabled = value;
}
async function openPublication(entry) {
  const data = await api(`thoughts/${entry.id}/publication`);
  if (state.selected?.id !== entry.id || state.readerEntry?.id !== entry.id) return;
  state.publication = data; state.publicationId = entry.id; state.publicDirty = false;
  const draft = data.draft;
  if (!data.version && !entry.source_date) {
    const date = new Date(entry.created_at);
    draft.date = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  $('#public-thought-title').value = draft.title;
  $('#public-body').value = draft.body;
  $('#public-slug').value = draft.slug;
  $('#public-date').value = draft.date;
  $('#public-tags').value = draft.tags.join(', ');
  $('#public-description').value = draft.description;
  $('#public-cover').value = draft.cover;
  $('#public-cover-position').value = draft.coverPosition;
  $('#public-status').textContent = data.published ? JSON.stringify(data.draft) === JSON.stringify(data.published) ? 'published' : 'unpublished changes' : data.version ? 'draft saved' : '';
  publicationControls();
  $('#public-dialog').showModal();
}
async function savePublication() {
  if (state.publicBusy) throw new Error('Wait for the current save to finish.');
  if (!state.publication) return;
  if (!state.publicDirty && state.publication.version) return;
  publicBusy(true); $('#public-status').textContent = 'saving…';
  try {
    state.publication = await api(`thoughts/${state.publicationId}/publication`, { method: 'PUT', body: JSON.stringify({ draft: publicInput(), version: state.publication.version }) });
    state.publicDirty = false; publicationControls();
    $('#public-status').textContent = state.publication.published ? JSON.stringify(state.publication.draft) === JSON.stringify(state.publication.published) ? 'published' : 'unpublished changes' : 'draft saved';
  } catch (error) { $('#public-status').textContent = error.message; throw error; }
  finally { publicBusy(false); }
}
async function closePublication() {
  if (state.publicBusy) return;
  try { if (state.publicDirty) await savePublication(); $('#public-dialog').close(); }
  catch { /* Keep the editable text visible when saving fails. */ }
}
$('#public-dialog').addEventListener('input', () => { state.publicDirty = true; $('#public-status').textContent = 'unsaved'; });
$('#public-dialog').addEventListener('cancel', event => { event.preventDefault(); closePublication(); });
$('#save-public').addEventListener('click', () => savePublication().catch(() => {}));
async function changePublication(action) {
  if (state.publicBusy) return;
  try {
    await savePublication();
    publicBusy(true); $('#public-status').textContent = action === 'publish' ? 'publishing…' : 'unpublishing…';
    state.publication = await api(`thoughts/${state.publicationId}/publication/${action}`, { method: 'POST', body: JSON.stringify({ version: state.publication.version }) });
    publicationControls();
    $('#public-status').textContent = action === 'publish' ? 'published' : 'unpublished';
  } catch (error) { $('#public-status').textContent = error.message; }
  finally { publicBusy(false); }
}
$('#publish-public').addEventListener('click', () => changePublication('publish'));
$('#unpublish').addEventListener('click', () => changePublication('unpublish'));
$('#copy-public').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(entryText({ title: $('#public-thought-title').value, body: $('#public-body').value })); $('#public-status').textContent = 'copied.'; }
  catch { $('#public-status').textContent = 'select the text to copy it.'; }
});
$('#download-public').addEventListener('click', () => {
  const { slug, body, ...metadata } = publicInput();
  download(`${slug}.md`, `---\n${Object.entries({ ...metadata, published: false }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}\n`, 'text/markdown');
  $('#public-status').textContent = 'downloaded.';
});
$('#export').addEventListener('click', async () => {
  try { await saveDraft(); if (state.publicDirty) await savePublication(); const data = await api('export'); download(`journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json'); }
  catch (error) { notice(error.message); }
});
$('#logout').addEventListener('click', async () => {
  if (state.posting) return;
  try {
    await saveDraft();
    if (state.publicDirty) await savePublication();
    if (state.dirty) { notice('copy or post your unsaved draft before locking.'); return; }
    await api('logout', { method: 'POST', body: '{}' });
    state.entries.clear(); state.selected = null; state.publication = null; state.publicationId = null; state.publicDirty = false; state.pendingPost = null;
    $('#feed').replaceChildren();
    for (const area of document.querySelectorAll('textarea')) area.value = '';
    composerEditor?.setValue('');
    state.tag=null;
    readingView.clear();
    for (const input of document.querySelectorAll('.title-input')) input.value = '';
    $('#composer-title').hidden = true;
    showLogin();
  } catch (error) { notice(error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.dirty) saveDraft().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (state.dirty || state.saving || state.posting || state.publicDirty || state.publicBusy || state.readerDirty || state.readerSaving) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

try {
  const session = await api('session');
  if (session.authenticated) await enter();
  else { showLogin(session.ready ? '' : 'the journal is unavailable. try again later.'); $('#unlock').disabled = !session.ready; }
} catch (error) { showLogin(error.message); $('#unlock').disabled = true; }
