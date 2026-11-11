// Benchmark arms patch a served build; the patched code may sit in any chunk (tint-pass-gpu once looked only in src-*.js).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertPatchedOnce, patchChunk } from '../examples/package-benchmarks/parts/bundle-patch.mjs';

test('a pattern is counted over every chunk of a load', () => {
  const pairs = [[/=([\w$]+)=>!!\1\.attenuation&&!\1\.shading/g, '=$1=>!1']];
  const matched = new Map();
  assert.equal(patchChunk('export const a=1;', pairs, matched), 'export const a=1;');
  assert.equal(patchChunk('x,$n=e=>!!e.attenuation&&!e.shading;', pairs, matched), 'x,$n=e=>!1;');
  assertPatchedOnce('constant', pairs, matched);
  patchChunk('y=e=>!!e.attenuation&&!e.shading', pairs, matched);
  assert.throws(() => assertPatchedOnce('constant', pairs, matched), /must match the build once/);
  assert.throws(() => assertPatchedOnce('none', pairs, new Map()), /must match the build once/);
});

test('tint-pass-gpu routes every gltf-pro dist chunk and its patterns match the built package once', () => {
  const script = readFileSync(new URL('../examples/package-benchmarks/tint-pass-gpu.mjs', import.meta.url), 'utf8');
  assert.match(script, /packages\/gltf-pro\/dist\/\*\.js\*/);
  assert.match(script, /assertPatchedOnce\(/);
  const dist = new URL('../packages/gltf-pro/dist/', import.meta.url);
  const chunks = readdirSync(dist).filter((n) => n.endsWith('.js')); // built by npm run build:packages
  const all = chunks.map((n) => readFileSync(new URL(n, dist), 'utf8')).join('\n');
  assert.equal(all.match(/=([\w$]+)=>!!\1\.attenuation&&!\1\.shading/g)?.length, 1);
  assert.equal(all.match(/if\([\w$]+\.tint\)\{let /g)?.length, 1);
});
