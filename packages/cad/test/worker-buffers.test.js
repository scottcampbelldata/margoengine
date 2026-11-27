// The worker builds each mesh's buffers itself (src/internal/buffers.ts) instead of bundling core's Geometry, whose
// build declares its class fields: the worker then failed tests/class-fields.test.js. The page wraps the buffers in a
// Geometry without copying, so they must be exactly what `new Geometry(...)` makes, errors included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { Geometry } from '@margoengine/core';

const url = new URL('../src/internal/buffers.ts', import.meta.url);
let source = await readFile(url, 'utf8');
source = source.replace(/'(\.\.\/\.\.\/\.\.\/shared\/[^']+)'/g, (_, path) => JSON.stringify(new URL(path, url).href));
const { code } = await transformWithOxc(source, 'buffers.ts', { loader: 'ts', target: 'es2022' });
const { meshBuffers } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const bits = (array) => [...new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4)];
function same(positions, normals, indices) {
  const g = new Geometry(positions, normals, indices),
    b = meshBuffers(positions, normals, indices);
  assert.deepEqual(bits(b.vertices), bits(g.vertices));
  assert.deepEqual([...b.indices], [...g.indices]);
  assert.deepEqual(bits(b.bounds), bits(g.bounds), 'bounds bit for bit, the rounded-up radius included');
}

test('the worker buffers are bit for bit the buffers of core Geometry', () => {
  same([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
  same([-0, -0, -0, -0, 2, -0, 3, -0, -0], [0, 0, -1, 0, 0, -1, 0, 0, -1], [0, 2, 1]);
  same([], [], []);
  // Random float64 positions far from the origin: the float32 rounding and the radius rounding are where they differ.
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 2 ** 31 - 0.5) * 2000 + 12345.678;
  const positions = Array.from({ length: 300 }, rand),
    normals = Array.from({ length: 300 }, () => 0.5),
    indices = Array.from({ length: 297 }, (_, i) => (i * 7) % 100);
  same(positions, normals, indices);
});

test('the worker buffers refuse what core Geometry refuses, with the same error', () => {
  for (const args of [
    [
      [0, 0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 0, 1],
      [0, 1, 2],
    ],
    [
      [0, 0, 0, 1, 0, 0, 0, 1, Number.NaN],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2],
    ],
    [
      [0, 0, 0, 1, 0, 0, 0, 1, 1e39],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2],
    ],
    [
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 3],
    ],
    [
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1],
    ],
  ]) {
    let expected;
    assert.throws(
      () => new Geometry(...args),
      (error) => ((expected = error), true),
    );
    assert.throws(() => meshBuffers(...args), { name: expected.name, message: expected.message });
  }
});

test('the built worker bundles no core class and declares no bare class fields', () => {
  const worker = readFileSync(new URL('../dist/workers/cad-runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /\bclass(?:\s+[\w$]+)?(?:\s+extends\s+[\w$.]+)?\s*\{\s*[A-Za-z_$][\w$]*\s*;/);
  assert.doesNotMatch(worker, /vertices;\s*indices;\s*bounds;/);
});
