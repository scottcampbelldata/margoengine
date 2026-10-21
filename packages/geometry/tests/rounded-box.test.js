// roundedBoxGeometry against the analytic rounded box: closed, crack-free, outward, and converging to its area and volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxGeometry } from '../dist/index.js';
import { roundedBoxGeometry } from '../dist/extras.js';
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

// Inner box E = side - 2r per axis: slabs, quarter cylinders along the edges and sphere octants at the corners.
const exact = (w, h, d, r) => {
  const [x, y, z] = [w - 2 * r, h - 2 * r, d - 2 * r];
  return {
    area: 2 * (x * y + y * z + x * z) + 2 * Math.PI * r * (x + y + z) + 4 * Math.PI * r * r,
    volume: x * y * z + 2 * r * (x * y + y * z + x * z) + Math.PI * r * r * (x + y + z) + (4 / 3) * Math.PI * r ** 3,
  };
};

test('rounded boxes are closed, outward, genus 0 and converge to the analytic area and volume', () => {
  for (const [w, h, d, r] of [
    [1, 1, 1, 0.1],
    [2, 1, 0.5, 0.2],
    [3, 2, 1, 0.5],
  ]) {
    const { area, volume } = exact(w, h, d, r);
    let previous = Infinity,
      sixteen = 0;
    for (const segments of [1, 2, 3, 4, 8, 16, 32]) {
      const g = roundedBoxGeometry(w, h, d, segments, r),
        label = `${w}x${h}x${d} r${r} s${segments}`;
      assertValid(g, label);
      assertUVRange(g, label);
      assertNormalsAgreeWithWinding(g, label);
      assert.equal(watertight(g, label, 6).euler, 2, `${label} Euler characteristic`);
      const v = signedVolume(g),
        a = surfaceArea(g);
      assert.ok(
        v > 0 && v < volume + 1e-6 && a < area + 1e-6,
        `${label} inscribed: ${v} <= ${volume}, ${a} <= ${area}`,
      );
      assert.ok(volume - v <= previous + 1e-9, `${label} converges`);
      previous = volume - v;
      if (segments === 16) sixteen = volume - v;
      if (segments === 32) {
        // Inscribed arcs converge quadratically: doubling the segments quarters the error.
        assert.ok(sixteen / (volume - v) > 3.5, `${label} second-order convergence ${sixteen / (volume - v)}`);
        close(v, volume, volume * 1e-3, `${label} volume`);
        close(a, area, area * 1e-3, `${label} area`);
      }
    }
  }
});

test('neighbouring faces share seam vertices bit for bit (no cracks)', () => {
  const g = roundedBoxGeometry(1.3, 0.7, 2.1, 5, 0.23),
    exactKeys = new Set(),
    rounded = new Set();
  for (let i = 0; i < vertexCount(g); i++) {
    exactKeys.add(point(g, i).join(','));
    rounded.add(
      point(g, i)
        .map((x) => Math.round(x * 1e5) || 0)
        .join(','),
    );
  }
  // Welding at 1e-5 finds no vertex that only nearly matches another.
  assert.equal(exactKeys.size, rounded.size);
  assert.equal(watertight(g, 'seams', 9).euler, 2);
});

test('radius 0 is the box, and half of every side is a sphere', () => {
  const box = roundedBoxGeometry(2, 3, 4, 3, 0),
    plain = boxGeometry(2, 3, 4);
  assert.deepEqual(box.positions, plain.positions);
  assert.deepEqual(box.normals, plain.normals);
  assert.deepEqual(box.uvs, plain.uvs);
  assert.deepEqual(box.indices, plain.indices);
  assert.deepEqual(box.groups, plain.groups);
  const sphere = roundedBoxGeometry(2, 2, 2, 24, 1);
  assert.equal(watertight(sphere, 'sphere', 6).euler, 2);
  for (let i = 0; i < vertexCount(sphere); i++) {
    close(Math.hypot(...point(sphere, i)), 1, 1e-6, `sphere radius ${i}`);
    for (let c = 0; c < 3; c++) close(sphere.normals[i * 3 + c], sphere.positions[i * 3 + c], 1e-6, 'radial normal');
  }
  close(signedVolume(sphere), (4 / 3) * Math.PI, 0.01, 'sphere volume');
});

test('radius clamps to half the smallest side, six groups cover every triangle, bad sizes throw', () => {
  const g = roundedBoxGeometry(1, 1, 0.2, 2, 5);
  for (let i = 0; i < vertexCount(g); i++) assert.ok(Math.abs(g.positions[i * 3 + 2]) <= 0.1 + 1e-7);
  assert.equal(watertight(g, 'clamped', 6).euler, 2);
  assert.deepEqual(
    g.groups.map((group) => group.materialIndex),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(
    g.groups.reduce((s, group) => s + group.count, 0),
    g.indices.length,
  );
  // Each group's normals point along its axis on average.
  const axes = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  g.groups.forEach((group, k) => {
    for (let t = group.start; t < group.start + group.count; t++) {
      const i = g.indices[t];
      const n = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
      assert.ok(n[0] * axes[k][0] + n[1] * axes[k][1] + n[2] * axes[k][2] > 0.5 - 1e-6, `group ${k} normal`);
    }
  });
  assert.throws(() => roundedBoxGeometry(-1), /width -1 is invalid/);
  assert.throws(() => roundedBoxGeometry(1, 1, 1, Number.NaN), RangeError);
  assert.throws(() => roundedBoxGeometry(1, 1, 1, 2, Number.POSITIVE_INFINITY), /radius/);
});
