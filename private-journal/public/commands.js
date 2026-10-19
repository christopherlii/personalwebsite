// The writing field doubles as a command bar: a single line starting with "/"
// opens a menu of commands instead of searching or saving a draft.
const $ = selector => document.querySelector(selector);

export const COMMANDS = [
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

export function createCommands({ getText, fill, run }) {
  const menu = $('#command-menu');
  let matches = [], active = 0;

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
    const previous = matches[active]?.name;
    matches = commandMatches(getText());
    active = Math.max(0, matches.findIndex(item => item.name === previous));
    render();
  }

  function hide() { matches = []; render(); }

  async function execute() {
    const command = parseCommand(getText()), chosen = matches[active];
    if (!command || !chosen) return;
    // Typing past a full name keeps its argument; picking from the menu has none.
    const argument = command.name === chosen.name ? command.argument : '';
    hide(); fill('');
    await run(chosen.name, argument);
  }

  // Capture runs before the editor's own keymap, so Enter runs a command
  // rather than starting a new line, and the arrows move through the menu.
  $('#composer-editor').addEventListener('keydown', event => {
    if (menu.hidden || event.isComposing) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') active = (active + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
    else if (key === 'Tab') {
      const chosen = matches[active];
      fill(`/${chosen.name}${chosen.takes ? ' ' : ''}`);
    } else if (key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) execute();
    else if (key === 'Escape') hide();
    else return;
    event.preventDefault(); event.stopPropagation();
    if (!menu.hidden) render();
  }, true);

  return { update, hide };
}
