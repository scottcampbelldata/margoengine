// ai.onnx.ml review (docs/onnx-conformance.md): calibrated SVMClassifier scores at extreme margins, and classifiers
// that store one score for two classes. Operators: https://onnx.ai/onnx/operators/ (domain ai.onnx.ml).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

const info = (name) => p.field(1, name);
const x = new OnnxTensor('float32', Float32Array.of(0), [1, 1]);

async function classify(op, attrs) {
  using model = await loadOnnx(
    p.model(
      p.graph(
        [p.node(op, ['x'], ['label', 'score'], attrs, 'ai.onnx.ml')],
        [info('x')],
        [info('label'), info('score')],
      ),
      18,
      [p.field(8, p.message(p.field(1, 'ai.onnx.ml'), p.field(2, 3)))],
    ),
  );
  const result = await model.run({ x });
  return { label: Array.from(result.label.data, Number), score: [...result.score.data] };
}

/** Zero support weights make each pair's margin its rho; prob_a=1, prob_b=0 give the pair probability 1/(1+e^rho). */
function svm(classes, margins) {
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  return classify('SVMClassifier', [
    p.intsAttr('classlabels_ints', range(classes)),
    p.intsAttr('vectors_per_class', Array(classes).fill(1)),
    p.floatsAttr('support_vectors', Array(classes).fill(0)),
    p.floatsAttr('coefficients', Array((classes - 1) * classes).fill(0)),
    p.floatsAttr('rho', margins),
    p.floatsAttr(
      'prob_a',
      margins.map(() => 1),
    ),
    p.floatsAttr(
      'prob_b',
      margins.map(() => 0),
    ),
  ]);
}

function distribution(score, what) {
  assert.ok(
    score.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
    `${what}: ${score}`,
  );
  assert.ok(Math.abs(score.reduce((a, b) => a + b, 0) - 1) < 1e-5, `${what}: ${score}`);
}

test('two calibrated classes saturate at the 1e-7 pair clamp without losing normalisation', async () => {
  for (const margin of [-3e38, -1000, -20, 0, 20, 1000, 3e38]) {
    const { score } = await svm(2, [margin]);
    distribution(score, margin);
    const pair = Math.min(1 - 1e-7, Math.max(1e-7, 1 / (1 + Math.exp(margin))));
    // The coupling stops at a residual below 0.005 / classes.
    assert.ok(Math.abs(score[0] - pair) < 0.005, `${margin}: ${score}`);
  }
});

test('coupling converges for saturated, contradicting and mixed pair probabilities', async () => {
  let seed = 7;
  const random = (n) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const levels = [-1000, -16, -2, 0, 2, 16, 1000];
  for (const classes of [3, 4, 5, 8, 16]) {
    const pairs = (classes * (classes - 1)) / 2;
    for (let trial = 0; trial < 60; trial++) {
      // The first trials draw saturated pairs only, which contradict each other most.
      const margins = Array.from({ length: pairs }, () => (trial < 30 ? [-1000, 1000][random(2)] : levels[random(7)]));
      distribution((await svm(classes, margins)).score, `${classes} classes ${margins}`);
    }
  }
});

test('a class that beats every other one takes the probability', async () => {
  for (const classes of [3, 8]) {
    const pairs = [];
    for (let i = 0; i < classes; i++) for (let j = i + 1; j < classes; j++) pairs.push(i === 0 ? -1000 : 0);
    const { score } = await svm(classes, pairs);
    assert.ok(score[0] > 0.99, `${score}`);
  }
});

test('a margin that is not a number is refused, never returned as a score', async () => {
  await assert.rejects(svm(2, [Number.NaN]), /finite|converge/);
});

const labels = [p.intsAttr('classlabels_ints', [4, 9])];
const linear = (margin, attrs = []) =>
  classify('LinearClassifier', [
    ...labels,
    p.floatsAttr('coefficients', [0]),
    p.floatsAttr('intercepts', [margin]),
    ...attrs,
  ]);

test('LinearClassifier expands one stored score to two classes', async () => {
  assert.deepEqual(await linear(2), { label: [9], score: [-1, 2] });
  assert.deepEqual(await linear(0), { label: [4], score: [1, 0] });
  assert.deepEqual(await linear(2, [p.attr('multi_class', 1)]), { label: [9], score: [-2, 2] });
  for (const [margin, expected] of [
    [1000, [0, 1]],
    [-1000, [1, 0]],
  ])
    assert.deepEqual((await linear(margin, [p.attr('post_transform', 'LOGISTIC')])).score, expected);
});

test('TreeEnsembleClassifier expands one weighted class to two, by the sign of its weights', async () => {
  const stump = (weight, extra = []) =>
    classify('TreeEnsembleClassifier', [
      p.intsAttr('classlabels_int64s', [4, 9]),
      p.intsAttr('nodes_treeids', [0]),
      p.intsAttr('nodes_nodeids', [0]),
      p.intsAttr('nodes_featureids', [0]),
      p.stringsAttr('nodes_modes', ['LEAF']),
      p.floatsAttr('nodes_values', [0]),
      p.intsAttr('nodes_truenodeids', [0]),
      p.intsAttr('nodes_falsenodeids', [0]),
      p.intsAttr('class_treeids', [0]),
      p.intsAttr('class_nodeids', [0]),
      p.intsAttr('class_ids', [0]),
      p.floatsAttr('class_weights', [weight]),
      ...extra,
    ]);
  // Weights of one sign only are read as a probability of the second class, split at 0.5.
  assert.deepEqual(await stump(0.75), { label: [9], score: [0.25, 0.75] });
  assert.deepEqual(await stump(0.25), { label: [4], score: [0.75, 0.25] });
  // A negative weight makes it a margin, split at 0.
  assert.deepEqual(await stump(-2), { label: [4], score: [2, -2] });
  // One base value joins the margin; the pair of two base values joins the expanded scores.
  assert.deepEqual(await stump(-2, [p.floatsAttr('base_values', [3])]), { label: [9], score: [-1, 1] });
  assert.deepEqual(await stump(-2, [p.floatsAttr('base_values', [1, -4])]), { label: [4], score: [3, -6] });
  const logistic = await stump(-1000, [p.attr('post_transform', 'LOGISTIC')]);
  assert.deepEqual(logistic.score, [1, 0]);
});
