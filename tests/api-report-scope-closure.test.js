// KB-TOOL-APISCOPE1: `node scripts/api-report.js --package=<pkg>` rebuilt every stale package in the tree (108 of them
// after a rebase) before it wrote the one report asked for, because it loaded every package's declarations. A scoped
// run now loads and rebuilds only the selected package, the packages it imports and the packages that `declare module`
// one of those (scene augments core), and refuses a declaration that reads a package outside that set.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { apiReportScope, moduleAugmentations } from '../scripts/api-report-scope.mjs';
import { packageStamps, stalePackages } from '../scripts/package-stamps.mjs';
import { rebuildStalePackages } from '../scripts/support/fresh-dist.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = (name, fields = {}) => ({ name: `@margoengine/${name}`, ...fields });
const dep = (...names) => Object.fromEntries(names.map((name) => [`@margoengine/${name}`, '^1.0.0']));

test('a scoped report loads its package, what it imports and what augments those, nothing else', () => {
  const manifests = new Map([
    ['a', manifest('a', { dependencies: dep('b'), peerDependencies: dep('c'), devDependencies: dep('d') })],
    ['b', manifest('b')],
    ['c', manifest('c')],
    ['d', manifest('d')], // a dev dependency: a published declaration cannot import it
    ['e', manifest('e', { dependencies: dep('a') })], // depends on the selected package, never reached from it
    ['f', manifest('f', { dependencies: dep('g') })], // augments c, which a imports
    ['g', manifest('g')],
    ['h', manifest('h')], // augments d, which is not loaded
  ]);
  const augments = new Map([
    ['f', new Set(['@margoengine/c'])],
    ['h', new Set(['@margoengine/d'])],
  ]);
  assert.deepEqual([...apiReportScope('a', manifests, augments)].sort(), ['a', 'b', 'c', 'f', 'g']);
  assert.deepEqual([...apiReportScope('b', manifests, augments)].sort(), ['b']);
});

test('the repository: scene augments core, and a scoped physics report leaves most of the tree alone', () => {
  const augments = moduleAugmentations(root);
  assert.ok(augments.get('scene')?.has('@margoengine/core'), 'scene declares module @margoengine/core');
  const manifests = new Map();
  for (const dir of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', dir, 'package.json');
    if (existsSync(file)) manifests.set(dir, JSON.parse(readFileSync(file, 'utf8')));
  }
  const scope = apiReportScope('physics', manifests, augments);
  for (const dir of ['physics', 'core', 'math', 'scene']) assert.ok(scope.has(dir), `${dir} is loaded`);
  for (const dir of ['kit-react', 'cad', 'film']) assert.equal(scope.has(dir), false, `${dir} is not loaded`);
  assert.ok(scope.size < manifests.size / 2, `${scope.size} of ${manifests.size} packages`);
});

test('the stale check and the rebuild take only the scoped packages', () => {
  const asked = [];
  const built = [];
  const names = rebuildStalePackages(mkdtempSync(join(tmpdir(), 'scope-dist-')), {
    only: new Set(['physics', 'core']),
    stale: (_root, only) => (asked.push(only), ['core', 'kit-react', 'physics']),
    build: (stale) => built.push(stale),
    log: () => {},
  });
  assert.deepEqual([...asked[0]].sort(), ['core', 'physics']);
  assert.deepEqual(names, ['core', 'physics']);
  assert.deepEqual(built, [['core', 'physics']]);
});

test('a scoped stamp equals the full stamp, and the other packages are not hashed', () => {
  const tree = mkdtempSync(join(tmpdir(), 'scope-stamps-'));
  try {
    const write = (path, text) => {
      mkdirSync(join(tree, path, '..'), { recursive: true });
      writeFileSync(join(tree, path), text);
    };
    write('package.json', JSON.stringify({ workspaces: ['packages/a', 'packages/b', 'packages/c'] }));
    write('packages/a/package.json', JSON.stringify(manifest('a', { dependencies: dep('b') })));
    write('packages/b/package.json', JSON.stringify(manifest('b')));
    write('packages/c/package.json', JSON.stringify(manifest('c')));
    for (const dir of ['a', 'b', 'c']) write(`packages/${dir}/src/index.ts`, `export const ${dir} = 1;\n`);
    const full = packageStamps(tree);
    const scoped = packageStamps(tree, undefined, new Set(['a']));
    assert.deepEqual([...scoped.keys()].sort(), ['a', 'b'], 'a and the package it builds after');
    assert.equal(scoped.get('a'), full.get('a'));
    assert.deepEqual(stalePackages(tree, undefined, new Set(['a'])), ['a'], 'b is stale too but not asked for');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
