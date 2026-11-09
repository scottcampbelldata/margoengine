import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPython } from '../scripts/support/find-python.mjs';

const refused = () => assert.fail('the alias must not start');

test('on Windows an installed interpreter is taken and the app execution alias is never started', () => {
  const home = mkdtempSync(join(tmpdir(), 'find-python-')),
    folder = join(home, 'Python', 'pythoncore-3.15-64');
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'python.exe'), '');
    assert.equal(
      findPython({ run: refused, platform: 'win32', env: { LOCALAPPDATA: home } }),
      join(folder, 'python.exe'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a spawn that fails is a failure, so a test cannot pass by skipping its script', () => {
  const error = Object.assign(new Error('spawnSync python3 EINVAL'), { code: 'EINVAL' });
  assert.throws(() => findPython({ run: () => ({ error, status: null }), platform: 'linux', env: {} }), error);
});

test('no Python is undefined, and the first command that answers is used', () => {
  const missing = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), status: null });
  assert.equal(findPython({ run: missing, platform: 'linux', env: {} }), undefined);
  assert.equal(
    findPython({ run: (command) => (command === 'python' ? { status: 0 } : missing()), platform: 'linux', env: {} }),
    'python',
  );
});

// Regression (2026-11-09, M6 Mac mini): packages/lightmap/tests/cornell-box.test.js spawned a bare 'python', which
// macOS does not have (only python3), so verify failed there with spawnSync python ENOENT. Tests and checks start
// Python through findPython (or a list of candidates), never a hard-coded 'python'.
test('no test or check spawns a hard-coded python command', async () => {
  const { execFileSync } = await import('node:child_process'),
    { readFileSync } = await import('node:fs'),
    root = join(import.meta.dirname, '..'),
    files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && !file.includes('node_modules/')),
    bare = /(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"`]python['"`]|\?\?\s*['"`]python['"`]\s*,/,
    found = files.filter((file) => bare.test(readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(found, [], 'start Python with findPython() from scripts/support/find-python.mjs');
});
