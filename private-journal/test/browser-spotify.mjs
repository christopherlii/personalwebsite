import assert from 'node:assert/strict';
import { publicSitePreview } from './public-site.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await publicSitePreview(context, 'https://journal-preview.test');
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const listening = {
  track: { name: 'Test track', artists: ['Test artist'], url: `https://open.spotify.com/track/${'t'.repeat(22)}` },
  artist: { name: 'Test artist', url: `https://open.spotify.com/artist/${'a'.repeat(22)}` },
  time_range: 'short_term', updated_at: '2026-11-20T00:00:00Z'
};
let requests = 0, fail = false;
await page.route('https://site-preview.test/writing-source.json', route => route.fulfill({ json: {
  posts: '/posts/index.json', listening: '/public/listening'
} }));
await page.route('https://site-preview.test/public/listening', route => {
  requests++;
  return route.fulfill(fail ? { status: 503, json: {} } : { json: listening });
});
const openInfo = async () => {
  await page.locator('#home-view').waitFor({ state: 'visible' });
  await page.locator('#breadcrumb .crumb-name').click();
  await page.waitForURL('**/#stats');
};
const expectListening = async () => {
  await page.locator('#listening-track a').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#listening-track a').textContent(), 'Test track by Test artist');
  assert.equal(await page.locator('#listening-artist a').getAttribute('href'), listening.artist.url);
};

try {
  await page.goto('https://site-preview.test/');
  await page.waitForFunction(() => window.site?._routedOnce);
  assert.equal(requests, 0, 'home does not fetch Spotify');
  await openInfo();
  await expectListening();
  assert.equal(requests, 1, 'opening info fetches Spotify without reloading');

  await page.locator('#breadcrumb .crumb-name').click();
  await openInfo();
  await expectListening();
  assert.equal(requests, 1, 'reopening info reuses fresh data');

  await page.reload();
  await expectListening();
  assert.equal(requests, 2, 'direct info loads still fetch Spotify');
  await page.goto('https://site-preview.test/#youre-already-here');
  await expectListening();
  assert.equal(requests, 2, 'the legacy route retains fresh data');

  await page.goto('https://site-preview.test/');
  fail = true;
  const failedRequest = page.waitForResponse(response => response.url().endsWith('/public/listening') && response.status() === 503);
  await openInfo();
  await failedRequest;
  assert.equal(await page.locator('#listening-track [data-listening-label]').textContent(), 'favorite song');
  assert.equal(await page.locator('#listening-track a').count(), 0, 'a failed request preserves the fallback');
  fail = false;
  await page.locator('#breadcrumb .crumb-name').click();
  await openInfo();
  await expectListening();
  assert.equal(requests, 4, 'reopening info retries a failed request');
  assert.deepEqual(errors, []);
  console.log('PASS: info navigation, cached reopening, reload, legacy route, and retry after failure');
} finally {
  await browser.close();
}
