import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin = process.env.JOURNAL_TEST_URL || 'http://localhost:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Browser tests may only write to a local journal.');
const password = process.env.JOURNAL_TEST_PASSWORD;
if (!password) throw new Error('Set JOURNAL_TEST_PASSWORD to the local preview password.');
const artifacts = process.env.JOURNAL_TEST_ARTIFACTS || 'test-results';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.setDefaultNavigationTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const prefix = `journal browser test ${Date.now()}`;
const ids = [];
const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Journal': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}, { path, method, body });
const setView = async view => { await page.locator('#journal-menu > summary').click(); await page.locator(`[data-view=${view}]`).click(); };
const entryMenu = async article => { await article.hover(); await article.locator('summary').click(); };
const idle = () => page.waitForFunction(() => document.querySelector('#feed').getAttribute('aria-busy') === 'false' && document.querySelector('#feed-status').textContent !== 'loading…');

try {
  await page.goto(origin);
  await page.locator('#password').fill(password);
  await page.locator('#unlock').click();
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
  await idle();
  assert.equal(await page.evaluate(() => document.cookie.includes('journal')), false, 'session cookie is HttpOnly');
  const prior = await api('thoughts?q=journal%20browser%20test');
  for (const entry of prior.data.entries) if (entry.body.startsWith('journal browser test ')) await api(`thoughts/${entry.id}`, 'DELETE', {});
  const initial = await api('draft');
  if (initial.data.body) throw new Error('Use a clean local database: browser tests will not overwrite an existing draft.');

  const first = `${prefix}: basketball after a day of building things. café hopping tomorrow.\n\n${'a longer thought belongs here too. '.repeat(12)}`.trim();
  await page.locator('#body').fill(first);
  await page.waitForFunction(() => document.querySelector('#draft-status').textContent === 'draft saved');
  await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#body').inputValue(), first, 'draft survives reload');
  await page.locator('#post').click();
  await page.waitForFunction(text => [...document.querySelectorAll('.thought-body')].some(p => p.textContent === text), first);
  const root = (await api(`thoughts?q=${encodeURIComponent(prefix)}`)).data.entries[0]; ids.push(root.id);
  const article = page.locator(`article[data-id="${root.id}"]`);

  await article.locator('[data-action=expand]').waitFor({state:'visible'});
  assert.equal(await article.locator('.thought-body').evaluate(element => element.scrollHeight > element.clientHeight), true);
  await article.locator('[data-action=expand]').click();
  assert.equal(await article.locator('.thought-body').evaluate(element => element.classList.contains('collapsed')), false);
  await article.locator('[data-action=expand]').click();
  await entryMenu(article);
  await article.locator('[data-action=bookmark]').click();
  await setView('saved');
  await page.waitForFunction(id => Boolean(document.querySelector(`article[data-id="${id}"] button[aria-pressed=true]`)), root.id);
  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('cafe');
  await page.waitForFunction(() => document.querySelector('#view-title').textContent === 'search' && document.querySelector('mark')?.textContent === 'café');
  await page.locator('#clear-search').click();
  await idle();

  await entryMenu(article);
  await article.locator('[data-action=reply]').click();
  const reply = `${prefix}: a little more to remember.`;
  await page.locator('#body').fill(reply);
  await page.locator('#post').click();
  await page.waitForFunction(text => [...document.querySelectorAll('.thought-body')].some(p => p.textContent === text), reply);
  const replyEntry = (await api(`thoughts?q=${encodeURIComponent(prefix)}`)).data.entries.find(e => e.body === reply); ids.push(replyEntry.id);
  await page.locator(`article[data-id="${root.id}"] [data-action=thread]`).first().click();
  await page.waitForFunction(() => document.querySelector('#view-title').textContent === 'thread' && document.querySelectorAll('.thought').length === 2);

  await entryMenu(article);
  await article.locator('[data-action=edit]').click();
  const edited = `${prefix}: soccer and coffee instead. <img src=x onerror=alert(1)>`;
  await page.locator('#edit-body').fill(edited);
  await page.locator('#edit-form button[type=submit]').click();
  await page.waitForFunction(text => [...document.querySelectorAll('.thought-body')].some(p => p.textContent === text), edited);
  assert.equal(await page.locator('.thought-body img').count(), 0, 'HTML is rendered as text');
  await entryMenu(article);
  await article.locator('[data-action=public]').click();
  assert.equal(await page.locator('#public-body').inputValue(), edited);
  await page.locator('#public-body').fill('a separate public draft');
  await page.locator('#copy-public').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'a separate public draft');
  await page.locator('[data-close=public-dialog]').click();
  assert.equal((await api(`thoughts?q=${encodeURIComponent(prefix)}`)).data.entries.find(e => e.id === root.id).body, edited, 'public draft does not edit journal');

  // Clearly labeled sample text for review screenshots, separate from the
  // hostile-input and conflict fixtures used to exercise the implementation.
  for (const id of ids) await api(`thoughts/${id}`, 'DELETE', {});
  ids.length = 0;
  const samples = [
    'sample thought: somewhere to leave an idea before it needs to become a post.\n\na longer thought can stay in the timeline without taking over it. open it when you want to read the rest, then fold it back into the feed. the rest of this sample stays out of the way until it is opened. short thoughts keep their full text, while longer ones leave room for the next entry.',
    'sample thought: what did i want to remember about that book?',
    'sample reply: coming back to this with a little more context.'
  ];
  for (const [index, body] of samples.entries()) {
    const result = await api('thoughts', 'POST', { id: crypto.randomUUID(), body, reply_to: index === 2 ? ids[0] : null });
    ids.push(result.data.entry.id);
  }
  await api(`thoughts/${ids[1]}`, 'PATCH', { bookmarked: true });
  await setView('all'); await idle();
  await page.locator('#search-toggle').click();
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile has no horizontal overflow');
  const fontStatus = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map(font => ({ family: font.family, status: font.status })); });
  assert.ok(fontStatus.some(font => font.family.includes('Instrument Sans') && font.status === 'loaded'), 'homepage body font loads');

  // A second tab changes the draft: the first must preserve its own text.
  const oldVersion = (await api('draft')).data.version;
  await api('draft', 'PUT', { body: 'another device draft', reply_to: null, version: oldVersion });
  await page.locator('#body').fill('local text that must survive a conflict');
  await page.waitForFunction(() => document.querySelector('#draft-status').textContent.includes('changed elsewhere'));
  assert.equal(await page.locator('#body').inputValue(), 'local text that must survive a conflict');
  assert.equal((await api('draft')).data.body, 'another device draft');
  const draftVersion = (await api('draft')).data.version;
  await api('draft', 'PUT', { body: '', reply_to: null, version: draftVersion });
  // Reload after explicitly discarding this synthetic conflict, then test lock.
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#journal-menu > summary').click();
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal((await api('thoughts')).status, 401, 'locking revokes server session');
  assert.equal(await page.locator('#feed').textContent(), '', 'locking clears displayed thoughts');
  await page.locator('#password').fill(password); await page.locator('#unlock').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  for (const id of ids) await api(`thoughts/${id}`, 'DELETE', {});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['login', 'HttpOnly session', 'draft restore', 'post', 'truncation/expand', 'bookmark', 'search', 'thread', 'edit', 'HTML safety', 'public draft isolation', 'desktop/mobile', 'font loading', 'draft conflict', 'logout revocation'], screenshots: artifacts }));
} catch (error) {
  console.error(JSON.stringify({ pageErrors: errors, notice: await page.locator('#notice').textContent().catch(() => ''), feed: await page.locator('#feed-status').textContent().catch(() => '') }));
  await page.screenshot({path: `${artifacts}/failure.png`, fullPage:true}).catch(() => {});
  throw error;
} finally {
  // This test refuses remote hosts and creates only synthetic local entries.
  await browser.close();
}
