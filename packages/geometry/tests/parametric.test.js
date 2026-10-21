// parametricGeometry against analytic surfaces: sphere and torus area, volume and topology, and surface normals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parametricGeometry } from '../dist/extras.js';
import {
  assertNormalsAgreeWithWinding,
  assertUVRange,
  assertValid,
  close,
  point,
  signedVolume,
  surfaceArea,
  vertexCount,
  watertight,
} from './support/mesh-checks.js';

// Counter-clockwise seen from outside: u runs around +y, v from the south pole to the north pole.
const sphere = (r) => (u, v) => {
  const phi = u * 2 * Math.PI,
    theta = (v - 0.5) * Math.PI;
  return [r * Math.cos(theta) * Math.sin(phi), r * Math.sin(theta), r * Math.cos(theta) * Math.cos(phi)];
};
const torus = (R, r) => (u, v, target) => {
  const a = u * 2 * Math.PI,
    b = v * 2 * Math.PI;
  target[0] = (R + r * Math.cos(b)) * Math.cos(a);
  target[1] = (R + r * Math.cos(b)) * Math.sin(a);
  target[2] = r * Math.sin(b);
};

test('a parametric sphere is closed after welding and converges to 4 pi r^2 and 4/3 pi r^3', () => {
  for (const [slices, stacks] of [
    [16, 8],
    [64, 32],
    [256, 128],
  ]) {
    const g = parametricGeometry(sphere(2), slices, stacks),
      label = `sphere ${slices}x${stacks}`;
    assertValid(g, label);
    assertUVRange(g, label);
    assertNormalsAgreeWithWinding(g, label);
    assert.equal(vertexCount(g), (slices + 1) * (stacks + 1));
    assert.equal(g.indices.length, slices * stacks * 6);
    assert.equal(watertight(g, label).euler, 2, `${label} Euler characteristic`);
    // Normals are radial, poles included (taken a step inside the parameter square).
    for (let i = 0; i < vertexCount(g); i++) {
      const p = point(g, i),
        l = Math.hypot(...p);
      for (let c = 0; c < 3; c++) close(g.normals[i * 3 + c], p[c] / l, 2e-3, `${label} radial normal ${i}`);
    }
    if (slices === 256) {
      close(surfaceArea(g), 16 * Math.PI, 16 * Math.PI * 1e-3, `${label} area`);
      close(signedVolume(g), (32 / 3) * Math.PI, (32 / 3) * Math.PI * 1e-3, `${label} volume`);
    }
  }
});

test('a parametric torus written into the target has genus 1 and the analytic area and volume', () => {
  const R = 3,
    r = 1,
    g = parametricGeometry(torus(R, r), 128, 64);
  assertValid(g, 'torus');
  assertNormalsAgreeWithWinding(g, 'torus');
  assert.equal(watertight(g, 'torus').euler, 0);
  // Inscribed polygons: about (2 pi / 64)^2 / 6 = 1.6e-3 relative from the 64 tube segments.
  close(surfaceArea(g), 4 * Math.PI ** 2 * R * r, 4 * Math.PI ** 2 * R * r * 3e-3, 'torus area');
  close(signedVolume(g), 2 * Math.PI ** 2 * R * r * r, 2 * Math.PI ** 2 * R * r * r * 3e-3, 'torus volume');
  // Normals point from the tube's centre circle to the surface.
  for (let i = 0; i < vertexCount(g); i++) {
    const [x, y, z] = point(g, i),
      a = Math.atan2(y, x),
      d = [x - R * Math.cos(a), y - R * Math.sin(a), z],
      l = Math.hypot(...d);
    for (let c = 0; c < 3; c++) close(g.normals[i * 3 + c], d[c] / l, 1e-3, `torus normal ${i}`);
  }
});

test('a plane has its constant normal, exact UVs and defaults of 8 x 8', () => {
  const g = parametricGeometry((u, v) => [u * 4 - 2, v * 2 - 1, 0.5]);
  assert.equal(vertexCount(g), 81);
  close(surfaceArea(g), 8, 1e-6, 'plane area');
  for (let i = 0; i < vertexCount(g); i++) {
    assert.deepEqual([g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]], [0, 0, 1]);
    close(g.uvs[i * 2], (g.positions[i * 3] + 2) / 4, 1e-6, 'u');
    close(g.uvs[i * 2 + 1], (g.positions[i * 3 + 1] + 1) / 2, 1e-6, 'v');
  }
});

test('bad input throws with the fix in the message', () => {
  assert.throws(() => parametricGeometry(null), TypeError);
  assert.throws(() => parametricGeometry(() => [0, 0, 0], 0), /slices 0 is invalid/);
  assert.throws(() => parametricGeometry(() => [0, 0, 0], 2, Number.NaN), /stacks/);
  assert.throws(() => parametricGeometry(() => [0, Number.NaN, 0]), /return \[x, y, z\]/);
  assert.throws(() => parametricGeometry(() => [0, 0]), /not a finite point/);
});
