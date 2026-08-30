#!/usr/bin/env python3
"""
Build script for personal website.
Scans /posts/ directory for .md files and generates:
  - posts/index.json — post metadata (title, date, cover, word count, ...)
    so the site can render lists without downloading every post body
  - feed.xml — RSS feed of published posts
Run before deploying or committing new posts.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

SITE_URL = 'https://christopherli.dev'
SITE_TITLE = 'christopher li'
SITE_DESCRIPTION = "a little corner of the internet where i keep my writing and favorites."


def parse_front_matter(content: str):
    """Parse YAML-like front matter from markdown content."""
    match = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
    if not match:
        return {}, content

    front_matter = match.group(1)
    attributes = {}

    for line in front_matter.split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            key = key.strip()
            value = value.strip()

            # Remove quotes
            if (value.startswith('"') and value.endswith('"')) or \
               (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]

            # Parse arrays
            if value.startswith('[') and value.endswith(']'):
                value = [
                    item.strip().strip('"').strip("'")
                    for item in value[1:-1].split(',')
                ]

            attributes[key] = value

    return attributes, match.group(2)


def collect_posts():
    """Read every published post's metadata (and body, for the feed)."""
    posts_dir = Path(__file__).parent / 'posts'
    posts = []

    for path in sorted(posts_dir.glob('*.md')):
        content = path.read_text()
        attributes, body = parse_front_matter(content)
        if str(attributes.get('published', '')).lower() == 'false':
            continue
        posts.append({
            'file': path.name,
            'title': attributes.get('title', path.stem.replace('-', ' ')),
            'date': attributes.get('date', ''),
            'tags': attributes.get('tags', []),
            'description': attributes.get('description', ''),
            'cover': attributes.get('cover', ''),
            'coverPosition': attributes.get('coverPosition', ''),
            'words': len(body.split()),
            '_body': body,
        })

    posts.sort(key=lambda p: p['date'], reverse=True)
    return posts


def generate_posts_index(posts):
    index_path = Path(__file__).parent / 'posts' / 'index.json'
    public = [{k: v for k, v in p.items() if not k.startswith('_')} for p in posts]
    with open(index_path, 'w') as f:
        json.dump(public, f, indent=2)

    print(f"Generated {index_path} with {len(public)} posts:")
    for p in public:
        print(f"  - {p['file']}")


def rfc822_date(date_str: str) -> str:
    try:
        d = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
        return d.strftime('%a, %d %b %Y 00:00:00 GMT')
    except ValueError:
        return ''


def generate_feed(posts):
    items = []
    for p in posts:
        link = f"{SITE_URL}/#thought/{Path(p['file']).stem}"
        pub = rfc822_date(p['date'])
        items.append(f"""    <item>
      <title>{escape(p['title'])}</title>
      <link>{escape(link)}</link>
      <guid isPermaLink="false">{escape(link)}</guid>
      {f'<pubDate>{pub}</pubDate>' if pub else ''}
      <description>{escape(p['description'])}</description>
    </item>""")

    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{escape(SITE_TITLE)}</title>
    <link>{SITE_URL}</link>
    <description>{escape(SITE_DESCRIPTION)}</description>
    <language>en</language>
    <atom:link href="{SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
{chr(10).join(items)}
  </channel>
</rss>
"""
    feed_path = Path(__file__).parent / 'feed.xml'
    feed_path.write_text(feed)
    print(f"Generated {feed_path} with {len(items)} items")


def main():
    print("Building personal website assets...\n")
    posts = collect_posts()
    generate_posts_index(posts)
    generate_feed(posts)
    print("\nBuild complete!")


if __name__ == '__main__':
    main()
