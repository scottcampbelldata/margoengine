import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { ForestEcosystemSolver } from '../dist/forest.js';
import { PlantGrowth } from '../dist/growth.js';

// The growth and forest entries load @margoengine/physics/world (about 11 kB gzip) with import() inside load(), so a page
// that reads the entry for its types or its options does not fetch the world. quality sizes counts a static import as a
// leak; this test names the cause.
const dist = (file) => readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');

test('growth and forest never import the physics world statically; one chunk loads it with import()', () => {
  const staticImport = /^\s*(import|export)[^;]*from\s*['"]@margoengine\/physics\/world['"]/m;
  for (const file of ['growth.js', 'forest.js']) assert.doesNotMatch(dist(file), staticImport, file);
  const loaders = readdirSync(new URL('../dist/', import.meta.url)).filter((file) =>
    /^physics-world.*\.js$/.test(file),
  );
  assert.ok(loaders.length >= 1, 'the loader is its own chunk');
  for (const file of loaders) {
    assert.doesNotMatch(dist(file), staticImport, file);
    assert.match(dist(file), /import\(['"]@margoengine\/physics\/world['"]\)/, file);
  }
});

test('the solvers load, which brings the physics world in', async () => {
  const growth = await PlantGrowth.load();
  assert.equal(typeof growth.describe, 'function');
  const forest = await ForestEcosystemSolver.load();
  assert.equal(typeof forest.describe, 'function');
});
