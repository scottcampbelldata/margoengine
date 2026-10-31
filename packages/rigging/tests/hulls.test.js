import test from 'node:test';
import assert from 'node:assert/strict';
import { WeightMap } from '../dist/index.js';
import { jointHulls } from '../dist/hulls.js';

// A 1 x 3 x 1 box with four rings of corners (y = 0, 1, 2, 3), skinned to two joints: rings 0-1 to joint 0, rings 2-3
// to joint 1. Each joint dominates a 1 x 1 x 1 cube of eight corners.
function column({ weightsOf = (ring) => (ring < 2 ? [0, 1] : [1, 0]) } = {}) {
  const positions = [],
    joints = [],
    weights = [];
  for (let ring = 0; ring < 4; ring++)
    for (const x of [-0.5, 0.5])
      for (const z of [-0.5, 0.5]) {
        positions.push(x, ring, z);
        const [a, b] = weightsOf(ring);
        // Slot 0 holds joint 1 and slot 1 joint 0, so slot order never decides the owner.
        joints.push(1, 0, 0, 0);
        weights.push(a, b, 0, 0);
      }
  return {
    positions: Float32Array.from(positions),
    joints: Uint16Array.from(joints),
    weights: Float32Array.from(weights),
  };
}
const bounds = (points) => {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], points[i]);
    hi[i % 3] = Math.max(hi[i % 3], points[i]);
  }
  return { lo, hi };
};
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

test('each joint gets the hull of the vertices it dominates', () => {
  const { positions, joints, weights } = column(),
    hulls = jointHulls({ positions, skin: { joints, weights } });
  assert.deepEqual(
    hulls.map((h) => [h.joint, h.vertexCount, h.points.length / 3]),
    [
      [0, 8, 8],
      [1, 8, 8],
    ],
  );
  assert.deepEqual(bounds(hulls[0].points), { lo: [-0.5, 0, -0.5], hi: [0.5, 1, 0.5] });
  assert.deepEqual(bounds(hulls[1].points), { lo: [-0.5, 2, -0.5], hi: [0.5, 3, 0.5] });
});

test('inverse bind matrices put each hull in its joint space, so one world matrix moves it', () => {
  const { positions, joints, weights } = column(),
    ibm = [...translation(0, 0, 0), ...translation(0, -2, 0)],
    hulls = jointHulls({ positions, skin: { joints, weights } }, { inverseBindMatrices: ibm });
  assert.deepEqual(bounds(hulls[0].points), { lo: [-0.5, 0, -0.5], hi: [0.5, 1, 0.5] });
  assert.deepEqual(bounds(hulls[1].points), { lo: [-0.5, 0, -0.5], hi: [0.5, 1, 0.5] }, 'joint 1 sits at y = 2');
  // Joint 0 turned a quarter turn about z in column-major form: x' = y, y' = -x.
  const turned = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, ...translation(0, 0, 0)];
  const hull = jointHulls({ positions, skin: { joints, weights } }, { inverseBindMatrices: turned })[0];
  assert.deepEqual(bounds(hull.points), { lo: [0, -0.5, -0.5], hi: [1, 0.5, 0.5] });
});

test('minWeight decides whether blended vertices reach into both joints', () => {
  const blended = column({
      weightsOf: (ring) => (ring === 1 ? [0.4, 0.6] : ring === 2 ? [0.6, 0.4] : ring < 1 ? [0, 1] : [1, 0]),
    }),
    skin = { joints: blended.joints, weights: blended.weights },
    strict = jointHulls({ positions: blended.positions, skin }),
    loose = jointHulls({ positions: blended.positions, skin }, { minWeight: 0.4 });
  assert.equal(strict[0].vertexCount, 8);
  assert.equal(strict[1].vertexCount, 8);
  assert.equal(loose[0].vertexCount, 12, 'joint 0 also takes the ring-2 vertices it carries at 0.4');
  assert.deepEqual(bounds(loose[0].points).hi, [0.5, 2, 0.5]);
  assert.deepEqual(bounds(loose[1].points).lo, [-0.5, 1, -0.5]);
});

test('a joint repeated in several slots of one vertex counts its weights together, once', () => {
  const { positions } = column(),
    joints = new Uint16Array(64),
    weights = new Float32Array(64);
  for (let v = 0; v < 16; v++) {
    const owner = v < 8 ? 0 : 1;
    joints.set([owner, 2, owner, 2], v * 4);
    weights.set([0.3, 0.4, 0.3, 0], v * 4); // 0.6 together on the owner, 0.4 on joint 2
  }
  const hulls = jointHulls({ positions, skin: { joints, weights } });
  assert.deepEqual(
    hulls.map((h) => [h.joint, h.vertexCount]),
    [
      [0, 8],
      [1, 8],
    ],
  );
});

test('a dense WeightMap and the equivalent glTF influences give the same hulls', () => {
  const { positions, joints, weights } = column(),
    map = new WeightMap(16, 2);
  for (let v = 0; v < 16; v++) map.set(v, v < 8 ? 0 : 1, 1);
  assert.deepEqual(jointHulls({ positions, skin: map }), jointHulls({ positions, skin: { joints, weights } }));
});

test('duplicate vertices (split seams) do not change the hull', () => {
  const { positions, joints, weights } = column(),
    doubled = Float32Array.from([...positions, ...positions]),
    skin = { joints: Uint16Array.from([...joints, ...joints]), weights: Float32Array.from([...weights, ...weights]) };
  const hulls = jointHulls({ positions: doubled, skin });
  assert.equal(hulls[0].points.length / 3, 8);
  assert.equal(hulls[0].vertexCount, 16);
});

test('a joint with fewer than four vertices, or vertices without volume, has no hull', () => {
  // Joint 0: four corners of one square (a plane). Joint 1: one vertex. Joint 2: four more coplanar corners.
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 5, 5, 5, 6, 5, 5, 5, 6, 5, 6, 6, 5],
    joints = Uint16Array.from([0, 0, 0, 0, 1, 2, 2, 2, 2]),
    weights = new Float32Array(9).fill(1),
    hulls = jointHulls({ positions, skin: { joints, weights, influences: 1 } });
  assert.deepEqual(hulls, []);
});

test('a hull past maxPoints keeps corners of the full hull that still enclose most of the volume', () => {
  const positions = [],
    n = 800;
  for (let i = 0; i < n; i++) {
    // Fibonacci sphere of radius 2.
    const y = 1 - (2 * (i + 0.5)) / n,
      r = Math.sqrt(1 - y * y),
      a = i * Math.PI * (3 - Math.sqrt(5));
    positions.push(2 * r * Math.cos(a), 2 * y, 2 * r * Math.sin(a));
  }
  const skin = { joints: new Uint16Array(n), weights: new Float32Array(n).fill(1), influences: 1 },
    full = jointHulls({ positions, skin }, { maxPoints: 1024 })[0],
    capped = jointHulls({ positions, skin }, { maxPoints: 32 })[0];
  assert.ok(full.points.length / 3 > 400, `the full hull of a sphere has many corners, ${full.points.length / 3}`);
  assert.ok(capped.points.length / 3 <= 32 && capped.points.length / 3 >= 20);
  const key = (p, i) => `${p[i]},${p[i + 1]},${p[i + 2]}`,
    fullSet = new Set();
  for (let i = 0; i < full.points.length; i += 3) fullSet.add(key(full.points, i));
  for (let i = 0; i < capped.points.length; i += 3)
    assert.ok(fullSet.has(key(capped.points, i)), 'a kept point is a corner');
  // The reach along many directions stays within 10 percent of the sphere radius.
  for (let d = 0; d < 50; d++) {
    const y = 1 - (2 * (d + 0.5)) / 50,
      r = Math.sqrt(1 - y * y),
      dir = [r * Math.cos(d * 2.4), y, r * Math.sin(d * 2.4)];
    let reach = -Infinity;
    for (let i = 0; i < capped.points.length; i += 3)
      reach = Math.max(
        reach,
        capped.points[i] * dir[0] + capped.points[i + 1] * dir[1] + capped.points[i + 2] * dir[2],
      );
    assert.ok(reach > 2 * 0.9, `reach ${reach} along direction ${d}`);
  }
});

test('bad input is named and rejected', () => {
  const { positions, joints, weights } = column(),
    model = { positions, skin: { joints, weights } };
  assert.throws(() => jointHulls(null), TypeError);
  assert.throws(() => jointHulls({ positions }), TypeError);
  assert.throws(() => jointHulls({ positions, skin: { joints, weights: weights.subarray(1) } }), TypeError);
  const nan = Float32Array.from(positions);
  nan[5] = NaN;
  assert.throws(() => jointHulls({ ...model, positions: nan }), /position 5 is not finite/);
  assert.throws(() => jointHulls({ ...model, positions: positions.subarray(0, 14) }), RangeError);
  assert.throws(() => jointHulls({ positions: positions.subarray(0, 24), skin: model.skin }), /vertices/);
  const badWeight = Float32Array.from(weights);
  badWeight[0] = NaN;
  assert.throws(() => jointHulls({ positions, skin: { joints, weights: badWeight } }), /not finite/);
  for (const minWeight of [0, -1, 1.5, NaN]) assert.throws(() => jointHulls(model, { minWeight }), RangeError);
  for (const maxPoints of [3, 7, 2000, 9.5, NaN]) assert.throws(() => jointHulls(model, { maxPoints }), RangeError);
  assert.throws(() => jointHulls(model, { inverseBindMatrices: new Float32Array(15) }), RangeError);
  assert.throws(() => jointHulls(model, { inverseBindMatrices: new Float32Array(16).fill(NaN) }), /not finite/);
  assert.throws(() => jointHulls(model, { inverseBindMatrices: new Float32Array(16) }), /joint 1 has no inverse bind/);
});
