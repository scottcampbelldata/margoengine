import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  clearStamp,
  packageStamps,
  readStamp,
  stalePackages,
  writeStamp,
} from '../scripts/package-stamps.mjs';

// A small workspace: b builds after a, c stands alone.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'margo-stamps-'));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ workspaces: ['packages/a', 'packages/b', 'packages/c'] }));
  const manifest = (name, deps = {}, exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }) =>
    JSON.stringify({ name, dependencies: deps, exports });
  write('packages/a/package.json', manifest('@margoengine/a'));
  write('packages/a/src/index.ts', 'export const a = 1;\n');
  write('packages/b/package.json', manifest('@margoengine/b', { '@margoengine/a': '^1.0.0' }));
  write('packages/b/src/index.ts', "export { a as b } from '@margoengine/a';\n");
  write('packages/c/package.json', manifest('@margoengine/c'));
  write('packages/c/src/index.ts', 'export const c = 3;\n');
  write('packages/shared/math.js', 'export const pi = 3;\n');
  write('scripts/build-modern.js', '// build\n');
  const built = () => {
    for (const [dir, stamp] of packageStamps(root)) writeStamp(root, dir, stamp);
  };
  return { root, write, built, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Regression (2026-11-10): a rebase that added an entry to a package nobody touched left that package's dist from the
// old sources, and the API report failed on it until build:packages ran again. The stamp must notice the new entry.
test('a new entry makes its package and the packages built after it stale, and nothing else', (t) => {
  const { root, write, built, cleanup } = fixture();
  t.after(cleanup);
  built();
  assert.deepEqual(stalePackages(root), []);
  const manifest = JSON.parse(readFileSync(join(root, 'packages/a/package.json'), 'utf8'));
  manifest.exports['./extra'] = { types: './dist/extra.d.ts', import: './dist/extra.js' };
  write('packages/a/package.json', JSON.stringify(manifest));
  write('packages/a/src/extra.ts', 'export const extra = 2;\n');
  assert.deepEqual(stalePackages(root), ['a', 'b']);
  writeStamp(root, 'a', packageStamps(root).get('a'));
  assert.deepEqual(stalePackages(root), ['b'], 'b inlines types from a, so it waits for its own build');
  writeStamp(root, 'b', packageStamps(root).get('b'));
  assert.deepEqual(stalePackages(root), []);
});

test('a changed source file, shared module or build tool makes the right packages stale', (t) => {
  const { root, write, built, cleanup } = fixture();
  t.after(cleanup);
  built();
  write('packages/c/src/index.ts', 'export const c = 4;\n');
  assert.deepEqual(stalePackages(root), ['c']);
  built();
  write('packages/shared/math.js', 'export const pi = 3.14;\n');
  assert.deepEqual(stalePackages(root), ['a', 'b', 'c']);
  built();
  write('scripts/build-modern.js', '// build, changed\n');
  assert.deepEqual(stalePackages(root), ['a', 'b', 'c']);
  built();
  write('packages/a/tests/a.test.js', '// tests are not build input\n');
  assert.deepEqual(stalePackages(root), []);
});

// Regression (2026-11-10): the stamp hashed a fixed list of build tools and only each package's own tsconfig.json, so a
// change to a helper module a build tool imports, to a script a package's build command runs, or to the tsconfig.json a
// package extends (92 packages extend packages/gltf/tsconfig.json) left the old dist looking current, and the API report
// read declarations built from other sources.
test('a build helper, a package build script outside the package or an extended tsconfig makes the right packages stale', (t) => {
  const { root, write, built, cleanup } = fixture();
  t.after(cleanup);
  write('scripts/build-modern.js', "import { helper } from './helper.js';\n");
  write('scripts/helper.js', "export const helper = 'v1';\n");
  write('scripts/build-optional.js', "import './optional-helper.mjs';\n");
  write('scripts/optional-helper.mjs', '// v1\n');
  write(
    'packages/c/package.json',
    JSON.stringify({
      name: '@margoengine/c',
      scripts: { build: 'node ../../scripts/build-optional.js c' },
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
  );
  write('packages/a/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  write('packages/c/tsconfig.json', JSON.stringify({ extends: '../a/tsconfig.json', include: ['src'] }));
  built();
  assert.deepEqual(stalePackages(root), []);
  write('scripts/helper.js', "export const helper = 'v2';\n");
  assert.deepEqual(stalePackages(root), ['a', 'b', 'c'], 'a module build-modern imports');
  built();
  write('scripts/optional-helper.mjs', '// v2\n');
  assert.deepEqual(stalePackages(root), ['c'], "a module c's build command loads");
  built();
  write('packages/a/tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }));
  assert.deepEqual(stalePackages(root), ['a', 'b', 'c'], 'c extends the tsconfig.json of a without depending on a');
});

test('a package with no stamp, or a cleared one, is stale', (t) => {
  const { root, built, cleanup } = fixture();
  t.after(cleanup);
  assert.deepEqual(stalePackages(root), ['a', 'b', 'c'], 'never built');
  built();
  clearStamp(root, 'c');
  assert.equal(readStamp(root, 'c'), undefined);
  assert.deepEqual(stalePackages(root), ['c'], 'a build that failed part way');
});

test('the build writes a stamp after each package and clears it before', () => {
  const build = readFileSync(new URL('../scripts/build-modern.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(
    build,
    /clearStamp\(process\.cwd\(\), name\);\n\s*await buildPackage\(name\);[\s\S]*?writeStamp\(process\.cwd\(\), name, stamps\.get\(name\)\);/,
  );
  const report = readFileSync(new URL('../scripts/api-report.js', import.meta.url), 'utf8');
  assert.match(report, /const stale = stalePackages\(root\);/, 'the API report checks the stamps before it reads dist');
});
