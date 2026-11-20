// Regression (KB-IMPORTMAP-STALE1, 2026-11-16): after a package rename (scenery, the old kits, net into netcode) a
// checkout that had built before kept packages/<old>/dist, LICENSE and NOTICE (ignored files git leaves behind). An
// app's engine resolver read 34 dead @margoengine/scenery/* entries from them and api:update stopped on "missing
// package.json". A full build:packages now removes that output (scripts/support/stale-packages.mjs), and the import map
// lists only folders with a package.json.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { removeStalePackageOutputs } from '../scripts/support/stale-packages.mjs';
import { importMap } from '../scripts/umbrella.mjs';

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), 'margo-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(join(root, 'LICENSE'), 'license text');
  put(join(root, 'NOTICE'), 'notice text');
  const manifest = (name, exports) => JSON.stringify({ name, version: '1.0.0', exports });
  put(join(root, 'packages/margoengine/package.json'), manifest('margoengine', { '.': { import: './dist/index.js' } }));
  put(join(root, 'packages/live/package.json'), manifest('@margoengine/live', { '.': { import: './dist/index.js' } }));
  put(join(root, 'packages/live/dist/index.js'), 'live');
  put(join(root, 'packages/live/LICENSE'), 'license text');
  // Renamed away: only what the build wrote is left.
  put(join(root, 'packages/scenery/dist/index.js'), 'dead');
  put(join(root, 'packages/scenery/dist/trees.js'), 'dead');
  put(join(root, 'packages/scenery/LICENSE'), 'license text');
  put(join(root, 'packages/scenery/NOTICE'), 'notice text');
  // A folder someone is still working in: its sources stay, only the build output goes.
  put(join(root, 'packages/draft/src/index.ts'), 'work in progress');
  put(join(root, 'packages/draft/NOTICE'), 'its own notice');
  put(join(root, 'packages/draft/dist/index.js'), 'old build');
  // An internal folder with no package.json and no build output (packages/shared, packages/kernel).
  put(join(root, 'packages/shared/math.js'), 'shared');
  return root;
}

test('a full build removes the dist, LICENSE and NOTICE a package left behind when it left the workspace', (t) => {
  const root = checkout(t);
  const cleaned = removeStalePackageOutputs(root, ['packages/margoengine', 'packages/live', 'examples/vite']);
  assert.deepEqual(cleaned, [
    { dir: 'packages/draft', removed: ['dist'], folderRemoved: false },
    { dir: 'packages/scenery', removed: ['dist', 'LICENSE', 'NOTICE'], folderRemoved: true },
  ]);
  assert.equal(existsSync(join(root, 'packages/scenery')), false);
  assert.equal(readFileSync(join(root, 'packages/draft/src/index.ts'), 'utf8'), 'work in progress');
  assert.equal(readFileSync(join(root, 'packages/draft/NOTICE'), 'utf8'), 'its own notice');
  assert.equal(readFileSync(join(root, 'packages/live/dist/index.js'), 'utf8'), 'live');
  assert.equal(existsSync(join(root, 'packages/live/LICENSE')), true);
  assert.equal(existsSync(join(root, 'packages/shared/math.js')), true);
  assert.deepEqual(removeStalePackageOutputs(root, ['packages/margoengine', 'packages/live']), []);
});

test('the import map lists only package folders with a package.json, never a stray dist', (t) => {
  const root = checkout(t);
  const names = Object.keys(importMap(root).imports);
  assert.deepEqual(names.sort(), ['@margoengine/live', 'margoengine']);
});
