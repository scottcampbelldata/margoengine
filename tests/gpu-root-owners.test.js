// A root GPU suite that checks a package's own shaders runs from that package's GPU scripts, so the fast gate (the
// changed packages' GPU scripts only) runs it; a full or affected run still runs it once (KB-POSTFX-DOFSTALE1).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { picked, plan, ROOT, ROOT_OWNERS, rootSuiteOf, unownedRootSuites } from '../scripts/gpu-package-tests.mjs';

const root = resolve(import.meta.dirname, '..'),
  json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8')),
  scripts = json('package.json').scripts,
  packageScripts = (dir) =>
    existsSync(join(root, `packages/${dir}/package.json`)) ? json(`packages/${dir}/package.json`).scripts : undefined,
  read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined);

test('every root suite that checks a package is run by that package’s own GPU scripts', () => {
  assert.deepEqual(unownedRootSuites({ scripts, packageScripts, read }), []);
});

test('the check names a suite whose owner has no script for it, and one that imports an unlisted package', () => {
  const root = { 'modern:test:postfx:browser': 'x', 'test:other:browser': 'x' },
    found = unownedRootSuites({
      scripts: { 'modern:test:postfx:browser': 'node a.js', 'test:other:browser': 'node b.js' },
      packageScripts: (dir) =>
        dir === 'dof'
          ? { 'test:gpu': 'cd ../.. && node packages/dof/tests/gpu/lens-check.mjs' }
          : { 'test:gpu:postfx': 'cd ../.. && npm run modern:test:postfx:browser' },
      read: (file) => (file === 'a.js' ? "import('/packages/dof/src/shaders.ts')" : "import('/packages/sky/src/x.ts')"),
      root,
      owners: { 'modern:test:postfx:browser': ['dof', 'tonemap'] },
      prepare: {},
    });
  assert.deepEqual(
    found.map((line) => line.split(' ').slice(0, 2).join(' ')),
    ['modern:test:postfx:browser: dof', 'test:other:browser: checks'],
  );
});

test('an owner script runs the suite with its PREPARE commands first, and nothing else matches', () => {
  const prepare = { 'modern:test:usdz:browser': ['npm run modern:test:usdz'] };
  assert.equal(
    rootSuiteOf('cd ../.. && npm run modern:test:usdz && npm run modern:test:usdz:browser', ROOT, prepare),
    'modern:test:usdz:browser',
  );
  assert.equal(rootSuiteOf('cd ../.. && npm run modern:test:usdz:browser', ROOT, prepare), undefined);
  assert.equal(rootSuiteOf('cd ../.. && npm run modern:test:postfx:browser -- --compat', ROOT, prepare), undefined);
});

test('plan() folds the owners’ scripts into one root test, and --only and --select reach it by them', () => {
  const tests = plan();
  for (const [suite, dirs] of Object.entries(ROOT_OWNERS)) {
    const rows = tests.filter((t) => t.name === suite || rootSuiteOf(t.command) === suite);
    assert.equal(rows.length, 1, `${suite} runs once in a full plan`);
    for (const dir of dirs) {
      assert.ok(
        rows[0].owners?.some((label) => label.startsWith(`${dir} `)),
        `${suite} folds in ${dir}'s script`,
      );
      const [label] = rows[0].owners.filter((l) => l.startsWith(`${dir} `));
      assert.ok(picked(rows[0], dir, undefined), `--only=${dir} picks ${suite}`);
      assert.ok(picked(rows[0], undefined, new Set([label.replace(' ', '/')])), `--select of ${label} picks ${suite}`);
    }
  }
});
