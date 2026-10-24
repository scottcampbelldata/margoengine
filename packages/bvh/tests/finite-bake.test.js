import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeVertexColors } from '../dist/bake.js';
import { MeshBVH } from '../dist/tree.js';

// A ceiling quad at height y above a floor vertex at the origin, lit by a light just above the floor.
const bvhAt = (y) =>
  MeshBVH.build({
    positions: Float32Array.of(-1, y, -1, 1, y, -1, 1, y, 1, -1, y, 1),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  });
const target = { positions: [0, 0, 0], normals: [0, 1, 0] };
const light = (type) => ({
  type,
  position: [0, 2 ** -11, 0],
  intensity: 0.5,
  decay: 0,
  ...(type === 'spot' ? { direction: [0, -1, 0], angle: Math.PI / 4 } : {}),
});

test('segment shadows stop at the light and need no normal bias', () => {
  for (const type of ['point', 'spot']) {
    const bake = (y, segmentShadows) =>
      bakeVertexColors(target, bvhAt(y), { lights: [light(type)], segmentShadows })[0];
    // Blocker between surface and light: the biased ray starts above it and misses it; the segment sees it.
    assert.equal(bake(2 ** -12, false), 0.5);
    assert.equal(bake(2 ** -12, true), 0);
    // Blocker beyond the light: the biased ray runs past the light into it; the segment stops at the light.
    assert.equal(bake(5 * 2 ** -12, false), 0);
    assert.equal(bake(5 * 2 ** -12, true), 0.5);
  }
});

test('shadowFaceFilter receives face and vertex indices and can skip a blocker', () => {
  const seen = [];
  const out = bakeVertexColors(target, bvhAt(2 ** -12), {
    lights: [light('point')],
    segmentShadows: true,
    shadowFaceFilter: (face, vertex) => (seen.push([face, vertex]), false),
  });
  assert.equal(out[0], 0.5);
  assert.ok(seen.length && seen.every(([face, vertex]) => (face === 0 || face === 1) && vertex === 0));
});

test('directional light and AO are unchanged by segmentShadows', () => {
  const options = { lights: [{ type: 'directional', direction: [0, 1, 0] }], ao: { rays: 16, distance: 1 }, seed: 19 };
  assert.deepEqual(
    bakeVertexColors(target, bvhAt(0.2), { ...options, segmentShadows: true }),
    bakeVertexColors(target, bvhAt(0.2), options),
  );
});
