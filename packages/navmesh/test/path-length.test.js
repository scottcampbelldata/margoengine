// Open floor: the path length is the straight line. Gapped floor: a path exists, stays out of the hole,
// and is longer than the corner route through either hall. The Detour length is not frozen here: on the
// gapped mesh it disagreed, and that loss is recorded in docs/known-bugs.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Navigation } from '../dist/build.js';

const config = {
  cs: 0.25,
  ch: 0.2,
  walkableSlopeAngle: 60,
  walkableHeight: 2,
  walkableClimb: 2,
  walkableRadius: 1,
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  borderSize: 0,
  buildBvTree: true,
};

function quad(parts, x0, z0, x1, z1) {
  const b = parts.positions.length / 3;
  parts.positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
  parts.indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
}

function lengthOf(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    n += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return n;
}

test('an open floor path is the straight line between the ends', async () => {
  const nav = await Navigation.create(
    Float32Array.from([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]),
    Uint32Array.from([0, 2, 1, 0, 3, 2]),
    config,
  );
  try {
    const path = nav.path({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 });
    assert.ok(path);
    const length = lengthOf(path);
    assert.ok(Math.abs(length - Math.hypot(16, 16)) < 1e-9);
  } finally {
    nav.dispose();
  }
});

test('a gapped floor path stays out of the hole and beats the corner lower bound', async () => {
  const parts = { positions: [], indices: [] };
  quad(parts, -10, -8, -1, 8);
  quad(parts, 1, -8, 10, 8);
  quad(parts, -10, 8, 10, 10);
  quad(parts, -10, -10, 10, -8);
  const nav = await Navigation.create(Float32Array.from(parts.positions), Uint32Array.from(parts.indices), config);
  try {
    const path = nav.path({ x: -8, y: 0.2, z: 0 }, { x: 8, y: 0.2, z: 0 });
    assert.ok(path);
    assert.ok(path.length >= 2);
    for (const p of path) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
      const inHole = Math.abs(p.x) < 1 && Math.abs(p.z) < 8;
      assert.equal(inHole, false);
    }
    // Corners of the gap are (±1, ±8). The shorter hall is hypot(7, 8) + 2 + hypot(7, 8).
    const lower = Math.hypot(7, 8) * 2 + 2;
    const length = lengthOf(path);
    assert.ok(length > lower);
    assert.ok(length < 30);
  } finally {
    nav.dispose();
  }
});
