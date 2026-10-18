import { EditorState, StateField, Compartment, Prec, RangeSet } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, placeholder } from '@codemirror/view';
import { autocompletion, completionKeymap, pickedCompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown as renderMarkdown } from './markdown.js';
import { thoughtLinks, thoughtLink, thoughtLabel } from './thought-links.js';

const wikiLinks = {
  defineNodes: ['ThoughtLink', 'ThoughtLinkMark', 'ThoughtLinkTarget', 'ThoughtLinkLabel'],
  parseInline: [{ name: 'ThoughtLink', before: 'Link', parse(context, next, position) {
    if (next !== 91 || context.slice(position, position + 2) !== '[[') return -1;
    const link = thoughtLinks(context.slice(position, context.end))[0];
    if (!link || link.from !== 0) return -1;
    const end = position + link.to, labelFrom = position + link.labelFrom;
    return context.addElement(context.elt('ThoughtLink', position, end, [
      context.elt('ThoughtLinkMark', position, position + 2), context.elt('ThoughtLinkTarget', position + 2, labelFrom),
      context.elt('ThoughtLinkLabel', labelFrom, end - 2), context.elt('ThoughtLinkMark', end - 2, end)
    ]));
  } }]
};
const hiddenTargets = StateField.define({
  create: state => targetRanges(state),
  update: (value, transaction) => transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ? targetRanges(transaction.state) : value
});
function targetRanges(state) {
  const ranges = []; syntaxTree(state).iterate({ enter(node) { if (node.name === 'ThoughtLinkTarget') ranges.push(Decoration.replace({}).range(node.from, node.to)); } });
  return RangeSet.of(ranges, true);
}
function completions(findThoughts) {
  return async context => {
    const match = context.matchBefore(/\[\[[^\[\]\n|]{0,160}$/);
    if (!match) return null;
    for (let node = syntaxTree(context.state).resolveInner(context.pos, -1); node; node = node.parent) {
      if (['InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'ThoughtLink'].includes(node.name)) return null;
    }
    const controller = new AbortController(); context.addEventListener('abort', () => controller.abort(), { onDocChange: true });
    let entries; try { entries = await findThoughts(match.text.slice(2), controller.signal); } catch { return null; }
    if (context.aborted) return null;
    return { from: match.from, to: context.pos, filter: false, options: entries.map(entry => ({
      label: thoughtLabel(entry), detail: new Date(entry.source_date ? entry.source_date + 'T12:00:00' : entry.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase(),
      apply(view, completion, from, to) {
        const insert = thoughtLink(entry), closing = view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0;
        view.dispatch({ changes: { from, to: to + closing, insert }, selection: { anchor: from + insert.length }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
      }
    })) };
  };
}

class Bullet extends WidgetType {
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-bullet'; span.textContent = '•'; return span; }
}
class Task extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked;
    input.className = 'cm-md-task'; input.setAttribute('aria-label', this.checked ? 'mark incomplete' : 'mark complete');
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('click', event => {
      event.stopPropagation();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: this.checked ? '[ ]' : '[x]' } });
    });
    return input;
  }
  ignoreEvent() { return true; }
}
class Table extends WidgetType {
  constructor(from, source) { super(); this.from = from; this.source = source; }
  eq(other) { return this.from === other.from && this.source === other.source; }
  toDOM(view) {
    const div = document.createElement('div'); div.className = 'markdown-body cm-md-table'; div.append(renderMarkdown(this.source));
    div.addEventListener('mousedown', event => {
      if (view.state.readOnly) return;
      event.preventDefault(); view.dispatch({ selection: { anchor: this.from } }); view.focus();
    });
    return div;
  }
  ignoreEvent() { return false; }
}

function decorate(state) {
  const ranges = [], lines = new Map();
  const active = state.selection.ranges.map(range => ({ from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to }));
  const editing = (from, to) => active.some(range => from <= range.to && to >= range.from);
  const hide = (from, to, widget) => { if (to > from) ranges.push(Decoration.replace({ widget }).range(from, to)); };
  const mark = (from, to, className) => { if (to > from) ranges.push(Decoration.mark({ class: className }).range(from, to)); };
  const lineClass = (from, to, className) => {
    for (let line = state.doc.lineAt(from); line.from <= to;) {
      const classes = lines.get(line.from) || new Set(); classes.add(className); lines.set(line.from, classes);
      if (line.to >= to || line.number === state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  };
  syntaxTree(state).iterate({ enter(node) {
    const { name, from, to } = node;
    const selected = editing(from, to);
    if (name === 'ThoughtLinkTarget') { hide(from, to); return false; }
    if (name === 'ThoughtLinkLabel') mark(from, to, 'cm-md-link');
    if (name === 'ThoughtLink') mark(from, to, 'cm-thought-link');
    if (/^(ATX|Setext)Heading[1-6]$/.test(name)) lineClass(from, to, `cm-md-heading cm-md-h${name.at(-1)}`);
    if (name === 'Blockquote') lineClass(from, to, 'cm-md-quote');
    if (name === 'FencedCode' || name === 'CodeBlock') lineClass(from, to, 'cm-md-code-line');
    if (name === 'InlineCode') mark(from, to, 'cm-md-inline-code');
    if (name === 'Table' && !selected) {
      ranges.push(Decoration.replace({ block: true, widget: new Table(from, state.doc.sliceString(from, to)) }).range(from, to));
      return false;
    }
    if (name === 'Link' || name === 'Image') {
      if (!selected) {
        const children = []; for (let child = node.node.firstChild; child; child = child.nextSibling) children.push(child);
        const open = children.find(child => child.name === 'LinkMark');
        const close = children.find(child => child.name === 'LinkMark' && state.doc.sliceString(child.from, child.to) === ']');
        if (open && close) { hide(from, open.to); hide(close.from, to); mark(open.to, close.from, 'cm-md-link'); return false; }
      }
    }
    if (name === 'TaskMarker' && !selected) { hide(from, to, new Task(from, /x/i.test(state.doc.sliceString(from, to)))); return false; }
    if (name === 'ListMark' && !selected && /^[-+*]$/.test(state.doc.sliceString(from, to))) {
      if (node.node.parent?.getChild('Task')) hide(from, to + (state.doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
      else hide(from, to, new Bullet());
      return false;
    }
    if (['HeaderMark', 'QuoteMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'CodeInfo', 'ThoughtLinkMark'].includes(name)) {
      if (!selected) {
        let end = to;
        if (name === 'HeaderMark' || name === 'QuoteMark') while (state.doc.sliceString(end, end + 1) === ' ') end++;
        hide(from, end);
      } else mark(from, to, 'cm-md-marker');
    }
  } });
  for (const [from, classes] of lines) ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return Decoration.set(ranges, true);
}
const liveFormatting = StateField.define({
  create: decorate,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ? decorate(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field)
});
const formatting = HighlightStyle.define([
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strikethrough, class: 'cm-md-strike' }
]);

export function createLiveEditor(parent, { value, nonce, onChange, onLimit, findThoughts, onOpenThought, onSubmit, emptyText = '' }) {
  const editable = new Compartment(); let readOnly = false;
  const makeState = value => EditorState.create({
    doc: value, selection: { anchor: value.length },
    extensions: [
      EditorView.cspNonce.of(nonce),
      markdown({ extensions: [GFM, wikiLinks] }), syntaxHighlighting(formatting), liveFormatting, hiddenTargets,
      EditorView.atomicRanges.of(view => view.state.field(hiddenTargets)),
      placeholder(emptyText),
      autocompletion({ override: [completions(findThoughts)], icons: false, maxRenderedOptions: 8, activateOnTypingDelay: 180 }),
      Prec.highest(keymap.of(completionKeymap)),
      ...(onSubmit ? [Prec.highest(keymap.of([{ key: 'Mod-Enter', run() { onSubmit(); return true; } }]))] : []),
      history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'thought', 'aria-multiline': 'true', spellcheck: 'true', autocapitalize: 'sentences' }),
      editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      EditorView.domEventHandlers({ click(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const position = view.posAtDOM(event.target, 0);
        for (let node = syntaxTree(view.state).resolveInner(position, 1); node; node = node.parent) {
          if (node.name === 'ThoughtLink') {
            const link = thoughtLinks(view.state.doc.sliceString(node.from, node.to))[0];
            if (link) { event.preventDefault(); onOpenThought(link.id); return true; }
          }
        }
        return false;
      } }),
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= 20000) return true;
        queueMicrotask(onLimit); return false;
      }),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); })
    ]
  });
  const view = new EditorView({ parent, state: makeState(value) });
  return {
    focus() { view.focus(); },
    destroy() { view.destroy(); },
    setValue(value) { if (view.state.doc.toString() !== value) view.setState(makeState(value)); },
    setReadOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
    }
  };
}
