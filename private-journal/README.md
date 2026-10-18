# Private journal

A single-owner journal with a chronological timeline, bookmarks, draft
autosave, editing, deletion, export, and keyword plus semantic search. The feed
has a borderless writing/search field above a faint timeline, and three-line
thought previews with an open/close control. Typing recalls related past
thoughts; clearing restores the timeline. Only an explicit post creates a new
entry. Enter inserts a new line; Cmd/Ctrl+Enter also posts. Entries have no 280-character limit (the
storage limit is 20,000 characters). No analytics, trackers, browser-local
thought storage, or external runtime assets.

The interface and backend live in `personalwebsite`. **Journal text is stored in
Cloudflare D1, not Git or `site-content`.** `build.py` excludes this entire
directory from the public GitHub Pages artifact. Published writing continues to
live in `christopherlii/site-content`; the journal's public-draft action makes a
separate editable copy that can be copied to Substack or downloaded as unpublished
Markdown for `site-content/posts/`. It does not publish or email anything.

## Local preview

Use Node 24+ (the API tests use `node:sqlite`) and Python 3 for the build test.
From this directory:

```sh
npm ci
```

Generate a local password hash without putting a password in a command argument,
shell history, or chat. In zsh:

```sh
read -rs 'journal_password?Journal password (16+ characters): '
printf '%s' "$journal_password" | node scripts/password.mjs --local
unset journal_password
npm run db:local
npm run dev
```

Open `http://localhost:8787`. `.dev.vars` contains only the hash and is gitignored;
the generator sets mode 0600 and refuses to overwrite it. Never reuse a local
test password for production. All local D1 state lives in the ignored `.wrangler/`.

## Verification

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
npx playwright install chromium
```

For a browser check, run the preview server, then set `JOURNAL_TEST_PASSWORD` to
the local preview password using a hidden prompt. Run `npm run test:browser`.
Browser tests refuse remote URLs and use only synthetic local entries. Use a
clean local draft before running them. Screenshots go to ignored `test-results/`.
An existing Chromium binary can be selected with `CHROMIUM_PATH`. These tests
cover autosave restoration, posting, bookmarks, accent-insensitive search,
editing, safe rendering, separate public drafts, desktop/mobile layout,
font loading, draft conflicts, and server-side session revocation. Shared-field
checks cover pause-triggered semantic requests, stale response cancellation,
clear-to-restore behavior, and typing without creating entries. Browser semantic
responses are controlled test fixtures, not live model quality verification.

## Deploy after connecting a Cloudflare account

No production resources or secrets are included. The zero database UUIDs in
`wrangler.jsonc` are deliberately placeholders. The local environment has no AI
binding; the production environment enables Cloudflare Workers AI. Workers preview URLs and the
workers.dev hostname are disabled until hosting is configured.

1. Run `npx wrangler login` and `npx wrangler d1 create christopher-private-journal`.
   Replace both `database_id` values in `wrangler.jsonc` with the returned ID.
2. Choose either a custom journal hostname in an existing Cloudflare zone via
   `routes: [{ "pattern": "journal.christopherli.dev", "custom_domain": true }]`,
   or enable `workers_dev` and use the account's workers.dev URL. Set this in
   the production environment when using an environment-specific override. Do not move the
   public site's DNS or nameservers as part of journal setup.
3. Install the production password hash without displaying it:

   ```sh
   read -rs 'journal_password?Production journal password (16+ characters): '
   printf '%s' "$journal_password" | node scripts/password.mjs | npx wrangler secret put JOURNAL_PASSWORD_HASH --env production
   unset journal_password
   ```

4. Apply the schema with `npx wrangler d1 migrations apply JOURNAL_DB --remote --env production`,
   then `npm run deploy`. Check a fresh private browser session: listing,
   exporting, and posting must return 401 until login; test login, a disposable
   thought, search by a related phrase with no shared words, edit/delete search
   invalidation, and logout. The local tests mock embedding responses; actual
   model quality and live binding access still need this verification.
5. Once the hostname works, add the unlisted `/journal/` redirect on the public
   site to this exact URL. Do not add it to public navigation or RSS. The
   redirect is intentionally not shipped until the destination is configured.

Keep the production password in a password manager. To rotate it, run the same
secret command and deploy again. Existing sessions immediately fail validation
on the new deployment because every session is bound to the current hash.

## Privacy and behavior

- Every journal API read/write is authenticated server-side, apart from the
  login and session-status endpoints. Missing database/password configuration
  fails closed. The HTML/JS contain no entries or credentials.
- PBKDF2-SHA256 uses a random salt and 600,000 iterations. Random 256-bit session
  tokens are stored only as SHA-256 digests; cookies are Secure, HttpOnly,
  SameSite=Strict, host-only, and expire after seven days. Logout deletes the
  server-side session. Login attempts are limited per IP digest and globally in
  D1; the IP itself is not stored. Cross-origin writes are rejected.
- D1 is access-controlled server storage, **not end-to-end encryption**. The
  owner of the Cloudflare account and Cloudflare infrastructure can access it.
  Do not describe the journal as a zero-knowledge vault.
- Drafts autosave after 650ms and are shared between devices. A revision check
  prevents one device from silently overwriting another. A conflicting draft
  stays in the editor; it can still be copied or posted as a separate thought.
  An unload warning protects pending writes. No entries are saved in
  localStorage or a service worker cache.
- All responses are `no-store` and `noindex`; request observability is disabled.
  Avoid enabling request/body logging for production. These headers are not
  the access control; login is.
- The writing field also searches. Typing shows keyword results after 150ms;
  after a 750ms pause it requests semantic results when the AI binding is
  configured. Earlier requests are canceled and stale responses cannot replace
  newer results. Input, selection, and draft content stay separate from result
  rendering. Clearing restores the timeline; switching bookmark views preserves
  what is being written. No typing/search request creates a timeline entry.
- SQLite FTS5 ranks prefix matches, normalizes accents, and ignores common
  function words when specific terms are present. Search requests use a POST
  body so a composed thought is not placed in a URL. Queries support the full
  20,000-character writing limit; embedding batches never exceed eight chunks.
  Keyword results remain available without the AI binding or on provider
  failure. Results and timelines use 40-entry pages. Search highlighting uses
  the same term selection and never renders user text as HTML.
- Semantic search uses Cloudflare-hosted `@cf/baai/bge-small-en-v1.5` (384
  dimensions). Thoughts are embedded on creation/edit and normalized Float32
  vectors are stored in D1. Long text is split into overlapping chunks of at
  most 400 UTF-8 bytes; it is never silently truncated. The first search repairs
  missing indexing jobs in bounded batches. Edits invalidate vectors in a SQL
  trigger; stale async jobs cannot replace the new content. Deletes cascade.
- A semantic query embeds only the query once the archive is indexed. The
  server scans stored vectors in bounded pages, takes each thought's best chunk
  similarity, and merges the top 200 semantic and keyword candidates by
  reciprocal rank. It does not send the archive to the model again on every
  query. This suits a personal journal; a large archive should move retrieval
  to a vector index rather than assuming constant search latency. The 0.45
  cosine cutoff is a retrieval heuristic, not a probability or validated
  accuracy guarantee. Search requests are limited to 120 per minute.
- Cloudflare lists the model at $0.0202 per million input tokens, before any
  free allocation. For example, embedding a 20-token query is about $0.000000404
  in model usage; this excludes Worker/database hosting. Indexing text is an
  additional cost when writing or editing. Check current [model pricing](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/)
  and [account limits](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- JSON export includes all entries, timestamps, bookmarks, and the
  current draft. Export periodically to an owner-controlled private backup.
  Deleting an entry removes it from active search; provider backups may retain
  previous data under their own policies.
- No Jev or OpenAI key is required. Semantic indexing sends each thought to
  Cloudflare Workers AI when it is created/edited; searches send the current writing/search text after the typing pause, even
  before it is posted.
  This stays within the selected Cloudflare backend but is still model
  processing, not on-device inference. See [Cloudflare data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
- Typography matches the personal homepage: self-hosted Instrument Sans at
  14px with 1.55 line height, #333 reading text, and the same #fafafa background.
  The existing font subsets are reused with their OFL license. Square corners, solid fills, and visible rules
  separate menus and controls; the feed itself has no cards or boxed composer.
  Its line marks saved chronology and points align with timestamps. The
  writing/search field stays separate above the line, without a timestamp or
  timeline marker. There are no decorative effects or motion.

For host setup, use the official [Workers static asset docs](https://developers.cloudflare.com/workers/static-assets/)
and [D1 docs](https://developers.cloudflare.com/d1/). The public GitHub Pages
deployment and the private journal are separate deployments.
