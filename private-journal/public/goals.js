// Goals float on the right of the writing, where they stay in sight while you
// write. A goal is done once: pressing it marks it kept. A habit is kept day
// by day: pressing it marks today, and its last week shows as seven dots. On
// either, the bullet turns into an x that drops it.
const $ = selector => document.querySelector(selector);
const DAY = 86400000;
const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
// Habits are marked by the writer's own calendar day, not the server's.
const pad = number => String(number).padStart(2, '0');
const localDay = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const daysBefore = (count, from = new Date()) => localDay(new Date(from.getFullYear(), from.getMonth(), from.getDate() - count));

// Consecutive days kept, counting back from today, or from yesterday while
// today is still open.
export function streak(days, now = new Date()) {
  const kept = new Set(days);
  let count = 0;
  const back = kept.has(localDay(now)) ? 0 : 1;
  while (kept.has(daysBefore(back + count, now))) count++;
  return count;
}

export function createGoals({ api, notice }) {
  let goals = null, hidden = false, asked = false;
  const float = () => $('#float-right');
  const element = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text) item.textContent = text; return item; };

  function row(goal, index, meta, hint, press, lead = null) {
    const item = element('div', `float-idea float-goal${goal.done_at ? ' is-done' : ''}`); item.dataset.goal = goal.id;
    item.style.animationDelay = `${Math.min(index + 1, 8) * 18}ms`;
    const remove = element('button', 'float-bullet float-remove'); remove.type = 'button';
    remove.setAttribute('aria-label', goal.kind === 'habit' ? 'drop this habit' : 'drop this goal');
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await api(`goals/${goal.id}`, { method: 'DELETE' }); goals = goals.filter(other => other.id !== goal.id); render(false); }
      catch (error) { remove.disabled = false; notice(error.message); }
    });
    const toggle = element('button', 'float-item'); toggle.type = 'button';
    const since = element('span', 'float-date'), idle = element('span', 'float-date-idle');
    idle.append(...meta);
    // Hovering says what a press does, so marking one is findable; a habit's
    // week stays in view so a press shows today filling in.
    since.append(...(lead ? [lead] : []), idle, element('span', 'float-date-hint', hint));
    toggle.append(element('span', 'float-text', goal.text), since);
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await press(); } catch (error) { toggle.disabled = false; notice(error.message); }
    });
    item.append(remove, toggle);
    return { item, toggle };
  }

  function goalRow(goal, index) {
    // How long it has been held, counted in days from the day it was set.
    const held = `day ${Math.floor((Date.now() - new Date(goal.created_at).setHours(0, 0, 0, 0)) / DAY) + 1}`;
    const { item, toggle } = row(goal, index, [goal.done_at ? `kept ${day(goal.done_at)}` : held], goal.done_at ? 'press to reopen' : 'press to mark kept', async () => {
      await api(`goals/${goal.id}`, { method: 'PATCH', body: JSON.stringify({ done: !goal.done_at }) });
      await load(false);
    });
    toggle.setAttribute('aria-pressed', String(Boolean(goal.done_at)));
    return item;
  }

  function habitRow(goal, index) {
    const today = localDay(), kept = new Set(goal.days), done = kept.has(today), run = streak(goal.days);
    // The last seven days, today on the right.
    const week = element('span', 'habit-week'); week.setAttribute('aria-hidden', 'true');
    for (let back = 6; back >= 0; back--) week.append(element('span', `habit-day${kept.has(daysBefore(back)) ? ' is-kept' : ''}`));
    const meta = run > 1 ? [element('span', 'habit-streak', `${run} days in a row`)] : done ? [element('span', 'habit-streak', 'done today')] : [];
    const { item, toggle } = row(goal, index, meta, done ? 'press to undo today' : 'press to mark today', async () => {
      await api(`goals/${goal.id}/days/${today}`, { method: 'PUT', body: JSON.stringify({ done: !done }) });
      goal.days = done ? goal.days.filter(other => other !== today) : [today, ...goal.days];
      render(false);
      // The new row takes the place of the one pressed; keep the keyboard on it.
      float().querySelector(`[data-goal="${goal.id}"] .float-item`)?.focus({ preventScroll: true });
    }, week);
    toggle.setAttribute('aria-pressed', String(done));
    toggle.setAttribute('aria-label', `${goal.text}, ${run > 1 ? `${run} days in a row` : done ? 'done today' : 'not done today'}`);
    return item;
  }

  function render(animate) {
    const list = float();
    if (hidden || !goals || (!goals.length && !asked)) { list.replaceChildren(); list.hidden = true; delete list.dataset.showing; return; }
    const habits = goals.filter(goal => goal.kind === 'habit'), others = goals.filter(goal => goal.kind !== 'habit');
    const children = [];
    // Two short lists when both kinds exist: habits, then goals.
    if (habits.length) children.push(element('p', 'float-heading', 'habits'), ...habits.map(habitRow));
    if (others.length || !habits.length) children.push(element('p', 'float-heading', 'goals'), ...others.map((goal, index) => goalRow(goal, index + habits.length)));
    if (!goals.length) children.push(element('p', 'float-empty', 'nothing committed to yet. set a goal with /goal … or a habit with /habit …'));
    list.classList.toggle('is-quiet', !animate);
    list.replaceChildren(...children); list.hidden = false; list.dataset.showing = 'goals';
  }

  async function load(animate = true) {
    const data = await api('goals');
    goals = data.goals; render(animate);
    return goals;
  }

  return {
    load,
    // Setting a goal or habit brings the list back even if it was cleared away.
    async add(text, kind = 'goal') {
      const { goal } = await api('goals', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID().replaceAll('-', ''), kind, text }) });
      hidden = false; await load(!float().dataset.showing);
      return goal;
    },
    async show() { hidden = false; asked = true; if (goals) render(true); await load(!goals); },
    hide() { hidden = true; asked = false; render(false); },
    clear() { goals = null; hidden = false; asked = false; render(false); }
  };
}
