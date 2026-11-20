// Triangle.intersectsBox and Capsule.intersectsBox on boxes with infinite bounds. The separating tests work on the
// box centre and half sizes, which an infinite bound made NaN or infinite, so a triangle or capsule far outside an
// unbounded box was reported as touching it. The reference is the same query against the box with each infinite
// bound replaced by a finite one far beyond the shape, which has the same overlap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Capsule, Triangle, Vector3 } from '../dist/index.js';

const inf = Infinity;
const v3 = (a) => new Vector3(...a);
const box = (lo, hi) => new Box3(v3(lo), v3(hi));
const FAR = 1e4;
const finite = (b) =>
  box(
    [b.min.x, b.min.y, b.min.z].map((x) => (x === -inf ? -FAR : x)),
    [b.max.x, b.max.y, b.max.z].map((x) => (x === inf ? FAR : x)),
  );

const slab = box([-inf, 10, -inf], [inf, 20, inf]);
const halfX = box([-inf, 10, 0], [0, 20, 1]);
const upZ = box([-1, -1, 2], [1, 1, inf]);

test('Triangle.intersectsBox: a triangle outside an unbounded box does not touch it', () => {
  const tri = (a, b, c) => new Triangle(v3(a), v3(b), v3(c));
  assert.equal(tri([5, 0, 0.2], [6, 0, 0.2], [5, 0, 0.8]).intersectsBox(slab), false);
  assert.equal(tri([5, 15, 0.2], [6, 15, 0.2], [5, 15, 0.8]).intersectsBox(halfX), false);
  assert.equal(tri([0, 0, 0], [0.5, 0, 0], [0, 0.5, 1.9]).intersectsBox(upZ), false);
  // A slanted triangle whose bounding box overlaps the box but whose plane passes beside it.
  assert.equal(tri([0.5, 9, 0], [-0.5, 9, 1], [0.5, 9.5, 1]).intersectsBox(halfX), false);
});

test('Triangle.intersectsBox: a triangle inside or across an unbounded box touches it', () => {
  const tri = (a, b, c) => new Triangle(v3(a), v3(b), v3(c));
  assert.equal(tri([5, 15, 0.2], [6, 15, 0.2], [5, 15, 0.8]).intersectsBox(slab), true);
  assert.equal(tri([-5, 15, 0.2], [-6, 15, 0.2], [-5, 15, 0.8]).intersectsBox(halfX), true);
  assert.equal(tri([5, 5, 0.5], [-5, 15, 0.5], [5, 15, 0.5]).intersectsBox(halfX), true);
  assert.equal(tri([0, 0, 0], [0.5, 0, 0], [0, 0.5, 2]).intersectsBox(upZ), true);
  assert.equal(tri([0, 0, 1e30], [0.5, 0, 1e30], [0, 0.5, 1e30]).intersectsBox(upZ), true);
  assert.equal(tri([0, 0, 0], [1, 0, 0], [0, 1, 0]).intersectsBox(box([-inf, -inf, -inf], [inf, inf, inf])), true);
});

test('Triangle.intersectsBox: a box empty on an infinite axis meets nothing', () => {
  const t = new Triangle(v3([0, 0, 0]), v3([1, 0, 0]), v3([0, 1, 0]));
  assert.equal(t.intersectsBox(box([inf, -inf, -inf], [inf, inf, inf])), false);
  assert.equal(t.intersectsBox(box([-inf, -inf, -inf], [inf, -inf, inf])), false);
  assert.equal(t.intersectsBox(new Box3()), false);
});

test('Capsule.intersectsBox: a capsule outside an unbounded box does not touch it', () => {
  const cap = (a, b, r) => new Capsule(v3(a), v3(b), r);
  assert.equal(cap([5, 15, 0.5], [6, 15, 0.5], 0.5).intersectsBox(halfX), false);
  assert.equal(cap([5, 0, 0.5], [6, 0, 0.5], 0.5).intersectsBox(slab), false);
  assert.equal(cap([0, 0, 0], [0, 0, 1], 0.5).intersectsBox(upZ), false);
  assert.equal(cap([0.6, 15, 0.5], [0.6, 16, 0.5], 0.5).intersectsBox(halfX), false);
});

test('Capsule.intersectsBox: a capsule inside or across an unbounded box touches it', () => {
  const cap = (a, b, r) => new Capsule(v3(a), v3(b), r);
  assert.equal(cap([-5, 15, 0.5], [-6, 15, 0.5], 0.5).intersectsBox(halfX), true);
  assert.equal(cap([0.4, 15, 0.5], [0.4, 16, 0.5], 0.5).intersectsBox(halfX), true);
  assert.equal(cap([5, 15, 0.5], [6, 15, 0.5], 6).intersectsBox(halfX), true);
  assert.equal(cap([0, 0, 0], [0, 0, 1], 1.5).intersectsBox(upZ), true);
  assert.equal(cap([5, 0, 0.5], [6, 30, 0.5], 0.1).intersectsBox(slab), true);
  assert.equal(cap([0, 0, 0], [1, 1, 1], 0).intersectsBox(box([-inf, -inf, -inf], [inf, inf, inf])), true);
});

test('Capsule.intersectsBox: a box empty on an infinite axis meets nothing', () => {
  const c = new Capsule(v3([0, 0, 0]), v3([1, 0, 0]), 0.5);
  assert.equal(c.intersectsBox(box([inf, -inf, -inf], [inf, inf, inf])), false);
  assert.equal(c.intersectsBox(box([-inf, -inf, -inf], [inf, -inf, inf])), false);
  assert.equal(c.intersectsBox(new Box3()), false);
});

test('unbounded boxes agree with their far finite stand-ins on random shapes', () => {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 8 - 4;
  const p = () => [rnd(), rnd(), rnd()];
  const pick = () => (rnd() > 0 ? rnd() : rnd() > 0 ? -inf : inf);
  let checked = 0;
  for (let i = 0; i < 2000; i++) {
    const lo = [pick(), pick(), pick()].map((x) => (x === inf ? -inf : x)),
      hi = [pick(), pick(), pick()].map((x, k) => (x === -inf ? inf : Math.max(x, lo[k]))),
      b = box(lo, hi);
    if (![...lo, ...hi].some((x) => !Number.isFinite(x))) continue;
    const ref = finite(b),
      t = new Triangle(v3(p()), v3(p()), v3(p())),
      c = new Capsule(v3(p()), v3(p()), Math.abs(rnd()) / 4);
    assert.equal(t.intersectsBox(b), t.intersectsBox(ref), `triangle ${i}`);
    assert.equal(c.intersectsBox(b), c.intersectsBox(ref), `capsule ${i}`);
    checked++;
  }
  assert.ok(checked > 1000, `${checked} boxes with an infinite bound`);
});
