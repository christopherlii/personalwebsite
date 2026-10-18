import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


class PublicBuildTest(unittest.TestCase):
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
