import { EditorState, StateField, StateEffect, Compartment, Prec, RangeSet } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, placeholder } from '@codemirror/view';
import { autocompletion, completionKeymap, pickedCompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown as renderMarkdown } from './markdown.js';
import { thoughtLinks, thoughtLink, thoughtLabel } from './thought-links.js';
import { photoReference } from './photo-links.js';
// Cmd/Ctrl-click follows web and mail links, never other schemes.
const externalLink = source => {
  try { const url = new URL(/^www\./i.test(source) ? `https://${source}` : source); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};
const isPhoto=source=>photoReference(source.match(/^!\[(?:\\.|[^\]])*\]\(([^)]+)\)$/u)?.[1]);

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
// "/idea" and "/project" at the start of a line take the tag style as you
// type, so a captured idea looks the same here as it will once saved.
const ideaMarkers = StateField.define({
  create: state => ideaRanges(state),
  update: (value, transaction) => transaction.docChanged ? ideaRanges(transaction.state) : value,
  provide: field => EditorView.decorations.from(field)
});
function ideaRanges(state) {
  const ranges = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number), match = /^([ \t]*)\/(idea|project|curious|hm)(?=[ \t]+\S)/i.exec(line.text);
    if (match) ranges.push(Decoration.mark({ class: `cm-idea-marker cm-idea-marker-${match[2].toLowerCase() === 'hm' ? 'curious' : match[2].toLowerCase()}` }).range(line.from + match[1].length, line.from + match[0].length));
  }
  return RangeSet.of(ranges);
}
const hiddenTargets = StateField.define({
  create: state => targetRanges(state),
  update: (value, transaction) => transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ? targetRanges(transaction.state) : value
});
function targetRanges(state) {
  const ranges = []; syntaxTree(state).iterate({ enter(node) { if (node.name === 'ThoughtLinkTarget'||(node.name==='Image'&&isPhoto(state.doc.sliceString(node.from,node.to)))) ranges.push(Decoration.replace({}).range(node.from, node.to)); } });
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

// Live preview, as in Obsidian: Markdown syntax is hidden and the text shown
// formatted, except where the selection touches it. Block syntax (headings,
// quotes, rules, code fences) reappears for the line or block being edited;
// inline syntax (emphasis, code, links) only for the span the cursor is in.
// List bullets, indentation, and checkboxes stay rendered unless the
// selection reaches into the marker itself, so a line does not jump sideways.

// Disc, circle, then square by depth, as the reading view's nested lists draw them.
class Bullet extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(other) { return this.depth === other.depth; }
  toDOM() {
    const span = document.createElement('span'); span.className = `cm-md-bullet cm-md-bullet-${Math.min(this.depth, 2)}`;
    span.setAttribute('aria-hidden', 'true'); return span;
  }
  ignoreEvent() { return false; }
}
class Indent extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(other) { return this.depth === other.depth; }
  toDOM() { const span = document.createElement('span'); span.className = `cm-md-indent cm-md-indent-${this.depth}`; return span; }
  ignoreEvent() { return false; }
}
class Rule extends WidgetType {
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-rule'; span.setAttribute('aria-hidden', 'true'); return span; }
  ignoreEvent() { return false; }
}
class Task extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view) {
    const box = document.createElement('span'); box.className = 'cm-md-task-box';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked;
    input.className = 'cm-md-task'; input.setAttribute('aria-label', this.checked ? 'mark incomplete' : 'mark complete');
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('click', event => {
      event.stopPropagation();
      if (view.state.readOnly) { event.preventDefault(); return; }
      view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: this.checked ? '[ ]' : '[x]' } });
    });
    box.append(input); return box;
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

class Photo extends WidgetType{
  constructor(source){super();this.source=source;}
  eq(other){return this.source===other.source;}
  toDOM(){const span=document.createElement('span');span.className='cm-photo';const parsed=document.createElement('div');parsed.append(renderMarkdown(this.source));const img=parsed.querySelector('img');if(img)span.append(img);return span;}
  ignoreEvent(){return true;}
}
// Selection tests. `touches` includes a cursor resting at either edge of a
// span (so `**word**|` still shows its stars); `overlaps` needs the selection
// to reach inside, which keeps rendered bullets and checkboxes steady.
const touches = (state, from, to) => state.selection.ranges.some(range => range.from <= to && range.to >= from);
const overlaps = (state, from, to) => state.selection.ranges.some(range => range.from < to && range.to > from);
const linesTouch = (state, from, to) => touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
const children = node => { const list = []; for (let child = node.firstChild; child; child = child.nextSibling) list.push(child); return list; };
const listDepth = node => { let depth = -1; for (let parent = node; parent; parent = parent.parent) if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++; return Math.max(0, depth); };
const blank = /^[ \t]*$/;

// Inactive tables become rendered block widgets. Block decorations must come
// from state, so tables live in a field; everything else is drawn per viewport.
function tableRanges(state) {
  const ranges = [];
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'Table') return;
    if (!linesTouch(state, node.from, node.to)) ranges.push(Decoration.replace({ block: true, widget: new Table(node.from, state.doc.sliceString(node.from, node.to)) }).range(node.from, node.to));
    return false;
  } });
  return Decoration.set(ranges, true);
}
const tables = StateField.define({
  create: tableRanges,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ? tableRanges(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field)
});

function decorate(view) {
  const { state } = view, { doc } = state, ranges = [], lines = new Map();
  const text = (from, to) => doc.sliceString(from, to);
  // Replacements never cross a line break: inline syntax that spans lines
  // stays visible rather than collapsing the lines together.
  const hide = (from, to, widget) => { if (to > from && doc.lineAt(from).to >= to) ranges.push(Decoration.replace(widget ? { widget } : {}).range(from, to)); };
  const mark = (from, to, className) => { if (to > from) ranges.push(Decoration.mark({ class: className }).range(from, to)); };
  const marker = (from, to) => mark(from, to, 'cm-md-marker');
  const lineClass = (from, to, className) => {
    for (let line = doc.lineAt(from); ;) {
      const classes = lines.get(line.from) || new Set(); classes.add(className); lines.set(line.from, classes);
      if (line.to >= to || line.number === doc.lines) break;
      line = doc.line(line.number + 1);
    }
  };
  const spaceAfter = at => { let end = at; while (end < doc.length && /[ \t]/.test(text(end, end + 1))) end++; return end; };
  // A delimited inline span: format its content, then show or hide its marks.
  const span = (node, markName, className) => {
    const marks = children(node).filter(child => child.name === markName);
    if (marks.length < 2) return;
    const open = marks[0], close = marks.at(-1), shown = touches(state, node.from, node.to);
    mark(open.to, close.from, className);
    for (const child of [open, close]) shown ? marker(child.from, child.to) : hide(child.from, child.to);
  };
  const link = node => {
    const parts = children(node), marks = parts.filter(child => child.name === 'LinkMark');
    const open = marks[0], close = marks.find(child => text(child.from, child.to) === ']');
    // A bare `[words]` with no destination is just text in brackets.
    if (!open || !close || !parts.some(child => child.name === 'URL' || child.name === 'LinkLabel' || (child.name === 'LinkMark' && text(child.from, child.to) === '('))) return;
    mark(open.to, close.from, 'cm-md-link');
    if (touches(state, node.from, node.to)) { marker(node.from, open.to); marker(close.from, node.to); }
    else { hide(node.from, open.to); hide(close.from, node.to); }
  };
  const list = node => {
    const from = node.from, to = node.to, line = doc.lineAt(from), depth = listDepth(node);
    const indented = line.from < from && blank.test(text(line.from, from));
    if (!/^[-+*]$/.test(text(from, to))) {
      // Numbers stay as written; nested ones keep a steady indent.
      if (indented && depth && !overlaps(state, line.from, from)) hide(line.from, from, new Indent(Math.min(depth, 5)));
      return;
    }
    if (!/[ \t]/.test(text(to, to + 1))) return; // `-` alone may yet become a rule.
    const task = node.parent?.getChild('Task')?.getChild('TaskMarker');
    const taskHere = task && blank.test(text(to, task.from));
    const end = taskHere ? Math.min(spaceAfter(task.to), task.to + 1) : to + 1;
    if (overlaps(state, indented ? line.from : from, end)) { if (taskHere) marker(task.from, task.to); return; }
    if (indented) hide(line.from, from, new Indent(Math.min(depth, 5)));
    hide(from, end, taskHere ? new Task(task.from, /x/i.test(text(task.from, task.to))) : new Bullet(depth));
    if (indented || line.from === from) lineClass(from, from, `cm-md-list cm-md-list-${Math.min(depth, 5)}`);
  };
  const { visibleRanges } = view;
  if (!visibleRanges.length) return Decoration.none;
  syntaxTree(state).iterate({ from: visibleRanges[0].from, to: visibleRanges.at(-1).to, enter(ref) {
    const { name, from, to } = ref, node = ref.node;
    if (name === 'Image' && isPhoto(text(from, to))) { hide(from, to, new Photo(text(from, to))); return false; }
    if (name === 'Table') return linesTouch(state, from, to) ? undefined : false;
    if (/^(ATX|Setext)Heading[1-6]$/.test(name)) {
      lineClass(from, to, `cm-md-heading cm-md-h${name.at(-1)}`);
      const shown = linesTouch(state, from, to);
      for (const child of children(node)) if (child.name === 'HeaderMark') {
        if (shown) { marker(child.from, child.to); continue; }
        hide(child.from, spaceAfter(child.to));
        if (name.startsWith('Setext')) lineClass(child.from, child.to, 'cm-md-collapsed');
      }
      return;
    }
    switch (name) {
      case 'Blockquote': lineClass(from, to, 'cm-md-quote'); return;
      case 'QuoteMark':
        if (linesTouch(state, from, from)) marker(from, to);
        else hide(from, Math.min(spaceAfter(to), to + 1));
        return;
      case 'HorizontalRule':
        if (linesTouch(state, from, to)) marker(from, to);
        else hide(from, to, new Rule());
        return false;
      case 'FencedCode': case 'CodeBlock': {
        lineClass(from, to, 'cm-md-code-line'); lineClass(from, from, 'cm-md-code-first'); lineClass(to, to, 'cm-md-code-last');
        const shown = linesTouch(state, from, to);
        for (const child of children(node)) if (child.name === 'CodeMark' || child.name === 'CodeInfo') {
          if (shown) marker(child.from, child.to);
          else { hide(child.from, child.to); lineClass(child.from, child.from, 'cm-md-collapsed'); }
        }
        return false;
      }
      case 'InlineCode': {
        mark(from, to, 'cm-md-inline-code');
        const shown = touches(state, from, to);
        for (const child of children(node)) if (child.name === 'CodeMark') shown ? marker(child.from, child.to) : hide(child.from, child.to);
        return false;
      }
      case 'StrongEmphasis': span(node, 'EmphasisMark', 'cm-md-strong'); return;
      case 'Emphasis': span(node, 'EmphasisMark', 'cm-md-emphasis'); return;
      case 'Strikethrough': span(node, 'StrikethroughMark', 'cm-md-strike'); return;
      case 'Link': case 'Image': link(node); return;
      case 'Autolink': {
        const shown = touches(state, from, to);
        for (const child of children(node)) {
          if (child.name === 'URL') mark(child.from, child.to, 'cm-md-link');
          else if (child.name === 'LinkMark') shown ? marker(child.from, child.to) : hide(child.from, child.to);
        }
        return false;
      }
      case 'URL': if (!['Link', 'Image'].includes(node.parent?.name)) mark(from, to, 'cm-md-link'); return;
      case 'Escape': if (!touches(state, from, to)) hide(from, from + 1); return;
      case 'ListMark': list(node); return;
      case 'TaskMarker': {
        const bullet = node.parent?.parent?.getChild('ListMark');
        // Tasks under a bullet were drawn with it; others keep their number.
        if (bullet && /^[-+*]$/.test(text(bullet.from, bullet.to)) && /[ \t]/.test(text(bullet.to, bullet.to + 1)) && blank.test(text(bullet.to, from))) return;
        if (overlaps(state, from, to)) marker(from, to);
        else hide(from, to, new Task(from, /x/i.test(text(from, to))));
        return;
      }
      case 'ThoughtLinkTarget': hide(from, to); return false;
      case 'ThoughtLinkLabel': mark(from, to, 'cm-md-link'); return;
      case 'ThoughtLink': mark(from, to, 'cm-thought-link'); return;
      case 'ThoughtLinkMark': touches(state, node.parent.from, node.parent.to) ? marker(from, to) : hide(from, to); return;
    }
  } });
  for (const [from, classes] of lines) ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return Decoration.set(ranges, true);
}
const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = decorate(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = decorate(update.view);
  }
}, { decorations: plugin => plugin.decorations });

const speechPreview = StateEffect.define();
class SpeechPreview extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  toDOM() { const span = document.createElement('span'); span.className = 'cm-dictation-preview'; span.textContent = this.text; span.setAttribute('aria-hidden','true'); return span; }
  ignoreEvent() { return true; }
}
const liveSpeech = StateField.define({
  create: () => ({ text:'', decorations:Decoration.none }),
  update(value, transaction) {
    let text = value.text;
    for (const effect of transaction.effects) if (effect.is(speechPreview)) text = effect.value;
    const at = transaction.state.selection.main.to, before = transaction.state.doc.sliceString(Math.max(0,at-1),at);
    const prefix = before && !/\s/u.test(before) && !/^[.,!?;:)}\]]/u.test(text) ? ' ' : '';
    return { text, decorations:text ? Decoration.set([Decoration.widget({widget:new SpeechPreview(prefix+text),side:1}).range(at)]) : Decoration.none };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

export function createLiveEditor(parent, { value, nonce, onChange, onLimit, findThoughts, onOpenThought, onSubmit, emptyText = '' }) {
  const editable = new Compartment(),insertions=new Set(); let readOnly = false, destroyed = false;
  const makeState = value => EditorState.create({
    doc: value, selection: { anchor: value.length },
    extensions: [
      EditorView.cspNonce.of(nonce),
      markdown({ extensions: [GFM, wikiLinks] }), tables, livePreview, hiddenTargets, ideaMarkers, liveSpeech,
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
          if (['Link', 'Autolink', 'URL'].includes(node.name)) {
            const target = node.name === 'URL' ? node : node.getChild('URL');
            const url = target && externalLink(view.state.doc.sliceString(target.from, target.to));
            if (url) { event.preventDefault(); window.open(url, '_blank', 'noopener,noreferrer'); return true; }
          }
        }
        return false;
      } }),
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= 20000) return true;
        queueMicrotask(onLimit); return false;
      }),
      EditorView.updateListener.of(update => { if (update.docChanged){
        for(const target of insertions){const collapsed=target.from===target.to;target.from=update.changes.mapPos(target.from,1);target.to=collapsed?target.from:Math.max(target.from,update.changes.mapPos(target.to,-1));}
        onChange(update.state.doc.toString());
      } })
    ]
  });
  const view = new EditorView({ parent, state: makeState(value) });
  return {
    focus() { view.focus(); },
    // The line under a collapsed cursor, for commands typed on any line.
    cursorLine() {
      const { main } = view.state.selection;
      if (!main.empty || destroyed) return null;
      const line = view.state.doc.lineAt(main.head);
      return { text: line.text, from: line.from, to: line.to, alone: view.state.doc.lines === 1 };
    },
    removeLine(from, to) {
      if (readOnly || destroyed) return;
      const length = view.state.doc.length;
      const start = to < length ? from : Math.max(0, from - 1), end = to < length ? to + 1 : to;
      view.dispatch({ changes: { from: start, to: end }, selection: { anchor: start }, userEvent: 'delete.command' });
    },
    lineRect(from) { return destroyed ? null : view.coordsAtPos(from); },
    previewText(text) {
      if (readOnly || destroyed) return false;
      if (view.state.doc.length - (view.state.selection.main.to-view.state.selection.main.from) + text.length > 20000) { onLimit(); return false; }
      view.dispatch({effects:speechPreview.of(text)}); return true;
    },
    destroy() { destroyed = true; insertions.clear(); view.destroy(); },
    captureInsertion(){
      if(readOnly||destroyed)return null;
      const target={from:view.state.selection.main.from,to:view.state.selection.main.to};insertions.add(target);
      return{cancel(){insertions.delete(target);},insert(source){
        if(destroyed||readOnly||!insertions.has(target))return false;
        const {from,to}=target,before=view.state.doc.sliceString(Math.max(0,from-2),from),after=view.state.doc.sliceString(to,to+2);
        const prefix=!before||before.endsWith('\n\n')?'':before.endsWith('\n')?'\n':'\n\n';
        const suffix=after.startsWith('\n\n')?'':after.startsWith('\n')?'\n':'\n\n';const insert=prefix+source+suffix;
        if(view.state.doc.length-(to-from)+insert.length>20000){onLimit();return false;}
        view.dispatch({changes:{from,to,insert},selection:{anchor:from+insert.length},annotations:isolateHistory.of('full'),userEvent:'input.photo'});
        target.from=target.to=from+insert.length;return true;
      }};
    },
    insertText(text) {
      if (readOnly || destroyed) return false;
      const { from, to } = view.state.selection.main;
      const before = view.state.doc.sliceString(Math.max(0, from - 1), from), after = view.state.doc.sliceString(to, to + 1);
      const prefix = before && !/[\s([{]/u.test(before) && !/^[.,!?;:)}\]]/u.test(text) ? ' ' : '';
      const suffix = after && !/[\s.,!?;:)}\]]/u.test(after) ? ' ' : '';
      const insert = prefix + text + suffix;
      if (view.state.doc.length - (to - from) + insert.length > 20000) { onLimit(); return false; }
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, annotations: isolateHistory.of('full'), userEvent: 'input.dictation' });
      return true;
    },
    setValue(value) { if (view.state.doc.toString() !== value){insertions.clear();view.setState(makeState(value));} },
    setReadOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
    }
  };
}
