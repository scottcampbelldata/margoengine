// KB-QUALITY-CROSSTREE1: another session wrote into a lane's tree during its gate run and nothing said so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeChanges, treeState } from '../scripts/quality/tree-watch.js';

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'margo-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const write = (name, text) => writeFileSync(join(root, name), text);
  git('init', '-q');
  write('.gitignore', 'dist/\n');
  write('sun.ts', 'one\n');
  write('sky.ts', 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { root, git, write };
}

test('an unchanged tree, with or without uncommitted work, reports nothing', (t) => {
  const { root, write } = repository(t);
  assert.deepEqual(treeChanges(treeState(root), treeState(root)), []);
  write('sun.ts', 'two\n');
  write('new.ts', 'new\n');
  const dirty = treeState(root);
  assert.deepEqual([...dirty.files.keys()].sort(), ['new.ts', 'sun.ts']);
  assert.deepEqual(treeChanges(dirty, treeState(root)), []);
});

test('writes during a run are named: changed, new, written again, restored and committed', (t) => {
  const { root, git, write } = repository(t);
  write('sun.ts', 'two\n');
  const before = treeState(root);
  write('sky.ts', 'two\n');
  write('new.ts', 'new\n');
  // The same size again: only the write time tells.
  utimesSync(join(root, 'sun.ts'), new Date(0), new Date(0));
  assert.deepEqual(treeChanges(before, treeState(root)), [
    'new.ts was changed',
    'sky.ts was changed',
    'sun.ts was written again',
  ]);
  git('checkout', '-q', '--', 'sun.ts');
  assert.deepEqual(treeChanges(before, treeState(root)).at(-1), 'sun.ts was committed or restored');
  git('add', '.');
  git('commit', '-qm', 'second');
  assert.match(treeChanges(before, treeState(root))[0], /^HEAD moved from [0-9a-f]+ to [0-9a-f]+$/);
});

test('a rename, a deletion, ignored files and the gate’s own folder', (t) => {
  const { root, git, write } = repository(t);
  const before = treeState(root, { own: ['baselines/'] });
  git('mv', 'sun.ts', 'moon.ts');
  rmSync(join(root, 'sky.ts'));
  execFileSync(
    process.execPath,
    [
      '-e',
      "const f=require('node:fs');f.mkdirSync('dist');f.mkdirSync('baselines');f.writeFileSync('dist/a.js','');f.writeFileSync('baselines/sizes.json','{}')",
    ],
    { cwd: root },
  );
  write('.gitignore', 'dist/\n');
  assert.deepEqual([...treeState(root, { own: ['baselines/'] }).files.keys()].sort(), ['moon.ts', 'sky.ts']);
  assert.equal(treeChanges(before, treeState(root, { own: ['baselines/'] })).length, 2);
});

test('the quality gate takes the tree before it reads it and fails when it differs afterwards', () => {
  const gate = readFileSync(new URL('../scripts/quality-gate.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.ok(gate.indexOf('treeState(root, watched)') < gate.indexOf('repoFiles(root);'));
  assert.match(
    gate,
    /const changes = treeChanges\(tree, treeState\(root, watched\)\);\n\s+if \(changes\.length\) \{\n\s+failed\+\+;/,
  );
});
