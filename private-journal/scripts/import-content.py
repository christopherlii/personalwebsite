#!/usr/bin/env python3
"""Import site-content writing without printing or committing its contents."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import uuid
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def entries(content):
    module_path = Path(__file__).resolve().parents[2] / 'build.py'
    spec = importlib.util.spec_from_file_location('site_build', module_path)
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    result = []
    for path in sorted((content / 'posts').glob('*.md')):
        attrs, body = build.parse_front_matter(path.read_text())
        if not re.fullmatch(r'[a-z0-9]+(?:[-_][a-z0-9]+)*', path.stem):
            raise ValueError('An imported filename needs a supported address')
        source = 'site-content/posts/' + path.name
        identifier = str(uuid.UUID(bytes=hashlib.sha256(source.encode()).digest()[:16], version=4))
        result.append({
            'id': identifier, 'source_key': source,
            'published': str(attrs.get('published', '')).lower() != 'false',
            'draft': {
                'slug': path.stem, 'title': attrs.get('title', path.stem.replace('-', ' ')),
                'body': body, 'date': attrs.get('date', ''), 'tags': attrs.get('tags', []),
                'description': attrs.get('description', ''), 'cover': attrs.get('cover', ''),
                'coverPosition': attrs.get('coverPosition', ''),
            },
        })
    return sorted(result, key=lambda item: item['draft']['date'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--content', type=Path, default=Path(__file__).resolve().parents[2] / 'content')
    parser.add_argument('--origin')
    parser.add_argument('--password-file', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    data = entries(args.content)
    if not data:
        parser.error('No posts found')
    print(json.dumps({'posts': len(data), 'published': sum(item['published'] for item in data), 'drafts': sum(not item['published'] for item in data), 'apply': args.apply}))
    if not args.apply:
        return
    origin = args.origin or ''
    parsed = urlparse(origin)
    if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1'))) or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username:
        parser.error('Use the exact journal HTTPS origin (or localhost for testing)')
    if not args.password_file:
        parser.error('--password-file is required; never pass the password as an argument')
    password = args.password_file.read_text().rstrip('\r\n')
    opener = build_opener(NoRedirects)
    origin = origin.rstrip('/')
    cookie = ''

    def call(path, payload):
        request = Request(origin + '/api/' + path, data=json.dumps(payload).encode(), headers={'User-Agent': 'ChristopherLiSite/1.0', 'Content-Type': 'application/json', 'X-Journal': '1', 'Origin': origin, 'Cookie': cookie}, method='POST')
        with opener.open(request, timeout=60) as response:
            return json.loads(response.read(1_000_000)), response.headers.get('Set-Cookie', '')

    _, token = call('login', {'password': password})
    cookie = token.split(';')[0]
    if not cookie:
        raise RuntimeError('Login did not return a session')
    imported = 0
    try:
        for entry in data:
            response, _ = call('import', entry)
            imported += response['imported']
    finally:
        call('logout', {})
    print(json.dumps({'imported': imported, 'already_present': len(data) - imported}))


if __name__ == '__main__':
    main()
