import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';
import { mlCases, mlModel, treeNodes, treeVotes, tensorAttribute } from './onnx-ml-cases.js';
test('ONNX tree and SVM analytic boundaries, labels, kernels, topology and resource ownership', async () =>
  assert.equal(await mlCases(), 52));
const replace = (attrs, name, value) => [...attrs.filter((a) => !new TextDecoder().decode(a).includes(name)), value];
test('ONNX trees reject malformed graphs and tuples with no retained run storage', async () => {
  const base = [...treeNodes(), ...treeVotes()];
  const bad = [
    replace(base, 'nodes_nodeids', p.intsAttr('nodes_nodeids', [0, 0, 2])),
    replace(base, 'nodes_truenodeids', p.intsAttr('nodes_truenodeids', [9, 0, 0])),
    replace(base, 'nodes_truenodeids', p.intsAttr('nodes_truenodeids', [0, 0, 0])),
    replace(base, 'nodes_featureids', p.intsAttr('nodes_featureids', [2, 0, 0])),
    replace(base, 'nodes_modes', p.stringsAttr('nodes_modes', ['INVALID', 'LEAF', 'LEAF'])),
    replace(base, 'target_ids', p.intsAttr('target_ids', [0, 1])),
    replace(base, 'target_nodeids', p.intsAttr('target_nodeids', [0, 2])),
    replace(base, 'nodes_missing_value_tracks_true', p.intsAttr('nodes_missing_value_tracks_true', [2, 0, 0])),
    replace(base, 'nodes_treeids', p.intsAttr('nodes_treeids', [0, 0])),
    [...base, tensorAttribute('nodes_values_as_tensor', 11, Float64Array.of(0, 0, 0))],
  ];
  for (const attrs of bad) {
    using m = await loadOnnx(mlModel('TreeEnsembleRegressor', attrs, [1, 1]));
    const baseline = m.work.liveBytes;
    await assert.rejects(m.run({ x: new OnnxTensor('float32', Float32Array.of(0), [1, 1]) }), /tree|attribute/i);
    assert.equal(m.work.liveBytes, baseline);
  }
});
test('ONNX SVM rejects inconsistent learned dimensions and calibration', async () => {
  const base = [
    p.intsAttr('classlabels_ints', [0, 1]),
    p.intsAttr('vectors_per_class', [1, 1]),
    p.floatsAttr('support_vectors', [-1, 1]),
    p.floatsAttr('coefficients', [1, -1]),
    p.floatsAttr('rho', [0]),
  ];
  const bad = [
    replace(base, 'coefficients', p.floatsAttr('coefficients', [1])),
    replace(base, 'vectors_per_class', p.intsAttr('vectors_per_class', [1, -1])),
    [...base, p.floatsAttr('prob_a', [1])],
    [...base, p.attr('kernel_type', 'INVALID')],
    [...base, p.floatsAttr('kernel_params', [1, 0])],
    [...base, p.floatsAttr('prob_a', [NaN]), p.floatsAttr('prob_b', [0])],
  ];
  for (const attrs of bad) {
    using m = await loadOnnx(mlModel('SVMClassifier', attrs, [1, 1]));
    const baseline = m.work.liveBytes;
    await assert.rejects(m.run({ x: new OnnxTensor('float32', Float32Array.of(0), [1, 1]) }), /SVM/);
    assert.equal(m.work.liveBytes, baseline);
  }
});

test('ONNX modern trees reject unreachable cycles before empty-batch execution', async () => {
  const attrs = [
    p.attr('n_targets', 1),
    p.intsAttr('nodes_featureids', [0, 0]),
    p.intsAttr('nodes_truenodeids', [0, 1]),
    p.intsAttr('nodes_falsenodeids', [0, 0]),
    p.intsAttr('nodes_trueleafs', [1, 0]),
    p.intsAttr('nodes_falseleafs', [1, 1]),
    tensorAttribute('nodes_modes', 2, Uint8Array.of(0, 0)),
    tensorAttribute('nodes_splits', 1, Float32Array.of(0, 0)),
    tensorAttribute('leaf_weights', 1, Float32Array.of(2)),
    p.intsAttr('leaf_targetids', [0]),
    p.intsAttr('tree_roots', [0]),
  ];
  using m = await loadOnnx(mlModel('TreeEnsemble', attrs, [0, 1], 1, 5));
  const baseline = m.work.liveBytes;
  await assert.rejects(m.run({ x: new OnnxTensor('float32', new Float32Array(), [0, 1]) }), /cycle/);
  assert.equal(m.work.liveBytes, baseline);
});
