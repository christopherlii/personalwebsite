// The shelf: articles opened with /read <link> and books dropped in as PDFs,
// read in a quiet view with nothing but the text and a way back.
import { pdfBlocks, splitParts } from './pdf-text.js';

const $ = selector => document.querySelector(selector);

export function createShelf({ api, status }) {
  let open = null, saveTimer = null;

  function render(work, blocks) {
    const content = $('#work-content'); content.replaceChildren();
    const title = document.createElement('h1'); title.className = 'work-title'; title.textContent = work.title;
    const meta = document.createElement('p'); meta.className = 'work-meta';
    meta.textContent = [work.author, work.kind === 'article' ? work.site : 'book'].filter(Boolean).join(' · ');
    content.append(title, meta);
    let list = null;
    for (const block of blocks) {
      // Text only: every block is set with textContent, never as markup.
      const tag = { h2: 'h2', h3: 'h3', p: 'p', li: 'li', quote: 'blockquote', pre: 'pre' }[block.t];
      if (!tag) continue;
      const element = document.createElement(tag); element.textContent = block.x;
      if (tag === 'li') { if (!list) { list = document.createElement('ul'); content.append(list); } list.append(element); }
      else { list = null; content.append(element); }
    }
  }

  // Where you stopped is kept as a fraction of the way through.
  function progress() {
    if (!open) return;
    const id = open, height = document.documentElement.scrollHeight - innerHeight;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api(`works/${id}`, { method: 'PATCH', body: JSON.stringify({ position: height > 0 ? Math.min(1, Math.max(0, scrollY / height)) : 0 }) }).catch(() => {}), 1200);
  }
  addEventListener('scroll', () => { if (open && !$('#work').hidden) progress(); }, { passive: true });

  return {
    async open(id) {
      open = id;
      const { work } = await api(`works/${id}`);
      const blocks = [];
      for (let part = 0; part < work.parts; part++) blocks.push(...(await api(`works/${id}/parts/${part}`)).blocks);
      if (open !== id) return null;
      render(work, blocks);
      requestAnimationFrame(() => scrollTo(0, work.position * (document.documentElement.scrollHeight - innerHeight)));
      return work;
    },
    close() { open = null; clearTimeout(saveTimer); $('#work-content').replaceChildren(); },
    async addArticle(url) {
      status('opening…');
      return (await api('works', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), url }) })).work;
    },
    // A dropped PDF is read here in the browser; only its text is uploaded.
    async addPdf(file) {
      status('reading the pdf…');
      const pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
      const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true });
      try {
        const pdf = await task.promise;
        const pages = [];
        for (let number = 1; number <= pdf.numPages; number++) {
          if (number % 10 === 1) status(`reading page ${number} of ${pdf.numPages}…`);
          const page = await pdf.getPage(number), text = await page.getTextContent();
          pages.push({ items: text.items.filter(item => typeof item.str === 'string').map(item => ({ str: item.str, x: item.transform[4], y: item.transform[5], size: Math.hypot(item.transform[2], item.transform[3]) || item.height, width: item.width })) });
          page.cleanup();
        }
        const blocks = pdfBlocks(pages);
        if (!blocks.length) throw new Error("couldn't find text in that pdf. scanned pages have no text to read.");
        const info = (await pdf.getMetadata().catch(() => null))?.info || {};
        const title = (typeof info.Title === 'string' && info.Title.trim()) || file.name.replace(/\.pdf$/i, '');
        const parts = splitParts(blocks), id = crypto.randomUUID();
        const { work } = await api('works', { method: 'POST', body: JSON.stringify({ id, kind: 'book', title: title.slice(0, 300), author: (typeof info.Author === 'string' ? info.Author.trim() : '').slice(0, 200), parts: parts.length }) });
        try {
          for (let index = 0; index < parts.length; index++) {
            status(`saving ${Math.round((index + 1) / parts.length * 100)}%…`);
            await api(`works/${id}/parts/${index}`, { method: 'PUT', body: JSON.stringify({ blocks: parts[index] }) });
          }
        } catch (error) {
          // Never leave half a book on the shelf.
          await api(`works/${id}`, { method: 'DELETE' }).catch(() => {});
          throw error;
        }
        return work;
      } finally { await task.destroy(); }
    },
    async list() { return (await api('works?status=reading')).works; }
  };
}
