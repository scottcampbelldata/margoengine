import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainFar, TerrainFar } from '../dist/far.js';
import { TerrainStream } from '../dist/stream.js';

const load = async () => null,
  near = { tileSize: 64, tileTexels: 64, window: 4 };

test('terrain far rings check their options', () => {
  assert.throws(() => terrainFar(), TypeError);
  assert.throws(() => terrainFar({}), TypeError);
  for (const options of [
    { scale: 1 },
    { scale: 65 },
    { scale: 2.5 },
    { tileTexels: 3 },
    { tileTexels: 1025 },
    { window: 3 },
    { window: 18 },
    { blend: 0 },
    { blend: Infinity },
    { fade: -1 },
    { fade: NaN },
  ])
    assert.throws(() => terrainFar({ load, ...options }), RangeError, JSON.stringify(options));
  const ring = terrainFar({ load });
  assert.ok(ring instanceof TerrainFar);
  assert.equal(ring.load, load);
  assert.equal(ring.heightAt(0, 0), undefined, 'nothing is drawn before a stream takes the ring');
  assert.equal(ring.tiles, undefined);
  assert.equal(ring.reach, undefined);
});

test('a far window takes the near window sizes by default and must reach past it', () => {
  // Scale 4: 256 m tiles; (4 / 2 - 0.75) * 256 - 2 * 4 m.
  assert.deepEqual(terrainFar({ load }).plan(near), { tileSize: 256, tileTexels: 64, window: 4, reach: 312 });
  assert.deepEqual(terrainFar({ load, scale: 8, tileTexels: 32, window: 6 }).plan(near), {
    tileSize: 512,
    tileTexels: 32,
    window: 6,
    reach: 1120,
  });
  // The near window reaches 1.25 tiles; two far tiles twice as wide reach only 0.4375.
  assert.throws(() => terrainFar({ load, scale: 2, window: 2 }).plan(near), /raise far\.scale or far\.window/);
  assert.throws(() => terrainFar({ load, blend: 100 }).plan(near), /blend must be at most 78/);
  assert.throws(() => terrainFar({ load }).plan({ ...near, window: 2, tileTexels: 8 }), /too small to blend/);
  assert.throws(() => terrainFar({ load }).plan({ ...near, tileTexels: 2, window: 8 }), /tileTexels of 4 or more/);
});

test('a terrain stream refuses a far option that is not a ring, and a ring that does not fit', () => {
  const engine = { camera: { position: [0, 0, 0] } },
    layers = Array.from({ length: 4 }, () => ({ height: [-1, 1], slope: [0, 1], scale: 1 })),
    base = { layers, ...near, load, colors: () => ({}) };
  assert.throws(() => TerrainStream.attach(engine, { ...base, far: { load } }), TypeError);
  assert.throws(
    () => TerrainStream.attach(engine, { ...base, far: terrainFar({ load, scale: 2, window: 2 }) }),
    RangeError,
  );
});
