// The writing field doubles as a command bar: a line starting with "/" that
// could still become a command opens a menu, on any line of a note.
const $ = selector => document.querySelector(selector);

export const COMMANDS = [
  { name: 'idea', hint: 'log a writing idea, or list them', takes: 'idea', captures: true },
  { name: 'project', hint: 'log a project idea, or list them', takes: 'idea', captures: true },
  { name: 'ideas', hint: 'your writing ideas' },
  { name: 'projects', hint: 'your project ideas' },
  { name: 'timeline', hint: 'show or hide the timeline' },
  { name: 'draft', hint: 'your essay drafts' },
  { name: 'focus', hint: 'hide everything but the page' },
  { name: 'random', hint: 'open a random thought' },
  { name: 'onthisday', hint: 'this date in earlier years' },
  { name: 'read', hint: 'save a link, or open read later', takes: 'link' },
  { name: 'lock', hint: 'lock the journal' },
  { name: 'cl', hint: 'clear the left side' },
  { name: 'cr', hint: 'clear the right side' }
];

// A command is one line: "/name" or "/name argument".
export function parseCommand(text) {
  const match = /^\/([a-z]*)(?:[ \t]+(.*))?$/i.exec(text.trim());
  if (!match || text.trim().includes('\n')) return null;
  return { name: match[1].toLowerCase(), argument: (match[2] || '').trim(), spaced: /\s/.test(text.trim()) };
}

// Commands the text could still become. Anything else is ordinary writing,
// even if it starts with "/".
export function commandMatches(text) {
  const command = parseCommand(text);
  if (!command) return [];
  return command.spaced ? COMMANDS.filter(item => item.name === command.name) : COMMANDS.filter(item => item.name.startsWith(command.name));
}

export function createCommands({ getEditor, fill, run, receipt }) {
  const menu = $('#command-menu'), history = [];
  let matches = [], active = 0, browsing = null, dismissed = null;

  function render() {
    menu.replaceChildren(...matches.map((command, index) => {
      const item = document.createElement('li');
      item.id = `command-${command.name}`; item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === active));
      const name = document.createElement('span'); name.className = 'command-name'; name.textContent = `/${command.name}`;
      const hint = document.createElement('span'); hint.className = 'command-hint'; hint.textContent = command.hint;
      item.append(name, hint);
      item.addEventListener('mousedown', event => { event.preventDefault(); active = index; execute(); });
      return item;
    }));
    menu.hidden = !matches.length;
    menu.setAttribute('aria-activedescendant', matches[active] ? `command-${matches[active].name}` : '');
  }

  function update() {
    const line = getEditor()?.cursorLine(), previous = matches[active]?.name;
    // Esc keeps the menu closed until that line changes.
    if (dismissed !== null && line?.text !== dismissed) dismissed = null;
    matches = line && dismissed === null ? commandMatches(line.text) : [];
    active = Math.max(0, matches.findIndex(item => item.name === previous));
    render();
  }

  function hide() { matches = []; render(); }

  // Returns false when Enter should keep its usual meaning (a new line).
  function execute() {
    const editor = getEditor(), line = editor?.cursorLine(), chosen = matches[active];
    const command = line && parseCommand(line.text);
    if (!command || !chosen) return true;
    // Typing past a full name keeps its argument; picking from the menu has none.
    const argument = command.name === chosen.name ? command.argument : '';
    history.push(`/${chosen.name}${argument ? ` ${argument}` : ''}`); if (history.length > 30) history.shift();
    hide();
    // "/idea …" inside a longer note stays there as its tag; the idea is
    // indexed when the note is saved, and Enter just moves to the next line.
    if (chosen.captures && argument && !line.alone) { receipt(chosen.name === 'idea' ? 'idea noted' : 'project noted'); return false; }
    const rect = editor.lineRect(line.from);
    if (line.alone) fill(''); else editor.removeLine(line.from, line.to);
    run(chosen.name, argument, { standalone: line.alone, rect });
    return true;
  }

  // Capture runs before the editor's own keymap, so Enter runs a command
  // rather than starting a new line, and the arrows move through the menu.
  $('#composer-editor').addEventListener('keydown', event => {
    if (event.isComposing) return;
    const key = event.key, line = getEditor()?.cursorLine();
    // Up in an empty field walks back through recent commands, like a terminal.
    if ((key === 'ArrowUp' || key === 'ArrowDown') && history.length && (browsing !== null || (key === 'ArrowUp' && line?.alone && !line.text))) {
      browsing = browsing === null ? history.length - 1 : Math.max(0, Math.min(history.length, browsing + (key === 'ArrowUp' ? -1 : 1)));
      fill(history[browsing] ?? '');
      if (browsing === history.length) browsing = null;
      event.preventDefault(); event.stopPropagation(); return;
    }
    browsing = null;
    if (menu.hidden) return;
    if (key === 'ArrowDown' || key === 'ArrowUp') active = (active + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
    else if (key === 'Tab') {
      const chosen = matches[active];
      if (!line?.alone) return;
      fill(`/${chosen.name}${chosen.takes ? ' ' : ''}`);
    } else if (key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) { if (!execute()) return; }
    else if (key === 'Escape') { dismissed = line?.text ?? null; hide(); }
    else return;
    event.preventDefault(); event.stopPropagation();
    if (!menu.hidden) render();
  }, true);

  // Moving the cursor onto or off a command line opens or closes the menu.
  $('#composer-editor').addEventListener('keyup', event => { if (!['Enter', 'Tab', 'Escape'].includes(event.key)) update(); });
  $('#composer-editor').addEventListener('mouseup', () => setTimeout(update));

  return { update, hide };
}
