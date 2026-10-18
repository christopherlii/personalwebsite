# Private journal

A single-owner journal with a chronological timeline, bookmarks, draft
autosave, editing, deletion, export, and keyword plus semantic search. The feed
has a borderless writing/search field above a faint timeline, and three-line
thought previews with an open link to a separate reading page. Optional titles sit above the
body; dates sit to the left of the timeline on desktop and mobile.
The header, reading-page, and public-draft menus appear in reserved space without
resizing their containers or moving surrounding content. Only opacity fades
are used, with reduced-motion support. Hover reveals dates and small text actions, and moving away
fades them out even after a click. Keyboard focus reveals the same controls;
touch devices show them directly. Hide timeline removes the whole feed while
leaving writing and autosave available. It is a temporary view choice.

Typing recalls related past thoughts after a pause. The existing list and its
status stay intact until the full response is ready, including semantic
indexing; there is no intermediate word-match pass or loading label. Clearing
restores the timeline. The feed offers copy and open; other actions live on
the full-page writing view. Open renders Markdown with headings, emphasis,
lists, quotes, code, tasks, tables, and links. Edit switches to a borderless
Markdown source editor with preview, save, and cancel. Back saves changes
before returning; save errors or version conflicts keep the source visible.
Unsaved source and preview also survive reauthentication in the same tab.
Reload/close warns while edits are unsaved. Publishing stays an explicit,
separate public draft, and delete still requires confirmation.
Previews never expand inline.
Reading links require the same
session and work on reload and under `/journal/`.
Only an explicit post creates a new
entry. Enter inserts a new line; Cmd/Ctrl+Enter also posts. Entries have no
280-character limit (the storage limit is 20,000 body characters and 160 title
characters). No analytics, trackers, browser-local thought storage, or external
runtime assets.

Markdown uses the existing site's vendored Marked 15.0.12 lexer (MIT), copied
unchanged to `public/vendor/marked.min.js`. `public/markdown.js` constructs DOM
nodes from tokens instead of injecting parsed HTML. Raw HTML remains literal
text, links allow only HTTP(S)/mailto, and Markdown images become links rather
than automatic external requests. This is a reading view and source editor,
not Obsidian's block-level Live Preview editor or its plugin syntax.

The interface and backend live in `personalwebsite`. **Journal text is stored in
Cloudflare D1, not Git or `site-content`.** `build.py` excludes this entire
directory from the public GitHub Pages artifact. After deployment/import,
`writing-source.json` points the public site at published database snapshots.
Public-draft saves and private journal edits never update the live snapshot;
only publish/update does. Unpublish removes public access and retains the draft.
Copy/download remain available for Substack, X, or Markdown backups without
posting to those services. Existing media and reading/favorites stay in Git.

## Local preview

Use Node 24+ (the API tests use `node:sqlite`) and Python 3 for the build test.
From this directory:

```sh
npm ci
```

Generate a local password hash without putting a password in a command argument,
shell history, or chat. In zsh:

```sh
read -rs 'journal_password?Journal password (8+ characters): '
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
cover title/body autosave restoration, posting, bookmarks, accent-insensitive search,
editing, safe rendering, separate public drafts, desktop/mobile layout,
font loading, draft conflicts, and server-side session revocation. Shared-field
checks cover retained results without a loading label, pause-triggered semantic requests, stale response cancellation,
clear-to-restore behavior, and typing without creating entries. Browser semantic
responses are controlled test fixtures, not live model quality verification.
The browser workflow also covers hiding/restoring the timeline, fading controls
after clicks, fixed geometry while menus open on desktop and mobile, and
complete private reading links on reload.

## Deploy after connecting a Cloudflare account

Production is deployed at
`https://christopher-private-journal.christopherlii.workers.dev` with D1 and
Workers AI. The production database ID is configured; the top-level zero ID
stays local-only. No credentials are committed. Request observability and
preview URLs are disabled. The journal is also active at
`https://christopherli.dev/journal/` with the same database and password.
Cloudflare's Free zone, Universal SSL certificate, and web-record proxies are
active. The `christopherli.dev/*` route serves the journal under `/journal/`
and forwards public paths to GitHub Pages after stripping the journal session
cookie. Existing DNS caches may temporarily use the GitHub Pages `/journal/`
fallback, which redirects to workers.dev.
See [domain-setup.md](domain-setup.md) for the reviewed records and verification.

For a new account or deployment:

1. Run `npx wrangler login` and `npx wrangler d1 create christopher-private-journal`.
   Replace only the production `database_id` in `wrangler.jsonc` with the returned ID.
2. Choose either a custom journal hostname in an existing Cloudflare zone via
   `routes: [{ "pattern": "journal.christopherli.dev", "custom_domain": true }]`,
   or enable `workers_dev` and use the account's workers.dev URL. Set this in
   the production environment when using an environment-specific override. Do not move the
   public site's DNS or nameservers as part of journal setup.
3. Install the production password hash without displaying it:

   ```sh
   read -rs 'journal_password?Production journal password (8+ characters): '
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

## Switch the public writing source

The live source is the Worker. Four existing Markdown posts were imported,
preserving one published post and three private drafts. For a new deployment,
keep `writing-source.json` on `/posts` until the Worker is verified. Preview the
existing content import, then authenticate with an owner-only password file:

```sh
python3 scripts/import-content.py
python3 scripts/import-content.py --apply --origin https://YOUR-JOURNAL-HOST --password-file /PRIVATE/PATH/owner-password.txt
```

Import preserves addresses, dates, metadata, and original published/draft
statuses. Re-running skips source keys and never overwrites newer database
edits. Date-only imports do not display an invented time. Verify the anonymous
index contains exactly the originally published writing before switching.

Set `writing-source.json` to:

```json
{"posts":"https://YOUR-JOURNAL-HOST/public/posts","feed":"https://YOUR-JOURNAL-HOST/public/feed.xml"}
```

The public renderer fetches this index and article bodies without credentials.
The daily build uses its published export for the legacy RSS file and stops on
remote errors instead of falling back to stale Git posts. It excludes old
Markdown bodies and the old index. Existing media stays in site-content; an
article referencing an image previously withheld with a draft needs the next
site build to make that image available. Public image URLs also work directly.
Owner JSON export and per-draft Markdown download provide writing backups.

## Privacy and behavior

- Every journal API read/write is authenticated server-side, apart from the
  login and session-status endpoints. Missing database/password configuration
  fails closed. The HTML/JS contain no entries or credentials.
- PBKDF2-SHA256 uses a random salt and 100,000 iterations, the production
  [Workers runtime ceiling](https://github.com/cloudflare/workerd/issues/1346).
  The deployed owner password is randomly generated with 192 bits of entropy;
  use a password-manager-generated password when rotating it. Random 256-bit session
  tokens are stored only as SHA-256 digests; cookies are Secure, HttpOnly,
  SameSite=Strict, host-only, and expire after seven days. Logout deletes the
  server-side session. Login attempts are limited per IP digest and globally in
  D1; the IP itself is not stored. Cross-origin writes are rejected.
- D1 is access-controlled server storage, **not end-to-end encryption**. The
  owner of the Cloudflare account and Cloudflare infrastructure can access it.
  Do not describe the journal as a zero-knowledge vault.
- Titles are optional. The writing field stays borderless; “add title” reveals
  a separate inline title once writing begins. Title and body autosave together,
  and both are included in search, copying, exports, and separate public drafts.
  Posting saves privately in this journal. Public drafts have revision checks
  and explicit publish, update, and unpublish actions. Private thought edits do
  not modify an existing public draft or published snapshot. Publishing needs
  a title, text, and an address unique among published posts. Unpublish an
  entry before deleting it.
- Dates, times, and entry controls appear on hover, keyboard focus, or touch.
  Copy is available directly below each note; open/close appears when its body
  needs truncation. Touch selection persists through expansion, keyboard focus
  stays on the open/close control, and revealing controls does not move notes.
- Drafts autosave after 650ms and are shared between devices. A revision check
  prevents one device from silently overwriting another. A conflicting draft
  stays in the editor; it can still be copied or posted as a separate thought.
  An unload warning protects pending writes. No entries are saved in
  localStorage or a service worker cache.
- All responses are `no-store`; private routes are `noindex`. Request observability is disabled.
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
  title and 20,000-character body; embedding batches never exceed eight chunks.
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
- Anonymous GET/HEAD routes under `/public/` serve only published snapshots:
  `posts/index.json`, `posts/<address>.md`, `feed.xml`, and `export.json`. They
  allow credential-free CORS and use `no-store`. Private endpoints stay behind
  owner authentication and reject cross-origin writes. Unpublishing removes
  active public routes; readers may have retained earlier public copies.
- JSON export includes all entries, timestamps, bookmarks, publications, and the
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
  The header name uses the homepage’s 14px Fraunces at weight 500.
  The existing font subsets are reused with their OFL license. Square corners, solid fills, and visible rules
  separate menus and controls; the feed itself has no cards or boxed composer.
  Its line marks saved chronology. Dates and times sit to its left, aligned
  with each thought’s first line. On narrow screens the date column moves
  inside the page to keep all timestamps visible. The writing/search field stays separate above the line, without a timestamp or
  timeline marker. There are no decorative effects or motion.

For host setup, use the official [Workers static asset docs](https://developers.cloudflare.com/workers/static-assets/)
and [D1 docs](https://developers.cloudflare.com/d1/). The public GitHub Pages
deployment and the private journal are separate deployments.
