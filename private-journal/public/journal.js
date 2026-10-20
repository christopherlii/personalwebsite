import { searchTerms } from './search-terms.js';
import { markdown, markdownPreview } from './markdown.js';
import { createLiveEditor } from './live-editor.js';
import { thoughtLinks, plainThoughtLinks } from './thought-links.js';
import { createReading } from './reading.js';
import { markdownTags, normalizeTag } from './tags.js';
import { createDictation } from './dictation.js';
import { createPhotos } from './photos.js';
import { plainPhotoLinks } from './photo-links.js';
import { createCommands, commandMatches } from './commands.js';
import { IDEA_KINDS, IDEA_WORDS, IDEA_WORD_PATTERN } from './ideas.js';

const $ = selector => document.querySelector(selector);
const state = { authenticated: false, view: 'all', query: '', cursor: null, entries: new Map(), generation: 0, controller: null, draft: { version: 0 }, dirty: false, saving: null, conflict: false, posting: false, pendingPost: null, selected: null, publication: null, publicationId: null, publicDirty: false, publicBusy: false, draftTimer: null, searchTimer: null, semanticAvailable: false, semantic: false, timelineHidden: false, renderedQuery: null, renderedView: null, readerGeneration: 0, feedScroll: 0 };
Object.assign(state, { readerEntry: null, readerEditing: false, readerDirty: false, readerSaving: null, readerHistory: null });
Object.assign(state, { readerDraftTimer:null, readerConflict:false, readerAutosaving:false });
state.tag = null;
let readerEditor = null;
let composerEditor = null;
const readingView = createReading({ api, navigateThought });
const photos=createPhotos({api,getEditor:owner=>owner==='composer'?composerEditor:readerEditor,
  onBusy(busy){for(const id of ['composer-editor','live-editor'])document.getElementById(id).setAttribute('aria-busy',String(busy));},
  onMessage(owner,message){if(owner==='composer')notice(message);else $('#reader-error').textContent=message;}
});
const dictation = createDictation({
  onUnavailable() { api('session').then(session => { if (!session.authenticated) showLogin('your session ended. unlock to continue.'); }).catch(() => {}); },
  onState(owner, value) {
    const button = $(`#dictate-${owner}`), recording = value === 'starting' || value === 'listening';
    button.setAttribute('aria-pressed', String(recording));
    button.setAttribute('aria-label', recording ? 'stop dictation' : value === 'transcribing' ? 'transcribing recording' : 'start dictation');
    button.disabled = value === 'transcribing';
    const status = $(`#dictation-${owner}-status`);
    if (value !== 'idle') status.textContent = value === 'starting' ? 'allow microphone access' : value === 'listening' ? 'listening…' : 'transcribing…';
    else if (['allow microphone access','listening…','transcribing…'].includes(status.textContent)) status.textContent = '';
  },
  onMessage(owner, message) { $(`#dictation-${owner}-status`).textContent = message; }
});
$('#dictate-composer').addEventListener('click', () => dictation.toggle('composer', composerEditor));
$('#dictate-reader').addEventListener('click', () => dictation.toggle('reader', readerEditor));
function navigateThought(id) {
  const current = readerId(); if (id === current) return;
  history.pushState({ journalNavigation: true, previousThought: current || null }, '', `#thought/${id}`);
  showRoute();
}
async function findThoughts(query, signal, exclude = '') {
  const result = await api(`link-suggestions?q=${encodeURIComponent(query)}${exclude ? `&exclude=${exclude}` : ''}`, { signal });
  return result.entries;
}
function clearReaderEditor() { clearTimeout(state.readerDraftTimer); readerEditor?.destroy(); readerEditor = null; $('#live-editor').replaceChildren(); }

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function draftStatus(message) {
  const routine = {'saving…':'saving',unsaved:'unsaved','draft saved':'saved','':'empty'};
  $('#composer').dataset.draftState = routine[message] || 'error';
  $('#draft-status').textContent = Object.hasOwn(routine,message) ? '' : message;
}
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
  setFocus(false);
  photos.cancel();
  dictation.cancel();
  closeMenus();
  if (state.readerDirty && state.readerEntry) history.replaceState(state.readerHistory, '', `#thought/${state.readerEntry.id}`);
  state.authenticated = false;
  state.generation++;
  state.controller?.abort();
  clearTimeout(state.draftTimer);
  clearTimeout(state.readerDraftTimer);
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
  $('#save-essay').disabled = $('#post').disabled;
  $('#dictate-composer').disabled = state.posting || dictation.phase === 'transcribing';
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
  commands.update();
  // A command in progress is neither a draft nor a search: the timeline and
  // the saved draft stay as they were until it runs or turns back into writing.
  if (commandMatches($('#body').value).length) { clearTimeout(state.draftTimer); clearTimeout(state.searchTimer); updateComposer(); return; }
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
  prefetchIdeas();
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
  const name = entry.title || entry.published_title, tags = entryTags(entry);
  if (name || tags.childNodes.length) {
    const title = document.createElement('h1'); title.className = 'thought-title';
    if (name) { const label = document.createElement('span'); label.append(bodyContent(name,'')); title.append(label); }
    title.append(tags); content.append(title);
  }
  const body = document.createElement('div'); body.className = 'thought-body markdown-body'; body.append(markdown(entry.body)); decorateIdeas(body); content.append(body);
  readingView.related(entry);
}
function readerControls() {
  const editing = state.readerEditing;
  const draft = Boolean(state.readerEntry?.is_draft);
  const busy = Boolean(state.readerSaving) && !state.readerAutosaving;
  for (const id of ['reader-edit', 'reader-bookmark', 'reader-like']) $(`#${id}`).hidden = editing || !state.readerEntry;
  $('#reader-menu-toggle').hidden = (editing && !draft) || !state.readerEntry;
  $('#reader-save').hidden = !editing || draft; $('#reader-cancel').hidden = !editing || draft;
  $('#reader-post').hidden = !draft;
  $('#reader-draft-label').hidden = !draft;
  $('#reader-public').hidden = draft;
  $('#dictate-reader').hidden = !editing;
  $('#dictate-reader').disabled = busy || (dictation.owner === 'reader' && dictation.phase === 'transcribing');
  $('#edit-form').hidden = !editing;
  $('#reader-content').hidden = editing;
  readingView.editing(editing);
  readerEditor?.setReadOnly(busy);
  for (const control of document.querySelectorAll('.reader-actions button, #edit-form input, #edit-form textarea')) control.disabled = busy;
  $('#reader-save').disabled = busy || !$('#edit-body').value.trim();
  $('#reader-post').disabled = busy || state.readerConflict || !$('#edit-body').value.trim();
  const saved = Boolean(state.readerEntry?.bookmarked), liked = Boolean(state.readerEntry?.liked);
  $('#reader-bookmark').textContent = saved ? 'unsave' : 'save';
  $('#reader-bookmark').setAttribute('aria-pressed', String(saved));
  $('#reader-like').textContent = liked ? 'unlike' : 'like';
  $('#reader-like').setAttribute('aria-pressed', String(liked));
}
function updateEntry(entry) {
  if (state.readerEntry?.id === entry.id) state.readerEntry = entry;
  state.selected = entry;
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
  if (dictation.owner === 'reader') dictation.cancel();
  state.readerEditing = false; state.readerDirty = false; clearReaderEditor();
  $('#reader-error').textContent = ''; renderReader(); readerControls();
}
async function saveReader({autosave=false,post=false}={}) {
  clearTimeout(state.readerDraftTimer);
  if (!autosave) {
    if(!await photos.finish())throw new Error('Photo upload failed. Try adding the photo again.');
    if (dictation.owner === 'reader' && !await dictation.stop()) throw new Error('Dictation was not saved. Try again.');
  }
  if (state.readerSaving) { await state.readerSaving; return saveReader({autosave,post}); }
  if (state.readerConflict) throw new Error('This draft changed elsewhere. Copy your text before reloading.');
  if (!state.readerEntry) return;
  const draft = Boolean(state.readerEntry.is_draft);
  if (!state.readerDirty && !post) { if (!draft) stopEditing(); return; }
  state.readerAutosaving = autosave;
  state.readerSaving = (async () => {
    do {
      const title = $('#edit-thought-title').value, body = $('#edit-body').value;
      if (!body.trim()) throw new Error('Add some text before saving.');
      state.readerDirty = false;
      $('#edit-form').dataset.draftState = 'saving';
      try {
        const { entry } = await api(`thoughts/${state.readerEntry.id}`, { method:'PATCH', body:JSON.stringify({title,body,updated_at:state.readerEntry.updated_at,revision:state.readerEntry.revision,...(post?{is_draft:false}:{})}) });
        updateEntry(entry);
        if (post || !draft) { stopEditing(); return; }
        state.readerDirty = $('#edit-thought-title').value !== entry.title || $('#edit-body').value !== entry.body;
      } catch(error) { state.readerDirty=true;state.readerConflict=error.status===409;if(state.readerConflict&&draft)error.message='This draft changed elsewhere. Copy your text before reloading.';throw error; }
    } while(state.readerDirty);
    $('#edit-form').dataset.draftState = 'saved';
    $('#reader-error').textContent = ''; $('#reader-retry').hidden = true;
  })();
  readerControls();
  try { await state.readerSaving; }
  catch(error) { $('#edit-form').dataset.draftState='error';$('#reader-retry').hidden=state.readerConflict;throw error; }
  finally { state.readerSaving = null; state.readerAutosaving=false;readerControls(); }
}
async function showRoute() {
  if (!state.authenticated) return;
  if(!await photos.finish()){history.replaceState({...state.readerHistory,journalNavigation:false},'',state.readerEntry?`#thought/${state.readerEntry.id}`:state.tag?`#tag/${encodeURIComponent(state.tag)}`:'#');return;}
  if(!await dictation.stop()){history.replaceState({...state.readerHistory,journalNavigation:false},'',state.readerEntry?`#thought/${state.readerEntry.id}`:state.tag?`#tag/${encodeURIComponent(state.tag)}`:'#');return;}
  if (!state.authenticated) return;
  const generation = ++state.readerGeneration;
  const id = readerId();
  readingView.hide();
  $('#reader-back').href = readerBackTarget();
  if ((state.readerDirty || state.readerSaving) && id !== state.readerEntry?.id) {
    try { await saveReader(); }
    catch (error) {
      if (generation !== state.readerGeneration) return;
      history.replaceState({...state.readerHistory,journalNavigation:false}, '', `#thought/${state.readerEntry.id}`);
      state.readerHistory=history.state;
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
    renderReader(); readerControls(); revealIdea(entry.id);
    $('#reader-error').textContent = '';
    if (entry.is_draft) beginEditing(false);
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

function bodyContent(body, query, linkify = true) {
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
  if (!linkify) { appendText(body); return fragment; }
  // Titles stay plain text, with safe links and search highlights.
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

function entryTags(entry) {
  const status = document.createDocumentFragment();
  if (entry?.is_draft) { const label=document.createElement('span');label.className='entry-tag entry-draft';label.textContent='draft';status.append(label); }
  if (entry?.published_slug) {
    const published = document.createElement('a'); published.className = 'entry-tag entry-published'; published.textContent = 'published';
    published.href = `https://christopherli.dev/#thought/${encodeURIComponent(entry.published_slug)}`;
    published.target = '_blank'; published.rel = 'noopener noreferrer'; published.setAttribute('aria-label', 'view published thought'); status.append(published);
  }
  for (const [field, label] of [['bookmarked', 'saved'], ['liked', 'liked']]) {
    if (!entry?.[field]) continue;
    const tag = document.createElement('span'); tag.className = `entry-tag entry-${label}`; tag.textContent = label; status.append(tag);
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
  if (entry.source) { const via = document.createElement('span'); via.textContent = `via ${entry.source}`; dateDetails.append(via); }
  header.append(dateDetails);
  article.append(header);
  const name = entry.title || entry.published_title, tags = entryTags(entry);
  if (name || tags.childNodes.length) {
    const title = document.createElement('h2'); title.className = 'thought-title';
    if (name) { const label = document.createElement('span'); label.append(bodyContent(name, state.query)); title.append(label); }
    title.append(tags); article.append(title);
  }
  const text = document.createElement('div'); text.className = 'thought-body markdown-body thought-preview';
  text.id = `thought-${entry.id}`;
  text.append(markdownPreview(entry.body));
  decorateIdeas(text);
  if (state.query) {
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT), nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) node.replaceWith(bodyContent(node.data, state.query, false));
  }
  article.append(text);
  const footer = document.createElement('div'); footer.className = 'entry-footer';
  const copy = button('copy', 'copy', entry); copy.className = 'copy-thought'; copy.setAttribute('aria-label', 'copy thought'); footer.append(copy);
  const read = document.createElement('a'); read.href = `#thought/${entry.id}`; read.dataset.action = 'read'; read.textContent = 'open'; read.setAttribute('aria-label', 'open thought'); footer.append(read);
  const save = button(entry.bookmarked ? 'unsave' : 'save', 'bookmarked', entry); save.setAttribute('aria-pressed', String(Boolean(entry.bookmarked))); footer.append(save);
  const like = button(entry.liked ? 'unlike' : 'like', 'liked', entry); like.setAttribute('aria-pressed', String(Boolean(entry.liked))); footer.append(like);
  article.append(footer);

  return article;
}

function updateView() {
  $('#tag-filter').hidden=!state.tag;$('#active-tag').textContent=state.tag?`#${state.tag}`:'';
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === state.view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#view-title').textContent = state.view === 'saved' ? 'saved' : 'thoughts';
  $('#view-title').classList.toggle('sr-only', state.view === 'all' || Boolean(state.query));
}

function searchFromComposer(immediate = false) {
  clearTimeout(state.searchTimer);
  if(state.tag){state.query='';if(immediate)return loadFeed(false,false);return;}
  state.query = plainPhotoLinks(plainThoughtLinks(entryText({ title: $('#title').value.trim(), body: $('#body').value.trim() }))).trim();
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
    $('#feed-status').textContent = !state.entries.size && !queryText ? saved ? 'nothing saved yet.' : 'your first thought goes here.' : '';
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

// "/idea …" and "/project …" lines render as a small tag followed by the idea.
function decorateIdeas(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (new RegExp(`\\/(${IDEA_WORD_PATTERN})[ \\t]`, 'i').test(node.data) && !node.parentElement.closest('code,pre,a')) nodes.push(node);
  for (const node of nodes) {
    // A match at the very start of this text node only counts at a line start.
    const lineStart = !node.previousSibling || node.previousSibling.nodeName === 'BR';
    const fragment = document.createDocumentFragment(); let last = 0;
    for (const match of node.data.matchAll(new RegExp(`(^|\\n)[ \\t]*\\/(${IDEA_WORD_PATTERN})[ \\t]+([^\\n]*)`, 'gi'))) {
      if (match.index === 0 && !match[1] && !lineStart) continue;
      const start = match.index + match[1].length, kind = IDEA_WORDS[match[2].toLowerCase()], value = match[3];
      fragment.append(node.data.slice(last, start));
      const line = document.createElement('span'); line.className = 'idea-line'; line.dataset.key = `${kind}\n${value.trim()}`;
      const tag = document.createElement('span'); tag.className = `entry-tag entry-${kind}`; tag.textContent = kind;
      line.append(tag, ` ${value}`); fragment.append(line); last = match.index + match[0].length;
    }
    if (!last) continue;
    fragment.append(node.data.slice(last)); node.replaceWith(fragment);
  }
}
function revealIdea(id) {
  const wanted = state.revealIdea; state.revealIdea = null;
  if (!wanted || wanted.thought !== id) return;
  const line = [...document.querySelectorAll('#reader-content .idea-line')].find(item => item.dataset.key === wanted.key);
  if (!line) return;
  line.scrollIntoView({ block: 'center' }); line.classList.add('is-revealed');
  setTimeout(() => line.classList.remove('is-revealed'), 2400);
}
// Lists are fetched ahead (after unlocking) and kept, so /idea shows at once;
// a fresh copy follows and replaces the list only if something changed.
const ideaLists = new Map();
async function fetchIdeas(kind) {
  let data;
  do { data = await api(`ideas?kind=${kind}`); } while (data.indexing);
  ideaLists.set(kind, data.ideas);
  return data.ideas;
}
async function floatIdeas(kind) {
  const cached = ideaLists.get(kind);
  if (cached) renderIdeas(kind, cached, true);
  const fresh = await fetchIdeas(kind);
  const float = $('#float-left');
  if (float.dataset.showing !== kind && cached) return;
  if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) renderIdeas(kind, fresh, !cached);
}
function prefetchIdeas() { setTimeout(() => { for (const kind of Object.keys(IDEA_KINDS)) fetchIdeas(kind).catch(() => {}); }, 400); }
function renderIdeas(kind, ideas, animate) {
  const float = $('#float-left'), finished = { idea: 'written', project: 'started', curious: 'looked into' }[kind];
  const title = document.createElement('p'); title.className = 'float-heading'; title.textContent = IDEA_KINDS[kind];
  const items = ideas.map((idea, index) => {
    const item = document.createElement('div'); item.className = `float-idea${idea.done_at ? ' is-done' : ''}`;
    item.style.animationDelay = `${Math.min(index + 1, 8) * 18}ms`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'float-item';
    const text = document.createElement('span'); text.className = 'float-text'; text.textContent = idea.text;
    open.append(text);
    // A line idea opens at its line; a loose one opens the note it followed.
    open.addEventListener('click', () => { if (!idea.thought_id) return; if (idea.origin === 'line') state.revealIdea = { thought: idea.thought_id, key: `${idea.kind}\n${idea.text}` }; navigateThought(idea.thought_id); });
    const done = document.createElement('button'); done.type = 'button'; done.className = 'float-done';
    done.textContent = idea.done_at ? 'undo' : finished; done.setAttribute('aria-label', idea.done_at ? `mark not ${finished}` : `mark ${finished}`);
    done.addEventListener('click', async () => {
      done.disabled = true;
      try { await api(`ideas/${idea.id}`, { method: 'PATCH', body: JSON.stringify({ done: !idea.done_at }) }); await floatIdeas(kind); }
      catch (error) { done.disabled = false; notice(error.message); }
    });
    item.append(open, done);
    return item;
  });
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'float-empty'; empty.textContent = `no ${IDEA_KINDS[kind]} yet. log one with /${kind} …`; items.push(empty); }
  float.classList.toggle('is-quiet', !animate);
  float.replaceChildren(title, ...items); float.hidden = false; float.dataset.showing = kind;
}
function floatBullets(heading, items, emptyText) {
  const float = $('#float-left'); float.classList.remove('is-quiet');
  const title = document.createElement('p'); title.className = 'float-heading'; title.textContent = heading;
  const rows = items.map((item, index) => {
    const row = document.createElement('div'); row.className = 'float-idea'; row.style.animationDelay = `${Math.min(index + 1, 8) * 18}ms`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'float-item';
    const text = document.createElement('span'); text.className = 'float-text'; text.textContent = item.text;
    open.append(text); open.addEventListener('click', item.open); row.append(open);
    return row;
  });
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'float-empty'; empty.textContent = emptyText; rows.push(empty); }
  float.replaceChildren(title, ...rows); float.hidden = false; delete float.dataset.showing;
}
function setFocus(on) { document.body.classList.toggle('focus-mode', on); }
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('focus-mode') && !document.querySelector('dialog[open]')) setFocus(false);
});
function clearFloat(side) { const float = $(`#float-${side}`); float.replaceChildren(); float.hidden = true; delete float.dataset.showing; }
// Results float up beside the writing as plain text: no panel, no border.
async function runCommand(name, argument, context = {}) {
  notice();
  try {
    if (name === 'focus') setFocus(!document.body.classList.contains('focus-mode'));
    else if (name === 'lock') $('#logout').click();
    else if (name === 'cl') { clearFloat('left'); receipt('cleared the left'); }
    else if (name === 'cr') { clearFloat('right'); receipt('cleared the right'); }
    else if (Object.hasOwn(IDEA_WORDS, name)) {
      const kind = IDEA_WORDS[name];
      if (!argument) { await floatIdeas(kind); return; }
      // An idea logged on its own lives only in the ideas list, linked to the
      // note written just before it, and flies there from where it was typed.
      await api('ideas', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID().replaceAll('-', ''), kind, text: argument }) });
      receipt({ idea: 'idea saved', project: 'project saved', curious: 'curiosity saved' }[kind]);
      await flyIdea(kind, argument, context.rect);
    }
    else if (name === 'ideas' || name === 'projects') await floatIdeas(name === 'ideas' ? 'idea' : 'project');
    else if (name === 'timeline') $('#toggle-timeline').click();
    else if (name === 'draft') {
      const { entries } = await api('thoughts/drafts');
      floatBullets('essay drafts', entries.map(entry => ({ text: entry.title || plainPhotoLinks(plainThoughtLinks(entry.body)).slice(0, 120), open: () => navigateThought(entry.id) })), 'no essay drafts. keep one with ⌘S.');
    }
    else if (name === 'random') { const { entry } = await api('thoughts/random'); navigateThought(entry.id); }
    else if (name === 'read') {
      if (!argument) { location.hash = '#reading'; return; }
      const data = await api('reading', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), url: argument }) });
      receipt(data.existing ? 'already in read later' : 'saved to read later');
    }
  } catch (error) { notice(error.status === 404 && name === 'random' ? 'no thoughts yet.' : error.message); }
}
// A faint line under the writing that says what a command did, then fades.
function receipt(text) {
  const element = $('#command-receipt');
  element.textContent = text; element.classList.remove('is-showing'); void element.offsetWidth; element.classList.add('is-showing');
}
async function flyIdea(kind, text, from) {
  await floatIdeas(kind);
  const target = [...document.querySelectorAll('#float-left .float-idea:not(.is-done) .float-text')].find(item => item.textContent === text);
  if (!target || !from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = target.getBoundingClientRect();
  const ghost = document.createElement('span'); ghost.className = 'idea-ghost'; ghost.textContent = text;
  ghost.style.left = `${from.left}px`; ghost.style.top = `${from.top}px`;
  document.body.append(ghost); target.style.opacity = '0';
  const flight = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${12 / 14})`, opacity: 0.6 }
  ], { duration: 560, easing: 'cubic-bezier(.3,.6,.2,1)' });
  await flight.finished.catch(() => {});
  ghost.remove(); target.style.opacity = '';
}
const commands = createCommands({
  getEditor: () => composerEditor,
  fill(text) { $('#body').value = text; composerEditor?.setValue(text); changedDraft(); composerEditor?.focus(); },
  run: runCommand,
  receipt
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#unlock').disabled = true; $('#login-message').textContent = 'unlocking…';
  try { await api('login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); await enter(); }
  catch (error) { $('#login-message').textContent = error.message; }
  finally { $('#unlock').disabled = false; }
});
// Without CSS masking the field falls back to a real password input, which
// still never shows the password; new-password at least stops autofill.
if (!CSS.supports('-webkit-text-security', 'disc')) { $('#password').type = 'password'; $('#password').autocomplete = 'new-password'; }
for (const type of ['copy', 'cut']) $('#password').addEventListener(type, event => event.preventDefault());
$('#body').addEventListener('input', changedDraft);
$('#title').addEventListener('input', changedDraft);
$('#retry-draft').addEventListener('click', () => saveDraft().catch(() => {}));
$('#composer').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#post').disabled) { event.preventDefault(); $('#composer').requestSubmit(); }
  // Cmd/Ctrl+S keeps the piece as an essay draft on the timeline (the old save draft button).
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!$('#save-essay').disabled) $('#composer').requestSubmit($('#save-essay')); }
  else if (event.target.id === 'title' && event.key === 'Enter') { event.preventDefault(); composerEditor?.focus(); }
});
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  const essay = event.submitter?.id === 'save-essay';
  if(!await photos.finish())return;
  if (dictation.owner === 'composer' && !await dictation.stop()) return;
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
    if (!state.pendingPost || state.pendingPost.body !== body || state.pendingPost.title !== title || Boolean(state.pendingPost.is_draft) !== essay) state.pendingPost = { id: crypto.randomUUID(), title, body, ...(essay?{is_draft:true}:{}) };
    const data = await api('thoughts', { method: 'POST', body: JSON.stringify({ ...state.pendingPost, draft_version: state.draft.version }) });
    state.pendingPost = null; state.dirty = false; state.conflict = false; state.draft = data.draft;
    $('#body').value = data.draft.body; $('#title').value = data.draft.title || '';
    draftStatus(hasDraft(data.draft) ? 'draft saved' : '');
    prefetchIdeas();
    await setView('all');
    if (essay) navigateThought(data.entry.id);
  } catch (error) { notice(error.message); }
  finally { state.posting = false; $('#body').disabled = false; $('#title').disabled = false; updateComposer(); }
});
$('#more').addEventListener('click', () => { if ($('#feed').getAttribute('aria-busy') !== 'true' && state.query === state.renderedQuery && state.view === state.renderedView) loadFeed(state.entries.size > 0 && state.cursor !== null); });
function setTimelineHidden(hidden) {
  state.timelineHidden = hidden;
  $('#timeline').hidden = state.timelineHidden;
  $('#toggle-timeline').textContent = state.timelineHidden ? 'show timeline' : 'hide timeline';
  $('#toggle-timeline').setAttribute('aria-expanded', String(!state.timelineHidden));
}
$('#toggle-timeline').addEventListener('click', () => {
  setTimelineHidden(!state.timelineHidden);
  try { localStorage.setItem('journal.timelineHidden', String(state.timelineHidden)); } catch {}
  searchFromComposer(true);
});
// Two quick taps of Shift lock the journal, same as the lock button. A tap
// only counts if no other key went down while Shift was held, so typing
// capitals never adds up to a lock.
const shiftTap = { clean: false, last: -Infinity };
document.addEventListener('keydown', event => {
  if (event.key !== 'Shift') { shiftTap.clean = false; shiftTap.last = -Infinity; }
  else if (!event.repeat) shiftTap.clean = true;
});
document.addEventListener('keyup', event => {
  if (event.key !== 'Shift' || !shiftTap.clean) return;
  shiftTap.clean = false;
  if (event.timeStamp - shiftTap.last < 400 && state.authenticated) { shiftTap.last = -Infinity; $('#logout').click(); }
  else shiftTap.last = event.timeStamp;
});
// Typing anywhere on the timeline writes in the box, no click needed. Keys
// meant for another field, shortcuts, and space (which scrolls) are left alone.
document.addEventListener('keydown', event => {
  if (!state.authenticated || $('#app').hidden || event.defaultPrevented || event.isComposing) return;
  if (event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable=true], dialog')) return;
  composerEditor?.focus();
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
    if (action === 'bookmarked' || action === 'liked') {
      target.disabled = true;
      const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ [action]: !entry[action] }) });
      const focused = document.activeElement === target;
      updateEntry(data.entry);
      if (focused) $(`#feed article[data-id="${entry.id}"] [data-action=${action}]`)?.focus();
    } else if (action === 'copy') {
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
function beginEditing(focus=true) {
  if (!state.readerEntry) return;
  closeMenus();
  $('#edit-thought-title').value = state.readerEntry.title || '';
  $('#edit-body').value = state.readerEntry.body;
  state.readerEditing = true; state.readerDirty = false;
  state.readerConflict=false;$('#reader-retry').hidden=true;$('#edit-form').dataset.draftState='saved';
  $('#reader-error').textContent = ''; readerControls(); clearReaderEditor();
  readerEditor = createLiveEditor($('#live-editor'), {
    value: state.readerEntry.body,
    nonce: document.querySelector('meta[name=editor-style-nonce]').content,
    findThoughts: (query, signal) => findThoughts(query, signal, state.readerEntry.id), onOpenThought: navigateThought,
    onChange(value) { $('#edit-body').value = value; changedReader(); },
    onLimit() { $('#reader-error').textContent = 'Thoughts can contain up to 20,000 characters.'; }
  });
  if(focus)readerEditor.focus();
}
$('#reader-edit').addEventListener('click', () => beginEditing());
function changedReader() {
  state.readerDirty = $('#edit-thought-title').value !== state.readerEntry.title || $('#edit-body').value !== state.readerEntry.body;
  if(state.readerEntry.is_draft)$('#edit-form').dataset.draftState=state.readerDirty?'unsaved':state.readerSaving?'saving':'saved';
  readerControls();
  clearTimeout(state.readerDraftTimer);
  if(state.readerEntry.is_draft && state.readerDirty && !state.readerConflict)state.readerDraftTimer=setTimeout(()=>saveReader({autosave:true}).catch(error=>{$('#reader-error').textContent=error.message;}),650);
}
$('#edit-form').addEventListener('input', event => {
  if (event.target.id === 'edit-thought-title') changedReader();
});
$('#reader-cancel').addEventListener('click', stopEditing);
$('#reader-post').addEventListener('click',()=>saveReader({post:true}).catch(error=>{$('#reader-error').textContent=error.message;}));
$('#reader-retry').addEventListener('click',()=>saveReader({autosave:true}).catch(error=>{$('#reader-error').textContent=error.message;}));
async function toggleReaderMark(control, field) {
  const entry = state.readerEntry; if (!entry) return;
  control.disabled = true;
  try {
    const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ [field]: !entry[field] }) });
    if (state.readerEntry?.id === entry.id) { updateEntry(data.entry); renderReader(); readerControls(); }
  } catch (error) { $('#reader-error').textContent = error.message; }
  finally { control.disabled = false; }
}
$('#reader-bookmark').addEventListener('click', () => toggleReaderMark($('#reader-bookmark'), 'bookmarked'));
$('#reader-like').addEventListener('click', () => toggleReaderMark($('#reader-like'), 'liked'));
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
    if(!await photos.finish() || !await dictation.stop())return;
    clearTimeout(state.readerDraftTimer);
    if(state.readerSaving)await state.readerSaving.catch(()=>{});
    await api(`thoughts/${state.selected.id}`, { method: 'DELETE' });
    state.entries.delete(state.selected.id);
    if(state.readerEntry?.id===state.selected.id){state.readerDirty=false;state.readerEntry=null;state.readerEditing=false;clearReaderEditor();}
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
    updateEntry({ ...state.readerEntry, published_slug: published?.slug || null, published_title: published?.title || null });
    if (!state.readerEditing) renderReader();
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
$('#logout').addEventListener('click', async () => {
  if (state.posting) return;
  try {
    if(!await photos.finish())return;
    if(!await dictation.stop())return;
    if(state.readerEntry?.is_draft && (state.readerDirty || state.readerSaving))await saveReader();
    await saveDraft();
    if (state.publicDirty) await savePublication();
    if (state.dirty) { notice('copy or post your unsaved draft before locking.'); return; }
    await api('logout', { method: 'POST', body: '{}' });
    state.entries.clear(); state.selected = null; state.publication = null; state.publicationId = null; state.publicDirty = false; state.pendingPost = null;
    $('#feed').replaceChildren();
    for (const area of document.querySelectorAll('textarea')) area.value = '';
    composerEditor?.setValue('');
    state.tag=null;
    ideaLists.clear();
    readingView.clear();
    for (const input of document.querySelectorAll('.title-input')) input.value = '';
    showLogin();
  } catch (error) { notice(error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { dictation.cancel(); if (state.dirty) saveDraft().catch(() => {});if(state.readerEntry?.is_draft && state.readerDirty)saveReader({autosave:true}).catch(error=>{$('#reader-error').textContent=error.message;}); } });
window.addEventListener('pagehide', () => dictation.cancel());
window.addEventListener('beforeunload', event => {
  if (dictation.owner || photos.busy || state.dirty || state.saving || state.posting || state.publicDirty || state.publicBusy || state.readerDirty || state.readerSaving) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

try { setTimelineHidden(localStorage.getItem('journal.timelineHidden') === 'true'); } catch {}

try {
  const session = await api('session');
  if (session.authenticated) await enter();
  else { showLogin(session.ready ? '' : 'the journal is unavailable. try again later.'); $('#unlock').disabled = !session.ready; }
} catch (error) { showLogin(error.message); $('#unlock').disabled = true; }
