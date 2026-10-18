import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
import io
import json
from unittest.mock import patch


class PublicBuildTest(unittest.TestCase):
    def load_build(self):
        root = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('site_build', root / 'build.py')
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        return build

    def test_remote_source_never_falls_back_to_old_git_posts_or_private_drafts(self):
        build = self.load_build()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'content' / 'posts').mkdir(parents=True)
            (root / 'index.html').write_text('public home')
            (root / 'writing-source.json').write_text(json.dumps({'posts': 'https://journal.example/public/posts'}))
            (root / 'content' / 'posts' / 'old.md').write_text('old removed public text')
            (root / 'content' / 'posts' / 'private.md').write_text('---\npublished: false\n---\nprivate words')
            (root / 'content' / 'reading').mkdir()
            (root / 'content' / 'reading' / 'index.json').write_text('[]')
            public = {'slug': 'live-note', 'title': 'a "quoted" title', 'date': '2026-10-17', 'body': 'only the published version', 'tags': ['one', 'two'], 'description': '', 'cover': '', 'coverPosition': ''}
            payload = io.BytesIO(json.dumps({'posts': [public]}).encode())
            tracked = types.SimpleNamespace(stdout='index.html\nwriting-source.json\n')
            with patch.object(build, 'ROOT', root), patch.object(build, 'CONTENT', root / 'content'), patch.object(build, 'urlopen', return_value=payload) as request, patch.object(build.subprocess, 'run', return_value=tracked):
                posts = build.collect_posts()
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.args[0].full_url, 'https://journal.example/public/export.json')
                self.assertEqual(request.call_args.args[0].get_header('User-agent'), 'ChristopherLiSite/1.0')
                self.assertEqual(request.call_args.kwargs, {'timeout': 30})
                build.assemble_site(root / '_site', posts)
            files = {p.relative_to(root / '_site').as_posix() for p in (root / '_site').rglob('*') if p.is_file()}
            self.assertNotIn('posts/old.md', files)
            self.assertNotIn('posts/private.md', files)
            self.assertNotIn('posts/live-note.md', files, 'public builds do not create a second copy of database writing')
            self.assertNotIn('posts/index.json', files)
            self.assertIn('reading/index.json', files)
            restored, body = build.parse_front_matter('---\ntitle: "a \\"quoted\\" title"\ntags: ["one", "two"]\n---\nbody')
            self.assertEqual(restored['title'], public['title'])
            self.assertEqual(restored['tags'], public['tags'])
            self.assertEqual(body, 'body')
            self.assertNotIn('private words', (root / '_site' / 'feed.xml').read_text())

    def test_unavailable_remote_source_fails_the_build(self):
        build = self.load_build()
        with patch.object(build, 'writing_source', return_value='https://journal.example/public/posts'), patch.object(build, 'urlopen', side_effect=OSError('unavailable')):
            with self.assertRaises(OSError):
                build.collect_posts()

    def test_journal_and_credentials_never_enter_pages_artifact(self):
        root = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('site_build', root / 'build.py')
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        with tempfile.TemporaryDirectory() as temp:
            fixture = Path(temp)
            (fixture / 'private-journal').mkdir()
            (fixture / 'content' / 'posts').mkdir(parents=True)
            (fixture / 'index.html').write_text('public home')
            (fixture / 'private-journal' / 'worker.mjs').write_text('private backend')
            (fixture / 'private-journal' / '.dev.vars').write_text('fake test secret')
            (fixture / 'content' / 'posts' / 'public.md').write_text('---\ntitle: Public\n---\npublic prose')
            (fixture / 'content' / 'posts' / 'draft.md').write_text('---\ntitle: Draft\npublished: false\n---\nprivate draft prose')
            tracked = 'index.html\nprivate-journal/worker.mjs\nprivate-journal/.dev.vars\n'
            with patch.object(build, 'ROOT', fixture), patch.object(build, 'CONTENT', fixture / 'content'), patch.object(build.subprocess, 'run', return_value=types.SimpleNamespace(stdout=tracked)):
                build.assemble_site(fixture / '_site')
            files = sorted(path.relative_to(fixture / '_site').as_posix() for path in (fixture / '_site').rglob('*') if path.is_file())
            self.assertEqual(files, ['index.html', 'posts/public.md'])


if __name__ == '__main__':
    unittest.main()
