const $ = selector => document.querySelector(selector);
const state = { authenticated: false, view: 'all', query: '', parent: null, cursor: null, entries: new Map(), generation: 0, controller: null, draft: { version: 0, reply_to: null }, dirty: false, saving: null, conflict: false, posting: false, pendingPost: null, selected: null, draftTimer: null, searchTimer: null, expanded: new Set(), observers: [], semanticAvailable: false, semantic: false };

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function draftStatus(message) { $('#draft-status').textContent = message; }
function showLogin(message = '') {
  state.authenticated = false;
  state.generation++;
  state.controller?.abort();
  clearTimeout(state.draftTimer);
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

function updateReply() {
  $('#reply-context').hidden = !state.draft.reply_to;
  const entry = state.entries.get(state.draft.reply_to);
  $('#reply-label').textContent = entry ? `replying to: ${entry.body.replace(/\s+/g, ' ').slice(0, 95)}` : 'continuing a thought';
}

function updateComposer() {
  $('#post').disabled = !$('#body').value.trim() || state.posting;
  $('#compose-actions').hidden = !$('#body').value && !state.dirty;
}

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
      const reply_to = state.draft.reply_to;
      state.dirty = false;
      draftStatus('saving…');
      $('#retry-draft').hidden = true;
      try {
        const draft = await api('draft', { method: 'PUT', body: JSON.stringify({ body, reply_to, version: state.draft.version }) });
        state.draft.version = draft.version;
        draftStatus(state.dirty ? 'unsaved' : body ? 'draft saved' : '');
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
  finally { state.saving = null; }
}

function changedDraft() {
  state.dirty = true;
  updateComposer();
  draftStatus(state.conflict ? 'draft changed elsewhere. copy your text or post it.' : 'unsaved');
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => saveDraft().catch(() => {}), 650);
}

async function enter() {
  const unsaved = state.dirty ? { body: $('#body').value, reply_to: state.draft.reply_to } : null;
  const session = await api('session');
  state.semanticAvailable = Boolean(session.semanticSearch);
  const draft = await api('draft');
  state.draft = draft;
  state.conflict = Boolean(unsaved && (draft.body !== unsaved.body || draft.reply_to !== unsaved.reply_to));
  state.dirty = state.conflict;
  $('#body').value = unsaved?.body ?? draft.body;
  if (unsaved) state.draft.reply_to = unsaved.reply_to;
  state.authenticated = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#boot-status').hidden = true;
  $('#password').value = '';
  draftStatus(state.conflict ? 'unsaved text restored. copy your text or post it.' : draft.body ? 'draft saved' : '');
  updateReply(); updateComposer();
  await loadFeed();
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
  const matches = (query?.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 20).map(fold).filter(Boolean);
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
  time.textContent = new Date(entry.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const permalink = button(time.textContent, 'thread', entry); permalink.replaceChildren(time); header.append(permalink);
  if (entry.updated_at !== entry.created_at) { const edited = document.createElement('span'); edited.textContent = '· edited'; header.append(edited); }
  article.append(header);
  if (entry.parent_body && entry.reply_to !== state.parent) {
    const parent = button(entry.parent_body.replace(/\s+/g, ' ').slice(0, 120), 'parent', entry); parent.className = 'parent-preview'; article.append(parent);
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
  if (entry.replies) { const thread = button(`${entry.replies} ${entry.replies === 1 ? 'reply' : 'replies'}`, 'thread', entry); thread.className = 'thread-link'; footer.append(thread); }
  const actions = document.createElement('div'); actions.className = 'thought-actions';
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'more'; summary.setAttribute('aria-label', 'more actions for thought');
  const menu = document.createElement('div'); menu.className = 'entry-menu';
  const bookmark = button(entry.bookmarked ? 'bookmarked' : 'bookmark', 'bookmark', entry);
  bookmark.setAttribute('aria-pressed', String(Boolean(entry.bookmarked)));
  menu.append(button('reply', 'reply', entry), bookmark, button('edit', 'edit', entry), button('copy', 'copy', entry), button('public draft', 'public', entry), button('delete', 'delete', entry));
  details.append(summary, menu); actions.append(details); footer.append(actions); article.append(footer);
  const observer = new ResizeObserver(() => { expand.hidden = !state.expanded.has(entry.id) && text.scrollHeight <= text.clientHeight + 2; });
  observer.observe(text); state.observers.push(observer);

  return article;
}

function updateView() {
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === state.view && !state.parent) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#view-title').textContent = state.parent ? 'thread' : state.query ? 'search' : state.view === 'saved' ? 'bookmarks' : 'thoughts';
  $('#back').hidden = !state.parent;
  $('#view-title').classList.toggle('sr-only', !state.parent && state.view === 'all' && !state.query);
  $('#clear-search').hidden = !state.query;
}

async function loadFeed(append = false, semantic = state.semantic) {
  state.semantic = Boolean(semantic && state.query && state.semanticAvailable);
  state.controller?.abort();
  const controller = new AbortController(); state.controller = controller;
  const generation = ++state.generation;
  if (!append) { state.observers.forEach(observer => observer.disconnect()); state.observers = []; state.cursor = null; state.entries.clear(); $('#feed').replaceChildren(); }
  updateView();
  $('#feed').setAttribute('aria-busy', 'true'); $('#feed-status').textContent = 'loading…'; $('#more').hidden = true;
  const query = new URLSearchParams();
  if (state.query) query.set('q', state.query);
  if (state.view === 'saved' && !state.parent) query.set('saved', '1');
  if (state.parent) query.set('parent', state.parent);
  if (state.cursor !== null) query.set('cursor', state.cursor);
  try {
    let data;
    if (state.semantic) {
      try {
        do {
          data = await api('search', { method: 'POST', body: JSON.stringify({ query: state.query, saved: state.view === 'saved', cursor: state.cursor || 0 }), signal: controller.signal });
        } while (data.indexing && generation === state.generation);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        state.semantic = false;
        notice('showing matching words. related search is unavailable.');
        data = await api(`thoughts?${query}`, { signal: controller.signal });
      }
    } else data = await api(`thoughts?${query}`, { signal: controller.signal });
    if (generation !== state.generation || !state.authenticated) return;
    for (const entry of data.entries) {
      if (state.entries.has(entry.id)) continue;
      state.entries.set(entry.id, entry); $('#feed').append(renderEntry(entry));
    }
    state.cursor = data.next;
    $('#more').hidden = data.next === null;
    $('#feed-status').textContent = !state.entries.size ? state.query ? 'no thoughts found.' : state.view === 'saved' ? 'no bookmarks yet.' : 'your first thought goes here.' : '';
    updateReply();
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
  state.view = view; state.parent = null; state.query = ''; $('#search').value = ''; notice();
  await loadFeed();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#unlock').disabled = true; $('#login-message').textContent = 'unlocking…';
  try { await api('login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); await enter(); }
  catch (error) { $('#login-message').textContent = error.message; }
  finally { $('#unlock').disabled = false; }
});
$('#body').addEventListener('input', changedDraft);
$('#retry-draft').addEventListener('click', () => saveDraft().catch(() => {}));
$('#body').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('#post').disabled) { event.preventDefault(); $('#composer').requestSubmit(); }
});
$('#cancel-reply').addEventListener('click', () => { state.draft.reply_to = null; updateReply(); changedDraft(); });
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.posting || !$('#body').value.trim()) return;
  state.posting = true; $('#body').disabled = true; $('#cancel-reply').disabled = true; updateComposer(); notice();
  try {
    // If autosave failed, posting still saves the thought. A conflict cannot
    // clear the other device's draft because the version is checked in SQL.
    await saveDraft().catch(() => {});
    const body = $('#body').value;
    const reply_to = state.draft.reply_to;
    if (!state.pendingPost || state.pendingPost.body !== body || state.pendingPost.reply_to !== reply_to) state.pendingPost = { id: crypto.randomUUID(), body, reply_to };
    const data = await api('thoughts', { method: 'POST', body: JSON.stringify({ ...state.pendingPost, draft_version: state.draft.version }) });
    state.pendingPost = null; state.dirty = false; state.conflict = false; state.draft = data.draft;
    $('#body').value = data.draft.body; updateReply(); draftStatus(data.draft.body ? 'draft saved' : '');
    if (!state.parent) await setView('all'); else await loadFeed();
  } catch (error) { notice(error.message); }
  finally { state.posting = false; $('#body').disabled = false; $('#cancel-reply').disabled = false; updateComposer(); }
});
$('#search').addEventListener('input', () => {
  state.semantic = false; clearTimeout(state.searchTimer); state.query = $('#search').value.trim(); state.parent = null;
  state.controller?.abort(); state.generation++; updateView();
  state.searchTimer = setTimeout(() => { notice(); loadFeed(); }, 150);
});
$('#search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(state.searchTimer); notice(); loadFeed(false, true); });
$('#clear-search').addEventListener('click', () => { state.query = ''; $('#search').value = ''; loadFeed(); $('#search').focus(); });
$('#more').addEventListener('click', () => { $('#more').textContent = 'load more'; loadFeed(state.entries.size > 0 && state.cursor !== null); });
$('#back').addEventListener('click', () => setView(state.view));
$('#search-toggle').addEventListener('click', () => {
  const open = $('#search-form').hidden; $('#search-form').hidden = !open; $('#search-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#search').focus();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-form').hidden = false; $('#search-toggle').setAttribute('aria-expanded', 'true'); $('#search').focus(); }
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
    } else if (action === 'reply') {
      if (state.posting) return;
      if (state.draft.reply_to && state.draft.reply_to !== entry.id && $('#body').value.trim()) { notice('finish your current reply before starting another.'); return; }
      state.draft.reply_to = entry.id; updateReply(); changedDraft(); $('#body').scrollIntoView({ block: 'center' }); $('#body').focus();
    } else if (action === 'thread' || action === 'parent') {
      state.parent = action === 'parent' ? entry.reply_to : entry.id;
      state.query = ''; $('#search').value = ''; notice(); await loadFeed();
    } else if (action === 'bookmark') {
      target.disabled = true;
      const data = await api(`thoughts/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ bookmarked: !entry.bookmarked }) });
      state.entries.set(entry.id, { ...entry, ...data.entry });
      if (state.view === 'saved' && !data.entry.bookmarked) await loadFeed();
      else target.closest('article').replaceWith(renderEntry({ ...entry, ...data.entry }));
    } else if (action === 'copy') { await navigator.clipboard.writeText(entry.body); notice('copied.'); }
    else if (action === 'edit') { $('#edit-body').value = entry.body; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); }
    else if (action === 'delete') { $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }
    else if (action === 'public') { $('#public-body').value = entry.body; $('#public-status').textContent = ''; $('#public-dialog').showModal(); }
  } catch (error) { target.disabled = false; notice(error.message); }
});

$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    await api(`thoughts/${state.selected.id}`, { method: 'PATCH', body: JSON.stringify({ body: $('#edit-body').value, updated_at: state.selected.updated_at }) });
    $('#edit-dialog').close(); await loadFeed();
  } catch (error) { $('#edit-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try {
    await api(`thoughts/${state.selected.id}`, { method: 'DELETE' });
    if (state.draft.reply_to === state.selected.id) { state.draft.reply_to = null; updateReply(); changedDraft(); }
    if (state.parent === state.selected.id) state.parent = null;
    $('#delete-dialog').close(); await loadFeed();
  } catch (error) { $('#delete-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#copy-public').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#public-body').value); $('#public-status').textContent = 'copied.'; }
  catch { $('#public-status').textContent = 'select the text to copy it.'; }
});
$('#download-public').addEventListener('click', () => {
  const date = new Date().toISOString().slice(0, 10);
  download(`thought-${date}.md`, `---\ntitle: "Untitled"\ndate: "${date}"\npublished: false\n---\n\n${$('#public-body').value}\n`, 'text/markdown');
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
