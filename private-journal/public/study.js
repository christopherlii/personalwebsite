// Reading a PDF closely: everything else goes away but the pages. Select a
// passage to leave a note beside it, or to have it explained.
import { markdown } from './markdown.js';

const $ = selector => document.querySelector(selector);
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
export const MAXIMUM_BYTES = 20 * 1024 * 1024;
const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const squash = text => text.replace(/\s+/g, '');
const narrow = matchMedia('(max-width: 1000px)');

// PDF.js is large, so it loads the first time a PDF is opened or added.
let library = null;
function pdfjs() {
  library ??= import('./vendor/pdf.min.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
    return module;
  }).catch(error => { library = null; throw error; });
  return library;
}
const options = data => ({ data, isEvalSupported: false, useWasm: false, enableXfa: false,
  standardFontDataUrl: new URL('./vendor/standard_fonts/', location.href).href });

// A PDF's own title is often a leftover like "Microsoft Word - draft3.docx";
// the file name is used unless the title looks like a real one.
function titleFor(info, filename) {
  const own = (info?.Title || '').replace(/^Microsoft Word - /i, '').replace(/\s+/g, ' ').trim();
  const name = filename.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'untitled pdf';
  return (own.length > 3 && !/\.(docx?|pdf|tex|indd|pages)$/i.test(own) && !/^untitled/i.test(own) ? own : name).slice(0, 160);
}

export function createStudy({ api, onBack }) {
  let pdf = null, current = null, pages = [], notes = [], generation = 0, observer = null, resizer = null;
  let pending = null, editing = null, saveTimer = null, shownPage = 0;
  const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  async function upload(file) {
    if (!isPdf(file)) throw new Error('Drop a PDF.');
    if (file.size > MAXIMUM_BYTES) throw new Error('This PDF is too large. PDFs can be up to 20 MB.');
    const data = new Uint8Array(await file.arrayBuffer());
    const library = await pdfjs();
    let pages, title;
    try {
      // PDF.js takes ownership of the bytes it is given, so it gets a copy.
      const opened = await library.getDocument(options(data.slice())).promise;
      pages = opened.numPages;
      title = titleFor((await opened.getMetadata().catch(() => null))?.info, file.name);
      await opened.loadingTask.destroy();
    } catch (error) { throw new Error(error?.name === 'PasswordException' ? 'This PDF is locked with a password.' : 'This PDF could not be opened.'); }
    const { document } = await api(`documents/${crypto.randomUUID()}?${new URLSearchParams({ title, pages })}`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/pdf' } });
    return document;
  }

  // ---- the text of a page, for finding passages again --------------------
  // Offsets count only the text-layer characters (what Range.toString gives),
  // so they come out the same however the selection's ends land.
  function textIndex(layer) {
    const nodes = []; let raw = 0, readable = '';
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let item = walker.nextNode(); item; item = walker.nextNode()) {
      if (item.nodeType === Node.TEXT_NODE) { nodes.push({ node: item, raw, readable: readable.length }); raw += item.data.length; readable += item.data; }
      else if (item.nodeName === 'BR') readable += '\n';
    }
    return { nodes, readable };
  }
  function rangeAt(entry, start, length) {
    if (!entry.index) return null;
    const range = document.createRange(); let started = false;
    for (const { node: text, raw } of entry.index.nodes) {
      const end = raw + text.data.length;
      if (!started && start < end) { range.setStart(text, start - raw); started = true; }
      if (started && start + length <= end) { range.setEnd(text, start + length - raw); return range; }
    }
    return null;
  }
  // A passage is shown only where the text still matches what was quoted.
  function passage(note) {
    const entry = pages[note.page - 1], range = entry && rangeAt(entry, note.start, note.length);
    return range && squash(range.toString()) === squash(note.quote) ? range : null;
  }
  function paint() {
    if (!highlights) return;
    for (const kind of ['note', 'ai']) CSS.highlights.set(`study-${kind}`, new Highlight(...notes.filter(note => note.kind === kind).map(passage).filter(Boolean)));
  }
  function activate(range) {
    if (!highlights) return;
    if (range) CSS.highlights.set('study-active', new Highlight(range)); else CSS.highlights.delete('study-active');
  }

  // ---- pages -------------------------------------------------------------
  async function render(entry) {
    if (entry.rendering || entry.canvas) return;
    entry.rendering = true;
    const library = await pdfjs(), opened = pdf;
    try {
      const page = await opened.getPage(entry.number);
      if (opened !== pdf) return;
      const base = page.getViewport({ scale: 1 });
      entry.width = base.width;
      entry.sheet.style.aspectRatio = `${base.width} / ${base.height}`;
      const scale = entry.sheet.clientWidth / base.width, viewport = page.getViewport({ scale });
      entry.sheet.style.setProperty('--total-scale-factor', String(scale));
      const ratio = Math.min(window.devicePixelRatio || 1, 2), canvas = node('canvas');
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      // The page is drawn on the journal's own paper colour; only its outline marks the edge.
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fafafa';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: paper, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
      if (opened !== pdf) return;
      entry.sheet.prepend(canvas); entry.canvas = canvas;
      if (!entry.index) {
        const layer = node('div', 'textLayer');
        await new library.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
        if (opened !== pdf) return;
        // As in PDF.js's viewer: while selecting, an end block fills the page so
        // dragging across a gap between lines doesn't jump to the page's end.
        const end = node('div', 'endOfContent'); layer.append(end);
        layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
        entry.sheet.append(layer); entry.layer = layer; entry.index = textIndex(layer);
        paint();
      }
      position(entry);
      // It may have scrolled far away while drawing.
      if (!entry.near) release(entry);
    } catch (error) {
      if (opened === pdf && error?.name !== 'RenderingCancelledException') entry.sheet.dataset.failed = 'true';
    } finally { entry.rendering = false; }
  }
  // Canvases far from view are dropped to save memory; the text stays.
  function release(entry) { entry.canvas?.remove(); entry.canvas = null; }

  function build(count, ratio) {
    const fragment = document.createDocumentFragment();
    pages = Array.from({ length: count }, (_, index) => {
      const section = node('section', 'study-page'); section.dataset.page = String(index + 1);
      section.setAttribute('aria-label', `page ${index + 1}`);
      const sheet = node('div', 'study-sheet'); sheet.style.aspectRatio = ratio;
      const margin = node('aside', 'study-notes'); margin.setAttribute('aria-label', `notes on page ${index + 1}`);
      section.append(sheet, margin); fragment.append(section);
      return { number: index + 1, section, sheet, margin, canvas: null, layer: null, index: null, near: false, rendering: false, width: 0 };
    });
    $('#study-pages').replaceChildren(fragment);
    observer = new IntersectionObserver(items => {
      for (const item of items) {
        const entry = pages[Number(item.target.dataset.page) - 1];
        entry.near = item.isIntersecting;
        if (entry.near) render(entry); else release(entry);
      }
    }, { rootMargin: '1200px 0px' });
    for (const entry of pages) observer.observe(entry.section);
    // The text layer scales with its page; only the canvas needs redrawing for sharpness.
    resizer = new ResizeObserver(() => {
      for (const entry of pages) if (entry.width) entry.sheet.style.setProperty('--total-scale-factor', String(entry.sheet.clientWidth / entry.width));
      for (const entry of pages) position(entry);
    });
    resizer.observe($('#study-pages'));
  }

  // ---- notes in the margin ---------------------------------------------
  function card(note) {
    const item = node('div', `study-note is-${note.kind}${note.pending ? ' is-pending' : ''}${note.failed ? ' is-failed' : ''}`);
    item.dataset.id = note.id; item.dataset.top = String(note.top); item.tabIndex = 0;
    const label = note.kind === 'ai' ? note.question ? note.question : 'explained' : '';
    if (label) item.append(node('p', 'study-note-label', label));
    const body = node('div', 'study-note-body markdown-body');
    if (note.pending && note.kind === 'ai') body.textContent = note.question ? 'thinking…' : 'explaining…';
    else if (note.failed) body.textContent = note.failed;
    else body.append(markdown(note.body));
    item.append(body);
    if (!note.pending) {
      const remove = node('button', 'study-note-remove', note.failed ? 'dismiss' : 'remove'); remove.type = 'button';
      remove.addEventListener('click', event => { event.stopPropagation(); removeNote(note, remove); });
      item.append(remove);
    }
    item.addEventListener('mouseenter', () => activate(passage(note)));
    item.addEventListener('mouseleave', () => activate(editing ? editing.range : null));
    item.addEventListener('click', () => { const range = passage(note); if (range) { activate(range); if (narrow.matches) pages[note.page - 1].sheet.scrollIntoView({ block: 'nearest' }); } });
    return item;
  }
  function layout(entry) {
    if (!entry) return;
    const own = notes.filter(note => note.page === entry.number).sort((a, b) => a.top - b.top || a.created_at.localeCompare(b.created_at));
    const items = own.map(note => card(note));
    let field = null, caret = null;
    if (editing?.anchor.page === entry.number) {
      const at = own.findIndex(note => note.top > editing.anchor.top);
      items.splice(at < 0 ? items.length : at, 0, editing.element);
      editing.element.dataset.top = String(editing.anchor.top);
      // Moving the note being written must not take the caret out of it.
      field = editing.element.querySelector('textarea');
      if (document.activeElement === field) caret = [field.selectionStart, field.selectionEnd]; else field = null;
      editing.moving = true;
    }
    entry.margin.replaceChildren(...items);
    if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(...caret); }
    if (editing) editing.moving = false;
    position(entry);
  }
  // Each note sits level with its passage, pushed down past the one above.
  function position(entry) {
    const items = [...entry.margin.children];
    if (narrow.matches) { for (const item of items) item.style.top = ''; return; }
    const height = entry.sheet.clientHeight; let floor = 0;
    for (const item of items) {
      const top = Math.max(Number(item.dataset.top) * height, floor);
      item.style.top = `${top}px`; floor = top + item.offsetHeight + 12;
    }
  }
  async function removeNote(note, button) {
    if (note.failed) { notes = notes.filter(other => other !== note); layout(pages[note.page - 1]); return; }
    button.disabled = true;
    try {
      await api(`annotations/${note.id}`, { method: 'DELETE' });
      notes = notes.filter(other => other.id !== note.id); paint(); activate(null); layout(pages[note.page - 1]);
    } catch (error) { button.disabled = false; message(error.message); }
  }
  function message(text = '') { $('#study-message').textContent = text; }

  // ---- selecting a passage ---------------------------------------------
  function selected() {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const layer = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest('.textLayer');
    const end = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement)?.closest('.textLayer');
    if (!layer || layer !== end) return null;
    const entry = pages.find(item => item.layer === layer); if (!entry) return null;
    const before = document.createRange(); before.setStart(layer, 0); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length, length = range.toString().length;
    const quote = (selection.toString() || range.toString()).replace(/\s+/g, ' ').trim();
    if (!quote || !length) return null;
    const box = range.getBoundingClientRect(), sheet = entry.sheet.getBoundingClientRect();
    const top = Math.min(1, Math.max(0, (box.top - sheet.top) / sheet.height));
    return { page: entry.number, start, length, top, quote, box, range: range.cloneRange() };
  }
  function context(anchor) {
    // The page's text around the passage, so an explanation knows where it is.
    const entry = pages[anchor.page - 1], index = entry.index;
    const first = index.nodes.findLast(item => item.raw <= anchor.start);
    const at = first ? first.readable + (anchor.start - first.raw) : 0;
    return index.readable.slice(Math.max(0, at - 2500), at + anchor.length + 2500).replace(/[ \t]+/g, ' ');
  }
  function placeActions() {
    const actions = $('#study-actions');
    pending = editing ? null : selected();
    if (!pending) { actions.hidden = true; return; }
    if (pending.quote.length > 2000) { actions.hidden = true; message('select a shorter passage to note or explain.'); return; }
    message();
    actions.hidden = false;
    const width = actions.offsetWidth;
    actions.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, pending.box.left + pending.box.width / 2 - width / 2))}px`;
    actions.style.top = `${pending.box.top > 44 ? pending.box.top - 36 : pending.box.bottom + 8}px`;
  }
  document.addEventListener('mouseup', () => { for (const layer of document.querySelectorAll('.textLayer.selecting')) layer.classList.remove('selecting'); });
  let placing = 0;
  document.addEventListener('selectionchange', () => {
    if ($('#study').hidden) return;
    cancelAnimationFrame(placing); placing = requestAnimationFrame(placeActions);
  });
  let tracking = 0;
  window.addEventListener('scroll', () => {
    if ($('#study').hidden) return;
    $('#study-actions').hidden = true;
    cancelAnimationFrame(tracking); tracking = requestAnimationFrame(trackPage);
  }, { passive: true });
  window.addEventListener('scrollend', () => { if (!$('#study').hidden && !editing) placeActions(); });

  function write(anchor, mode) {
    finishEditing();
    const element = node('div', `study-note is-editing is-${mode === 'note' ? 'note' : 'ai'}`);
    const field = node('textarea', 'study-note-field'); field.rows = 1;
    field.maxLength = mode === 'note' ? 4000 : 500;
    field.placeholder = mode === 'note' ? 'a note…' : 'ask about this…';
    field.setAttribute('aria-label', mode === 'note' ? 'note on the selected passage' : 'question about the selected passage');
    element.append(field);
    editing = { anchor, mode, element, range: anchor.range };
    activate(anchor.range);
    getSelection().removeAllRanges();
    layout(pages[anchor.page - 1]);
    const grow = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; position(pages[anchor.page - 1]); };
    field.addEventListener('input', grow);
    field.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEditing(); }
      else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    });
    // Clicking away keeps what was written, or lets an empty note go.
    field.addEventListener('blur', () => setTimeout(() => { if (editing?.element === element && !editing.moving && document.activeElement !== field) { if (field.value.trim()) submit(); else finishEditing(); } }, 0));
    field.focus();
  }
  function finishEditing() {
    if (!editing) return;
    const page = editing.anchor.page; editing = null; activate(null); layout(pages[page - 1]);
  }
  function submit() {
    const { anchor, mode, element } = editing, text = element.querySelector('textarea').value.trim();
    if (!text) { finishEditing(); return; }
    editing = null; activate(null);
    if (mode === 'note') save(anchor, { kind: 'note', body: text }); else save(anchor, { kind: 'ai', question: text });
  }
  async function save(anchor, input) {
    const reading = current;
    const note = { id: crypto.randomUUID(), page: anchor.page, start: anchor.start, length: anchor.length, top: anchor.top, quote: anchor.quote, kind: input.kind, question: input.question || '', body: input.body || '', created_at: new Date().toISOString(), pending: true };
    // A note shows at once; an explanation shows as it is worked out.
    notes.push(note); paint(); layout(pages[anchor.page - 1]);
    try {
      const { annotation } = await api(`documents/${reading.id}/annotations`, { method: 'POST', body: JSON.stringify({
        id: note.id, page: note.page, start: note.start, length: note.length, top: note.top, quote: note.quote, kind: note.kind,
        ...(note.kind === 'note' ? { body: note.body } : { question: note.question, context: context(anchor) })
      }) });
      if (current !== reading) return;
      Object.assign(note, annotation); delete note.pending;
    } catch (error) {
      if (current !== reading) return;
      delete note.pending; note.failed = note.kind === 'note' ? `${error.message} your note: ${note.body}` : error.message;
    }
    paint(); layout(pages[note.page - 1]);
  }
  for (const button of document.querySelectorAll('[data-study]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const anchor = pending || selected(); if (!anchor) return;
      $('#study-actions').hidden = true; pending = null;
      if (button.dataset.study === 'explain') { getSelection().removeAllRanges(); save(anchor, { kind: 'ai' }); }
      else write(anchor, button.dataset.study);
    });
  }

  // ---- where you are ----------------------------------------------------
  function visiblePage() {
    const middle = window.innerHeight / 2;
    for (const entry of pages) { const box = entry.section.getBoundingClientRect(); if (box.bottom >= middle) return entry.number; }
    return pages.length;
  }
  function trackPage() {
    if (!current || !pages.length) return;
    const page = visiblePage();
    if (page === shownPage) return;
    shownPage = page; $('#study-position').textContent = `${page} / ${pages.length}`;
    clearTimeout(saveTimer); saveTimer = setTimeout(() => savePage(), 1500);
  }
  function savePage() {
    clearTimeout(saveTimer);
    if (!current || !shownPage || shownPage === current.page) return;
    current.page = shownPage;
    api(`documents/${current.id}`, { method: 'PATCH', body: JSON.stringify({ page: shownPage }) }).catch(() => {});
  }

  document.addEventListener('keydown', event => {
    if ($('#study').hidden || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!$('#study-actions').hidden) { $('#study-actions').hidden = true; getSelection().removeAllRanges(); return; }
    if (editing) return;
    onBack();
  });
  narrow.addEventListener('change', () => { for (const entry of pages) layout(entry); });

  function teardown() {
    generation++;
    savePage();
    observer?.disconnect(); resizer?.disconnect(); observer = resizer = null;
    pdf?.loadingTask.destroy().catch(() => {}); pdf = null;
    current = null; pages = []; notes = []; editing = null; pending = null; shownPage = 0;
    if (highlights) for (const name of ['study-note', 'study-ai', 'study-active']) CSS.highlights.delete(name);
    $('#study-pages').replaceChildren(); $('#study-actions').hidden = true; message();
  }

  return {
    isPdf,
    upload,
    list: () => api('documents').then(data => data.documents),
    remove: id => api(`documents/${id}`, { method: 'DELETE' }),
    async open(id) {
      if (current?.id === id && !$('#study').hidden) return;
      teardown();
      const opening = generation;
      $('#study').hidden = false; $('#study-title').textContent = ''; $('#study-position').textContent = '';
      message('opening…');
      try {
        const [{ document: info }, { annotations }, response, library] = await Promise.all([
          api(`documents/${id}`), api(`documents/${id}/annotations`),
          fetch(`./api/documents/${id}/file`, { credentials: 'same-origin', cache: 'no-store' }), pdfjs()
        ]);
        if (!response.ok) throw new Error(response.status === 404 ? 'PDF not found.' : 'This PDF could not be opened.');
        const data = new Uint8Array(await response.arrayBuffer());
        if (opening !== generation) return;
        const opened = await library.getDocument(options(data)).promise;
        if (opening !== generation) { opened.loadingTask.destroy(); return; }
        pdf = opened; current = info; notes = annotations;
        $('#study-title').textContent = info.title; document.title = info.title;
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (opening !== generation) return;
        message();
        build(pdf.numPages, `${first.width} / ${first.height}`);
        for (const entry of pages) layout(entry);
        // Reopen where you left off.
        const start = Math.min(info.page, pages.length);
        if (start > 1) pages[start - 1].section.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
        shownPage = 0; trackPage(); current.page = start;
        api(`documents/${id}`, { method: 'PATCH', body: JSON.stringify({ page: start }) }).catch(() => {});
      } catch (error) { if (opening === generation) message(error.message); }
    },
    close() { if ($('#study').hidden) return; teardown(); $('#study').hidden = true; }
  };
}
