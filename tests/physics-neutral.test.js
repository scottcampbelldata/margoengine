// Margo's own solver replaces Rapier in one commit, so nothing outside the physics packages may lean on it: no package
// names it and none reaches past the Physics API to the solver's own objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', 'packages'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|mjs|md|json)$/.test(file) && !/^packages\/physics(2d)?\//.test(file));
const text = (file) => readFileSync(file, 'utf8');

// Each entry says why it stays until the switch; a line that no longer matches fails, so this list only shrinks.
const NAMED = [
  // The optional peers of the umbrella package, generated from the two physics packages.
  ['packages/margoengine/package.json', /@dimforge\/rapier[23]d-compat/i],
  // What an app installs today.
  ['packages/margoengine/README.md', /npm i @dimforge\/rapier3d-compat/],
  ['packages/stage/README.md', /@dimforge\/rapier3d-compat/],
  // The guard that the root entry never pulls it in.
  ['packages/react/tests/subpaths.test.js', /rapier/i],
  // Vite must see the lazy import before a scene mounts, or it reloads the running page.
  ['packages/react/tests/scene-browser.tsx', /@dimforge\/rapier3d-compat|Rapier/],
];

test('no package outside physics names Rapier', () => {
  const found = [];
  for (const file of files) {
    text(file)
      .split('\n')
      .forEach((line, i) => {
        if (/rapier/i.test(line) && !NAMED.some(([where, allowed]) => where === file && allowed.test(line)))
          found.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(found, []);
  for (const [file, allowed] of NAMED) assert.ok(allowed.test(text(file)), `${file} no longer needs its entry`);
});

test('no package outside physics reaches the solver through raw, world or rapier', () => {
  const solver = /\.raw\.\w|\{ raw \} = |\bphysics\.(world|rapier)\b/,
    found = [];
  for (const file of files) {
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    const source = text(file);
    if (!/@margoengine\/physics|physics(2d)?\/dist|gltf-pro\/physics|GLTFPhysics/.test(source)) continue;
    source.split('\n').forEach((line, i) => {
      if (solver.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
