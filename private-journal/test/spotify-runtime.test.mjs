import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the real workerd Fetch parser, which differs from Node's redirect modes.
test('Spotify refresh runs inside workerd and refuses redirects without forwarding credentials', async () => {
  const schema = readFileSync(new URL('../migrations/0017_spotify.sql', import.meta.url), 'utf8');
  const bundle = await build({ stdin: { contents: `
    import {refreshListening} from './spotify.mjs';
    export default {async fetch(request,env){
      await env.JOURNAL_DB.exec(${JSON.stringify(schema.replace(/\s+/g, ' '))});
      await env.JOURNAL_DB.prepare('INSERT INTO spotify_connection(id,client_id,refresh_token) VALUES (1,?,?)').bind('c'.repeat(32),'test-refresh').run();
      await refreshListening(env);
      const row=await env.JOURNAL_DB.prepare('SELECT public_json,lease_until FROM spotify_connection WHERE id=1').first();
      return Response.json(row);
    }};`, resolveDir: new URL('../', import.meta.url).pathname }, bundle: true, format: 'esm', write: false });
  for (const redirect of [false, true]) {
    const calls = [];
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, compatibilityDate: '2026-10-17', script: bundle.outputFiles[0].text,
      d1Databases: ['JOURNAL_DB'],
      outboundService: async request => {
        const url = new URL(request.url); calls.push(url.href);
        if (redirect) return new Response('redirect', { status: 302, headers: { Location: 'https://unexpected.example/' } });
        if (url.hostname === 'accounts.spotify.com') {
          const body = await request.formData();
          assert.equal(body.get('grant_type'), 'refresh_token');
          return Response.json({ access_token: 'test-access' });
        }
        assert.equal(url.hostname, 'api.spotify.com');
        assert.equal(request.headers.get('Authorization'), 'Bearer test-access');
        assert.equal(url.searchParams.get('time_range'), 'short_term');
        return Response.json({ items: [{ id: 'a'.repeat(22), name: url.pathname.endsWith('/tracks') ? 'test track' : 'test artist', artists: [{ name: 'test artist' }] }] });
      }
    }));
    try {
      const response = await mf.dispatchFetch('http://localhost/');
      const row = await response.json();
      assert.equal(response.status, 200);
      assert.equal(row.lease_until, 0);
      if (redirect) { assert.equal(row.public_json, null); assert.equal(calls.length, 1); }
      else { assert.equal(JSON.parse(row.public_json).track.name, 'test track'); assert.equal(calls.length, 3); }
    } finally { await mf.dispose(); }
  }
});
