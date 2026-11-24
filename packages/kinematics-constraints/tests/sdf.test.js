// @margoengine/kinematics-constraints/sdf: concave obstacles. A convex proxy of the same shape fails each of the scenes
// here: it fills the hole of a ring and the inside of a bowl. Distances are compared with the closed form of a torus,
// and with a brute-force scan of the real mesh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MeshBVH } from '../../bvh/dist/index.js';
import { bakeSDF } from '../../bvh/dist/sdf.js';
import { AvoidanceSolver, ConvexHullVolume, SolveStatus } from '../dist/index.js';
import { MeshVolume, SDFVolume } from '../dist/sdf.js';
import { sweepChain, sweepHull } from '../dist/swept.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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
/** How far a facet can sit inside the true torus: the sagitta of the coarser ring. */
const sag = (radius, sides) => radius * (1 - Math.cos(Math.PI / sides));
/** Largest gap from the real surface to the facets: both rings at once. */
const facets = (major, minor) => 2 * (sag(major + minor, 96) + sag(minor, 48));

test('MeshVolume: point and segment distances match the closed form of a torus, sign included', () => {
  const major = 1,
    minor = 0.3,
    tolerance = facets(major, minor),
    volume = new MeshVolume({ bvh: MeshBVH.build(torus(major, minor)) }),
    rand = random(5),
    surface = new Float64Array(3),
    normal = new Float64Array(3);
  for (let i = 0; i < 200; i++) {
    const p = [rand() * 3 - 1.5, rand() * 3 - 1.5, rand() * 2 - 1],
      expected = trueDistance(major, minor, p),
      got = volume.evaluate(p, surface, normal);
    assert.ok(Math.abs(got - expected) < tolerance, `at ${p}: ${got} against ${expected}`);
    if (Math.abs(expected) > 2 * tolerance) {
      // Outward normal: from the surface to an outside point, away from an inside one.
      const s = Math.sign(got),
        back = Math.hypot(p[0] - surface[0], p[1] - surface[1], p[2] - surface[2]);
      assert.ok(Math.abs(back - Math.abs(got)) < 1e-9);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - surface[k] - normal[k] * s * back) < 1e-9);
    }
  }
  // Down the axis through the hole: the capsule is `major - minor - radius` clear.
  const gap = volume.segmentClearance([0, 0, -2], [0, 0, 2], 0.1);
  assert.ok(Math.abs(gap - (major - minor - 0.1)) < tolerance);
  // Across the ring through its tube: it crosses.
  assert.ok(volume.segmentClearance([0, -2, 0], [0, 2, 0], 0.1) <= -0.1 + 1e-9);
  // Wholly inside the tube: negative by the depth of its nearest end.
  const inside = volume.segmentClearance([1, 0, -0.05], [1, 0, 0.05], 0.02);
  assert.ok(Math.abs(inside - (-(minor - 0.05) - 0.02)) < tolerance);
});

test('MeshVolume: a placed mesh measures in the world, scale included, and a skewed matrix is refused', () => {
  const placed = new MeshVolume({ bvh: MeshBVH.build(torus(1, 0.3)), matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1] }),
    tolerance = 2 * facets(1, 0.3);
  // Twice the size, centred at x = 5: the axis of the hole stands 1.4 from the tube.
  assert.ok(Math.abs(placed.segmentClearance([5, 0, -3], [5, 0, 3], 0) - 1.4) < tolerance);
  assert.ok(Math.abs(placed.setTransform(translate(5, 0, 0)).segmentClearance([5, 0, -3], [5, 0, 3], 0) - 0.7) < tolerance);
  assert.throws(() => placed.setTransform([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), /uniform scale/);
});

test('MeshVolume: an open sheet has no inside, and reads the plain distance on either side', () => {
  const positions = new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]),
    sheet = new MeshVolume({ bvh: MeshBVH.build({ positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }), solid: false });
  assert.ok(Math.abs(sheet.segmentClearance([0, 0, 1], [1, 0, 1], 0.25) - 0.75) < 1e-6);
  assert.ok(Math.abs(sheet.segmentClearance([0, 0, -1], [1, 0, -1], 0.25) - 0.75) < 1e-6);
  const s = new Float64Array(3),
    n = new Float64Array(3);
  assert.ok(Math.abs(sheet.evaluate([0.5, 0.5, -1], s, n) - 1) < 1e-6);
  assert.deepEqual([...n], [0, 0, -1]);
  // Exactly on the surface there is no line to the point: the wound normal, unit length.
  assert.equal(sheet.evaluate([0.5, 0.5, 0], s, n), 0);
  assert.deepEqual([...n], [0, 0, 1]);
});

test('hulls: a box in the hole of a ring is clear of the mesh, one on the tube is not, one wholly inside reads negative', () => {
  const volume = new MeshVolume({ bvh: MeshBVH.build(torus(1, 0.3)) }),
    field = new SDFVolume({ field: { distance: (p) => trueDistance(1, 0.3, p) }, precision: 1e-3 }),
    cube = (x, y, z, half) => {
      const points = [];
      for (const a of [-half, half]) for (const b of [-half, half]) for (const c of [-half, half]) points.push(x + a, y + b, z + c);
      return new ConvexHullVolume({ points });
    },
    tolerance = facets(1, 0.3),
    out = new Float64Array(1);
  // The vertical edge of the box meets the ring's plane at radius 0.2 * sqrt 2: nothing of the box is closer to the tube.
  const corner = 1 - 0.2 * Math.SQRT2 - 0.3;
  volume.hullClearanceInto(cube(0, 0, 0, 0.2), out);
  assert.ok(Math.abs(out[0] - corner) < 2 * tolerance, `${out[0]} against ${corner}`);
  field.hullClearanceInto(cube(0, 0, 0, 0.2), out);
  assert.ok(out[0] <= corner + 1e-9, 'the field read overstates the gap');
  assert.ok(corner - out[0] < 5e-3, `field read ${out[0]} is far below ${corner}`);
  volume.hullClearanceInto(cube(1, 0, 0.3, 0.05), out);
  assert.ok(out[0] <= 0);
  volume.hullClearanceInto(cube(1, 0, 0, 0.05), out);
  assert.ok(out[0] < -0.1, 'inside the tube');
  field.hullClearanceInto(cube(1, 0, 0, 0.05), out);
  assert.ok(out[0] < -0.2, 'the field reaches the lowest point of a hull inside it');
});

test('SDFVolume: a baked field never reads a larger gap than the mesh leaves, within the bounds it states', () => {
  const major = 1,
    minor = 0.3,
    bvh = MeshBVH.build(torus(major, minor)),
    field = bakeSDF(bvh, { resolution: 48 }),
    volume = new SDFVolume({ field }),
    raw = new SDFVolume({ field, margin: 0 }),
    cell = Math.hypot(...field.spacing),
    rand = random(9),
    s = new Float64Array(3),
    n = new Float64Array(3);
  assert.equal(volume.margin, cell);
  assert.equal(raw.margin, 0);
  let overstated = 0;
  for (let i = 0; i < 400; i++) {
    const p = [rand() * 6 - 3, rand() * 6 - 3, rand() * 4 - 2],
      truth = trueDistance(major, minor, p) - facets(major, minor);
    if (volume.evaluate(p, s, n) > truth) overstated++;
    // Inside the grid a raw reading lies within one cell's diagonal of the truth, by the argument on `margin`.
    const inGrid = p.every((value, k) => value >= field.min[k] && value <= field.max[k]);
    if (inGrid) assert.ok(Math.abs(raw.evaluate(p, s, n) - trueDistance(major, minor, p)) < cell + 2 * facets(major, minor));
  }
  assert.equal(overstated, 0);
  // A far point outside the grid must not read as a collision.
  assert.ok(volume.evaluate([20, 0, 0], s, n) > 10);
});

test('SDFVolume: a segment reading finds a dip a coarse scan misses, and a budget that runs out stays a lower bound', () => {
  // A plane with one narrow pit at x = 0.37, in a 1-Lipschitz field.
  const field = { distance: ([x, y, z]) => Math.min(z, Math.hypot(x - 0.37, y, z) - 0.05) },
    volume = new SDFVolume({ field, precision: 1e-3 }),
    truth = 0.2 - 0.05,
    gap = volume.segmentClearance([0, 0, 0.2], [1, 0, 0.2], 0);
  assert.ok(gap <= truth);
  assert.ok(truth - gap < 3e-3);
  // Ends and middle all read 0.2 or more: only a search down to the dip finds it.
  assert.ok(volume.evaluate([0, 0, 0.2], [0, 0, 0], [0, 0, 0]) > 0.19);
  const tiny = new SDFVolume({ field, precision: 1e-3, maxCells: 1 });
  assert.ok(tiny.segmentClearance([0, 0, 0.2], [1, 0, 0.2], 0) <= truth);
});

test('a link passes through the hole of a ring; its convex proxy blocks the same motion', () => {
  const ring = torus(1, 0.2),
    bvh = MeshBVH.build(ring),
    points = [];
  for (let i = 0; i < ring.positions.length; i += 3 * 37) points.push(ring.positions[i], ring.positions[i + 1], ring.positions[i + 2]);
  const proxy = new ConvexHullVolume({ points, maxPoints: points.length }),
    link = (z) => [[0, 0, z], [0, 0, z + 0.5]],
    from = link(-3),
    to = link(3);
  assert.equal(sweepChain(from, to, [proxy], { radius: 0.1 }).clear, false, 'the proxy fills the hole');
  assert.equal(sweepChain(from, to, [new MeshVolume({ bvh })], { radius: 0.1, minClearance: 0.01 }).clear, true);
  const field = new SDFVolume({ field: bakeSDF(bvh, { resolution: 40 }) });
  assert.equal(sweepChain(from, to, [field], { radius: 0.1, minClearance: 0.01 }).clear, true);
  // Off the axis by the ring's radius it meets the tube, on the mesh, on the field and at the same height.
  const ball = (z) => [[1, 0, z], [1, 0, z]],
    onMesh = sweepChain(ball(-3), ball(3), [new MeshVolume({ bvh })], { radius: 0.1, tolerance: 1e-4 }),
    onField = sweepChain(ball(-3), ball(3), [field], { radius: 0.1, tolerance: 1e-4 });
  assert.equal(onMesh.clear, false);
  assert.equal(onField.clear, false);
  assert.ok(Math.abs(-3 + onMesh.time * 6 - -0.3) < 0.01);
  assert.ok(onField.time <= onMesh.time, 'the field stops first, by its margin');
});

test('a hull swept at a real mesh stops at the surface of the real model, as a dense scan finds it', () => {
  const file = new URL('../../../examples/assets/khronos/Lantern/Lantern.glb', import.meta.url);
  const duck = glbTriangles(readFileSync(file)),
    bvh = MeshBVH.build(duck),
    obstacle = new MeshVolume({ bvh }),
    box = bvh.getBoundingBox(),
    size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]),
    cx = (box.min[0] + box.max[0]) / 2,
    cy = (box.min[1] + box.max[1]) / 2,
    cz = (box.min[2] + box.max[2]) / 2,
    half = size * 0.02,
    points = [];
  for (const a of [-half, half]) for (const b of [-half, half]) for (const c of [-half, half]) points.push(a, b, c);
  const pellet = new ConvexHullVolume({ points }),
    from = translate(cx - size * 2, cy, cz),
    to = translate(cx + size * 2, cy, cz),
    hit = sweepHull(pellet, from, to, [obstacle], { tolerance: size * 1e-5 });
  assert.equal(hit.clear, false);
  const out = new Float64Array(1);
  let first = 1;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    pellet.setTransform(translate(cx - size * 2 + t * size * 4, cy, cz));
    obstacle.hullClearanceInto(pellet, out);
    if (out[0] <= 0) {
      first = t;
      break;
    }
  }
  assert.ok(hit.time <= first);
  assert.ok(first - hit.time < 2 / 2000);
});

test('the solvers take them as they are: a target is pushed out of a bowl mesh, and a limit solve reaches into it', () => {
  // A half sphere of radius 1 open toward +Z, as a thin closed-off surface read as a sheet.
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
    solver = new AvoidanceSolver([bowl], { minClearance: 0.05, complianceMargin: 0, targetRadius: 0 }),
    resolved = solver.resolveTarget([0, 0, -1], 1 / 60);
  assert.equal(solver.targetResult.resolved, true);
  assert.ok(Math.abs(Math.hypot(...resolved) - 1) >= 0.05 - 1e-3, 'projected the shell off the surface');
  assert.equal(SolveStatus.Success, 0);
  // Into the bowl, where a convex proxy would stand in the way: the capsule's tip stops its radius plus the gap above the
  // bottom, facets aside.
  const drop = sweepChain([[0, 0, 1], [0, 0, 3]], [[0, 0, -1.5], [0, 0, 0.5]], [bowl], { radius: 0.05, minClearance: 0.02 });
  assert.equal(drop.clear, false);
  assert.ok(Math.abs(1 - 2.5 * drop.time - (-1 + 0.07)) < 0.01);
});

/** Positions and indices of the first primitive of a glb. */
function glbTriangles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    binary = 20 + jsonLength + 8,
    primitive = json.meshes[0].primitives[0],
    read = (index, Type) => {
      const accessor = json.accessors[index],
        bufferView = json.bufferViews[accessor.bufferView],
        offset = binary + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
        width = accessor.type === 'VEC3' ? 3 : 1,
        copy = new Type(accessor.count * width),
        size = Type.BYTES_PER_ELEMENT;
      for (let i = 0; i < copy.length; i++) {
        const at = offset + i * size;
        copy[i] = size === 4 ? (Type === Float32Array ? view.getFloat32(at, true) : view.getUint32(at, true)) : view.getUint16(at, true);
      }
      return copy;
    },
    kind = json.accessors[primitive.indices].componentType === 5125 ? Uint32Array : Uint16Array;
  return { positions: read(primitive.attributes.POSITION, Float32Array), indices: Uint32Array.from(read(primitive.indices, kind)) };
}
