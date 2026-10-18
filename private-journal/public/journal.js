import { searchTerms } from './search-terms.js';

const $ = selector => document.querySelector(selector);
const state = { authenticated: false, view: 'all', query: '', cursor: null, entries: new Map(), generation: 0, controller: null, draft: { version: 0 }, dirty: false, saving: null, conflict: false, posting: false, pendingPost: null, selected: null, publication: null, publicationId: null, publicDirty: false, publicBusy: false, draftTimer: null, searchTimer: null, expanded: new Set(), observers: [], semanticAvailable: false, semantic: false, timelineHidden: false, readerGeneration: 0, feedScroll: 0 };

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
  state.authenticated = false;
  state.generation++;
  state.controller?.abort();
  clearTimeout(state.draftTimer);
  clearTimeout(state.searchTimer);
  state.readerGeneration++;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#app').hidden = true;
  $('#reader').hidden = true;
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
  $('#app').hidden = Boolean(readerId());
  $('#boot-status').hidden = true;
  $('#password').value = '';
  draftStatus(state.conflict ? 'unsaved text restored. copy your text or post it.' : hasDraft(draft) ? 'draft saved' : '');
  updateComposer();
  if (readerId()) await showRoute();
  else await searchFromComposer(true);
  if (state.publicDirty && state.publicationId) { $('#public-dialog').showModal(); $('#public-status').textContent = 'unsaved text restored'; }
}

function button(label, action, entry) {
  const result = document.createElement('button');
  result.type = 'button'; result.textContent = label;
  result.dataset.action = action; result.dataset.id = entry.id;
  return result;
}

const icons = {
  copy: '<rect x="8" y="8" width="12" height="13"/><path d="M16 8V3H3v13h5"/>',
  copied: '<path d="m4 12 5 5L20 6"/>',
  open: '<path d="m5 9 7 7 7-7"/>',
  close: '<path d="m5 15 7-7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  read: '<path d="M14 3h7v7M21 3l-8 8M10 21H3v-7M3 21l8-8"/>'
};
function setIcon(control, icon, label) {
  control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>`;
  control.setAttribute('aria-label', label); control.title = label;
  control.classList.add('icon-control');
}
setIcon($('#public-menu-toggle'), 'more', 'public draft options');

function readerId() { return location.hash.match(/^#thought\/([a-f0-9-]{36})$/)?.[1]; }
async function showRoute() {
  if (!state.authenticated) return;
  const generation = ++state.readerGeneration;
  const id = readerId();
  if (!id) {
    const wasReading = !$('#reader').hidden;
    $('#reader').hidden = true; $('#reader-content').replaceChildren();
    $('#app').hidden = false; document.title = 'journal';
    if (!state.entries.size && !state.timelineHidden) await searchFromComposer(true);
    if (wasReading) window.scrollTo(0, state.feedScroll);
    return;
  }
  try {
    const { entry } = await api(`thoughts/${id}`);
    if (generation !== state.readerGeneration || !state.authenticated) return;
    const content = $('#reader-content'); content.replaceChildren();
    if (entry.title) {
      const title = document.createElement('h1'); title.className = 'thought-title'; title.textContent = entry.title; content.append(title);
    }
    const body = document.createElement('p'); body.className = 'thought-body'; body.append(bodyContent(entry.body, '')); content.append(body);
    $('#reader-error').textContent = '';
    document.title = 'journal';
  } catch (error) {
    if (generation !== state.readerGeneration || !state.authenticated) return;
    $('#reader-content').replaceChildren(); $('#reader-error').textContent = error.message;
  }
  if (!$('#app').hidden) state.feedScroll = window.scrollY;
  closeMenus(); $('#app').hidden = true; $('#reader').hidden = false;
  window.scrollTo(0, 0); $('#reader-content').focus({ preventScroll: true });
}
window.addEventListener('hashchange', showRoute);

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
  // No markdown/HTML interpretation: private text is always textContent.
  const links = /https?:\/\/[^\s<>]+/gu;
  let end = 0;
  for (const match of body.matchAll(links)) {
    appendText(body.slice(end, match.index));
    const a = document.createElement('a');
    a.textContent = match[0]; a.href = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    fragment.append(a); end = match.index + match[0].length;
  }
  appendText(body.slice(end));
  return fragment;
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
  header.append(time);
  if (entry.updated_at !== entry.created_at) { const edited = document.createElement('span'); edited.textContent = 'edited'; header.append(edited); }
  article.append(header);
  if (entry.title) {
    const title = document.createElement('h2'); title.className = 'thought-title';
    title.append(bodyContent(entry.title, state.query)); article.append(title);
  }
  const text = document.createElement('p'); text.className = 'thought-body';
  text.id = `thought-${entry.id}`;
  text.classList.toggle('collapsed', !state.expanded.has(entry.id));
  text.append(bodyContent(entry.body, state.query)); article.append(text);
  const footer = document.createElement('div'); footer.className = 'entry-footer';
  const copy = button('', 'copy', entry); setIcon(copy, 'copy', 'copy thought'); footer.append(copy);
  const expand = button(state.expanded.has(entry.id) ? 'close' : 'open', 'expand', entry);
  expand.className = 'expand-thought'; expand.hidden = !state.expanded.has(entry.id);
  setIcon(expand, state.expanded.has(entry.id) ? 'close' : 'open', state.expanded.has(entry.id) ? 'collapse thought' : 'open thought inline');
  expand.setAttribute('aria-expanded', String(state.expanded.has(entry.id)));
  expand.setAttribute('aria-controls', text.id); footer.append(expand);
  const read = document.createElement('a'); read.href = `#thought/${entry.id}`; read.dataset.action = 'read'; setIcon(read, 'read', 'expand to reading page'); footer.append(read);
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'thought-actions'; toggle.dataset.menu = ''; setIcon(toggle, 'more', 'more actions for thought');
  toggle.setAttribute('aria-label', 'more actions for thought'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `entry-menu-${entry.id}`);
  const menu = document.createElement('nav'); menu.className = 'entry-menu thought-menu'; menu.id = `entry-menu-${entry.id}`; menu.hidden = true; menu.setAttribute('aria-label', 'thought actions');
  const bookmark = button(entry.bookmarked ? 'bookmarked' : 'bookmark', 'bookmark', entry);
  bookmark.setAttribute('aria-pressed', String(Boolean(entry.bookmarked)));
  menu.append(bookmark, button('edit', 'edit', entry), button('public draft', 'public', entry), button('delete', 'delete', entry));
  footer.append(toggle); article.append(footer, menu);
  article.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'mouse') return;
    menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
  });
  const observer = new ResizeObserver(() => {
    if (text.getClientRects().length) expand.hidden = !state.expanded.has(entry.id) && text.scrollHeight <= text.clientHeight + 2;
  });
  observer.observe(text); state.observers.push(observer);

  return article;
}

function updateView() {
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === state.view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#view-title').textContent = state.view === 'saved' ? 'bookmarks' : 'thoughts';
  $('#view-title').classList.toggle('sr-only', state.view === 'all' || Boolean(state.query));
}

function searchFromComposer(immediate = false) {
  clearTimeout(state.searchTimer);
  state.query = entryText({ title: $('#title').value.trim(), body: $('#body').value.trim() }).trim();
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
    if (queryText && semanticMode) {
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
      state.observers.forEach(observer => observer.disconnect()); state.observers = [];
      state.entries.clear();
      const fragment = document.createDocumentFragment();
      for (const entry of data.entries) { state.entries.set(entry.id, entry); fragment.append(renderEntry(entry)); }
      $('#feed').replaceChildren(fragment);
    } else for (const entry of data.entries) {
      if (state.entries.has(entry.id)) continue;
      state.entries.set(entry.id, entry); $('#feed').append(renderEntry(entry));
    }
    state.semantic = semanticMode;
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
  else if (event.target.id === 'title' && event.key === 'Enter') { event.preventDefault(); $('#body').focus(); }
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
  $('#body').value = ''; $('#title').value = ''; $('#composer-title').hidden = true; changedDraft(); $('#body').focus();
});
$('#more').addEventListener('click', () => { if ($('#feed').getAttribute('aria-busy') !== 'true') loadFeed(state.entries.size > 0 && state.cursor !== null); });
$('#toggle-timeline').addEventListener('click', () => {
  state.timelineHidden = !state.timelineHidden;
  $('#timeline').hidden = state.timelineHidden;
  $('#toggle-timeline').textContent = state.timelineHidden ? 'show timeline' : 'hide timeline';
  $('#toggle-timeline').setAttribute('aria-expanded', String(!state.timelineHidden));
  searchFromComposer(true);
});
document.addEventListener('keydown', event => {
  if (state.authenticated && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#body').focus(); }
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
    if (action === 'expand') {
      const focused = document.activeElement === target;
      if (state.expanded.has(entry.id)) state.expanded.delete(entry.id); else state.expanded.add(entry.id);
      const replacement = renderEntry(entry);
      target.closest('article').replaceWith(replacement);
      if (focused) {
        const control = replacement.querySelector('[data-action=expand]');
        control.hidden = false;
        replacement.focus({ preventScroll: true });
        control.focus({ preventScroll: true });
      }
    } else if (action === 'bookmark') {
      target.disabled = true;
      const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ bookmarked: !entry.bookmarked }) });
      state.entries.set(entry.id, { ...entry, ...data.entry });
      if (state.view === 'saved' && !data.entry.bookmarked) await loadFeed();
      else target.closest('article').replaceWith(renderEntry({ ...entry, ...data.entry }));
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(entryText(entry));
      setIcon(target, 'copied', 'thought copied');
      setTimeout(() => { setIcon(target, 'copy', 'copy thought'); }, 1200);
    } else if (action === 'edit') { $('#edit-thought-title').value = entry.title || ''; $('#edit-body').value = entry.body; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); }
    else if (action === 'delete') { $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }
    else if (action === 'public') { await openPublication(entry); }
  } catch (error) { target.disabled = false; notice(error.message); }
});

$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    await api(`thoughts/${state.selected.id}`, { method: 'PATCH', body: JSON.stringify({ title: $('#edit-thought-title').value, body: $('#edit-body').value, updated_at: state.selected.updated_at }) });
    $('#edit-dialog').close(); await loadFeed();
  } catch (error) { $('#edit-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try {
    await api(`thoughts/${state.selected.id}`, { method: 'DELETE' });
    $('#delete-dialog').close(); await loadFeed();
  } catch (error) { $('#delete-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
function publicInput() {
  const tags = $('#public-tags').value;
  return {
    slug: $('#public-slug').value, title: $('#public-thought-title').value, body: $('#public-body').value,
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
}
function publicBusy(value) {
  state.publicBusy = value;
  for (const control of $('#public-dialog').querySelectorAll('input,textarea,button')) control.disabled = value;
}
async function openPublication(entry) {
  const data = await api(`thoughts/${entry.id}/publication`);
  if (state.selected?.id !== entry.id) return;
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
    for (const input of document.querySelectorAll('.title-input')) input.value = '';
    $('#composer-title').hidden = true;
    showLogin();
  } catch (error) { notice(error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.dirty) saveDraft().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (state.dirty || state.saving || state.posting || state.publicDirty || state.publicBusy) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

try {
  const session = await api('session');
  if (session.authenticated) await enter();
  else { showLogin(session.ready ? '' : 'the journal is unavailable. try again later.'); $('#unlock').disabled = !session.ready; }
} catch (error) { showLogin(error.message); $('#unlock').disabled = true; }
