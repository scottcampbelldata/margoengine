// Node checks of @margoengine/pixel/render3d: the CPU outline on hand-made depth, option errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outlineMask, Render3D, renderSpriteFrames } from '../dist/render3d.js';

// An identity matrix: depth values are clip z directly, x and y from -1 to 1, looking along +z from far behind.
const IDENTITY = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const frame = (rows) => ({
  depth: Float32Array.from(rows.flat()),
  width: rows[0].length,
  height: rows.length,
  matrix: IDENTITY,
  eye: [0, 0, -10],
  forward: [0, 0, 1],
});
const grid = (mask, width) =>
  Array.from({ length: mask.length / width }, (_, y) => [...mask.subarray(y * width, (y + 1) * width)].join(''));

test('a drawn pixel beside an empty one is outlined; the frame edge is not a neighbour', () => {
  const mask = outlineMask(
    frame([
      [0, 0, 0, 0],
      [0, 0.5, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
    ]),
    { crease: 0 },
  );
  assert.deepEqual(grid(mask, 4), ['0000', '0111', '0100', '0100']);
});

test('the nearer side of a depth step is outlined, by depthEdge', () => {
  const depth = frame([[0.2, 0.2, 0.8, 0.8]]);
  assert.deepEqual(grid(outlineMask(depth, { depthEdge: 0.1, crease: 0 }), 4), ['0100']);
  assert.deepEqual(grid(outlineMask(depth, { depthEdge: 0.7, crease: 0 }), 4), ['0000']);
});

test('a crease is found where the surface turns, a flat slope has none', () => {
  const ramp = (f) => Array.from({ length: 4 }, () => Array.from({ length: 6 }, (_, x) => f(x)));
  const flat = outlineMask(frame(ramp((x) => 0.1 + x * 0.02)), { depthEdge: 10, crease: 0.1 });
  assert.equal(
    flat.reduce((a, b) => a + b),
    0,
  );
  // Slopes one way, then the other.
  const roof = outlineMask(frame(ramp((x) => 0.5 - Math.abs(x - 2.5) * 0.2)), { depthEdge: 10, crease: 0.1 });
  assert.ok(roof.reduce((a, b) => a + b) > 0);
});

test('bad options throw', () => {
  assert.throws(() => new Render3D({}), TypeError);
  assert.throws(() => new Render3D({ camera: {}, width: 1.5, height: 2 }), RangeError);
  assert.throws(() => new Render3D({ camera: {}, width: 2, height: 2, samples: 0 }), RangeError);
  assert.throws(
    () => renderSpriteFrames({}, { rotation: { x: 0, y: 0, z: 0 } }, { camera: {}, angles: [], width: 2, height: 2 }),
    RangeError,
  );
});

test('a camera matrix with no inverse names its fix', () => {
  const flat = { ...frame([[0.5]]), matrix: new Float64Array(16) };
  assert.throws(() => outlineMask(flat), { name: 'RangeError', message: /needs an inverse/ });
});
