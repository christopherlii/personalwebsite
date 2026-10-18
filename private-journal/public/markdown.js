import './vendor/marked.min.js';

// Use the site's existing Marked lexer, but build DOM nodes rather than HTML.
// Raw HTML stays visible text; Markdown cannot create scripts or attributes.
const element = (tag, children) => {
  const node = document.createElement(tag);
  if (children) node.append(children);
  return node;
};
const decode = text => text.replace(/&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, entity => {
  const decoder = document.createElement('textarea');
  decoder.innerHTML = entity; // Only a single entity reference, never markup.
  return decoder.value;
});
function safeLink(href) {
  try {
    const url = new URL(decode(href), location.href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function nodes(tokens) {
  const result = document.createDocumentFragment();
  for (const token of tokens) {
    const children = () => token.tokens ? nodes(token.tokens) : document.createTextNode(decode(token.text || ''));
    switch (token.type) {
      case 'space': case 'def': break;
      case 'heading': result.append(element(`h${token.depth}`, children())); break;
      case 'paragraph': result.append(element('p', children())); break;
      case 'blockquote': result.append(element('blockquote', children())); break;
      case 'strong': case 'em': case 'del': result.append(element(token.type, children())); break;
      case 'codespan': result.append(element('code', document.createTextNode(token.text))); break;
      case 'code': result.append(element('pre', element('code', document.createTextNode(token.text)))); break;
      case 'hr': case 'br': result.append(element(token.type)); break;
      case 'html': result.append(document.createTextNode(token.text)); break;
      case 'link': case 'image': {
        const href = safeLink(token.href);
        const content = token.type === 'image' ? document.createTextNode(decode(token.text || token.href)) : children();
        if (!href) { result.append(content); break; }
        const link = element('a', content);
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        if (token.title) link.title = decode(token.title);
        result.append(link);
        break;
      }
      case 'list': {
        const list = element(token.ordered ? 'ol' : 'ul');
        if (token.ordered && token.start !== 1) list.start = token.start;
        for (const item of token.items) {
          const li = element('li');
          if (item.task) {
            const check = element('input'); check.type = 'checkbox'; check.checked = item.checked; check.disabled = true;
            check.setAttribute('aria-label', item.checked ? 'completed' : 'not completed');
            li.className = 'task-item'; li.append(check, document.createTextNode(' '));
          }
          li.append(nodes(item.tokens)); list.append(li);
        }
        result.append(list);
        break;
      }
      case 'table': {
        const table = element('table');
        const row = (cells, tag) => {
          const tr = element('tr');
          for (const cell of cells) tr.append(element(tag, nodes(cell.tokens)));
          return tr;
        };
        table.append(element('thead', row(token.header, 'th')));
        const body = element('tbody');
        for (const cells of token.rows) body.append(row(cells, 'td'));
        table.append(body);
        const scroll = element('div', table); scroll.className = 'table-scroll'; result.append(scroll);
        break;
      }
      default: result.append(children());
    }
  }
  return result;
}
export function markdown(body) {
  try { return nodes(globalThis.marked.lexer(body, { gfm: true, breaks: false })); }
  catch { return document.createTextNode(body); }
}
