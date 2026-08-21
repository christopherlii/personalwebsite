# CLAUDE.md

## Project Overview

Personal website for Christopher Li (www.christopherli.dev). A static site with no framework — just HTML, CSS, and vanilla JS. Hosted on GitHub Pages.

## Architecture

- **Single-page app** using hash-based routing (`#thoughts`, `#projects`, `#favorites`, `#stats`, etc.) handled in `static/markdown-renderer.js`
- **`index.html`** — the single HTML entry point with all views defined inline (home, writing, article, projects, reading, favorites, stats)
- **`static/markdown-renderer.js`** — the `Site` class: routing, markdown rendering (via `marked` CDN), the banner, data loading
- **`styles/main.css`** — the whole stylesheet. (`filters.css` and `archives.css` are left over and not linked from `index.html`.)
- **One shared banner** sits above every view: a sticky photo header holding the breadcrumb and social links. It opens to `--banner-height` on home and article pages and shrinks with the scroll; on every other view it stays a `--banner-bar` strip. See `setupBanner()` and the `.banner` rules in `main.css`.

## Content

All content is data-driven via JSON index files and markdown:

- **`posts/`** — blog posts as `.md` files with YAML front matter (`title`, `date`, `tags`, `description`, optional `cover` + `coverPosition`). Index: `posts/index.json` (array of filenames). `cover` is the photo shown in the banner at the top of the article; `coverPosition` is a CSS `background-position` for its crop. Posts without a `cover` fall back to the home photo. `description` is kept for metadata but is not rendered — the article header is title + date only.
- **`projects/index.json`** — array of project objects (`name`, `slug`, `description`, `tech`, `year`, `status`, `image`, `link`, `privacy`). Project images go in `static/images/projects/` (e.g. `image: "/static/images/projects/my-project.png"`). Use `slug` for readable URLs like `#projects/linkedin-search-bypass`.
- **`reading/index.json`** — reading list entries
- **`solaces/index.json`** — solaces (things Chris likes)
- **`quests/index.json`** — quest photos/captions displayed on the home page
- **`library/index.json`** — library data

## Build

- **`build.py`** — Python script that scans `posts/*.md` and regenerates `posts/index.json`. Run this after adding/removing posts.
- **`server.py`** — local dev server on port 8001 with markdown content-type support. Run with `python3 server.py`.
- Node dependencies (`marked`, `chokidar`, `front-matter`) are in `package-lock.json` but the site primarily uses the `marked` CDN.

## Adding a New Post

1. Create `posts/your-post-slug.md` with front matter:
   ```
   ---
   title: "Post Title"
   date: "YYYY-MM-DD"
   tags: ["tag1", "tag2"]
   description: "Short description"
   cover: "/static/images/blogs/your-post-slug/cover.jpg"
   coverPosition: "center 70%"
   ---
   ```
2. Run `python3 build.py` to regenerate `posts/index.json`

## Style Notes

- Fonts: Fraunces (headings) and Instrument Sans (body) via Google Fonts
- Type scale: 30px Fraunces page titles, 20px h2, 17px h3, 14px body copy, 13px meta, 14px captions in `--fg-muted`
- Column is 640px wide (`--col`) with 24px gutters; figures use an 8px radius
- Home uses `/static/images/hero/rock.jpg` as its banner photo; articles use their own `cover`
- The site uses a warm, minimal aesthetic with subtle animations (view fade-in, banner collapse, photo shuffle)
- Lowercase writing style throughout the site content
