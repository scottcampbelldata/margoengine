// The Robot on concave obstacles from @margoengine/kinematics-constraints/sdf: a convex proxy of the same shape fails
// each scene here, filling the hole of a ring and the inside of a bowl. GPUClearance uploads an SDFVolume's grid: the
// grid it reads is checked against the field at every corner.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '@margoengine/bvh';
import { bakeSDF } from '@margoengine/bvh/sdf';
import { ConvexHullVolume, SphereVolume } from '@margoengine/kinematics-constraints';
import { MeshVolume, SDFVolume } from '@margoengine/kinematics-constraints/sdf';
import { gridData } from '../dist/gpu.js';
import { Robot, sweepRobot } from '../dist/index.js';
import { JointLimitSolver } from '../dist/limits.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** A closed torus about +Z, wound outward. The facets sit inside the true surface by at most `sag`. */
function torus(major, minor, around = 96, tube = 48) {
  const positions = new Float32Array(around * tube * 3),
    indices = new Uint32Array(around * tube * 6);
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < tube; j++) {
      const u = (i / around) * Math.PI * 2,
        v = (j / tube) * Math.PI * 2,
        r = major + minor * Math.cos(v),
        at = (i * tube + j) * 3;
      positions[at] = r * Math.cos(u);
      positions[at + 1] = r * Math.sin(u);
      positions[at + 2] = minor * Math.sin(v);
      const a = i * tube + j,
        b = ((i + 1) % around) * tube + j,
        c = ((i + 1) % around) * tube + ((j + 1) % tube),
        d = i * tube + ((j + 1) % tube),
        k = a * 6;
      indices.set([a, b, c, a, c, d], k);
    }
  }
  return { positions, indices };
}
const trueDistance = (major, minor, p) => Math.hypot(Math.hypot(p[0], p[1]) - major, p[2]) - minor;

test('a link passes through the hole of a ring; its convex proxy blocks the same motion', () => {
  const ring = torus(1, 0.2),
    bvh = MeshBVH.build(ring),
    points = [];
  for (let i = 0; i < ring.positions.length; i += 3 * 37) points.push(ring.positions[i], ring.positions[i + 1], ring.positions[i + 2]);
  const proxy = new ConvexHullVolume({ points, maxPoints: points.length }),
    slider = new Robot({
      joints: [{ type: 'prismatic', axis: [0, 0, 1], lower: -5, upper: 5 }],
      shapes: [{ joint: 0, end: [0, 0, 0.5], radius: 0.1 }],
    }),
    from = [-3],
    to = [3];
  assert.equal(sweepRobot(slider, from, to, [proxy]).clear, false, 'the proxy fills the hole');
  assert.equal(sweepRobot(slider, from, to, [new MeshVolume({ bvh })], { minClearance: 0.01 }).clear, true);
  const field = new SDFVolume({ field: bakeSDF(bvh, { resolution: 40 }) });
  assert.equal(sweepRobot(slider, from, to, [field], { minClearance: 0.01 }).clear, true);
  // Off the axis by the ring's radius it meets the tube, on the mesh, on the field and at the same height.
  const off = new Robot({
      joints: [{ type: 'prismatic', axis: [0, 0, 1], lower: -5, upper: 5, origin: translate(1, 0, 0) }],
      shapes: [{ joint: 0, radius: 0.1 }],
    }),
    onMesh = sweepRobot(off, from, to, [new MeshVolume({ bvh })], { tolerance: 1e-4 }),
    onField = sweepRobot(off, from, to, [field], { tolerance: 1e-4 });
  assert.equal(onMesh.clear, false);
  assert.equal(onField.clear, false);
  assert.ok(Math.abs(-3 + onMesh.time * 6 - -0.3) < 0.01);
  assert.ok(onField.time <= onMesh.time, 'the field stops first, by its margin');
});

test('a limit solve reaches into a bowl mesh, where a convex proxy would stand in the way, and stops above its bottom', () => {
  // A half sphere of radius 1 open toward +Z, read as a sheet.
  const rows = 24,
    cols = 48,
    positions = new Float32Array((rows + 1) * cols * 3),
    indices = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j < cols; j++) {
      const polar = Math.PI - (i / rows) * (Math.PI / 2),
        turn = (j / cols) * Math.PI * 2,
        at = (i * cols + j) * 3;
      positions[at] = Math.sin(polar) * Math.cos(turn);
      positions[at + 1] = Math.sin(polar) * Math.sin(turn);
      positions[at + 2] = Math.cos(polar);
      if (i < rows) {
        const a = i * cols + j,
          b = i * cols + ((j + 1) % cols),
          c = (i + 1) * cols + ((j + 1) % cols),
          d = (i + 1) * cols + j;
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  const bowl = new MeshVolume({ bvh: MeshBVH.build({ positions, indices: new Uint32Array(indices) }), solid: false }),
    arm = new Robot({
      joints: [
        { type: 'prismatic', axis: [0, 0, 1], lower: -1, upper: 2, origin: translate(0, 0, 0) },
        { name: 'tip', type: 'fixed', origin: translate(0, 0, 0) },
      ],
      shapes: [{ joint: 0, end: [0, 0, 2], radius: 0.05 }],
    }),
    reach = new JointLimitSolver(arm, { tip: 'tip', colliders: [bowl], minClearance: 0.02 }).solve([1], {
      position: [0, 0, -0.8],
    });
  assert.equal(reach.reached, true);
  const stop = new JointLimitSolver(arm, { tip: 'tip', colliders: [bowl], minClearance: 0.02 }).solve([1], {
    position: [0, 0, -1],
  });
  assert.equal(stop.reached, false);
  assert.equal(stop.blocked, true);
  // The capsule's tip stands its radius plus the gap above the bottom of the bowl, facets aside.
  assert.ok(Math.abs(stop.q[0] - (-1 + 0.07)) < 0.01);
});

test('gridData reads an SDFVolume grid with that volume settings, corner for corner, and nothing from other volumes', () => {
  const ring = torus(1, 0.2, 24, 12),
    field = bakeSDF(MeshBVH.build(ring), { resolution: 8 }),
    volume = new SDFVolume({ field, matrix: translate(0.5, 0, 0), margin: 0.01, lipschitz: 2, maxCells: 77 }),
    grid = gridData(volume);
  assert.ok(grid);
  const [nx, ny, nz] = grid.size;
  assert.equal(grid.samples.length, nx * ny * nz);
  assert.equal(nx, Math.round((field.max[0] - field.min[0]) / field.spacing[0]) + 1);
  const corner = new Float64Array(3);
  for (const [x, y, z] of [[0, 0, 0], [nx - 1, ny - 1, nz - 1], [1, 2, 3]]) {
    for (let k = 0; k < 3; k++) corner[k] = Math.min(field.min[k] + [x, y, z][k] * field.spacing[k], field.max[k]);
    assert.equal(grid.samples[(z * ny + y) * nx + x], Math.fround(field.distance(corner)));
  }
  assert.deepEqual(
    [grid.margin, grid.lipschitz, grid.maxCells, grid.scale, grid.precision],
    [0.01, 2, 77, 1, volume.precision],
  );
  // The inverse placement takes the volume's move back off.
  assert.deepEqual(Array.from(grid.inverse.subarray(9, 12), (v) => v + 0), [-0.5, 0, 0]);
  assert.equal(gridData(new SphereVolume({ center: [0, 0, 0], radius: 1 })), null);
  assert.equal(gridData(new SDFVolume({ field: { distance: (p) => p[0] } })), null);
  // A volume of the caller's own may give its grid.
  assert.equal(gridData({ evaluate: () => 0, segmentClearance: () => 0, gridData: () => grid }), grid);
});
