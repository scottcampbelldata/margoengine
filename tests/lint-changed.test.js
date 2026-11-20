// `npm run lint` holds the changed files to Biome's format and lint warnings (scripts/lint.mjs). `biome lint` alone
// never checked formatting and passed on warnings, so packages/netcode/tests/browser/signal.mjs and
// scripts/publish-rehearsal.mjs landed unformatted and tools/shot/cli.mjs with an unused import, all through a green gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { biomeBin, checkChanged } from '../scripts/lint.mjs';

const root = resolve(import.meta.dirname, '..');
const bin = biomeBin(root);

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-lint-'));
  writeFileSync(join(dir, 'biome.json'), JSON.stringify({ formatter: { indentStyle: 'space', lineWidth: 120 } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('npm run lint runs the changed-file check', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.lint, 'node scripts/lint.mjs');
});

test('a changed file Biome would reformat fails', (t) => {
  const dir = project({ 'a.js': 'export const a   =  [1,2];\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(checkChanged(['a.js'], { cwd: dir, bin, stdio: 'pipe' }), 0);
});

test('a changed file with an unused import fails; a clean one and a file Biome does not cover pass', (t) => {
  const dir = project({
    'unused.js': "import { join } from 'node:path';\nexport const a = 1;\n",
    'clean.js': 'export const a = [1, 2];\n',
    'notes.md': '# notes   \n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(checkChanged(['unused.js'], { cwd: dir, bin, stdio: 'pipe' }), 0);
  assert.equal(checkChanged(['clean.js', 'notes.md'], { cwd: dir, bin, stdio: 'pipe' }), 0);
  assert.equal(checkChanged([], { cwd: dir, bin, stdio: 'pipe' }), 0);
});
