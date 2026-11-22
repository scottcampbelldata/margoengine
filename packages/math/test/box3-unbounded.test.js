// Box3.intersectsPlane on a box that is unbounded along an axis the plane does not use: a zero normal component must
// add nothing, not 0 * Infinity (NaN), which made the answer false for a plane that crosses the box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from '../dist/index.js';

const v3 = (a) => new Vector3(...a);
const box = (lo, hi) => new Box3(v3(lo), v3(hi));
const arr = (v) => [v.x, v.y, v.z];
const I = Infinity;

test('Box3.intersectsPlane keeps an unbounded axis for a plane that is parallel to it', () => {
  const inf = Infinity;
  const planeZ = { normal: v3([0, 0, 1]), constant: -0.5 };
  assert.equal(box([-inf, 0, 0], [1, 1, 1]).intersectsPlane(planeZ), true);
  assert.equal(box([0, 0, 0], [inf, 1, 1]).intersectsPlane(planeZ), true);
  assert.equal(box([-inf, -inf, 0], [inf, inf, 1]).intersectsPlane(planeZ), true);
  assert.equal(box([-inf, -inf, 0], [inf, inf, 1]).intersectsPlane({ normal: v3([0, 0, 1]), constant: -2 }), false);
  const planeX = { normal: v3([1, 0, 0]), constant: -0.5 };
  assert.equal(box([0, -inf, 0], [1, 1, 1]).intersectsPlane(planeX), true);
  assert.equal(box([0, 0, -inf], [1, 1, inf]).intersectsPlane(planeX), true);
  const planeY = { normal: v3([0, 1, 0]), constant: -0.5 };
  assert.equal(box([-inf, 0, 0], [inf, 1, 1]).intersectsPlane(planeY), true);
  assert.equal(box([0, 0, -inf], [1, 1, inf]).intersectsPlane(planeY), true);
});

// Regression (KB-MATH-UNB2): the centre and bounding sphere of a box with an infinite bound were NaN.
// Rule: an axis with an infinite bound has centre 0, other axes the midpoint; the sphere radius is Infinity.
test('Box3.getCenter: 0 on an axis with an infinite bound, the midpoint elsewhere', () => {
  assert.deepEqual(arr(box([-I, -I, -I], [I, I, I]).getCenter(new Vector3(9, 9, 9))), [0, 0, 0]);
  assert.deepEqual(arr(box([-I, 10, -2], [I, 20, 4]).getCenter(new Vector3())), [0, 15, 1]);
  assert.deepEqual(arr(box([-I, 2, 6], [5, 4, I]).getCenter(new Vector3())), [0, 3, 0]);
  assert.deepEqual(arr(box([1, -I, 3], [3, -5, 5]).getCenter(new Vector3())), [2, 0, 4]);
  // Both bounds at the same infinity is a valid (non-empty) box too.
  assert.deepEqual(arr(box([I, 0, 0], [I, 2, 2]).getCenter(new Vector3())), [0, 1, 1]);
  assert.deepEqual(arr(box([0, 0, -I], [2, 2, -I]).getCenter(new Vector3())), [1, 1, 0]);
  // Empty boxes keep their documented centre (0, 0, 0).
  assert.deepEqual(arr(new Box3().getCenter(new Vector3(9, 9, 9))), [0, 0, 0]);
});

test('Box3.getBoundingSphere: radius Infinity and a finite centre for an unbounded box', () => {
  const cases = [
    [
      [-I, -I, -I],
      [I, I, I],
      [0, 0, 0],
    ],
    [
      [-I, 10, -2],
      [I, 20, 4],
      [0, 15, 1],
    ],
    [
      [1, -I, 3],
      [3, -5, 5],
      [2, 0, 4],
    ],
    [
      [I, 0, 0],
      [I, 2, 2],
      [0, 1, 1],
    ],
    [
      [0, 0, -I],
      [2, 2, -I],
      [1, 1, 0],
    ],
  ];
  for (const [lo, hi, centre] of cases) {
    const s = { center: new Vector3(7, 7, 7), radius: 3 };
    assert.equal(box(lo, hi).getBoundingSphere(s), s);
    assert.deepEqual([arr(s.center), s.radius], [centre, I], `${lo} ${hi}`);
  }
  // Finite and empty boxes are unchanged.
  const f = { center: new Vector3(), radius: 0 };
  box([0, 0, 0], [2, 3, 6]).getBoundingSphere(f);
  assert.deepEqual([arr(f.center), f.radius], [[1, 1.5, 3], 3.5]);
  const e = { center: new Vector3(7, 7, 7), radius: 3 };
  new Box3().getBoundingSphere(e);
  assert.deepEqual([arr(e.center), e.radius], [[0, 0, 0], -1]);
});
