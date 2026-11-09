import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { ScatterTiles } from '../dist/tiles.js';
import { Scatter } from '../dist/index.js';
import { outsideLod, tileDistance } from '../src/lod.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('LOD boundaries must stay positive and strictly increasing in uploaded f32 values', () => {
  for (const lod of [
    [Number.MIN_VALUE, 2, 4],
    [2 ** -127, 2, 4],
    [1, 1 + 2 ** -25, 4],
    [1, 4 - 2 ** -25, 4],
    [1, , 4],
  ]) {
    assert.throws(() => new Scatter(box(), { lod }), RangeError);
    assert.throws(() => new ScatterTiles(box(), { bounds: [0, 0, 1, 1], lod }), RangeError);
  }
  const lod = [2 ** -126, 2 ** -125, 2 ** -124];
  using valid = new Scatter(box(), { lod });
  assert.deepEqual(Array.from(valid.values.slice(32, 35)), lod);
});

test('CPU and WGSL share an inclusive outer LOD rejection rule', () => {
  assert.equal(outsideLod(4, 4), false);
  assert.equal(outsideLod(4 + 2 ** -20, 4), true);
  assert.equal(outsideLod('d', 'frame.lod.z'), 'd>frame.lod.z');
});

test('fresh tile rings budget inclusive endpoints and the uploaded origin, side and camera', async (t) => {
  const records = new Uint8Array(64 * 8);
  for (const { origin, side, eye, lod, ring } of [
    { origin: [0, 0], side: 1, eye: [0, 0, -4], lod: [0.5, 2, 4], ring: 2 },
    { origin: [16777217, 0], side: 1, eye: [16777216, 0, 0], lod: [0.5, 2, 4], ring: 0 },
    { origin: [16777216, 0], side: 0.125, eye: [16777217, 0, 0], lod: [0.5, 2, 4], ring: 0 },
    { origin: [0, 0], side: 1, eye: [-3.000000238418579, 0, -Math.fround(Math.sqrt(7))], lod: [0.5, 2, 4], ring: 2 },
    // The packed upper edge rounds to 16777218, beyond origin + side in double precision.
    { origin: [16777216, 0], side: 1.1, eye: [16777218, 0, 0], lod: [0.5, 2, 4], ring: 0 },
  ]) {
    await t.test(JSON.stringify({ origin, side, eye, ring }), () => {
      const h = optionalGPU(),
        tiles = new ScatterTiles(box(0.01), {
          bounds: origin[0] > 1000000 ? [16777200, -32, 16777232, 32] : [-32, -32, 32, 32],
          lod,
          lodFade: 0,
        });
      h.engine.use(tiles);
      Object.assign(h.engine.camera.position, eye);
      tiles.setTile('a', origin, side, records);
      h.frame();
      assert.ok(tiles.instances[ring].size / 32 >= 64, JSON.stringify({ origin, side, eye, ring }));
      tiles.dispose();
    });
  }
});

test('tile distance encloses f32 placement, distance rounding and flushed squared components', () => {
  const f = Math.fround;
  for (const [x, z, side] of [
    [0, 0, 1],
    [16777216, 0, 1],
    [-65536, 65536, 3.2],
    [0, 0, 1e-30],
  ])
    for (const packed of [0, 1, 32767, 65534, 65535]) {
      const world = [x, z].map((v) => f(v + f(f(packed * f(side)) / 65536)));
      for (const [eyeX, eyeZ] of [
        [0, 0],
        [-3, -Math.sqrt(7)],
        [x + side, z + side],
        [-1e-20, -1e-20],
      ]) {
        const dx = f(world[0] - f(eyeX)),
          dz = f(world[1] - f(eyeZ));
        const flush = (v) => (Math.abs(v) < 2 ** -126 ? 0 : v);
        const gpu = f(Math.sqrt(flush(f(flush(f(dx * dx)) + flush(f(dz * dz))))));
        assert.ok(tileDistance(f(x), f(z), f(side), f(eyeX), f(eyeZ)) <= gpu);
      }
    }
});
