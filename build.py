#!/usr/bin/env python3
"""
Build script for personal website.
Scans /posts/ directory for .md files and generates posts/index.json.
Run before deploying or committing new posts.
"""

import json
import os
import re
from pathlib import Path


def parse_front_matter(content: str) -> dict:
    """Parse YAML-like front matter from markdown content."""
    match = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
    if not match:
        return {}

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

    return attributes


def generate_posts_index():
    """Generate posts/index.json from markdown files."""
    posts_dir = Path(__file__).parent / 'posts'

    if not posts_dir.exists():
        print(f"Posts directory not found: {posts_dir}")
        return

    md_files = sorted(posts_dir.glob('*.md'))
    filenames = [f.name for f in md_files]

    index_path = posts_dir / 'index.json'
    with open(index_path, 'w') as f:
        json.dump(filenames, f, indent=2)

    print(f"Generated {index_path} with {len(filenames)} posts:")
    for name in filenames:
        print(f"  - {name}")


def main():
    print("Building personal website assets...\n")
    generate_posts_index()
    print("\nBuild complete!")


if __name__ == '__main__':
    main()
