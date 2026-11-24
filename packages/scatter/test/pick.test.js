import test from 'node:test';
import assert from 'node:assert/strict';
import { InstancePicker, boundsOf } from '../dist/pick.js';
import { instanceTransforms } from '../dist/index.js';

// A seeded generator, so every run tests the same rays.
const rng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const unit = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
const field = (n, spacing, seed = 7) => {
  const r = rng(seed),
    places = [];
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) places.push([x * spacing + r() * 0.5, r() * 0.3, z * spacing + r() * 0.5, 0.5 + r(), r() * 6.283]);
  return instanceTransforms(places);
};
// Brute force: every instance, the box in its local space, the smallest entry parameter.
function brute(m, box, o, dir) {
  const len = Math.hypot(...dir),
    d = dir.map((v) => v / len);
  let best = Infinity,
    index = -1;
  for (let i = 0; i < m.length / 16; i++) {
    const a = m.subarray(i * 16, i * 16 + 16);
    // Solve a3x3 * l = p - t by Cramer's rule, for the origin and the direction.
    const det3 = (c0, c1, c2) =>
      c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
    const cols = [[a[0], a[1], a[2]], [a[4], a[5], a[6]], [a[8], a[9], a[10]]],
      D = det3(...cols);
    const solve = (v) => [0, 1, 2].map((k) => det3(...cols.map((c, j) => (j === k ? v : c))) / D);
    const lo = solve([o[0] - a[12], o[1] - a[13], o[2] - a[14]]),
      ld = solve(d);
    let tn = 0,
      tf = Infinity;
    for (let k = 0; k < 3; k++) {
      if (ld[k] === 0) {
        if (lo[k] < box.min[k] || lo[k] > box.max[k]) tn = Infinity;
        continue;
      }
      const t0 = (box.min[k] - lo[k]) / ld[k],
        t1 = (box.max[k] - lo[k]) / ld[k];
      tn = Math.max(tn, Math.min(t0, t1));
      tf = Math.min(tf, Math.max(t0, t1));
    }
    if (tn <= tf && tn < best) [best, index] = [tn, i];
  }
  return index < 0 ? null : { index, distance: best };
}

test('the grid walk finds the same nearest instance as testing every one, for 3,000 rays', () => {
  const m = field(40, 2),
    picker = new InstancePicker(m, { bounds: unit }),
    r = rng(3);
  let hits = 0;
  for (let k = 0; k < 3000; k++) {
    // Rays from above the field at all slopes, and some nearly level ones skimming it.
    const o = [r() * 90 - 5, 0.2 + r() * 30, r() * 90 - 5],
      d = [r() * 2 - 1, k % 5 === 0 ? -0.02 * r() : -r(), r() * 2 - 1];
    const want = brute(m, unit, o, d),
      got = picker.pick(o, d);
    assert.equal(got?.index ?? null, want?.index ?? null, `ray ${k}`);
    if (want) {
      hits++;
      assert.ok(Math.abs(got.distance - want.distance) < 1e-4, `ray ${k}: ${got.distance} vs ${want.distance}`);
      assert.ok(Math.abs(Math.hypot(...got.point.map((v, i) => v - o[i])) - got.distance) < 1e-6);
    }
  }
  assert.ok(hits > 500 && hits < 2500, `${hits} hits`);
});

test('pickAll lists every instance on the ray, nearest first, and maxDistance cuts it', () => {
  const m = instanceTransforms([0, 1, 2, 3, 4].map((i) => [i * 3, 0, 0, 1, 0]));
  const picker = new InstancePicker(m, { bounds: unit });
  const all = picker.pickAll([-10, 0.5, 0], [1, 0, 0]);
  assert.deepEqual(all.map((h) => h.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(all.map((h) => h.distance), [9.5, 12.5, 15.5, 18.5, 21.5]);
  assert.deepEqual(picker.pickAll([-10, 0.5, 0], [1, 0, 0], 13).map((h) => h.index), [0, 1]);
  assert.equal(picker.pick([-10, 0.5, 0], [1, 0, 0], 9), null);
  assert.equal(picker.pick([-10, 0.5, 0], [-1, 0, 0]), null);
});

test('with a mesh, a ray through the gaps of the box misses, one on a face hits it at the face', () => {
  // A blade card: one quad in the local XY plane, 0.2 wide and 1 tall, at z = 0.
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0.1, 1, 0, -0.1, 1, 0]),
    indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const m = instanceTransforms([[0, 0, 0, 2, 0]]);
  const boxOnly = new InstancePicker(m, { bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] } }),
    exact = new InstancePicker(m, { bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }, mesh: { positions, indices } });
  // At x = 0.6 (local 0.3), inside the box but beside the card.
  assert.equal(boxOnly.pick([0.6, 1, -5], [0, 0, 1])?.index, 0);
  assert.equal(exact.pick([0.6, 1, -5], [0, 0, 1]), null);
  const hit = exact.pick([0.1, 1, -5], [0, 0, 1]);
  assert.equal(hit.index, 0);
  assert.ok(Math.abs(hit.distance - 5) < 1e-6, String(hit.distance));
  // From behind: both faces count.
  assert.ok(Math.abs(exact.pick([0.1, 1, 5], [0, 0, -1]).distance - 5) < 1e-6);
  // Bounds default to the mesh's own box.
  const f = Math.fround;
  assert.deepEqual(boundsOf(positions), { min: [f(-0.1), 0, 0], max: [f(0.1), 1, 0] });
});

test('a ScatterBatch layout (20 floats a vertex) picks through boundsOf and the batch mesh', () => {
  const vertices = new Float32Array(4 * 20);
  [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]].forEach((p, i) => vertices.set(p, i * 20));
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  assert.deepEqual(boundsOf(vertices, 20), { min: [-1, 0, 0], max: [1, 2, 0] });
  const picker = new InstancePicker(instanceTransforms([[5, 0, 5, 1, Math.PI / 2]]), { mesh: { positions: vertices, stride: 20, indices } });
  // Turned a quarter about +Y, the card faces +-X: a ray along X hits it.
  assert.equal(picker.pick([0, 1, 5.5], [1, 0, 0]).index, 0);
  assert.equal(picker.pick([5.5, 1, 0], [0, 0, 1]), null);
});

test('harvesting: remove takes the front instance out, the next pick finds the one behind, kept() drops it', () => {
  const m = instanceTransforms([0, 1, 2].map((i) => [i * 3, 0, 0, 1, 0]));
  const picker = new InstancePicker(m, { bounds: unit });
  const ray = [[-10, 0.5, 0], [1, 0, 0]];
  assert.equal(picker.pick(...ray).index, 0);
  assert.equal(picker.remove(0), true);
  assert.equal(picker.remove(0), false);
  assert.equal(picker.pick(...ray).index, 1);
  assert.equal(picker.active, 2);
  const { transforms, indices } = picker.kept();
  assert.deepEqual([...indices], [1, 2]);
  assert.deepEqual(transforms, m.slice(16));
  assert.equal(picker.removed(0), true);
  assert.equal(picker.restore(0), true);
  assert.equal(picker.pick(...ray).index, 0);
  assert.equal(picker.kept().transforms.length, 48);
});

test('near() finds the instances whose box reaches into a sphere, nearest first, matching every one tested', () => {
  const m = field(30, 1.5, 11),
    picker = new InstancePicker(m, { bounds: unit }),
    r = rng(5);
  // The world boxes, through the same picks: a vertical ray down each instance's centre hits it.
  for (let k = 0; k < 200; k++) {
    const c = [r() * 45, r() * 2, r() * 45],
      radius = 0.1 + r() * 4;
    const got = picker.near(c, radius);
    const want = [];
    for (let i = 0; i < m.length / 16; i++) {
      const a = m.subarray(i * 16, i * 16 + 16);
      let s = 0;
      for (let row = 0; row < 3; row++) {
        let centre = a[12 + row],
          half = 0;
        for (let col = 0; col < 3; col++) {
          centre += a[col * 4 + row] * (unit.min[col] + unit.max[col]) * 0.5;
          half += Math.abs(a[col * 4 + row]) * (unit.max[col] - unit.min[col]) * 0.5;
        }
        const lo = Math.fround(centre - half),
          hi = Math.fround(centre + half),
          e = c[row] < lo ? lo - c[row] : c[row] > hi ? c[row] - hi : 0;
        s += e * e;
      }
      if (s <= radius * radius) want.push([s, i]);
    }
    want.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(got, want.map((w) => w[1]), `sphere ${k}`);
  }
});

test('setTransform moves an instance: the old place misses, the new one hits', () => {
  const picker = new InstancePicker(instanceTransforms([[0, 0, 0, 1, 0], [10, 0, 0, 1, 0]]), { bounds: unit });
  assert.equal(picker.pick([0, 5, 0], [0, -1, 0]).index, 0);
  picker.setTransform(0, instanceTransforms([[30, 0, 30, 1, 0]]));
  assert.equal(picker.pick([0, 5, 0], [0, -1, 0]), null);
  assert.equal(picker.pick([30, 5, 30], [0, -1, 0]).index, 0);
  assert.ok(Math.abs(picker.pick([30, 5, 30], [0, -1, 0]).distance - 4) < 1e-6);
});

test('an instance scaled to 0 draws nothing and is never picked', () => {
  const picker = new InstancePicker(instanceTransforms([[0, 0, 0, 1, 0]]).map((v, i) => (i < 12 ? 0 : v)), { bounds: unit });
  assert.equal(picker.pick([0, 5, 0], [0, -1, 0]), null);
  assert.deepEqual(picker.near([0, 0, 0], 1), []);
});

test('a ray that starts inside an instance hits it at 0', () => {
  const picker = new InstancePicker(instanceTransforms([[0, 0, 0, 1, 0]]), { bounds: unit });
  assert.equal(picker.pick([0, 0.5, 0], [1, 0, 0]).distance, 0);
});

test('bad input throws with a link to the scatter help', () => {
  const ok = instanceTransforms([[0, 0, 0, 1, 0]]);
  const link = /see https:\/\/margoengine\.com\/errors#scatter$/;
  assert.throws(() => new InstancePicker(new Float32Array(15), { bounds: unit }), (e) => e instanceof TypeError && link.test(e.message));
  assert.throws(() => new InstancePicker(ok), /needs bounds/);
  assert.throws(() => new InstancePicker(ok, { bounds: { min: [1, 0, 0], max: [0, 1, 1] } }), RangeError);
  assert.throws(() => new InstancePicker(ok, { bounds: unit, cell: 0 }), /cell/);
  assert.throws(() => new InstancePicker(ok, { mesh: { positions: new Float32Array(9), indices: new Uint16Array([0, 1, 3]) } }), /pick mesh/);
  const picker = new InstancePicker(ok, { bounds: unit });
  assert.throws(() => picker.pick([0, 0, 0], [0, 0, 0]), /direction other than 0/);
  assert.throws(() => picker.pick([0, Number.NaN, 0], [0, 1, 0]), /finite origin/);
  assert.throws(() => picker.pick([0, 0, 0], [0, 1, 0], 0), /maxDistance/);
  assert.throws(() => picker.near([0, 0, 0], -1), /radius/);
  assert.throws(() => picker.remove(1), /index/);
  assert.throws(() => picker.setTransform(0, [1, 2, 3]), /16 floats/);
});

test('rays through a point box or a box corner hit it: the slab entries round apart by a step', () => {
  // Rays from (-x, -y, -z) toward the origin for whole x, y, z from 1 to 8 (512 rays), the case that lost hits in
  // math's Ray.intersectBox and OBB.intersectRay. The point box holds one instance at the origin, identity transform.
  const identity = instanceTransforms([[0, 0, 0, 1, 0]]);
  const point = new InstancePicker(identity, { bounds: { min: [0, 0, 0], max: [0, 0, 0] } });
  const corner = new InstancePicker(identity, { bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
  const lost = [];
  for (let x = 1; x <= 8; x++)
    for (let y = 1; y <= 8; y++)
      for (let z = 1; z <= 8; z++) {
        const o = [-x, -y, -z];
        if (point.pick(o, [x, y, z]) === null) lost.push(`point ${o}`);
        if (corner.pick(o, [x, y, z])?.index !== 0) lost.push(`corner ${o}`);
        const hit = point.pick(o, [x, y, z]);
        if (hit) assert.ok(Math.abs(hit.distance - Math.hypot(x, y, z)) < 1e-9, `distance ${o}`);
      }
  assert.deepEqual(lost, []);
  // Clear misses stay misses: a ray a hair of 1e-3 off the point, and one passing a unit box by a centimetre.
  assert.equal(point.pick([-4, -4, -4 + 1e-3], [4, 4, 4]), null);
  assert.equal(corner.pick([-1, 1.01, -1], [1, 0, 1]), null);
});
