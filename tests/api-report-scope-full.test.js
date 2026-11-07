// A scoped API check must judge a package exactly as the full check does. The scoped program once loaded only the
// selected package's declarations, so the `declare module '@margoengine/core/extension'` in @margoengine/scene was
// missing: `node scripts/api-report.js --package=core` dropped `class Mesh` from api/core.extension.api.md on a clean
// tree, and a scoped update wrote a wrong unexported count for core into docs/api-surface.md, which the full check
// never compared. Needs the packages built (verify builds them first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const run = (...args) =>
  spawnSync(process.execPath, ['scripts/api-report.js', ...args], { cwd: root, encoding: 'utf8', timeout: 240_000 });

test('a scoped check of a package another package augments matches the committed full reports', () => {
  // core is augmented by scene's `declare module`, so a program without scene reports a different core.
  for (const selector of ['core', '@margoengine/scene']) {
    const result = run(`--package=${selector}`);
    assert.equal(result.status, 0, `--package=${selector}:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /API reports match: \d+ selected entr/);
  }
});

test('a scoped entry check of core/extension matches the committed full report', () => {
  const result = run('--package=core', '--entry=./extension');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
