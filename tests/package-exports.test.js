import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { missingPackageTargets, missingTargets } from '../scripts/package-export-targets.mjs';

test('every declared package export target exists after build, including all conditional and type targets', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const problems = [];
  for (const workspace of root.workspaces.filter((path) => path.startsWith('packages/')))
    for (const directory of globSync(workspace)) problems.push(...missingPackageTargets(directory));
  assert.deepEqual(problems, [], 'run npm run build:packages; every declared export branch must emit its target');
});

// KB-RM4 (2026-11-11): a full CI run went on for forty minutes with no packages/web/dist. build-modern now checks every
// package it built with the same function and stops.
test('build:packages checks the export targets of every package it built before it ends', () => {
  const build = readFileSync('scripts/build-modern.js', 'utf8');
  const check = build.indexOf('missingPackageTargets(');
  assert.ok(check > 0, 'build-modern calls missingPackageTargets');
  assert.ok(check < build.indexOf('if (only) process.exit(0);'), 'before an --only build returns');
});

test('the export gate detects missing runtime, declaration and nested condition outputs', () => {
  const exports = {
    '.': {
      types: './dist/index.d.ts',
      browser: { import: './dist/browser.js' },
      node: { import: './dist/node.js' },
      default: './dist/index.js',
    },
    './choice': [null, './dist/choice.js'],
  };
  assert.deepEqual(
    missingTargets(exports, (target) => target === './dist/index.js'),
    ['./dist/index.d.ts', './dist/browser.js', './dist/node.js', './dist/choice.js'],
  );
  assert.deepEqual(
    missingTargets(exports, () => true),
    [],
  );
});

test('test-page 35/38/40: rebuilt preview, tilemap and viewcube APIs resolve', async () => {
  const [preview, iso, hex, axes, cube] = await Promise.all([
    import('@margoengine/webgl2-compat/preview'),
    import('@margoengine/tilemap/iso'),
    import('@margoengine/tilemap/hex'),
    import('@margoengine/viewcube/axes'),
    import('@margoengine/viewcube'),
  ]);
  assert.equal(typeof preview.webglRenderer, 'function');
  assert.equal(typeof iso.cellCenter, 'function');
  assert.equal(typeof hex.cellCenter, 'function');
  assert.equal(typeof axes.AxisTriad.attach, 'function');
  assert.equal(typeof cube.ViewCube.prototype.setTheme, 'function');
  assert.equal(typeof cube.ViewCube.prototype.roll, 'function');
});
