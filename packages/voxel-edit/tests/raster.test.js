import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from '@margoengine/math/mathutils';
import { cellIndex } from '../dist/index.js';
import {
  cylinderCells,
  ellipsoidCells,
  ringCells,
  stampCells,
  taperedLineCells,
  thickLineCells,
} from '../dist/edit.js';

// Margo Voxel Studio's frozen showcase kernels (src/editor/showcase/mechanical-kit.ts, nature-sculpt.ts and
// skyforge-citadel.ts: put, box, ellipsoid, cylinder, ring, line), recording writes, kept as the oracle.
function studioKit(size) {
  const writes = [],
    put = (x, y, z) => {
      x = Math.round(x);
      y = Math.round(y);
      z = Math.round(z);
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2])
        throw new RangeError('outside volume');
      writes.push(cellIndex(size, x, y, z));
    },
    box = (x0, y0, z0, x1, y1, z1) => {
      for (let y = Math.ceil(y0); y <= Math.floor(y1); y++)
        for (let z = Math.ceil(z0); z <= Math.floor(z1); z++)
          for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) put(x, y, z);
    },
    ellipsoid = (cx, cy, cz, rx, ry, rz) => {
      for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++)
        for (let z = Math.ceil(cz - rz); z <= Math.floor(cz + rz); z++)
          for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++)
            if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) put(x, y, z);
    },
    cylinder = (axis, center, radius, length, hole = -1) => {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      for (let a = Math.ceil(-length / 2); a <= Math.floor(length / 2); a++)
        for (let b = Math.ceil(-radius); b <= radius; b++)
          for (let d = Math.ceil(-radius); d <= radius; d++)
            if (b * b + d * d <= radius * radius && b * b + d * d > hole * Math.abs(hole)) {
              const p = [...center];
              p[axis] += a;
              p[u] += b;
              p[v] += d;
              put(...p);
            }
    },
    ring = (cx, cy, z, outer, inner, thickness) => cylinder(2, [cx, cy, z], outer, thickness, inner),
    // mechanical-kit line: ceil of the longest span.
    mechanicalLine = (a, b, radius = 0) => {
      const n = Math.ceil(Math.max(...a.map((v, i) => Math.abs(v - b[i]))));
      for (let k = 0; k <= n; k++) {
        const p = a.map((v, i) => Math.round(v + ((b[i] - v) * k) / Math.max(1, n)));
        box(p[0] - radius, p[1] - radius, p[2] - radius, p[0] + radius, p[1] + radius, p[2] + radius);
      }
    },
    // skyforge-citadel line: the span itself.
    skyforgeLine = (a, b, radius = 0) => {
      const n = Math.max(...a.map((v, i) => Math.abs(b[i] - v)));
      for (let t = 0; t <= n; t++) {
        const p = a.map((v, i) => Math.round(v + ((b[i] - v) * t) / Math.max(1, n)));
        box(p[0] - radius, p[1] - radius, p[2] - radius, p[0] + radius, p[1] + radius, p[2] + radius);
      }
    },
    // nature-sculpt line: tapered spheres.
    natureLine = (a, b, r = 1, endRadius = r) => {
      const distance = Math.hypot(...a.map((v, i) => b[i] - v));
      for (let i = 0; i <= Math.ceil(distance * 1.4); i++) {
        const t = i / Math.max(1, Math.ceil(distance * 1.4)),
          radius = r + (endRadius - r) * t;
        ellipsoid(
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
          Math.max(0.6, radius),
          Math.max(0.6, radius),
          Math.max(0.6, radius),
        );
      }
    };
  return { writes, ellipsoid, cylinder, ring, mechanicalLine, skyforgeLine, natureLine };
}

const SIZE = [48, 40, 44];
const unique = (writes) => [...new Set(writes)];
function compare(draw, ours) {
  const kit = studioKit(SIZE);
  let expected;
  try {
    draw(kit);
    expected = unique(kit.writes);
  } catch {
    expected = undefined;
  }
  if (!expected) {
    assert.throws(ours, /outside the grid/);
    return 'outside';
  }
  assert.deepEqual(Array.from(ours()), expected);
  return 'inside';
}

test("the rasterizers reproduce the showcase kernels' cells exactly, outside rule included", () => {
  const random = createRandom(33),
    real = (lo, hi) => lo + random() * (hi - lo),
    point = () => [real(-2, SIZE[0] + 2), real(-2, SIZE[1] + 2), real(-2, SIZE[2] + 2)],
    seen = { inside: 0, outside: 0 };
  for (let round = 0; round < 250; round++) {
    const c = point(),
      r = [real(0.3, 9), real(0.3, 9), real(0.3, 9)];
    seen[
      compare(
        (k) => k.ellipsoid(...c, ...r),
        () => ellipsoidCells(SIZE, { center: c, radii: r }),
      )
    ]++;
    const axis = round % 3,
      radius = real(0, 9),
      length = random() < 0.2 ? 0 : real(0, 12),
      hole = random() < 0.5 ? undefined : real(0, radius),
      center = round % 2 ? point() : point().map(Math.round);
    seen[
      compare(
        (k) => k.cylinder(axis, center, radius, length, hole),
        () =>
          cylinderCells(SIZE, {
            axis: 'xyz'[axis],
            center,
            radius,
            length,
            ...(hole === undefined ? {} : { inner: hole }),
          }),
      )
    ]++;
    const outer = real(1, 12),
      inner = real(0, outer),
      thickness = real(0, 4);
    seen[
      compare(
        (k) => k.ring(c[0], c[1], c[2], outer, inner, thickness),
        () => ringCells(SIZE, { center: c, outer, inner, thickness }),
      )
    ]++;
    const a = point(),
      b = round % 4 ? point() : point().map(Math.round),
      half = [0, 1, 2, 1.5][round % 4];
    seen[
      compare(
        (k) => k.mechanicalLine(a, b, half),
        () => thickLineCells(SIZE, { from: a, to: b, halfWidth: half }),
      )
    ]++;
    seen[
      compare(
        (k) => k.skyforgeLine(a, b, half),
        () => thickLineCells(SIZE, { from: a, to: b, halfWidth: half, steps: 'span' }),
      )
    ]++;
    const r0 = real(-1, 5),
      r1 = random() < 0.3 ? undefined : real(-1, 5);
    seen[
      compare(
        (k) => k.natureLine(a, b, r0, r1),
        () => taperedLineCells(SIZE, { from: a, to: b, radius: r0, ...(r1 === undefined ? {} : { endRadius: r1 }) }),
      )
    ]++;
  }
  assert.ok(seen.inside > 500 && seen.outside > 100, JSON.stringify(seen));
});

test("'clip' drops outside cells; the two line step rules differ only on fractional spans", () => {
  const inside = ellipsoidCells([5, 5, 5], { center: [0, 0, 0], radii: [2, 2, 2], outside: 'clip' });
  assert.ok(inside.length > 0);
  assert.ok(Array.from(inside).every((i) => i < 125));
  assert.throws(() => ellipsoidCells([5, 5, 5], { center: [0, 0, 0], radii: [2, 2, 2] }), /outside/);
  const whole = { from: [0, 0, 0], to: [6, 3, 0] };
  assert.deepEqual(thickLineCells([8, 8, 1], whole), thickLineCells([8, 8, 1], { ...whole, steps: 'span' }));
  const part = { from: [0.4, 0, 0], to: [5.9, 0, 0] };
  assert.deepEqual(Array.from(thickLineCells([8, 1, 1], part)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(thickLineCells([8, 1, 1], { ...part, steps: 'span' })), [0, 1, 2, 3, 4, 5]);
  const grid = { size: [8, 1, 1], voxels: new Uint8Array(8) },
    { grid: drawn } = stampCells(grid, thickLineCells([8, 1, 1], part), { operation: 'fill', color: 3 });
  assert.deepEqual(Array.from(drawn.voxels), [3, 3, 3, 3, 3, 3, 3, 0]);
});

test('the rasterizers check their arguments and budgets before drawing', () => {
  assert.throws(() => ellipsoidCells(SIZE, { center: [1, 1, 1], radii: [0, 1, 1] }), /positive/);
  assert.throws(() => ellipsoidCells(SIZE, { center: [1, 1, 1], radii: [400, 400, 400] }), /bounding box/);
  assert.throws(() => ellipsoidCells(SIZE, { center: [5, 5, 5], radii: [3, 3, 3], maxCells: 10 }), /maxCells/);
  assert.throws(() => cylinderCells(SIZE, { axis: 'w', center: [1, 1, 1], radius: 1, length: 1 }), TypeError);
  assert.throws(() => cylinderCells(SIZE, { axis: 'x', center: [1, 1, 1], radius: -1, length: 1 }), RangeError);
  assert.throws(() => ringCells(SIZE, { center: [1, 1, 1], outer: 2, inner: Number.NaN, thickness: 1 }), RangeError);
  assert.throws(() => thickLineCells(SIZE, { from: [0, 0, 0], to: [2e6, 0, 0], outside: 'clip' }), /steps/);
  assert.throws(() => thickLineCells(SIZE, { from: [0, 0, 0], to: [1, 0, 0], steps: 'floor' }), TypeError);
  assert.throws(() => taperedLineCells(SIZE, { from: [0, 0, 0], to: [1, 0, 0], minRadius: 0 }), RangeError);
  assert.throws(() => ellipsoidCells(SIZE, { center: [1, 1, 1], radii: [1, 1, 1], outside: 'wrap' }), TypeError);
  assert.throws(() => ellipsoidCells([0, 1, 1], { center: [1, 1, 1], radii: [1, 1, 1] }), RangeError);
});
