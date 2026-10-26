import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeightMap, boneHeatWeights, rigJoints, checkRig } from '../dist/index.js';
import { chain, merge, rowSums, split, tube } from './fixtures.js';

const weightAt = (map, v, b) => map.values[v * map.boneCount + b];

test('bone heat weights sum to 1, are non-negative and fall off along the chain', async () => {
  const mesh = tube(),
    weights = await boneHeatWeights(mesh, chain);
  assert.equal(weights.vertexCount, mesh.positions.length / 3);
  assert.equal(weights.boneCount, 3);
  for (const sum of rowSums(weights)) assert.ok(Math.abs(sum - 1) < 1e-6, `row sums to ${sum}`);
  assert.ok(weights.values.every((w) => w >= 0 && w <= 1));
  // Base owns the lower half, middle the upper half; they share near the middle joint; the weight changes smoothly.
  const ring = (r) => r * 12; // first vertex of ring r (16 rings over y 0..2)
  assert.ok(weightAt(weights, ring(1), 0) > 0.95, 'near the bottom the base bone dominates');
  assert.ok(weightAt(weights, ring(12), 1) > 0.9, 'up the upper half the middle bone dominates');
  assert.ok(weightAt(weights, ring(15), 0) < 0.02, 'the base bone does not reach the top');
  const atJoint = weightAt(weights, ring(8), 0);
  assert.ok(atJoint > 0.3 && atJoint < 0.7, `at the middle joint the two bones share (${atJoint})`);
  let previous = 2;
  for (let r = 0; r <= 16; r++) {
    const w = weightAt(weights, ring(r), 0);
    assert.ok(w <= previous + 1e-6, `base weight decreases up the tube (ring ${r}: ${w} after ${previous})`);
    previous = w;
  }
  for (let r = 1; r < 16; r++)
    assert.ok(
      Math.abs(weightAt(weights, ring(r), 0) - weightAt(weights, ring(r + 1), 0)) < 0.35,
      `no step between rings ${r} and ${r + 1}`,
    );
});

test('a split mesh welds: duplicates get one weight, equal to the indexed mesh', async () => {
  const mesh = tube({ rings: 8, sides: 8 }),
    indexed = await boneHeatWeights(mesh, chain),
    unindexed = await boneHeatWeights(split(mesh), chain);
  mesh.indices.forEach((vertex, corner) => {
    for (let b = 0; b < 3; b++)
      assert.ok(Math.abs(weightAt(indexed, vertex, b) - weightAt(unindexed, corner, b)) < 1e-5);
  });
});

test('skip leaves a joint with no weight', async () => {
  const weights = await boneHeatWeights(tube(), chain, { skip: ['base'] });
  for (let v = 0; v < weights.vertexCount; v++) assert.equal(weightAt(weights, v, 0), 0);
  for (const sum of rowSums(weights)) assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('visibility: heat does not jump through another limb', async () => {
  // A thick leg (bone A) beside a thin one (bone B) whose bone is closer to the thick leg's inner side than A's bone.
  const mesh = merge(tube({ cx: -0.45, radius: 0.4, sides: 16 }), tube({ cx: 0.06, radius: 0.04, sides: 8 })),
    joints = [
      { name: 'pelvis', parent: -1, position: [0, 2.5, 0] },
      { name: 'A', parent: 0, position: [-0.45, 2, 0] },
      { name: 'Afoot', parent: 1, position: [-0.45, 0, 0] },
      { name: 'B', parent: 0, position: [0.06, 2, 0] },
      { name: 'Bfoot', parent: 3, position: [0.06, 0, 0] },
    ],
    // Ring 8's first vertex (angle 0) on the thick tube: x = -0.05, the side facing the thin leg.
    middleRing = 8 * 16;
  const seen = await boneHeatWeights(mesh, joints, { skip: ['pelvis'] });
  const blind = await boneHeatWeights(mesh, joints, { skip: ['pelvis'], visibility: false });
  // Angle 0 is x = cx + radius = -0.05: 0.11 from bone B, 0.4 from bone A.
  assert.ok(Math.abs(mesh.positions[middleRing * 3] + 0.05) < 1e-6);
  assert.ok(weightAt(seen, middleRing, 1) > 0.9, `with visibility A owns its inner side`);
  assert.ok(weightAt(blind, middleRing, 3) > 0.5, 'without visibility the nearer bone B takes it');
  const custom = await boneHeatWeights(mesh, joints, { skip: ['pelvis'], visibility: (from, to) => to[0] < 0 });
  assert.ok(weightAt(custom, middleRing, 1) > 0.9, 'a custom visibility test is used');
});

test('bone heat honours AbortSignal and rejects bad input', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(boneHeatWeights(tube(), chain, { signal: controller.signal }), /stop/);
  await assert.rejects(boneHeatWeights(tube(), chain, { heat: 0 }), RangeError);
  await assert.rejects(boneHeatWeights(tube(), chain, { skip: ['nobody'] }), RangeError);
  await assert.rejects(boneHeatWeights(tube(), chain, { skip: [0, 1, 2] }), RangeError);
  await assert.rejects(boneHeatWeights({ positions: [0, 0, 0] }, chain), TypeError);
  await assert.rejects(boneHeatWeights(tube(), [{ name: 'a', parent: 0, position: [0, 0, 0] }]), RangeError);
});

test('WeightMap: influences keep the strongest, renormalised, and round-trip', () => {
  const map = new WeightMap(2, 6, [0.1, 0.3, 0.05, 0.2, 0.25, 0.1, 0, 0, 1, 0, 0, 0]);
  const { joints, weights, influences } = map.toInfluences(4);
  assert.equal(influences, 4);
  assert.deepEqual([...joints.slice(0, 4)], [1, 4, 3, 0]);
  const kept = 0.3 + 0.25 + 0.2 + 0.1;
  assert.deepEqual(
    [...weights.slice(0, 4)].map((w) => +w.toFixed(5)),
    [0.3, 0.25, 0.2, 0.1].map((w) => +(w / kept).toFixed(5)),
  );
  assert.deepEqual([...joints.slice(4)], [2, 0, 0, 0]);
  assert.deepEqual([...weights.slice(4)], [1, 0, 0, 0]);
  const back = WeightMap.fromInfluences({ joints, weights }, 6);
  assert.ok(Math.abs(back.get(0, 1) - 0.3 / kept) < 1e-6);
  assert.equal(back.get(0, 2), 0);
  map.normalize({ locked: [2] });
  assert.ok(Math.abs(rowSums(map)[0] - 1) < 1e-6);
  assert.equal(map.get(0, 2), Math.fround(0.05));
  assert.throws(() => new WeightMap(0, 1), RangeError);
  assert.throws(() => new WeightMap(1, 2, [1]), RangeError);
  assert.throws(() => map.set(0, 9, 1), RangeError);
  assert.throws(() => map.set(0, 0, -1), RangeError);
});

test('rigJoints gives world rest positions; checkRig rejects cycles', () => {
  const s = Math.SQRT1_2,
    joints = rigJoints({
      names: ['root', 'arm', ''],
      parents: [-1, 0, 1],
      // Root turned 90 degrees about z: the arm's local +x offset points up the world y axis.
      rest: [0, 1, 0, 0, 0, s, s, 1, 1, 1, 2, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    });
  assert.deepEqual(
    joints.map((j) => j.position.map((v) => +v.toFixed(6) + 0)),
    [
      [0, 1, 0],
      [0, 3, 0],
      [0, 4, 0],
    ],
  );
  assert.equal(joints[2].name, 'bone2');
  assert.throws(
    () =>
      checkRig([
        { name: 'a', parent: 1, position: [0, 0, 0] },
        { name: 'b', parent: 0, position: [0, 0, 0] },
      ]),
    /cycle/,
  );
});
