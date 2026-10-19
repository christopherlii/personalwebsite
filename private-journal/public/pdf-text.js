// Turns a PDF's positioned text runs back into readable blocks: headings by
// size, paragraphs by spacing and indents, with page numbers, running heads,
// and line-break hyphens removed. Shared by the browser (which reads the PDF)
// and the server (which splits text into parts).
const PART_BYTES = 150000;

export function splitParts(blocks) {
  const parts = [[]];
  let size = 0;
  for (const block of blocks) {
    const length = JSON.stringify(block).length + 1;
    if (size + length > PART_BYTES && parts.at(-1).length) { parts.push([]); size = 0; }
    parts.at(-1).push(block); size += length;
  }
  return parts;
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };

// pages: [{ items: [{ str, x, y, size, width }] }], y measured up from the bottom.
function pageLines(page) {
  const lines = [];
  for (const item of [...page.items].filter(item => item.str).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(candidate => Math.abs(candidate.y - item.y) <= Math.max(2, item.size * 0.3));
    if (line) line.items.push(item); else lines.push({ y: item.y, items: [item] });
  }
  return lines.map(line => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '', end = null;
    for (const item of line.items) {
      if (end !== null && item.x - end > item.size * 0.15 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
      text += item.str; end = item.x + (item.width ?? item.str.length * item.size * 0.5);
    }
    return { y: line.y, x: line.items[0].x, size: Math.max(...line.items.map(item => item.size)), text: text.replace(/\s+/g, ' ').trim() };
  }).filter(line => line.text).sort((a, b) => b.y - a.y);
}

export function pdfBlocks(pages) {
  const all = pages.map(pageLines);
  // Running heads and footers repeat at a page's edges; page numbers too.
  const edges = new Map(), key = text => text.toLowerCase().replace(/\d+/g, '#');
  for (const lines of all) for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) edges.set(key(line.text), (edges.get(key(line.text)) || 0) + 1);
  const repeated = Math.max(3, pages.length * 0.3);
  const body = all.map(lines => lines.filter((line, index) => {
    const edge = index < 2 || index >= lines.length - 2;
    return !(edge && (/^(page\s+)?[\divxlc]+$/i.test(line.text) || edges.get(key(line.text)) >= repeated));
  }));
  const lines = body.flat();
  if (!lines.length) return [];
  // The body size is the size most of the text is set in.
  const weighted = lines.flatMap(line => Array(Math.min(50, Math.ceil(line.text.length / 10))).fill(line.size));
  const size = median(weighted), left = median(lines.filter(line => Math.abs(line.size - size) < 0.5).map(line => Math.round(line.x)));
  const gaps = [];
  for (const page of body) for (let i = 1; i < page.length; i++) if (Math.abs(page[i].size - size) < 0.5) gaps.push(page[i - 1].y - page[i].y);
  const gap = median(gaps.filter(value => value > 0)) || size * 1.2;
  const blocks = [];
  let current = null;
  const flush = () => { if (current) blocks.push(current); current = null; };
  for (const page of body) {
    let previous = null;
    for (const line of page) {
      const heading = line.size >= size * 1.2 && line.text.length < 200;
      if (heading) {
        const t = line.size >= size * 1.6 ? 'h2' : 'h3', last = blocks.at(-1);
        flush();
        // A heading that wraps onto a second line stays one heading.
        if (last?.t === t && previous && previous.size === line.size && previous.y - line.y < line.size * 1.6) last.x += ` ${line.text}`;
        else blocks.push({ t, x: line.text });
      } else {
        const spaced = previous && previous.y - line.y > gap * 1.45;
        const indented = line.x > left + size * 1.2;
        const ended = current && /[.!?:"”’)]$/.test(current.x);
        if (!current || spaced || (indented && ended) || (!previous && ended && !/^[a-z]/.test(line.text)) || (previous && previous.size >= size * 1.2)) { flush(); current = { t: 'p', x: line.text }; }
        else current.x = current.x.endsWith('-') && /^[a-z]/.test(line.text) ? current.x.slice(0, -1) + line.text : `${current.x} ${line.text}`;
      }
      previous = line;
    }
  }
  flush();
  return blocks.map(block => ({ t: block.t, x: block.x.slice(0, 20000) }));
}
