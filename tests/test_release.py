#!/usr/bin/env python3
"""Execute the workflow's release shell blocks without calling GitHub or publishing."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/ci.yml').read_text()


def workflow_script(step):
    block = WORKFLOW.split('      - name: '+step+'\n', 1)[1]
    block = block.split('        run: |\n', 1)[1]
    return textwrap.dedent(re.split(r'\n(?=\S| {1,8}\S)', block, maxsplit=1)[0])


# The release job runs on Ubuntu; macOS runners have no sha256sum.
@unittest.skipUnless(shutil.which('sha256sum'), 'needs sha256sum, like the Ubuntu release job')
class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='opstrellis-release-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, GITHUB_REF_NAME='v0.1.0',
                        PATH=str(self.root / 'bin')+':'+os.environ['PATH'])
        (self.root / 'bin').mkdir()
        gh = self.root / 'bin/gh'
        gh.write_text('#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\nPath("gh-call").write_text(json.dumps(sys.argv[1:]))\n')
        gh.chmod(0o755)
        (self.root / 'desktop/src-tauri').mkdir(parents=True)
        (self.root / 'desktop/src-tauri/Cargo.toml').write_text('[package]\nname = "opstrellis"\nversion = "0.1.0"\n')
        self.names = ['opstrellis-linux-x86_64.AppImage', 'opstrellis-macos-aarch64.app.tar.gz', 'OpsTrellis_0.1.0_amd64.deb', 'OpsTrellis_0.1.0_aarch64.dmg']
        for name in self.names:
            path = self.root / 'artifacts/bundle' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('artifact '+name)

    def run_step(self, step, success=True):
        result = subprocess.run(['bash', '-euo', 'pipefail', '-c', workflow_script(step)], cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout+result.stderr)

    def test_matching_and_mismatched_tags(self):
        self.run_step('Check the tag matches the app version')
        self.env['GITHUB_REF_NAME'] = 'v0.2.0'
        self.run_step('Check the tag matches the app version', False)

    def test_release_contains_exact_checksums(self):
        self.run_step('Publish the release')
        sums = (self.root / 'dist/SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(sums), 4)
        for line in sums:
            digest, name = line.split()
            self.assertIn(name, self.names)
            self.assertEqual(digest, hashlib.sha256((self.root / 'dist' / name).read_bytes()).hexdigest())
        call = json.loads((self.root / 'gh-call').read_text())
        self.assertEqual(call[:3], ['release', 'create', 'v0.1.0'])
        self.assertNotIn('--prerelease', call)
        self.assertIn('--verify-tag', call)

    def test_missing_artifact_cannot_publish(self):
        (self.root / 'artifacts/bundle/opstrellis-macos-aarch64.app.tar.gz').unlink()
        self.run_step('Publish the release', False)
        self.assertFalse((self.root / 'gh-call').exists())

    def test_prerelease_does_not_become_stable(self):
        self.env['GITHUB_REF_NAME'] = 'v0.2.0-beta.1'
        self.run_step('Publish the release')
        self.assertIn('--prerelease', json.loads((self.root / 'gh-call').read_text()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
