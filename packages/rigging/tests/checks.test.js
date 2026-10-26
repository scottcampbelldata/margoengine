import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeightMap, assertSkin, boneHeatWeights, checkSkin } from '../dist/index.js';
import { chain, tube } from './fixtures.js';

const codes = (report) => report.issues.map((issue) => issue.code).sort();

test('solved weights pass the export checks', async () => {
  const weights = await boneHeatWeights(tube(), chain),
    influences = weights.toInfluences(4);
  for (const input of [{ weights }, { weights: influences, jointCount: 3 }]) {
    const report = checkSkin({ ...input, joints: chain });
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.equal(report.vertexCount, weights.vertexCount);
  }
  assert.doesNotThrow(() => assertSkin({ weights: influences, joints: chain }));
});

test('each fault is found and named with its fix', () => {
  const joints = Uint16Array.of(0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 7, 0, 0, 0, 0, 0, 0, 0),
    weights = Float32Array.of(
      0.5,
      0.5,
      0,
      0,
      0,
      0,
      0,
      0,
      0.7,
      0.7,
      0,
      0,
      0.25,
      0.25,
      0.25,
      0.25,
      1,
      0,
      0,
      0,
      NaN,
      1,
      0,
      0,
    );
  const report = checkSkin({ weights: { joints, weights }, jointCount: 4, maxInfluences: 3 });
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report), [
    'invalid-joint',
    'non-finite',
    'not-normalized',
    'too-many-influences',
    'unweighted',
  ]);
  const by = Object.fromEntries(report.issues.map((issue) => [issue.code, issue]));
  assert.deepEqual(by.unweighted.vertices, [1]);
  assert.deepEqual(by['not-normalized'].vertices, [2]);
  assert.deepEqual(by['too-many-influences'].vertices, [3]);
  assert.deepEqual(by['invalid-joint'].vertices, [4]);
  assert.deepEqual(by['invalid-joint'].bones, [7]);
  assert.deepEqual(by['non-finite'].vertices, [5]);
  assert.match(by['not-normalized'].message, /1 vertex\(es\) have weights that don't sum to 1; call normalize\(\)/);
  const negative = checkSkin({ weights: new WeightMap(1, 2, [1.5, -0.5]) });
  assert.deepEqual(codes(negative), ['negative-weight']);
  assert.throws(
    () => assertSkin({ weights: { joints, weights } }),
    /Skin is not ready to export: .*unweighted|have no weight/,
  );
});

test('degenerate bones: zero length and non-invertible bind matrices', () => {
  const weights = new WeightMap(1, 3, [1, 0, 0]),
    joints = [
      { name: 'a', parent: -1, position: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 1, 0] },
      { name: 'c', parent: 1, position: [0, 1, 0] },
    ],
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    flat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const report = checkSkin({ weights, joints, inverseBindMatrices: [...identity, ...flat, ...identity] });
  assert.deepEqual(codes(report), ['degenerate-bone']);
  assert.equal(report.issues[0].count, 2);
  assert.deepEqual(report.issues[0].bones, [1, 2]);
  assert.match(report.issues[0].message, /2 bone\(s\) \(1, 2\)/);
});

test('counts beyond the examples stay exact', () => {
  const weights = new WeightMap(40, 2);
  for (let v = 0; v < 40; v++) weights.values.set([0.3, -0.2], v * 2);
  const report = checkSkin({ weights });
  const negative = report.issues.find((issue) => issue.code === 'negative-weight');
  assert.equal(negative.count, 40);
  assert.equal(negative.vertices.length, 16);
  assert.throws(() => checkSkin({ weights: { joints: Uint16Array.of(0), weights: Float32Array.of(1, 0) } }), TypeError);
  assert.throws(() => checkSkin({ weights, maxInfluences: 0 }), RangeError);
});
