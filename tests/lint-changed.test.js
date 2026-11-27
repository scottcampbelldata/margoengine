// `npm run lint` holds the changed files to Biome's format and lint warnings (scripts/lint.mjs). `biome lint` alone
// never checked formatting and passed on warnings, so packages/netcode/tests/browser/signal.mjs and
// scripts/publish-rehearsal.mjs landed unformatted and tools/shot/cli.mjs with an unused import, all through a green gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { biomeBin, checkChanged, checkTree, compareDebt, DEBT } from '../scripts/lint.mjs';

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

// A commit already on main differs from origin/main in nothing, so the changed-file step checked 0 files on every local
// CI run and unformatted files landed (scripts/errors/entries.js among them). The tree step has no base to be empty.
test('a failing file that no diff names fails the tree step, unless the debt list holds that failure', (t) => {
  const dir = project({ 'old.js': 'export const a   =  [1,2];\n', 'clean.js': 'export const b = 1;\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Biome checks its own configuration file too, so it is written as the formatter leaves it.
  writeFileSync(
    join(dir, 'biome.json'),
    '{\n  "files": { "includes": ["*.js"] },\n  "formatter": { "indentStyle": "space" }\n}\n',
  );
  mkdirSync(join(dir, 'scripts'));
  const list = (debt) => writeFileSync(join(dir, DEBT), JSON.stringify(debt)),
    run = (options) => {
      const lines = [];
      return { status: checkTree({ cwd: dir, bin, log: (line) => lines.push(line), ...options }), lines };
    };
  list({});
  const fresh = run();
  assert.equal(fresh.status, 1);
  assert.ok(fresh.lines.includes('  old.js: format'), fresh.lines.join('\n'));
  list({ 'old.js': ['format'] });
  assert.equal(run().status, 0);
  // A second kind of failure in a listed file is new.
  writeFileSync(join(dir, 'old.js'), "import { join } from 'node:path';\nexport const a   =  [1,2];\n");
  const worse = run();
  assert.equal(worse.status, 1);
  assert.ok(
    worse.lines.some((line) => line.startsWith('  old.js: lint/')),
    worse.lines.join('\n'),
  );
  // Shrinking drops what is fixed and never adds.
  writeFileSync(join(dir, 'old.js'), 'export const a = [1, 2];\n');
  writeFileSync(join(dir, 'new.js'), 'export const c   =  1;\n');
  list({ 'old.js': ['format'], 'gone.js': ['format'] });
  assert.equal(run({ shrink: true }).status, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, DEBT), 'utf8')), {});
});

test('the committed debt list holds files, each with what fails there', () => {
  const debt = JSON.parse(readFileSync(join(root, DEBT), 'utf8'));
  for (const [file, kinds] of Object.entries(debt)) {
    assert.ok(Array.isArray(kinds) && kinds.length, file);
    assert.ok(
      kinds.every((kind) => kind === 'format' || kind.startsWith('lint/')),
      `${file}: ${kinds}`,
    );
  }
  assert.deepEqual(compareDebt(debt, debt), { fresh: [], fixed: [] });
});
