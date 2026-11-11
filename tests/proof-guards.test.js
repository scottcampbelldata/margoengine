// The package guards of the --current proofs (examples/package-benchmarks/proofs/ongoing.js and package-guard.mjs).
// On 2026-11-10, 16 of the 20 ongoing proofs broke on main one package change at a time (a reordered buffer, removed
// passes, a proof engine double missing `sceneOf`) because only verify ran them, after the push. Each ongoing proof now
// runs in the tests of every package it compares or composes; this test keeps that list complete.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ongoing } from '../examples/package-benchmarks/proofs/ongoing.js';

const root = resolve(import.meta.dirname, '..'),
  proofs = resolve(root, 'examples/package-benchmarks/proofs'),
  GUARD = '../../examples/package-benchmarks/proofs/package-guard.mjs';

/** Package folders a proof's source names: `versions('x'`, `entryAt('x'`, `both('x'`, `loadAt('x'`, `packages/x/`. */
function named(source) {
  const out = new Set();
  for (const [, name] of source.matchAll(/\b(?:versions|entryAt|both|loadAt|load)\('([a-z0-9-]+)'/g)) out.add(name);
  for (const [, name] of source.matchAll(/packages\/([a-z0-9-]+)\//g)) out.add(name);
  for (const [, list] of source.matchAll(/\[((?:'[a-z0-9-]+',\s*)+'[a-z0-9-]+')\]\.map\(\(name\)/g))
    for (const [, name] of list.matchAll(/'([a-z0-9-]+)'/g)) out.add(name);
  // core is every proof's host (a core change runs the full check) and shared is inlined into the packages that use it.
  for (const name of ['core', 'shared']) out.delete(name);
  return out;
}

test('every ongoing proof lists each package its source compares or composes', () => {
  for (const [proof, packages] of Object.entries(ongoing)) {
    const source = readFileSync(resolve(proofs, `${proof}.proof.js`), 'utf8');
    for (const name of named(source))
      assert.ok(packages.includes(name), `${proof} names ${name}; add it to ongoing.js so ${name}'s tests run it`);
  }
});

test('a proof named in ongoing.js is an ongoing proof file, and only those are listed', () => {
  const files = readdirSync(proofs)
    .filter((file) => file.endsWith('.proof.js'))
    .map((file) => file.slice(0, -9));
  for (const proof of Object.keys(ongoing)) assert.ok(files.includes(proof), `${proof}.proof.js does not exist`);
});

test('every guarded package runs its proofs in its own test script, and no other package does', () => {
  const guarded = new Set(Object.values(ongoing).flat());
  for (const dir of readdirSync(resolve(root, 'packages'))) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(root, 'packages', dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const script = manifest.scripts?.test ?? '';
    if (guarded.has(dir))
      assert.ok(
        script.trimEnd().endsWith(GUARD),
        `packages/${dir}: append ${GUARD} to its test script (its ongoing proofs)`,
      );
    else assert.ok(!script.includes('package-guard'), `packages/${dir} runs the proof guard but no proof names it`);
  }
});

test('the reader finds the names written each way the proofs write them', () => {
  const found = named(
    "versions('post', ref); entryAt('gltf-pro', 'src/index.ts'); both('labels', e); 'packages/bvh/src/math.ts' " +
      "['clustered', 'tonemap'].map((name) => entryAt(name)); packages/core/dist; packages/shared/x.js",
  );
  assert.deepEqual([...found].sort(), ['bvh', 'clustered', 'gltf-pro', 'labels', 'post', 'tonemap']);
});
