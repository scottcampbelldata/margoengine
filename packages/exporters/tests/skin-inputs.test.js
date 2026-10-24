// Skin authoring input checks: sparse or non-Float32 vectors, joint holes, rest offsets past Float32, vertex counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkJoints, skinBindMatrices, skinHierarchy, skinWeights } from '@margoengine/exporters/skin';

const root = (position = [0, 0, 0]) => ({ name: 'root', parent: -1, position });

test('joint positions and origins must be three dense finite Float32 numbers', () => {
  for (const vector of [[, 0, 0], Array(3), [0, undefined, 0], [0, NaN, 0], [0, Infinity, 0], [0, 2 ** 128, 0]]) {
    for (const run of [() => checkJoints([root(vector)]), () => skinWeights([0, 0, 0], [root(vector)])])
      assert.throws(run, { name: 'RangeError', message: /Joint root position must be three finite Float32/ });
    for (const run of [() => skinBindMatrices([root()], vector), () => skinHierarchy([root()], { origin: vector })])
      assert.throws(run, { name: 'RangeError', message: /Skin origin must be three finite Float32/ });
  }
});

test('a hole in the joint list is refused', () => {
  const joints = [root(), , { name: 'child', parent: 0, position: [0, 1, 0] }];
  assert.throws(() => checkJoints(joints), { name: 'TypeError', message: /Joint 1 needs a unique, nonempty name/ });
});

test('rest translations past Float32 throw; the largest Float32 values still bind', () => {
  for (const [joints, origin] of [
    [[root([3e38, 0, 0])], [-3e38, 0, 0]],
    [
      [root([0, 0, -3e38]), { name: 'tip', parent: 0, position: [0, 0, 3e38] }],
      [0, 0, 0],
    ],
  ]) {
    assert.throws(() => skinBindMatrices(joints, origin), { name: 'RangeError', message: /exceeds finite Float32/ });
    assert.throws(() => skinHierarchy(joints, { origin }), RangeError);
  }
  const largest = (2 - 2 ** -23) * 2 ** 127,
    { local, world, inverseBind } = skinBindMatrices([root([largest, 0, 0])]);
  assert.deepEqual([local[12], world[12], inverseBind[12]], [largest, largest, -largest]);
});

test('skin weights refuse a malformed vertex count and accept an empty one', () => {
  for (const length of [NaN, -3, 1.5, Infinity, 1, 3 * (2 ** 24 + 1), undefined, '3'])
    assert.throws(() => skinWeights({ length }, [root()]), { name: 'RangeError', message: /Skin positions/ });
  for (const positions of [[], { length: 0 }]) assert.equal(skinWeights(positions, [root()]).joints.length, 0);
});
