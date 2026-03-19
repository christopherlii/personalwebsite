# CLAUDE.md

## Project Overview

Personal website for Christopher Li (www.christopherli.dev). A static site with no framework — just HTML, CSS, and vanilla JS. Hosted on GitHub Pages.

## Architecture

- **Single-page app** using hash-based routing (`#thoughts`, `#projects`, `#solaces`, etc.) handled in `static/markdown-renderer.js`
- **`index.html`** — the single HTML entry point with all views defined inline (home, thoughts, projects, reading, solaces, easter egg)
- **`static/markdown-renderer.js`** — the `Site` class: routing, markdown rendering (via `marked` CDN), panel system, data loading
- **`styles/`** — CSS split into `main.css`, `filters.css`, `archives.css`

## Content

All content is data-driven via JSON index files and markdown:

- **`posts/`** — blog posts as `.md` files with YAML front matter (`title`, `date`, `tags`, `description`). Index: `posts/index.json` (array of filenames)
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
   ---
   ```
2. Run `python3 build.py` to regenerate `posts/index.json`

## Style Notes

- Fonts: Fraunces (headings) and Source Serif 4 (body) via Google Fonts
- The site uses a warm, minimal aesthetic with subtle animations (timeline reveal, panel slide-in)
- Lowercase writing style throughout the site content
