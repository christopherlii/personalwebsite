import { searchTerms } from './search-terms.js';

const $ = selector => document.querySelector(selector);
const state = { authenticated: false, view: 'all', query: '', cursor: null, entries: new Map(), generation: 0, controller: null, draft: { version: 0 }, dirty: false, saving: null, conflict: false, posting: false, pendingPost: null, selected: null, draftTimer: null, searchTimer: null, relatedTimer: null, expanded: new Set(), observers: [], semanticAvailable: false, semantic: false };

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function draftStatus(message) { $('#draft-status').textContent = message; }
function showLogin(message = '') {
  state.authenticated = false;
  state.generation++;
  state.controller?.abort();
  clearTimeout(state.draftTimer);
  clearTimeout(state.searchTimer);
  clearTimeout(state.relatedTimer);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#boot-status').hidden = true;
  $('#login-message').textContent = message;
  $('#password').focus();
}

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
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
  $('#app').hidden = false;
  $('#boot-status').hidden = true;
  $('#password').value = '';
  draftStatus(state.conflict ? 'unsaved text restored. copy your text or post it.' : hasDraft(draft) ? 'draft saved' : '');
  updateComposer();
  await searchFromComposer(true);
}

function button(label, action, entry) {
  const result = document.createElement('button');
  result.type = 'button'; result.textContent = label;
  result.dataset.action = action; result.dataset.id = entry.id;
  return result;
}

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
  const time = document.createElement('time'); time.dateTime = entry.created_at;
  const date = new Date(entry.created_at);
  time.title = date.toLocaleString();
  const day = document.createElement('span'); day.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
  const clock = document.createElement('span'); clock.textContent = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  time.append(day, clock);
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
  const expand = button(state.expanded.has(entry.id) ? 'close' : 'open', 'expand', entry);
  expand.className = 'expand-thought'; expand.hidden = !state.expanded.has(entry.id);
  expand.setAttribute('aria-expanded', String(state.expanded.has(entry.id)));
  expand.setAttribute('aria-controls', text.id); footer.append(expand);
  const actions = document.createElement('div'); actions.className = 'thought-actions';
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'more'; summary.setAttribute('aria-label', 'more actions for thought');
  const menu = document.createElement('div'); menu.className = 'entry-menu';
  const bookmark = button(entry.bookmarked ? 'bookmarked' : 'bookmark', 'bookmark', entry);
  bookmark.setAttribute('aria-pressed', String(Boolean(entry.bookmarked)));
  menu.append(bookmark, button('edit', 'edit', entry), button('copy', 'copy', entry), button('public draft', 'public', entry), button('delete', 'delete', entry));
  details.append(summary, menu); actions.append(details); footer.append(actions); article.append(footer);
  const observer = new ResizeObserver(() => { expand.hidden = !state.expanded.has(entry.id) && text.scrollHeight <= text.clientHeight + 2; });
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
  clearTimeout(state.relatedTimer);
  state.query = entryText({ title: $('#title').value.trim(), body: $('#body').value.trim() }).trim();
  state.semantic = false;
  state.controller?.abort();
  state.generation++;
  updateView();
  if (!state.authenticated || (state.posting && !immediate)) return;
  notice();
  if (!state.query || immediate) return loadFeed(false, Boolean(state.query && state.semanticAvailable));
  // Word matches arrive first; semantic recall runs only after a typing pause.
  state.searchTimer = setTimeout(() => loadFeed(false, false), 150);
  if (state.semanticAvailable) state.relatedTimer = setTimeout(() => loadFeed(false, true), 750);
}

async function loadFeed(append = false, semantic = state.semantic) {
  state.semantic = Boolean(semantic && state.query && state.semanticAvailable);
  state.controller?.abort();
  const controller = new AbortController(); state.controller = controller;
  const generation = ++state.generation;
  if (!append) state.cursor = null;
  const queryText = state.query;
  const saved = state.view === 'saved';
  let cursor = state.cursor || 0;
  updateView();
  $('#feed').setAttribute('aria-busy', 'true'); $('#feed-status').textContent = 'loading…'; $('#more').hidden = true;
  const search = semanticMode => api('search', {
    method: 'POST', body: JSON.stringify({ query: queryText, saved, cursor, semantic: semanticMode }), signal: controller.signal
  });
  try {
    let data;
    if (queryText && state.semantic) {
      try {
        do { data = await search(true); } while (data.indexing && generation === state.generation);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (generation !== state.generation) return;
        state.semantic = false; append = false; cursor = 0;
        notice('showing matching words. related search is unavailable.');
        data = await search(false);
      }
    } else if (queryText) data = await search(false);
    else {
      const params = new URLSearchParams();
      if (saved) params.set('saved', '1');
      if (state.cursor !== null) params.set('cursor', state.cursor);
      data = await api(`thoughts?${params}`, { signal: controller.signal });
    }
    if (generation !== state.generation || !state.authenticated) return;
    if (!append) {
      state.observers.forEach(observer => observer.disconnect()); state.observers = [];
      state.entries.clear(); $('#feed').replaceChildren();
    }
    for (const entry of data.entries) {
      if (state.entries.has(entry.id)) continue;
      state.entries.set(entry.id, entry); $('#feed').append(renderEntry(entry));
    }
    state.cursor = data.next;
    $('#more').hidden = data.next === null;
    $('#feed-status').textContent = !state.entries.size ? state.query ? 'no thoughts found.' : state.view === 'saved' ? 'no bookmarks yet.' : 'your first thought goes here.' : '';
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
  $('#journal-menu').open = false;
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
  clearTimeout(state.searchTimer); clearTimeout(state.relatedTimer); state.controller?.abort(); state.generation++;
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
$('#more').addEventListener('click', () => { $('#more').textContent = 'load more'; loadFeed(state.entries.size > 0 && state.cursor !== null); });
document.addEventListener('keydown', event => {
  if (state.authenticated && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#body').focus(); }
});
for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', () => setView(item.dataset.view));
for (const item of document.querySelectorAll('[data-close]')) item.addEventListener('click', () => $(`#${item.dataset.close}`).close());

$('#feed').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const entry = state.entries.get(target.dataset.id);
  if (!entry) return;
  document.querySelectorAll('details[open]').forEach(details => details.open = false);
  const action = target.dataset.action;
  state.selected = entry;
  try {
    if (action === 'expand') {
      if (state.expanded.has(entry.id)) state.expanded.delete(entry.id); else state.expanded.add(entry.id);
      target.closest('article').replaceWith(renderEntry(entry));
    } else if (action === 'bookmark') {
      target.disabled = true;
      const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ bookmarked: !entry.bookmarked }) });
      state.entries.set(entry.id, { ...entry, ...data.entry });
      if (state.view === 'saved' && !data.entry.bookmarked) await loadFeed();
      else target.closest('article').replaceWith(renderEntry({ ...entry, ...data.entry }));
    } else if (action === 'copy') { await navigator.clipboard.writeText(entryText(entry)); notice('copied.'); }
    else if (action === 'edit') { $('#edit-thought-title').value = entry.title || ''; $('#edit-body').value = entry.body; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); }
    else if (action === 'delete') { $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }
    else if (action === 'public') { $('#public-thought-title').value = entry.title || ''; $('#public-body').value = entry.body; $('#public-status').textContent = ''; $('#public-dialog').showModal(); }
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
$('#copy-public').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(entryText({ title: $('#public-thought-title').value, body: $('#public-body').value })); $('#public-status').textContent = 'copied.'; }
  catch { $('#public-status').textContent = 'select the text to copy it.'; }
});
$('#download-public').addEventListener('click', () => {
  const date = new Date().toISOString().slice(0, 10);
  download(`thought-${date}.md`, `---\ntitle: ${JSON.stringify($('#public-thought-title').value.trim() || 'Untitled')}\ndate: "${date}"\npublished: false\n---\n\n${$('#public-body').value}\n`, 'text/markdown');
  $('#public-status').textContent = 'downloaded.';
});
$('#export').addEventListener('click', async () => {
  try { await saveDraft(); const data = await api('export'); download(`journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json'); }
  catch (error) { notice(error.message); }
});
$('#logout').addEventListener('click', async () => {
  if (state.posting) return;
  try {
    await saveDraft();
    if (state.dirty) { notice('copy or post your unsaved draft before locking.'); return; }
    await api('logout', { method: 'POST', body: '{}' });
    state.entries.clear(); state.selected = null; state.pendingPost = null;
    $('#feed').replaceChildren();
    for (const area of document.querySelectorAll('textarea')) area.value = '';
    for (const input of document.querySelectorAll('.title-input')) input.value = '';
    $('#composer-title').hidden = true;
    showLogin();
  } catch (error) { notice(error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.dirty) saveDraft().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (state.dirty || state.saving || state.posting) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

try {
  const session = await api('session');
  if (session.authenticated) await enter();
  else { showLogin(session.ready ? '' : 'the journal is unavailable. try again later.'); $('#unlock').disabled = !session.ready; }
} catch (error) { showLogin(error.message); $('#unlock').disabled = true; }
