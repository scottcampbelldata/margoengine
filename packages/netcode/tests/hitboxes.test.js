import test from 'node:test';
import assert from 'node:assert/strict';
import { LagCompensation } from '../dist/index.js';
import { HitboxRewind } from '../dist/hitboxes.js';

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? 'value'}: ${a} against ${b}`);
const random = (seed) => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
};
const halfTurnAboutY = (angle) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

test('hitboxes: a ray hits a box where a box is, and misses the corner a turned box cut away', () => {
  const rewind = new HitboxRewind();
  rewind.record(0, [[1, { position: [10, 0, 0], halfExtents: [1, 1, 1] }]]);
  const straight = rewind.raycast(0, [0, 0, 0], [1, 0, 0]);
  close(straight.distance, 9);
  assert.deepEqual(straight.point, [9, 0, 0]);
  assert.equal(straight.id, 1);
  assert.equal(rewind.raycast(0, [0, 1.5, 0], [1, 0, 0]), undefined, 'over the top');
  assert.equal(rewind.raycast(0, [0, 0.9, 0.9], [1, 0, 0]).id, 1, 'the corner of the box as it stands');

  const turned = new HitboxRewind();
  turned.record(0, [[1, { position: [10, 0, 0], halfExtents: [1, 1, 1], rotation: halfTurnAboutY(Math.PI / 4) }]]);
  close(turned.raycast(0, [0, 0, 0], [1, 0, 0]).distance, 10 - Math.SQRT2, 'the turned box meets the ray at its edge');
  assert.equal(turned.raycast(0, [0, 0, 1.3], [1, 0, 0]).id, 1, 'wider than it was');
  assert.equal(turned.raycast(0, [0, 0, 1.5], [1, 0, 0]), undefined, 'past its edge');
});

test('hitboxes: a capsule is hit on its side and its caps, and turns with its rotation', () => {
  const rewind = new HitboxRewind();
  rewind.record(0, [[1, { position: [5, 0, 0], radius: 0.5, halfHeight: 1 }]]);
  close(rewind.raycast(0, [0, 0, 0], [1, 0, 0]).distance, 4.5, 'side');
  close(rewind.raycast(0, [5, 10, 0], [0, -1, 0]).distance, 8.5, 'top cap');
  close(rewind.raycast(0, [0, 1.25, 0], [1, 0, 0]).distance, 5 - Math.sqrt(0.25 - 0.0625), 'the round of the cap');
  assert.equal(rewind.raycast(0, [0, 1.6, 0], [1, 0, 0]), undefined, 'over the cap');

  const lying = new HitboxRewind(),
    s = Math.SQRT1_2;
  lying.record(0, [[1, { position: [5, 0, 0], radius: 0.5, halfHeight: 1, rotation: [s, 0, 0, s] }]]);
  assert.equal(lying.raycast(0, [0, 1.25, 0], [1, 0, 0]), undefined, 'lying down it is no longer that tall');
  assert.equal(lying.raycast(0, [0, 0, 1.25], [1, 0, 0]).id, 1, 'it lies along z');
});

test('hitboxes: spheres give what LagCompensation gives, on 200 random rays', () => {
  const r = random(5),
    round = new LagCompensation(),
    rewind = new HitboxRewind(),
    shapes = [];
  for (let id = 1; id <= 20; id++)
    shapes.push([id, { position: [r() * 20 - 10, r() * 20 - 10, r() * 20 - 10], radius: r() * 3 }]);
  round.record(0, shapes);
  rewind.record(0, shapes);
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const origin = [r() * 20 - 10, r() * 20 - 10, r() * 20 - 10],
      direction = [r() - 0.5, r() - 0.5, r() - 0.5],
      a = round.raycast(0, origin, direction),
      b = rewind.raycast(0, origin, direction);
    assert.equal(b?.id, a?.id);
    if (!a) continue;
    hits++;
    assert.ok(Math.abs(a.distance - b.distance) < 1e-9, `${a.distance} against ${b.distance}`);
  }
  assert.ok(hits > 20, `${hits} rays hit`);
});

test('hitboxes: boxes and capsules agree with a walk along the ray, on 300 random rays', () => {
  const r = random(11);
  const toLocal = (p, shape) => {
    const [x, y, z, w] = shape.rotation.map((v, i) => (i < 3 ? -v : v)),
      v = p.map((c, i) => c - shape.position[i]),
      t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [
      v[0] + w * t[0] + y * t[2] - z * t[1],
      v[1] + w * t[1] + z * t[0] - x * t[2],
      v[2] + w * t[2] + x * t[1] - y * t[0],
    ];
  };
  const inside = (p, shape) => {
    const [a, b, c] = toLocal(p, shape);
    if (shape.halfExtents) return shape.halfExtents.every((h, i) => Math.abs([a, b, c][i]) <= h);
    const y = Math.max(-shape.halfHeight, Math.min(shape.halfHeight, b));
    return Math.hypot(a, b - y, c) <= shape.radius;
  };
  let hits = 0,
    misses = 0;
  for (let i = 0; i < 300; i++) {
    const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5],
      n = Math.hypot(...q),
      rotation = q.map((v) => v / n),
      shape =
        i % 2
          ? { position: [r() * 4, r() * 4, r() * 4], rotation, halfExtents: [0.5 + r(), 0.5 + r(), 0.5 + r()] }
          : { position: [r() * 4, r() * 4, r() * 4], rotation, radius: 0.5 + r(), halfHeight: r() * 2 };
    const rewind = new HitboxRewind();
    rewind.record(0, [[1, shape]]);
    const origin = [-6, r() * 4, r() * 4],
      target = [r() * 4, r() * 4, r() * 4],
      direction = target.map((v, k) => v - origin[k]),
      hit = rewind.raycast(0, origin, direction);
    let first;
    for (let s = 0; s <= 2 && first === undefined; s += 0.0005)
      if (inside(origin.map((v, k) => v + direction[k] * s), shape)) first = s;
    if (first === undefined) {
      misses++;
      assert.equal(hit, undefined, `ray ${i} misses`);
    } else {
      hits++;
      assert.ok(hit, `ray ${i} hits at ${first}`);
      assert.ok(Math.abs(hit.distance - first) < 0.001, `ray ${i}: ${hit.distance} against the walk's ${first}`);
    }
  }
  assert.ok(hits > 50 && misses > 20, `${hits} hits, ${misses} misses`);
});

test('hitboxes: a shot lands on where the shape was, moved and turned, between two ticks', () => {
  const rewind = new HitboxRewind();
  rewind.record(10, [[1, { position: [0, 0, 0], halfExtents: [2, 1, 0.1] }]]);
  rewind.record(11, [[1, { position: [10, 0, 0], halfExtents: [2, 1, 0.1], rotation: halfTurnAboutY(Math.PI / 2) }]]);
  const at = rewind.at(10.5).get(1);
  assert.deepEqual(at.position, [5, 0, 0]);
  close(at.rotation[1], Math.sin(Math.PI / 8), 'half the turn');
  assert.equal(rewind.raycast(10, [0, 0, -5], [0, 0, 1]).id, 1, 'at the old tick it was at the origin');
  assert.equal(rewind.raycast(11, [0, 0, -5], [0, 0, 1]), undefined, 'at the new tick it had gone');
  assert.equal(rewind.raycast(11, [10, 0, -5], [0, 0, 1]).id, 1);
  close(rewind.raycast(11, [10, 0, -5], [0, 0, 1]).distance, 3, 'and turned its long side along z');
  // The short way: a turn across the sign of the quaternion is still a small turn.
  const signs = new HitboxRewind();
  signs.record(0, [[1, { position: [0, 0, 0], halfExtents: [1, 1, 1], rotation: [0, 0, 0, 1] }]]);
  signs.record(1, [[1, { position: [0, 0, 0], halfExtents: [1, 1, 1], rotation: [0, 0, 0, -1] }]]);
  close(Math.abs(signs.at(0.5).get(1).rotation[3]), 1, 'no half turn in the middle');
});

test('hitboxes: history is clamped, shapes come and go, ignore and maxDistance work', () => {
  const rewind = new HitboxRewind({ history: 2 });
  const sphere = (x) => ({ position: [x, 0, 0], radius: 1 });
  rewind.record(1, [[1, sphere(100)]]);
  rewind.record(2, [[1, sphere(10)]]);
  rewind.record(3, [
    [1, sphere(20)],
    [2, { position: [5, 0, 0], halfExtents: [1, 1, 1] }],
  ]);
  assert.deepEqual(rewind.range, [2, 3]);
  close(rewind.raycast(0, [0, 0, 0], [1, 0, 0]).distance, 9, 'older than the history is the oldest held');
  assert.equal(rewind.raycast(2.25, [0, 0, 0], [1, 0, 0]).id, 2, 'a new shape counts at once, as in LagCompensation');
  assert.equal(rewind.raycast(3, [0, 0, 0], [1, 0, 0]).id, 2);
  assert.equal(rewind.raycast(3, [0, 0, 0], [1, 0, 0], { ignore: 2 }).id, 1);
  assert.equal(rewind.raycast(3, [0, 0, 0], [1, 0, 0], { ignore: new Set([1, 2]) }), undefined);
  assert.equal(rewind.raycast(3, [0, 0, 0], [1, 0, 0], { maxDistance: 3 }), undefined);
  close(rewind.raycast(3, [5, 0, 0], [1, 0, 0]).distance, 0, 'starting inside');
  close(rewind.raycast(3, [0, 0, 0], [2, 0, 0]).distance, 2, 'in direction lengths');
  rewind.clear();
  assert.equal(rewind.range, undefined);
  assert.equal(rewind.raycast(3, [0, 0, 0], [1, 0, 0]), undefined);
});

test('hitboxes: what it refuses', () => {
  assert.throws(() => new HitboxRewind({ history: 1 }), RangeError);
  const rewind = new HitboxRewind();
  assert.throws(() => rewind.record(Number.NaN, []), RangeError);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0], radius: 1 }]]), TypeError);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0, 0] }]]), /radius/);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0, 0], radius: -1 }]]), RangeError);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0, 0], halfExtents: [1, -1, 1] }]]), RangeError);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0, 0], radius: 1, rotation: [0, 0, 0, 0] }]]), RangeError);
  assert.throws(() => rewind.record(0, [[1, { position: [0, 0, 0], radius: 1, halfHeight: -1 }]]), RangeError);
  rewind.record(5, []);
  assert.throws(() => rewind.record(4, []), RangeError);
  assert.throws(() => rewind.raycast(5, [0, 0], [1, 0, 0]), RangeError);
  assert.throws(() => rewind.raycast(5, [0, 0, 0], [0, 0, 0]), RangeError);
});
