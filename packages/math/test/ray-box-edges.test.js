// Ray.intersectsBox at its edges: an empty box (max below min) is never hit, an unbounded box keeps the exact slab
// test, and the hit tolerance is the documented one, the box grown by 8 machine epsilons of its farthest corner from
// the origin (the reference below works that rule out by hand).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Ray, Vector3 } from '../dist/index.js';

const inf = Infinity;
const v3 = (a) => new Vector3(...a);
const box = (lo, hi) => new Box3(v3(lo), v3(hi));
const ray = (o, d) => new Ray(v3(o), v3(d).normalize());

test('Ray.intersectsBox: an empty box is a miss from every direction', () => {
  for (const d of [
    [1, 1, 1],
    [-1, 2, -3],
    [0, 0, 1],
    [1, 0, 0],
  ]) {
    assert.equal(ray([0, 0, 0], d).intersectsBox(new Box3()), false, `default empty box, direction ${d}`);
    assert.equal(ray([0, 0, 0], d).intersectBox(new Box3(), new Vector3()), null);
    assert.equal(ray([0.5, 0.5, 0.5], d).intersectsBox(box([0, 0, 1], [1, 1, 0])), false, `z inverted, direction ${d}`);
    assert.equal(ray([0, 0, 0], d).intersectsBox(box([-1, 1, -1], [1, -1, 1])), false, `y inverted, direction ${d}`);
  }
});

test('Ray.intersectsBox: an unbounded box keeps the exact slab test', () => {
  const slab = box([-inf, 10, -inf], [inf, 20, inf]);
  assert.equal(ray([0, 0, 0], [1, -1, 0.5]).intersectsBox(slab), false);
  assert.equal(ray([0, 30, 0], [1, 1, 0.5]).intersectsBox(slab), false);
  assert.equal(ray([0, 0, 0], [1, 1, 0.5]).intersectsBox(slab), true);
  const hit = ray([0, 0, 0], [2, 1, 2]).intersectBox(slab, new Vector3());
  assert.ok(Math.abs(hit.x - 20) < 1e-12 && Math.abs(hit.y - 10) < 1e-12 && Math.abs(hit.z - 20) < 1e-12, JSON.stringify(hit));
  // Unbounded along x only, starting 0.5 above the ray in z.
  const bar = box([-inf, -1, 0.5], [inf, 1, 2]);
  assert.equal(ray([0, 0, 0], [1, 0.25, 1e-3]).intersectsBox(bar), false);
  assert.equal(ray([0, 0, 0], [1, 0.25, 0.25]).intersectsBox(bar), true);
});

test('Ray.intersectsBox: the miss tolerance is 8 epsilons of the farthest corner distance', () => {
  // Ray (t, t, 0) against x in [1, 2] and y in [2 + gap, 3]: the x slab ends at t = 2 and the y slab starts at
  // t = 2 + gap. The farthest corner is (2, 3, 1) at sqrt 14, so the grown box is reached when gap <= 2 * 8 eps sqrt 14,
  // about 59.87 eps. Every value here is exact in binary, so the result does not hang on rounding.
  const eps = Number.EPSILON,
    r = new Ray(v3([0, 0, 0]), v3([1, 1, 0])),
    at = (gap) => box([1, 2 + gap, -1], [2, 3, 1]);
  assert.ok(2 * 8 * eps * Math.sqrt(14) > 56 * eps && 2 * 8 * eps * Math.sqrt(14) < 64 * eps);
  assert.equal(r.intersectsBox(at(0)), true, 'touching');
  assert.equal(r.intersectsBox(at(56 * eps)), true, 'inside the tolerance');
  assert.equal(r.intersectsBox(at(64 * eps)), false, 'beyond the tolerance');
  assert.equal(r.intersectsBox(at(2 ** -40)), false, 'well beyond');
  // A hit inside the tolerance reports the exact entry, the start of the y slab.
  const p = r.intersectBox(at(56 * eps), new Vector3());
  assert.equal(p.y, 2 + 56 * eps);
});

test('Ray.intersectsBox: a later slab never loosens the entry or exit the earlier slabs set', () => {
  // Ray (t, t, t), so every slab grows by the same slack p = 8 eps |farthest corner|. The x slab sets the entry at
  // 2 - p; the y slab starts 56 eps earlier, inside the slack, and must leave that entry alone; the z slab ends 104 eps
  // before t = 2, more than 2p (about 75 eps, corner (3, 3, 2) at sqrt 22) and so a miss.
  const eps = Number.EPSILON,
    r = new Ray(v3([0, 0, 0]), v3([1, 1, 1]));
  assert.equal(r.intersectsBox(box([2, 2 - 56 * eps, -1], [3, 3, 2 - 104 * eps])), false, 'entry kept');
  assert.equal(r.intersectsBox(box([2, 2 - 56 * eps, -1], [3, 3, 2 - 64 * eps])), true, 'within the slack');
  // Mirror image for the exit: x ends at 2, y ends 48 eps later (inside the slack), z starts 90 eps after 2, more
  // than 2p (about 66 eps, corner (2, 2, 3) at sqrt 17).
  assert.equal(r.intersectsBox(box([-1, -1, 2 + 90 * eps], [2, 2 + 48 * eps, 3])), false, 'exit kept');
  assert.equal(r.intersectsBox(box([-1, -1, 2 + 56 * eps], [2, 2 + 48 * eps, 3])), true, 'within the slack');
});
