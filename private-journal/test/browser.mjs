import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { publicSitePreview } from './public-site.mjs';
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
const setView = async view => { await page.locator('#journal-menu-toggle').click(); await page.locator(`[data-view=${view}]`).click(); };
const openReader = async article => {
  await article.hover(); await article.locator('[data-action=read]').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
};
const readerMenu = async () => { await page.locator('#reader-menu-toggle').click(); };
const backToFeed = async () => { await page.locator('#reader-back').click(); await page.locator('#app').waitFor({ state: 'visible' }); };
const fillThought = async value => {
  const editor = page.locator('#live-editor .cm-content');
  await editor.click(); await editor.press('ControlOrMeta+a'); await page.keyboard.insertText(value);
  await page.waitForFunction(value => document.querySelector('#edit-body').value === value, value);
};
const blankDraft = async () => {
  await page.waitForFunction(async () => {const draft=await(await fetch('/api/draft')).json();return draft.body===''&&draft.title==='';});
  const { status, data } = await api('draft');
  assert.equal(status, 200); assert.equal(data.body, ''); assert.equal(data.title, '');
};
const fillComposer = async value => {
  const editor = page.locator('#composer-editor .cm-content');
  await editor.click(); await editor.press('ControlOrMeta+a');
  if (value) await page.keyboard.insertText(value); else await editor.press('Backspace');
  await page.waitForFunction(value => document.querySelector('#body').value === value, value);
};
const clearComposer = async () => {
  const persisted = page.waitForResponse(response => response.url().endsWith('/api/draft') && response.request().method() === 'PUT' && response.ok() && response.request().postDataJSON().body === '');
  await fillComposer(''); await persisted;
};
const idle = () => page.waitForFunction(() => document.querySelector('#feed').getAttribute('aria-busy') === 'false' && document.querySelector('#feed-status').textContent !== 'loading…');
const settled = () => page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
const feedLayout = () => page.locator('#composer-section, #feed > .thought').evaluateAll(elements => elements.map(element => {
  const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
}));

try {
  await page.goto(origin);
  await page.locator('#password').fill(password);
  await page.locator('#unlock').click();
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
  await idle();
  assert.equal(await page.evaluate(() => document.cookie.includes('journal')), false, 'session cookie is HttpOnly');
  const prior = await api('thoughts?q=journal%20browser%20test');
  for (const entry of prior.data.entries) if (entry.body.startsWith('journal browser test ')) {
    const publication = (await api(`thoughts/${entry.id}/publication`)).data;
    if (publication.published) await api(`thoughts/${entry.id}/publication/unpublish`, 'POST', { version: publication.version });
    await api(`thoughts/${entry.id}`, 'DELETE', {});
  }
  const initial = await api('draft');
  if (initial.data.body || initial.data.title) throw new Error('Use a clean local database: browser tests will not overwrite an existing draft.');

  const first = `${prefix}: basketball after a day of building things. café hopping tomorrow.\n\n${'a longer thought belongs here too. '.repeat(12)}`.trim();
  await fillComposer(first);
  await page.locator('#add-title').click();
  await page.locator('#title').fill('a day of building');
  await page.waitForFunction(async () => document.querySelector('#composer').dataset.draftState==='saved' && (await (await fetch('/api/draft')).json()).body === document.querySelector('#body').value);
  await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#body').inputValue(), first, 'draft survives reload');
  assert.equal(await page.locator('#title').inputValue(), 'a day of building', 'title survives reload');
  await page.locator('#post').click();
  await page.waitForFunction(text => [...document.querySelectorAll('#feed .thought-body')].some(p => p.textContent.startsWith(text)), first.split('\n')[0]);
  const root = (await api(`thoughts?q=${encodeURIComponent(prefix)}`)).data.entries[0]; ids.push(root.id);
  const article = page.locator(`article[data-id="${root.id}"]`);

  await page.mouse.move(0, 0);
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`article[data-id="${id}"] .thought-date`)).opacity === '0', root.id);
  await article.hover();
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`article[data-id="${id}"] .thought-date`)).opacity === '1', root.id);
  const openBeforeCopy = await article.locator('[data-action=read]').boundingBox();
  await article.locator('[data-action=copy]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `a day of building\n\n${first}`, 'direct copy includes title and full body');
  assert.equal(await article.locator('[data-action=copy]').textContent(), 'copy', 'copy feedback keeps the compact label');
  assert.equal(await page.locator('#copy-status').textContent(), 'thought copied');
  assert.deepEqual(await article.locator('[data-action=read]').boundingBox(), openBeforeCopy, 'copy feedback never moves the adjacent action');
  await page.mouse.move(0, 0);
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`article[data-id="${id}"] .entry-footer`)).opacity === '0', root.id);
  await article.hover();
  const initialPreview = await article.locator('.thought-body').textContent();
  assert.equal(await article.locator('.thought-body').evaluate(element => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(element.textContent)].length), 280);
  assert.ok(initialPreview.endsWith('…'));
  assert.equal(await article.locator('.thought-body').evaluate(element => getComputedStyle(element).webkitLineClamp), 'none', 'the character preview is not clipped to three lines');
  assert.equal(await article.locator('[data-action=expand]').count(), 0, 'thoughts have no inline expansion');
  await article.locator('[data-action=read]').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#reader .thought-body p').allTextContents()).join('\n\n'), first, 'open navigates to the complete writing');
  assert.equal(await page.locator('#reader-back').textContent(), 'back');
  await page.locator('#reader-back').click(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await article.locator('.thought-body').textContent(), initialPreview, 'back returns to the unchanged preview');
  await openReader(article); await readerMenu();
  await page.locator('#reader-bookmark').click();
  await page.waitForFunction(() => document.querySelector('#reader-bookmark').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#reader-status [aria-label=bookmarked]').count(), 1, 'reading view shows the heart');
  assert.equal(await article.locator('.entry-heart').count(), 1, 'feed also shows the heart');
  await backToFeed(); await setView('saved');
  await article.waitFor();
  await openReader(article); await readerMenu(); await page.locator('#reader-bookmark').click();
  await page.waitForFunction(() => document.querySelector('#reader-bookmark').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('#reader-status .entry-heart').count(), 0, 'removing the bookmark removes its indicator');
  await backToFeed();
  await page.waitForFunction(() => document.querySelector('#feed-status').textContent === 'no bookmarks yet.');
  await setView('all'); await idle();
  const previewEdgeCases = await page.evaluate(async () => {
    const { markdownPreview } = await import('./markdown.js');
    const emoji = '👩🏽‍💻';
    const exact = markdownPreview(`**${emoji.repeat(280)}**`);
    const longer = markdownPreview(`**${emoji.repeat(281)}**`);
    const link = markdownPreview(`[${'x'.repeat(300)}](https://example.com)`);
    const unsafe = markdownPreview('<img src=x onerror=alert(1)> [unsafe](javascript:alert%281%29)');
    return { exact: exact.textContent, longer: longer.textContent, bold: longer.querySelector('strong')?.textContent,
      link: link.querySelector('a')?.textContent, href: link.querySelector('a')?.href,
      unsafe: unsafe.querySelectorAll('img,script,a').length };
  });
  assert.equal(previewEdgeCases.exact, '👩🏽‍💻'.repeat(280), 'the limit counts visible characters without splitting emoji');
  assert.equal(previewEdgeCases.longer, '👩🏽‍💻'.repeat(279) + '…');
  assert.equal(previewEdgeCases.bold, previewEdgeCases.longer, 'truncation preserves formatting');
  assert.equal(previewEdgeCases.link, 'x'.repeat(279) + '…');
  assert.equal(previewEdgeCases.href, 'https://example.com/');
  assert.equal(previewEdgeCases.unsafe, 0, 'feed previews retain the safe Markdown rules');
  await fillComposer('cafe');
  await page.waitForFunction(() => document.querySelector('#view-title').classList.contains('sr-only') && document.querySelector('mark')?.textContent === 'café');
  await clearComposer();
  await idle(); await blankDraft();

  await openReader(article);
  await page.locator('#reader-edit').click();
  const edited = `${prefix}: soccer and coffee instead. <img src=x onerror=alert(1)>`;
  await fillThought(edited);
  await page.locator('#edit-thought-title').fill('a different day <img src=x onerror=alert(1)>');
  await page.locator('#reader-save').click();
  await page.locator('#edit-form').waitFor({ state: 'hidden' });
  await page.waitForFunction(text => [...document.querySelectorAll('.thought-body')].some(p => p.textContent === text), edited);
  assert.equal(await page.locator('.thought-body img').count(), 0, 'HTML is rendered as text');
  assert.equal(await article.locator('.thought-title img').count(), 0, 'title HTML is text too');
  await readerMenu();
  await page.locator('#reader-public').click();
  await page.locator('#public-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#public-body').inputValue(), edited);
  await page.locator('#public-body').fill('a separate public draft');
  await page.locator('#public-thought-title').fill('public version');
  const publicDialogBeforeMenu = await page.locator('#public-dialog').boundingBox();
  const publicBodyBeforeMenu = await page.locator('#public-body').boundingBox();
  await page.locator('#public-menu-toggle').click();
  await settled();
  assert.deepEqual(await page.locator('#public-dialog').boundingBox(), publicDialogBeforeMenu, 'public options do not resize or recenter the dialog');
  assert.deepEqual(await page.locator('#public-body').boundingBox(), publicBodyBeforeMenu, 'public options keep the writing still');
  await page.locator('#copy-public').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'public version\n\na separate public draft');
  await page.locator('[data-close=public-dialog]').click();
  await page.locator('#public-dialog').waitFor({ state: 'hidden' });
  assert.equal((await api(`thoughts?q=${encodeURIComponent(prefix)}`)).data.entries.find(e => e.id === root.id).body, edited, 'public draft does not edit journal');

  await readerMenu(); await page.locator('#reader-public').click();
  await page.locator('#public-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#public-body').inputValue(), 'a separate public draft', 'public draft is saved independently');
  await page.locator('#publish-public').click();
  await page.waitForFunction(() => document.querySelector('#public-status').textContent === 'published');
  assert.equal(await page.locator('#reader-content .thought-title .entry-published').textContent(), 'published');
  assert.equal(await page.locator('#reader-status .entry-published').count(), 0, 'publication status sits beside the title');
  assert.equal(await article.locator('.thought-title .entry-published').count(), 1);
  assert.equal(await article.locator('.entry-published').count(), 1, 'publishing updates the existing feed entry');
  const publicSite = await publicSitePreview(context, origin);
  await publicSite.emulateMedia({ reducedMotion: 'reduce' });
  await publicSite.goto('https://site-preview.test/#thoughts');
  await publicSite.getByRole('link', { name: /public version/ }).waitFor();
  await publicSite.getByRole('link', { name: /public version/ }).click();
  await publicSite.locator('.article-body').filter({ hasText: 'a separate public draft' }).waitFor();
  await publicSite.waitForFunction(() => !document.documentElement.classList.contains('route-pending'));
  await publicSite.locator('.article-body').scrollIntoViewIfNeeded();
  assert.equal(await publicSite.locator('.article-body').textContent().then(text => text.trim()), 'a separate public draft');
  await publicSite.screenshot({ path: `${artifacts}/public-site-post.png`, fullPage: true });
  await page.locator('#public-body').fill('a still private revision');
  await page.locator('#save-public').click();
  await page.waitForFunction(() => document.querySelector('#public-status').textContent === 'unpublished changes');
  await publicSite.reload();
  await publicSite.locator('.article-body').filter({ hasText: 'a separate public draft' }).waitFor();
  assert.equal(await publicSite.locator('.article-body').textContent().then(text => text.trim()), 'a separate public draft', 'saved edits stay private on the real public frontend');
  await page.screenshot({ path: `${artifacts}/publishing-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/publishing-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#publish-public').click();
  await page.waitForFunction(() => document.querySelector('#public-status').textContent === 'published');
  await publicSite.reload();
  await publicSite.locator('.article-body').filter({ hasText: 'a still private revision' }).waitFor();
  const publicOptions = page.locator('#public-menu-toggle');
  if (await publicOptions.getAttribute('aria-expanded') !== 'true') await publicOptions.click();
  await page.locator('#unpublish').click();
  await page.waitForFunction(() => document.querySelector('#public-status').textContent === 'unpublished');
  assert.equal(await page.locator('#reader-content .entry-published').count(), 0);
  assert.equal(await article.locator('.entry-published').count(), 0, 'unpublishing removes the feed indicator');
  await publicSite.goto('https://site-preview.test/#thoughts');
  await publicSite.reload();
  await publicSite.locator('#thoughts-full-list .empty-note').waitFor();
  assert.equal(await publicSite.locator('.thought-row').count(), 0, 'unpublishing removes writing from the public site');
  await publicSite.close();
  await page.locator('[data-close=public-dialog]').click();
  await page.locator('#public-dialog').waitFor({ state: 'hidden' });

  await backToFeed();

  // Clearly labeled sample text for review screenshots, separate from the
  // hostile-input and conflict fixtures used to exercise the implementation.
  for (const id of ids) await api(`thoughts/${id}`, 'DELETE', {});
  ids.length = 0;
  const markdownSample = [
    'sample thought: somewhere to leave an idea before it needs to become a post.',
    '## holding an idea',
    'Some thoughts need **a little structure**, others just *a sentence*. Keep the writing itself at the center.',
    '- a question to return to\n- a connection worth following\n  - an unfinished thread',
    '> Leave room for a thought to change.',
    'Try `one small step` before making a plan.',
    '```\nwrite → revisit → revise\n```',
    '- [x] write it down\n- [ ] come back to it',
    '| idea | next step |\n| --- | --- |\n| unfinished | revisit |',
    '[a reference](https://example.com)'
  ].join('\n\n');
  const samples = [markdownSample,
    'sample thought: what did i want to remember about that book?',
    'sample thought: a passing idea worth keeping.'
  ];
  const sampleEntries = [];
  const sampleTitles = ['a place for unfinished ideas', 'a note from that book', 'a small observation'];
  for (const [index, body] of samples.entries()) {
    const result = await api('thoughts', 'POST', { id: crypto.randomUUID(), title: sampleTitles[index], body });
    ids.push(result.data.entry.id); sampleEntries.push(result.data.entry);
  }
  await api(`thoughts/${ids[1]}`, 'PATCH', { bookmarked: true });
  await setView('all'); await idle();
  const markdownPreview = page.locator(`article[data-id="${ids[0]}"] .thought-preview`);
  assert.ok(await markdownPreview.locator('strong').count(), 'the feed renders Markdown emphasis');
  assert.ok(await markdownPreview.locator('ul').count(), 'the feed preserves list structure');
  assert.ok((await markdownPreview.textContent()).endsWith('…'));
  await page.evaluate(() => document.fonts.ready);
  await settled();
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true });
  const beforeHeaderMenu = await feedLayout();
  await page.locator('#journal-menu-toggle').click();
  await settled();
  assert.deepEqual(await feedLayout(), beforeHeaderMenu, 'header options never move the composer or notes');
  await page.screenshot({ path: `${artifacts}/header-actions.png`, fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#journal-menu').isVisible(), false, 'Escape closes header actions');
  assert.equal(await page.locator('#journal-menu-toggle').evaluate(button => button === document.activeElement), true, 'Escape returns focus to its trigger');
  const sampleArticle = page.locator(`article[data-id="${ids[2]}"]`);
  assert.equal(await sampleArticle.locator('.entry-footer svg, [data-menu]').count(), 0, 'feed actions contain only copy and open');
  await sampleArticle.hover();
  await page.screenshot({ path: `${artifacts}/note-actions.png`, fullPage: true });
  const beforeHide = await page.locator('#feed').innerHTML();
  await page.locator('#toggle-timeline').click();
  assert.equal(await page.locator('#timeline').isVisible(), false, 'hide timeline removes the whole feed');
  await page.screenshot({ path: `${artifacts}/timeline-hidden.png`, fullPage: true });
  assert.equal(await page.locator('#feed').innerHTML(), beforeHide, 'hiding preserves the existing list');
  await page.locator('#toggle-timeline').click(); await idle();
  const longSample = page.locator(`article[data-id="${ids[0]}"]`);
  await longSample.hover();
  await longSample.locator('[data-action=read]').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reader .markdown-body h2').textContent(), 'holding an idea');
  assert.equal(await page.locator('#reader .markdown-body strong').textContent(), 'a little structure');
  assert.equal(await page.locator('#reader .markdown-body ul ul li').textContent(), 'an unfinished thread');
  assert.equal(await page.locator('#reader .markdown-body blockquote').textContent(), 'Leave room for a thought to change.');
  assert.equal(await page.locator('#reader .markdown-body pre code').textContent(), 'write → revisit → revise');
  assert.equal(await page.locator('#reader .markdown-body table td').first().textContent(), 'unfinished');
  assert.equal(await page.locator('#reader .markdown-body input:checked').count(), 1);
  assert.equal(await page.locator('#app').isVisible(), false, 'reading page hides the feed and composer');
  assert.equal(await page.locator('#reader .thought-header, #reader .entry-footer').count(), 0, 'reading page contains no note chrome');
  await page.screenshot({ path: `${artifacts}/reader-desktop.png`, fullPage: true });
  await page.reload(); await page.locator('#reader').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reader .markdown-body h2').textContent(), 'holding an idea', 'Markdown renders after reloading a reading link');
  await page.locator('#reader-edit').click();
  assert.equal(await page.locator('#edit-body').inputValue(), markdownSample, 'editing preserves exact Markdown source');
  await page.screenshot({ path: `${artifacts}/editing-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'full-page editor fits 320px');
  await page.screenshot({ path: `${artifacts}/editing-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const unsafeMarkdown = markdownSample + '\n\n**an unsaved idea** [unsafe](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) <img src=x onerror=alert(1)> ![an image](https://example.com/tracker.png)';
  await fillThought(unsafeMarkdown);
  assert.equal(await page.locator('#reader-preview').count(), 0, 'live editing needs no preview toggle');
  assert.ok(await page.locator('#live-editor .cm-md-strong').count(), 'bold renders while the text is editable');
  assert.equal(await page.locator('#live-editor img:not(.cm-widgetBuffer), #live-editor script, #live-editor a[href^="javascript:"]').count(), 0, 'live Markdown cannot execute HTML or create unsafe links or remote image requests');
  assert.equal(await page.locator('#live-editor img[src]').count(), 0, 'editor caret buffers have no image sources');
  assert.equal((await api(`thoughts/${ids[0]}`)).data.entry.body, markdownSample, 'live formatting does not save changes');
  await page.locator('#live-editor .cm-md-h2').click();
  await page.waitForFunction(() => document.querySelector('#live-editor .cm-md-h2').textContent.startsWith('## '));
  assert.equal(await page.locator('#edit-body').inputValue(), unsafeMarkdown, 'revealing heading syntax preserves source');
  await page.locator('#live-editor .cm-content').press('ControlOrMeta+End');
  await page.waitForFunction(() => !document.querySelector('#live-editor .cm-md-h2').textContent.startsWith('## '));
  await page.locator('#live-editor .cm-content').press('ControlOrMeta+a');
  await page.locator('#live-editor .cm-content').press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), unsafeMarkdown, 'copying the editable document preserves all Markdown syntax');
  await page.locator('#live-editor .cm-content').press('ArrowRight');
  await page.waitForTimeout(600); // Separate the next typing transaction from the bulk paste in undo history.
  await page.keyboard.type('x');
  await page.waitForFunction(value => document.querySelector('#edit-body').value === value + 'x', unsafeMarkdown);
  await page.locator('#live-editor .cm-content').press('ControlOrMeta+z');
  await page.waitForFunction(value => document.querySelector('#edit-body').value === value, unsafeMarkdown);
  await page.locator('#live-editor .cm-content').press('ControlOrMeta+Shift+z');
  await page.waitForFunction(value => document.querySelector('#edit-body').value === value + 'x', unsafeMarkdown);
  await page.locator('#reader-cancel').click();
  assert.equal(await page.locator('#reader .markdown-body strong').count(), 1, 'cancel restores saved writing');
  await page.locator('#reader-edit').click();
  const revisedMarkdown = markdownSample + '\n\na saved revision';
  await fillThought(revisedMarkdown);
  await backToFeed();
  assert.equal((await api(`thoughts/${ids[0]}`)).data.entry.body, revisedMarkdown, 'back saves edited writing before returning');
  await openReader(longSample);
  await page.locator('#reader-edit').click();
  await fillThought(markdownSample);
  await page.locator('#reader-save').click();
  await page.locator('#edit-form').waitFor({ state: 'hidden' });
  await page.locator('#reader-edit').click();
  await fillThought(markdownSample + '\n\nmy local change');
  const currentEntry = (await api(`thoughts/${ids[0]}`)).data.entry;
  await api(`thoughts/${ids[0]}`, 'PATCH', { title: currentEntry.title, body: markdownSample + '\n\nchange from another tab', updated_at: currentEntry.updated_at });
  await page.locator('#reader-save').click();
  await page.waitForFunction(() => document.querySelector('#reader-error').textContent.includes('changed'));
  assert.equal(await page.locator('#edit-body').inputValue(), markdownSample + '\n\nmy local change', 'a conflict retains the unsaved source');
  await page.locator('#reader-back').click();
  await page.waitForFunction(() => location.hash.startsWith('#thought/'));
  assert.equal(await page.locator('#reader').isVisible(), true, 'a failed save keeps the editor open on back');
  await page.locator('#reader-cancel').click();
  await page.reload(); await page.locator('#reader').waitFor({ state: 'visible' });

  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'reading page fits a narrow screen');
  await page.screenshot({ path: `${artifacts}/reader-mobile.png`, fullPage: true });
  await page.locator('#reader-back').click(); await page.locator('#app').waitFor({ state: 'visible' }); await idle();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile has no horizontal overflow');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await openReader(sampleArticle);
    const beforeMobileMenu = await page.locator('#reader-content').boundingBox();
    await readerMenu(); await settled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `reader actions fit ${width}px`);
    assert.deepEqual(await page.locator('#reader-content').boundingBox(), beforeMobileMenu, `reader menu never shifts the ${width}px writing`);
    assert.ok(await page.locator('#reader-menu').evaluate(menu => menu.getBoundingClientRect().bottom < document.querySelector('#reader-content').getBoundingClientRect().top), 'reader menu stays above writing');
    await page.screenshot({ path: `${artifacts}/reader-actions-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await backToFeed();
  }
  assert.equal(await page.locator('.page-header').evaluate(element => getComputedStyle(element).transform), 'none', 'the header never translates while controls open');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.page-header').evaluate(element => getComputedStyle(element).animationName), 'none', 'reduced motion disables entrances');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fontStatus = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map(font => ({ family: font.family, status: font.status })); });
  assert.ok(fontStatus.some(font => font.family.includes('Instrument Sans') && font.status === 'loaded'), 'homepage body font loads');
  assert.ok(fontStatus.some(font => font.family.includes('Fraunces') && font.status === 'loaded'), 'homepage name font loads');

  // Capture the quiet inline editor before posting, then its saved entry.
  await page.setViewportSize({ width: 1280, height: 900 });
  await fillComposer('sample thought: i remember ideas better when i leave myself a few words about why they mattered.');
  await page.locator('#add-title').click();
  await page.locator('#title').fill('leaving a little context');
  await page.waitForFunction(async () => document.querySelector('#composer').dataset.draftState==='saved' && (await (await fetch('/api/draft')).json()).body === document.querySelector('#body').value);
  await idle();
  await page.screenshot({ path: `${artifacts}/composing-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/composing-mobile.png`, fullPage: true });
  await page.locator('#title').press('Enter');
  assert.equal(await page.locator('#composer-editor .cm-content').evaluate(element => element === document.activeElement), true, 'title Enter moves into the body without posting');
  const created = page.waitForResponse(response => response.url().endsWith('/api/thoughts') && response.request().method() === 'POST');
  await page.locator('#post').click();
  const newEntry = (await (await created).json()).entry; ids.push(newEntry.id);
  await page.waitForFunction(() => document.querySelectorAll('.thought').length === 4 && !document.querySelector('#body').value && !document.querySelector('#title').value);
  assert.equal(await page.locator('.thought').first().locator('.thought-title').textContent(), 'leaving a little context');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${artifacts}/posted-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/posted-mobile.png`, fullPage: true });
  const rail = await page.locator('.thought').first().evaluate(article => ({ date: article.querySelector('time').getBoundingClientRect().right, line: article.getBoundingClientRect().left, title: article.querySelector('.thought-title').getBoundingClientRect().left }));
  assert.ok(rail.date < rail.line && rail.line < rail.title, 'date stays left of the timeline on mobile');
  await api(`thoughts/${newEntry.id}`, 'DELETE', {}); await setView('all'); await idle();

  // The same field filters old entries without publishing its contents.
  await fillComposer('remember a book');
  await page.waitForFunction(id => document.querySelectorAll('.thought').length === 1 && document.querySelector('.thought').dataset.id === id, ids[1]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${artifacts}/related-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/related-mobile.png`, fullPage: true });
  assert.equal(await page.locator('#body').inputValue(), 'remember a book');
  assert.equal((await api('export')).data.entries.length, samples.length, 'typing/searching creates no timeline entry');
  await clearComposer();
  await page.waitForFunction(() => document.querySelectorAll('.thought').length === 3 && document.querySelector('#compose-actions').hidden);
  await blankDraft();
  assert.equal(await page.locator('#composer-section').evaluate(element => element.closest('.stream') === null), true, 'composer is separate from the timeline');

  // Controlled provider responses verify automatic semantic requests and stale
  // response cancellation. They do not claim to test the live model's quality.
  const semanticCalls = [];
  await page.route('**/api/session', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), semanticSearch: true } });
  });
  await page.route('**/api/search', async route => {
    const payload = route.request().postDataJSON();
    if (!payload.semantic) return route.continue();
    semanticCalls.push(payload.query);
    if (payload.query === 'older query') await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ json: { entries: payload.query === 'nothing relevant here' ? [] : [payload.query === 'older query' ? sampleEntries[0] : sampleEntries[1]], next: payload.query === 'a thought about stories' ? 40 : null, indexing: false } }).catch(() => {});
  });
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#body').inputValue(), '', 'semantic checks start with a fully cleared draft');
  const recalled = page.waitForResponse(response => response.url().endsWith('/api/search') && response.request().postDataJSON().query === 'a thought about stories' && response.request().postDataJSON().semantic);
  await page.locator('#composer-editor .cm-content').pressSequentially('a thought about stories', { delay: 10 });
  await recalled;
  await page.waitForFunction(id => document.querySelectorAll('.thought').length === 1 && document.querySelector('.thought').dataset.id === id, ids[1]);
  assert.deepEqual(semanticCalls, ['a thought about stories'], 'semantic recall waits for a typing pause');
  assert.equal(await page.locator('#body').inputValue(), 'a thought about stories');
  const oldRequest = page.waitForRequest(request => request.url().endsWith('/api/search') && request.postDataJSON().semantic && request.postDataJSON().query === 'older query');
  const retainedFeed = await page.locator('#feed').innerHTML();
  const retainedStatus = await page.locator('#feed-status').textContent();
  await fillComposer('older query');
  await page.locator('#more').click();
  assert.equal((await oldRequest).postDataJSON().cursor, 0, 'a new query never reuses the previous result page');
  assert.equal(await page.locator('#feed').innerHTML(), retainedFeed, 'pending search preserves the exact displayed list');
  assert.equal(await page.locator('#feed-status').textContent(), retainedStatus, 'pending search shows no loading label');
  assert.equal(await page.locator('.thought').evaluate(article => getComputedStyle(article).animationName), 'none', 'search results never animate while editing');
  await fillComposer('newer query');
  await page.waitForFunction(id => document.querySelectorAll('.thought').length === 1 && document.querySelector('.thought').dataset.id === id, ids[1]);
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('.thought').getAttribute('data-id'), ids[1], 'a stale result cannot replace the newer query');
  assert.equal(await page.locator('#body').inputValue(), 'newer query');
  await fillComposer('nothing relevant here');
  await page.waitForFunction(() => document.querySelector('#feed').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.thought').length === 0);
  assert.equal(await page.locator('#feed-status').textContent(), '', 'no relevant results leaves a blank feed');
  assert.equal(await page.locator('#more').isVisible(), false);
  assert.equal((await api('export')).data.entries.length, samples.length);
  await fillComposer('an explicitly saved thought');
  await page.locator('#composer-editor .cm-content').press('Enter');
  await page.locator('#composer-editor .cm-content').pressSequentially('with a second line');
  const postedText = await page.locator('#body').inputValue();
  assert.ok(postedText.includes('\n'), 'Enter keeps a new line in the shared field');
  assert.equal((await api('export')).data.entries.length, samples.length);
  await page.locator('#post').click();
  await page.waitForFunction(() => document.querySelectorAll('.thought').length === 4 && document.querySelector('#body').value === '');
  const posted = (await api('export')).data.entries.find(entry => entry.body === postedText);
  assert.ok(posted, 'the explicit post saves the shared field as a new thought'); ids.push(posted.id);
  await page.unroute('**/api/search'); await page.unroute('**/api/session');
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });

  // A second tab changes the draft: the first must preserve its own text.
  const oldVersion = (await api('draft')).data.version;
  await api('draft', 'PUT', { body: 'another device draft', version: oldVersion });
  await fillComposer('local text that must survive a conflict');
  await page.waitForFunction(() => document.querySelector('#draft-status').textContent.includes('changed elsewhere'));
  assert.equal(await page.locator('#body').inputValue(), 'local text that must survive a conflict');
  assert.equal((await api('draft')).data.body, 'another device draft');
  const draftVersion = (await api('draft')).data.version;
  await api('draft', 'PUT', { body: '', version: draftVersion });
  // Reload after explicitly discarding this synthetic conflict, then test lock.
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal((await api('thoughts')).status, 401, 'locking revokes server session');
  assert.equal(await page.locator('#feed').textContent(), '', 'locking clears displayed thoughts');
  await page.locator('#password').fill(password); await page.locator('#unlock').click();
  await page.locator('#app').waitFor({ state: 'visible' });
  for (const id of ids) await api(`thoughts/${id}`, 'DELETE', {});
  assert.deepEqual(errors, []);
  // The same UI must keep every request under /journal/ when mounted there.
  const mountedRequests = [];
  page.on('request', request => { if (new URL(request.url()).origin === origin) mountedRequests.push(new URL(request.url()).pathname); });
  await page.goto(origin + '/journal');
  await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/journal/');
  assert.ok(mountedRequests.includes('/journal/journal.js'));
  assert.ok(mountedRequests.includes('/journal/journal.css'));
  assert.ok(mountedRequests.includes('/journal/api/session'));
  assert.ok(mountedRequests.includes('/journal/api/thoughts'));
  assert.ok(!mountedRequests.some(path => path.startsWith('/api/')), 'mounted UI never calls the origin root API');
  assert.equal(await page.locator('#body').evaluate(element => getComputedStyle(element).fontSize), '14px');
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  console.log(JSON.stringify({ passed: true, checks: ['login', 'HttpOnly session', 'draft restore', 'post', 'fixed previews and reading page', 'bookmark', 'shared input search', 'retained list while searching', 'debounced semantic request', 'stale request cancellation', 'hide timeline', 'quiet text controls', 'stationary menus on desktop/mobile', 'private reading links and reload', 'explicit posting', 'full-page Markdown editing', 'live Markdown, cursor syntax, copy, undo/redo, and cancel', 'save on back', 'edit conflict preservation', 'HTML safety', 'public draft isolation', 'font loading', 'title autosave/post/edit', 'date rail', 'draft conflict', 'logout revocation'], screenshots: artifacts }));
} catch (error) {
  console.error(JSON.stringify({ pageErrors: errors, notice: await page.locator('#notice').textContent().catch(() => ''), feed: await page.locator('#feed-status').textContent().catch(() => '') }));
  await page.screenshot({path: `${artifacts}/failure.png`, fullPage:true}).catch(() => {});
  throw error;
} finally {
  // This test refuses remote hosts and creates only synthetic local entries.
  await browser.close();
}
