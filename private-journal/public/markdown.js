import './vendor/marked.min.js';
import { thoughtLinks } from './thought-links.js';
import { textTags } from './tags.js';
import { photoReference, photoSource } from './photo-links.js';

const parser = new globalThis.marked.Marked({ gfm: true, breaks: false, extensions: [{
  name: 'thoughtLink', level: 'inline', start: source => source.indexOf('[['),
  tokenizer(source) {
    if (!source.startsWith('[[')) return;
    const link = thoughtLinks(source)[0];
    if (link?.from === 0) return { type: 'thoughtLink', raw: link.raw, id: link.id, text: link.label };
  }
}] });

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
function nodes(tokens, allowTags = true) {
  const result = document.createDocumentFragment();
  for (const token of tokens) {
    const children = () => token.tokens ? nodes(token.tokens,allowTags) : document.createTextNode(decode(token.text || ''));
    switch (token.type) {
      case 'text': {
        if(token.tokens){result.append(nodes(token.tokens,allowTags));break;}
        const value=token.raw || token.text || '',tags=allowTags?textTags(value):[];let end=0;
        for(const tag of tags){result.append(document.createTextNode(decode(value.slice(end,tag.from))));const link=element('a',document.createTextNode(tag.text));link.href=`#tag/${encodeURIComponent(tag.tag)}`;link.dataset.tag=tag.tag;link.className='thought-tag';result.append(link);end=tag.to;}
        result.append(document.createTextNode(decode(value.slice(end))));break;
      }
      case 'thoughtLink': {
        const link = element('a', document.createTextNode(token.text)); link.href = `#thought/${token.id}`;
        link.dataset.thoughtLink = token.id; result.append(link); break;
      }
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
        const photo=token.type==='image'&&photoReference(decode(token.href));
        if(photo){
          const img=element('img');img.width=photo.width;img.height=photo.height;img.alt=decode(token.text||'photo');img.loading='lazy';img.decoding='async';img.className='journal-photo';img.src=photoSource(photo);result.append(img);break;
        }
        const href = safeLink(token.href);
        const content = token.type === 'image' ? document.createTextNode(decode(token.text || token.href)) : token.tokens ? nodes(token.tokens,false) : document.createTextNode(decode(token.text || ''));
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
  try { return nodes(parser.lexer(body)); }
  catch { return document.createTextNode(body); }
}

const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function markdownPreview(body, limit = 280) {
  const fragment = document.createDocumentFragment(); fragment.append(markdown(body));
  if ([...characters.segment(fragment.textContent)].length <= limit) return fragment;
  let remaining = limit - 1; // Reserve the final character for the ellipsis.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const segments = [...characters.segment(node.data)];
    if (segments.length < remaining) { remaining -= segments.length; continue; }
    const offset = remaining ? segments[remaining - 1].index + segments[remaining - 1].segment.length : 0;
    // Trim the rendered DOM rather than Markdown source, preserving valid
    // emphasis, lists, and links even when the preview ends inside a block.
    const tail = document.createRange(); tail.setStart(node, offset); tail.setEnd(fragment, fragment.childNodes.length); tail.deleteContents();
    node.data = node.data.trimEnd() + '…';
    break;
  }
  return fragment;
}
