// "/idea …", "/project …", and "/curious …" (or "/hm …") lines inside a
// thought log things to come back to. Shared by the server index and the
// browser's rendering.
export const IDEA_KINDS = { idea: 'writing ideas', project: 'project ideas', curious: 'curiosities' };
// The word typed after the slash, and the kind it files under.
export const IDEA_WORDS = { idea: 'idea', project: 'project', curious: 'curious', hm: 'curious' };
export const IDEA_WORD_PATTERN = Object.keys(IDEA_WORDS).join('|');
const line = new RegExp(`(^|\\n)[ \\t]*\\/(${IDEA_WORD_PATTERN})[ \\t]+([^\\n]*\\S)`, 'gi');

export function ideaLines(text = '') {
  const result = [], seen = new Set();
  for (const match of text.matchAll(line)) {
    const kind = IDEA_WORDS[match[2].toLowerCase()], value = match[3].trim().slice(0, 280), key = `${kind}\n${value}`;
    if (!seen.has(key)) { seen.add(key); result.push({ kind, text: value }); }
  }
  return result.slice(0, 50);
}
