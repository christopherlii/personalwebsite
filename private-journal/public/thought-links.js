const pattern = /\[\[([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\|([^\[\]|\r\n]{1,160})\]\]/gu;
export function thoughtLinks(text) {
  return [...text.matchAll(new RegExp(pattern))].map(match => ({ from: match.index, to: match.index + match[0].length, id: match[1], label: match[2], labelFrom: match.index + 39, labelTo: match.index + match[0].length - 2, raw: match[0] }));
}
export function thoughtLabel(entry) {
  return plainThoughtLinks(entry.title || entry.body || '').replace(/[\[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'untitled thought';
}
export function thoughtLink(entry) { return `[[${entry.id}|${thoughtLabel(entry)}]]`; }
export function plainThoughtLinks(text) { return text.replace(new RegExp(pattern), (_, id, label) => label); }
