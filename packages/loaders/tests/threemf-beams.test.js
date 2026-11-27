// mesh3MFBeamLattice and threeMFBeamDistance against the 3MF Beam Lattice Extension
// (https://github.com/3MFConsortium/spec_beamlattice, chapter 2): a beam is a conical frustum between its two radii,
// closed at each end by a flat butt, a sphere of that radius or the half of it outside the end; a ball is a sphere.
// The expected solids are written here from those words, not from the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '@margoengine/bvh';
import { mesh3MFBeamLattice, threeMFBeamDistance } from '../dist/threemf-beams.js';
import { closed, volume } from './threemf-surface.js';

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected} within ${tolerance}`);
const beam = (r1, r2, cap1, cap2, v1 = 0, v2 = 1) => ({ v1, v2, r1, r2, cap1, cap2 });
const length = 10;
// A slanted axis, so no formula can lean on an axis of the world.
const axis = [2 / 7, 3 / 7, 6 / 7],
  start = [1, -2, 0.5],
  ends = [...start, ...start.map((v, k) => v + axis[k] * length)];

/** Whether `p` is in the solid the specification describes. */
function inside({ r1, r2, cap1, cap2 }, p) {
  const d = p.map((v, k) => v - start[k]),
    h = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2],
    r = Math.hypot(...d.map((v, k) => v - h * axis[k]));
  if (h >= 0 && h <= length && r <= r1 + ((r2 - r1) * h) / length) return true;
  const ball = (at, radius, outward) => Math.hypot(h - at, r) <= radius && (outward === 0 || (h - at) * outward >= 0);
  return (
    (cap1 !== 'butt' && ball(0, r1, cap1 === 'sphere' ? 0 : -1)) ||
    (cap2 !== 'butt' && ball(length, r2, cap2 === 'sphere' ? 0 : 1))
  );
}

/** Seeded points of the box around the beam. */
function points(count, reach) {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => {
    const h = -reach + random() * (length + 2 * reach);
    return start.map((v, k) => v + axis[k] * h + (random() - 0.5) * 2 * reach);
  });
}

const cases = [];
for (const cap1 of ['butt', 'sphere', 'hemisphere'])
  for (const cap2 of ['butt', 'sphere', 'hemisphere'])
    for (const [r1, r2] of [
      [2, 2],
      [3, 0.5],
      [0.4, 2.5],
    ])
      cases.push(beam(r1, r2, cap1, cap2));
// A beam shorter than its radii, and one whose big sphere swallows the other end.
cases.push(beam(8, 7, 'sphere', 'sphere'), beam(12, 0.5, 'sphere', 'butt'));

test('the distance has the sign of the specified solid, and the mesh lies on its surface', () => {
  for (const one of cases) {
    const lattice = { beams: [one] },
      distance = threeMFBeamDistance(ends, lattice),
      label = JSON.stringify(one);
    for (const p of points(600, 13)) {
      const d = distance(...p);
      if (Math.abs(d) > 1e-6) assert.equal(d < 0, inside(one, p), `${label} at ${p}: ${d}`);
    }
    const mesh = mesh3MFBeamLattice(ends, lattice, { segments: 48 });
    closed(mesh);
    assert.ok(volume(mesh) > 0, label);
    for (let v = 0; v < mesh.positions.length; v += 3) near(distance(...mesh.positions.subarray(v, v + 3)), 0, 1e-4);
    assert.deepEqual(mesh.parts, [
      { kind: 'beam', index: 0, triangleStart: 0, triangleCount: mesh.indices.length / 3 },
    ]);
  }
});

test('a point outside is as far from the distance as from the surface', () => {
  const lattice = { beams: [beam(3, 0.5, 'sphere', 'hemisphere')] },
    distance = threeMFBeamDistance(ends, lattice),
    mesh = mesh3MFBeamLattice(ends, lattice, { segments: 128 }),
    bvh = MeshBVH.build({ positions: mesh.positions, stride: 3, indices: mesh.indices });
  for (const p of points(60, 9)) {
    const d = distance(...p);
    if (d < 0.2) continue;
    // The chords of a fine mesh lie a little inside the round surface.
    near(bvh.closestPointToPoint(p).distance, d, 0.01);
  }
});

test('volumes of the caps and a ball follow their formulas', () => {
  const cylinder = Math.PI * 4 * length,
    sphere = (4 / 3) * Math.PI * 8,
    frustum = ((Math.PI * length) / 3) * (9 + 3 + 1),
    of = (one) => volume(mesh3MFBeamLattice(ends, { beams: [one] }, { segments: 128 }));
  near(of(beam(2, 2, 'butt', 'butt')), cylinder, cylinder * 0.002);
  near(of(beam(2, 2, 'sphere', 'sphere')), cylinder + sphere, cylinder * 0.002);
  near(of(beam(2, 2, 'hemisphere', 'hemisphere')), cylinder + sphere, cylinder * 0.002);
  near(of(beam(3, 1, 'butt', 'butt')), frustum, frustum * 0.002);
  const ball = mesh3MFBeamLattice(ends, { beams: [], effectiveBalls: [{ vertex: 1, radius: 2 }] }, { segments: 128 });
  closed(ball);
  near(volume(ball), sphere, sphere * 0.002);
  assert.deepEqual(ball.parts[0].kind, 'ball');
  assert.equal(Math.min(...ball.along), 0);
});

test('a lattice makes one shell for each active beam and ball, and its distance is the nearest of them', () => {
  const vertices = [0, 0, 0, 10, 0, 0, 10, 10, 0, 10.1, 10, 0],
    lattice = {
      beams: [beam(1, 1, 'sphere', 'sphere'), beam(1, 1, 'sphere', 'sphere', 1, 2), beam(1, 1, 'butt', 'butt', 2, 3)],
      activeBeams: [0, 1],
      effectiveBalls: [{ vertex: 0, radius: 3 }],
    },
    mesh = mesh3MFBeamLattice(vertices, lattice),
    distance = threeMFBeamDistance(vertices, lattice);
  assert.deepEqual(
    mesh.parts.map((p) => [p.kind, p.index]),
    [
      ['beam', 0],
      ['beam', 1],
      ['ball', 0],
    ],
  );
  near(distance(5, 5, 0), 4, 1e-9);
  near(distance(0, 0, 4), 1, 1e-9);
  near(distance(0, 0, 0), -3, 1e-9);
  assert.equal(threeMFBeamDistance(vertices, { beams: [] })(0, 0, 0), Infinity);
  assert.throws(() => mesh3MFBeamLattice(vertices, lattice, { segments: 2 }), { code: 'range' });
  assert.throws(() => mesh3MFBeamLattice(vertices, lattice, { maxTriangles: 10 }), { code: 'limit' });
  assert.throws(() => mesh3MFBeamLattice([0, 0, 0], lattice), { code: 'range' });
});
