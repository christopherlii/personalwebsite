// "/idea …" and "/project …" lines inside a thought log ideas to come back
// to. Shared by the server index and the browser's rendering.
export const IDEA_KINDS = { idea: 'writing ideas', project: 'project ideas' };
const line = /(^|\n)[ \t]*\/(idea|project)[ \t]+([^\n]*\S)/gi;

export function ideaLines(text = '') {
  const result = [], seen = new Set();
  for (const match of text.matchAll(line)) {
    const kind = match[2].toLowerCase(), value = match[3].trim().slice(0, 280), key = `${kind}\n${value}`;
    if (!seen.has(key)) { seen.add(key); result.push({ kind, text: value }); }
  }
  return result.slice(0, 50);
}
