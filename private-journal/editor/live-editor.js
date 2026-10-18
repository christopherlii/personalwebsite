import { EditorState, StateField, Compartment } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown as renderMarkdown } from './markdown.js';

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
    if (['HeaderMark', 'QuoteMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'CodeInfo'].includes(name)) {
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

export function createLiveEditor(parent, { value, nonce, onChange, onLimit }) {
  const editable = new Compartment(); let readOnly = false;
  const view = new EditorView({ parent, state: EditorState.create({
    doc: value, selection: { anchor: value.length },
    extensions: [
      EditorView.cspNonce.of(nonce),
      markdown({ extensions: GFM }), syntaxHighlighting(formatting), liveFormatting,
      history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'thought', 'aria-multiline': 'true', spellcheck: 'true', autocapitalize: 'sentences' }),
      editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= 20000) return true;
        queueMicrotask(onLimit); return false;
      }),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); })
    ]
  }) });
  return {
    focus() { view.focus(); },
    destroy() { view.destroy(); },
    setReadOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
    }
  };
}
