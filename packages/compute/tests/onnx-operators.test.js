import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

const f = (values, shape = [values.length]) => new OnnxTensor('float64', Float64Array.from(values), shape);
const i = (values, shape = [values.length]) => new OnnxTensor('int64', BigInt64Array.from(values, BigInt), shape);
const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
async function run(op, values, attrs = [], outputs = 1, version = 28, domain = '') {
  const names = values.map((v, j) => (v === null ? '' : `x${j}`));
  const out = Array.from({ length: outputs }, (_, j) => `y${j}`);
  const info = (name) => p.field(1, name);
  const extra = domain ? [p.field(8, p.message(p.field(1, domain), p.field(2, version)))] : [];
  using model = await loadOnnx(
    p.model(
      p.graph([p.node(op, names, out, attrs, domain)], names.filter(Boolean).map(info), out.map(info)),
      version,
      extra,
    ),
  );
  const persistentBytes = model.work.liveBytes;
  const result = await model.run(Object.fromEntries(values.flatMap((v, j) => (v === null ? [] : [[names[j], v]]))));
  assert.equal(model.work.liveBytes, persistentBytes);
  return out.map((name) => result[name]);
}
function close(actual, expected, tolerance = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, j) => assert.ok(Math.abs(v - expected[j]) <= tolerance, `element ${j}: ${v} vs ${expected[j]}`));
}
test('ONNX Unique sorted and unsorted slices return stable first, inverse and count indices', async () => {
  let y = await run('Unique', [i([9, 2, 9, 7, 3, 7], [2, 3])], [p.attr('axis', 1), p.attr('sorted', 0)], 4);
  assert.deepEqual(
    y.map((t) => [...t.data]),
    [
      [9n, 2n, 7n, 3n],
      [0n, 1n],
      [0n, 1n, 0n],
      [2n, 1n],
    ],
  );
  assert.deepEqual(y[0].shape, [2, 2]);
  y = await run('Unique', [i([9, 2, 9, 3])], [], 4);
  assert.deepEqual(
    y.map((t) => [...t.data]),
    [
      [2n, 3n, 9n],
      [1n, 3n, 0n],
      [2n, 0n, 2n, 1n],
      [1n, 1n, 2n],
    ],
  );
  y = await run('Unique', [new OnnxTensor('string', ['z', 'é', 'a', 'z'], [4])], [], 4);
  assert.deepEqual(y[0].data, ['a', 'z', 'é']);
  y = await run('Unique', [f([], [2, 0])], [p.attr('axis', 0)], 4);
  assert.deepEqual(y[0].shape, [1, 0]);
  assert.deepEqual([...y[3].data], [2n]);
});
test('ONNX reverse sequences and asymmetric centered crop and pad preserve raw int64 elements', async () => {
  const [reverse] = await run(
    'ReverseSequence',
    [i([0, 1, 2, 3, 4, 5, 6, 7], [2, 4]), i([3, 2])],
    [p.attr('batch_axis', 0), p.attr('time_axis', 1)],
  );
  assert.deepEqual([...reverse.data], [2n, 1n, 0n, 3n, 5n, 4n, 6n, 7n]);
  const [crop] = await run('CenterCropPad', [i([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [2, 5]), i([1, 8])]);
  assert.deepEqual(crop.shape, [1, 8]);
  assert.deepEqual([...crop.data], [0n, 0n, 1n, 2n, 3n, 4n, 0n, 0n]);
  await assert.rejects(
    run('ReverseSequence', [i([1, 2], [1, 2]), i([3])], [p.attr('batch_axis', 0), p.attr('time_axis', 1)]),
    /length/,
  );
});
test('ONNX Det, CumProd variants, bit reinterpretation and added activations follow analytic results', async () => {
  const [det] = await run('Det', [f([0, 2, 3, 4, 2, 0, 0, 5], [2, 2, 2])]);
  assert.deepEqual([...det.data], [-6, 10]);
  const [scan] = await run('CumProd', [i([2, 3, 5]), i([0], [])], [p.attr('exclusive', 1), p.attr('reverse', 1)]);
  assert.deepEqual([...scan.data], [15n, 5n, 1n]);
  const [bits] = await run('BitCast', [f32([1, -0, Infinity])], [p.attr('to', 6)]);
  assert.deepEqual([...bits.data], [1065353216, -2147483648, 2139095040]);
  const [celu] = await run('Celu', [f([-2, 0, 2])], [p.floatAttr('alpha', 2)]);
  close([...celu.data], [2 * Math.expm1(-1), 0, 2]);
  const [swish] = await run('SwiGLU', [f([-1, 0, 1]), f([2, 3, 4])]);
  close([...swish.data], [-2 / (1 + Math.E), 0, 4 / (1 + Math.exp(-1))]);
  const [shrink] = await run(
    'Shrink',
    [i([-3, -1, 0, 2, 9007199254740993n])],
    [p.floatAttr('lambd', 1), p.floatAttr('bias', 1)],
  );
  assert.deepEqual([...shrink.data], [-2n, 0n, 0n, 1n, 9007199254740992n]);
});
test('ONNX NMS preserves ties and strict IoU equality, reversed corners and class indices', async () => {
  const boxes = f32([0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 2], [1, 3, 4]);
  const scores = f32([0.9, 0.9, 0.7, 0.1, 0.2, 0.8], [1, 2, 3]);
  let [out] = await run('NonMaxSuppression', [boxes, scores, i([3], []), f32([0], [])]);
  assert.deepEqual([...out.data], [0n, 0n, 0n, 0n, 0n, 2n, 0n, 1n, 2n, 0n, 1n, 1n]);
  [out] = await run('NonMaxSuppression', [boxes, scores, i([3], []), f32([1], [])]);
  assert.equal(out.shape[0], 6);
  [out] = await run('NonMaxSuppression', [boxes, scores]);
  assert.deepEqual(out.shape, [0, 3]);
});
test('ONNX affine/grid sampling handles exact corners, nonaligned identity, nearest ties and reflection', async () => {
  const [grid] = await run('AffineGrid', [f([1, 0, 0, 0, 1, 0], [1, 2, 3]), i([1, 1, 2, 3])]);
  close([...grid.data], [-2 / 3, -0.5, 0, -0.5, 2 / 3, -0.5, -2 / 3, 0.5, 0, 0.5, 2 / 3, 0.5]);
  const image = f([1, 2, 3, 4, 5, 6], [1, 1, 2, 3]);
  const [identity] = await run('GridSample', [image, grid]);
  close([...identity.data], [1, 2, 3, 4, 5, 6]);
  const [corners] = await run(
    'GridSample',
    [image, f([-1, -1, 1, 1, 0, 0], [1, 1, 3, 2])],
    [p.attr('align_corners', 1)],
  );
  close([...corners.data], [1, 6, 3.5]);
  const [ties] = await run(
    'GridSample',
    [i([9007199254740993n, 7, 9], [1, 1, 3]), f([-0.5, 0.5], [1, 2, 1])],
    [p.attr('align_corners', 1), p.attr('mode', 'nearest')],
  );
  assert.deepEqual([...ties.data], [9007199254740993n, 9n]);
  const [reflection] = await run(
    'GridSample',
    [f([1, 2, 3], [1, 1, 3]), f([-2, 2], [1, 2, 1])],
    [p.attr('align_corners', 1), p.attr('padding_mode', 'reflection')],
  );
  close([...reflection.data], [2, 2]);
});
test('ONNX ROI align, max ROI pool and overlapping column folding retain full sampled work', async () => {
  const image = f([0, 1, 2, 3, 4, 5, 6, 7, 8], [1, 1, 3, 3]);
  const [align] = await run(
    'RoiAlign',
    [image, f([0, 0, 2, 2], [1, 4]), i([0])],
    [
      p.attr('output_height', 2),
      p.attr('output_width', 2),
      p.attr('sampling_ratio', 2),
      p.attr('coordinate_transformation_mode', 'output_half_pixel'),
    ],
  );
  close([...align.data], [2, 3, 5, 6]);
  const [max] = await run(
    'RoiAlign',
    [image, f([0, 0, 2, 2], [1, 4]), i([0])],
    [
      p.attr('mode', 'max'),
      p.attr('output_height', 2),
      p.attr('output_width', 2),
      p.attr('sampling_ratio', 2),
      p.attr('coordinate_transformation_mode', 'output_half_pixel'),
    ],
  );
  close([...max.data], [2.25, 2.8125, 3.9375, 4.5]);
  const [pool] = await run('MaxRoiPool', [image, f([0, 0, 0, 2, 2], [1, 5])], [p.intsAttr('pooled_shape', [2, 2])]);
  assert.deepEqual([...pool.data], [4, 5, 7, 8]);
  const [fold] = await run('Col2Im', [i(Array(16).fill(1), [1, 4, 4]), i([3, 3]), i([2, 2])]);
  assert.deepEqual(fold.shape, [1, 1, 3, 3]);
  assert.deepEqual([...fold.data], [1n, 2n, 1n, 2n, 4n, 2n, 1n, 2n, 1n]);
});
test('ONNX weighted cross entropy is stable with large logits, class axis and ignored targets', async () => {
  const [loss, log] = await run(
    'SoftmaxCrossEntropyLoss',
    [f([10000, 10002, 10001, 10000], [2, 2]), i([1, -1]), f([1, 3])],
    [p.attr('ignore_index', -1)],
    2,
  );
  close([...loss.data], [Math.log1p(Math.exp(-2))]);
  close(
    [...log.data],
    [
      -2 - Math.log1p(Math.exp(-2)),
      -Math.log1p(Math.exp(-2)),
      -Math.log1p(Math.exp(-1)),
      -1 - Math.log1p(Math.exp(-1)),
    ],
  );
  const [nll] = await run(
    'NegativeLogLikelihoodLoss',
    [f([-1, -2, -3, -4], [1, 2, 2]), i([0, 1], [1, 2])],
    [p.attr('reduction', 'none')],
  );
  assert.deepEqual([...nll.data], [1, 4]);
});
test('ONNX DFT handles prime lengths, arbitrary axes, real inverse, padding and explicit lengths', async () => {
  const [spectrum] = await run('DFT', [f([1, 2, 3, 4, 5], [5, 1])], [p.attr('onesided', 1)]);
  assert.deepEqual(spectrum.shape, [3, 2]);
  const expected = [];
  for (let k = 0; k < 3; k++) {
    let re = 0,
      im = 0;
    for (let j = 0; j < 5; j++) {
      re += (j + 1) * Math.cos((-2 * Math.PI * j * k) / 5);
      im += (j + 1) * Math.sin((-2 * Math.PI * j * k) / 5);
    }
    expected.push(re, im);
  }
  close([...spectrum.data], expected);
  const [inverse] = await run('DFT', [spectrum, i([5], [])], [p.attr('onesided', 1), p.attr('inverse', 1)]);
  close([...inverse.data], [1, 2, 3, 4, 5]);
  const [axes] = await run('DFT', [f([1, 10, 2, 20, 3, 30], [3, 2, 1]), i([4], []), i([0], [])]);
  assert.deepEqual(axes.shape, [4, 2, 2]);
  close([...axes.data], [6, 0, 60, 0, -2, -2, -20, -20, 2, 0, 20, 0, -2, 2, -20, 20]);
  const [old] = await run('DFT', [f([1, 2, 3], [1, 3, 1])], [p.attr('axis', 1)], 1, 17);
  close([...old.data], [6, 0, -1.5, Math.sqrt(3) / 2, -1.5, -Math.sqrt(3) / 2]);
});
test('ONNX STFT windows frames and mel matrix follow independent frequency formulas', async () => {
  const [stft] = await run('STFT', [f([1, 2, 3, 4, 5, 6], [1, 6, 1]), i([2], []), f([1, 1, 1, 1])]);
  assert.deepEqual(stft.shape, [1, 2, 3, 2]);
  close([...stft.data], [10, 0, -2, 2, -2, 0, 18, 0, -2, 2, -2, 0]);
  const [hann] = await run('HannWindow', [i([4], [])], [p.attr('output_datatype', 11)]);
  close([...hann.data], [0, 0.5, 1, 0.5]);
  const [symmetric] = await run('HannWindow', [i([5], [])], [p.attr('periodic', 0), p.attr('output_datatype', 11)]);
  close([...symmetric.data], [0, 0.5, 1, 0.5, 0]);
  const [mel] = await run(
    'MelWeightMatrix',
    [i([2], []), i([8], []), i([8000], []), f([0], []), f([4000], [])],
    [p.attr('output_datatype', 11)],
  );
  assert.deepEqual([...mel.data], [1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const [wide] = await run(
    'MelWeightMatrix',
    [i([2], []), i([64], []), i([8000], []), f([0], []), f([4000], [])],
    [p.attr('output_datatype', 11)],
  );
  const points = [0, 3, 9, 18];
  const expected = Array(66).fill(0);
  for (let col = 0; col < 2; col++)
    for (let row = points[col]; row < points[col + 2]; row++)
      expected[row * 2 + col] =
        row <= points[col + 1]
          ? (row - points[col]) / (points[col + 1] - points[col])
          : (points[col + 2] - row) / (points[col + 2] - points[col + 1]);
  close([...wide.data], expected);
});
test('ONNX UTF-8 concat broadcasts, and split handles empty strings, whitespace, suffixes and padded rows', async () => {
  const [concat] = await run('StringConcat', [
    new OnnxTensor('string', ['é', '猫'], [2, 1]),
    new OnnxTensor('string', ['!', '?'], [2]),
  ]);
  assert.deepEqual(concat.shape, [2, 2]);
  assert.deepEqual(concat.data, ['é!', 'é?', '猫!', '猫?']);
  let [split, n] = await run(
    'StringSplit',
    [new OnnxTensor('string', ['a,,b', 'é', ''], [3])],
    [p.attr('delimiter', ',')],
    2,
  );
  assert.deepEqual(split.shape, [3, 3]);
  assert.deepEqual(split.data, ['a', '', 'b', 'é', '', '', '', '', '']);
  assert.deepEqual([...n.data], [3n, 1n, 1n]);
  [split, n] = await run(
    'StringSplit',
    [new OnnxTensor('string', ['  one  two  three  ', '  '], [2])],
    [p.attr('maxsplit', 1)],
    2,
  );
  assert.deepEqual(split.data, ['one', 'two  three', '', '']);
  assert.deepEqual([...n.data], [2n, 0n]);
  [split, n] = await run('StringSplit', [new OnnxTensor('string', [], [0, 2])], [], 2);
  assert.deepEqual(split.shape, [0, 2]);
  assert.deepEqual(n.shape, [0, 2]);
});
const ml = (op, values, attrs = [], outputs = 1, version = 5) => run(op, values, attrs, outputs, version, 'ai.onnx.ml');
test('ONNX linear ML inference supports multiple targets, exact class labels and all score transforms', async () => {
  const x = f32([0, 1, -1, 2, 0.2, 0.7], [3, 2]);
  const attrs = [
    p.floatsAttr('coefficients', [1, 0, 0, 1]),
    p.floatsAttr('intercepts', [0, 0]),
    p.intsAttr('classlabels_ints', [9007199254740993n, 7]),
  ];
  const [labels, scores] = await ml('LinearClassifier', [x], attrs, 2);
  assert.deepEqual([...labels.data], [7n, 7n, 7n]);
  assert.deepEqual([...scores.data], [0, 1, -1, 2, Math.fround(0.2), Math.fround(0.7)]);
  const [, prob] = await ml('LinearClassifier', [x], [...attrs, p.attr('post_transform', 'SOFTMAX')], 2);
  close(
    [...prob.data],
    [
      1 / (1 + Math.E),
      1 - 1 / (1 + Math.E),
      1 / (1 + Math.exp(3)),
      1 - 1 / (1 + Math.exp(3)),
      1 / (1 + Math.exp(0.5)),
      1 - 1 / (1 + Math.exp(0.5)),
    ],
    4e-8,
  );
  const [reg] = await ml(
    'LinearRegressor',
    [x],
    [p.floatsAttr('coefficients', [2, 3]), p.floatsAttr('intercepts', [4])],
  );
  close([...reg.data], [7, 8, 6.5], 1e-6);
  const [singleLogistic] = await ml(
    'LinearRegressor',
    [f32([0, 1, -1])],
    [p.floatsAttr('coefficients', [1, 1, 1]), p.attr('post_transform', 'LOGISTIC')],
  );
  assert.deepEqual([...singleLogistic.data], [0.5]);
  const [quantile] = await ml(
    'LinearRegressor',
    [f32([0.2, 0.7], [1, 2])],
    [p.floatsAttr('coefficients', [1, 0, 0, 1]), p.attr('targets', 2), p.attr('post_transform', 'PROBIT')],
  );
  close([...quantile.data], [-0.8416212229273963, 0.5244004726409912], 1e-7);
  const [zero] = await ml(
    'LinearRegressor',
    [f32([0, 1], [1, 2])],
    [p.floatsAttr('coefficients', [1, 0, 0, 1]), p.attr('targets', 2), p.attr('post_transform', 'SOFTMAX_ZERO')],
  );
  assert.deepEqual([...zero.data], [0, 1]);
});
test('ONNX ML extraction, feature padding and one-hot category lookup preserve schema layouts', async () => {
  const [extract] = await ml('ArrayFeatureExtractor', [i([9007199254740993n, 2, 3]), i([2, 0])]);
  assert.deepEqual(extract.shape, [1, 2]);
  assert.deepEqual([...extract.data], [3n, 9007199254740993n]);
  const [vector] = await ml(
    'FeatureVectorizer',
    [f([2, 3], [1, 2]), f([7], [1, 1])],
    [p.intsAttr('inputdimensions', [3, 2])],
  );
  assert.deepEqual(vector.shape, [1, 5]);
  assert.deepEqual([...vector.data], [2, 3, 0, 7, 0]);
  const [hot] = await ml('OneHotEncoder', [f([2.9, 99, -1])], [p.intsAttr('cats_int64s', [-1, 2])]);
  assert.deepEqual(hot.shape, [3, 2]);
  assert.deepEqual([...hot.data], [0, 1, 0, 0, 1, 0]);
  await assert.rejects(ml('OneHotEncoder', [i([3])], [p.intsAttr('cats_int64s', [1]), p.attr('zeros', 0)]), /absent/);
});
test('ONNX ML threshold, scaler, zero normalization and typed imputation use exact values', async () => {
  const [binary] = await ml(
    'Binarizer',
    [i([9007199254740992n, 9007199254740993n])],
    [p.floatAttr('threshold', 9007199254740992)],
  );
  assert.deepEqual([...binary.data], [0n, 1n]);
  const [scaled] = await ml(
    'Scaler',
    [i([1, 2, 3, 4], [2, 2])],
    [p.floatsAttr('offset', [1, 2]), p.floatsAttr('scale', [2, 3])],
  );
  assert.deepEqual([...scaled.data], [0, 0, 4, 6]);
  const [norm] = await ml('Normalizer', [f([3, 4, 0, 0], [2, 2])], [p.attr('norm', 'L2')]);
  close([...norm.data], [0.6, 0.8, 0, 0], 3e-8);
  const [impute] = await ml(
    'Imputer',
    [f([NaN, 2, 4, NaN], [2, 2])],
    [p.floatAttr('replaced_value_float', NaN), p.floatsAttr('imputed_value_floats', [7, 8])],
  );
  assert.deepEqual([...impute.data], [7, 2, 4, 8]);
  const [exact] = await ml(
    'Imputer',
    [i([-1, 9007199254740993n])],
    [p.attr('replaced_value_int64', -1), p.intsAttr('imputed_value_int64s', [9007199254740995n])],
  );
  assert.deepEqual([...exact.data], [9007199254740995n, 9007199254740993n]);
});
test('ONNX ML categories and all label-encoding versions preserve exact64, duplicate keys and NaNs', async () => {
  const [category] = await ml(
    'CategoryMapper',
    [new OnnxTensor('string', ['猫', 'dog', 'none'], [3])],
    [p.stringsAttr('cats_strings', ['猫', 'dog']), p.intsAttr('cats_int64s', [9007199254740993n, 4])],
  );
  assert.deepEqual([...category.data], [9007199254740993n, 4n, -1n]);
  const [labels] = await ml(
    'LabelEncoder',
    [f32([NaN, 1, 3])],
    [p.floatsAttr('keys_floats', [NaN, 1, 1]), p.intsAttr('values_int64s', [5, 6, 9007199254740993n])],
  );
  assert.deepEqual([...labels.data], [5n, 9007199254740993n, -1n]);
  const [old] = await ml('LabelEncoder', [i([0, 1, 2])], [p.stringsAttr('classes_strings', ['a', 'b'])], 1, 1);
  assert.deepEqual(old.data, ['a', 'b', '_Unused']);
  const keys = p.message(
    p.field(1, 'keys_tensor'),
    p.field(20, 4),
    p.field(5, p.tensor('', 11, [2], Float64Array.of(1, 2))),
  );
  const vals = p.message(
    p.field(1, 'values_tensor'),
    p.field(20, 4),
    p.field(5, p.tensor('', 7, [2], BigInt64Array.of(9007199254740993n, 7n))),
  );
  const [typed] = await ml('LabelEncoder', [f([2, 1, 3])], [keys, vals]);
  assert.deepEqual([...typed.data], [7n, 9007199254740993n, -1n]);
  await assert.rejects(ml('Binarizer', [i([1])], [p.attr('ignored', 1)]), /unknown/);
});
test('ONNX ML map operators retain integer keys and typed values without transient leaks', async () => {
  const [zipped] = await ml(
    'ZipMap',
    [f32([0.25, 0.75, 0.8, 0.2], [2, 2])],
    [p.intsAttr('classlabels_int64s', [9007199254740993n, 9])],
  );
  assert.deepEqual([...zipped[0].keys()], [9007199254740993n, 9n]);
  assert.equal(zipped[1].get(9n).data[0], Math.fround(0.2));
  const map = new Map([
    ['猫', f([4], [])],
    ['a', f([8], [])],
  ]);
  const [dict] = await ml('DictVectorizer', [map], [p.stringsAttr('string_vocabulary', ['a', 'missing', '猫'])]);
  assert.deepEqual(dict.shape, [1, 3]);
  assert.deepEqual([...dict.data], [8, 0, 4]);
  const [cast] = await ml(
    'CastMap',
    [
      new Map([
        [2n, new OnnxTensor('string', ['9007199254740993'], [])],
        [0n, new OnnxTensor('string', ['7'], [])],
      ]),
    ],
    [p.attr('cast_to', 'TO_INT64'), p.attr('map_form', 'SPARSE'), p.attr('max_map', 4)],
  );
  assert.deepEqual([...cast.data], [7n, 0n, 9007199254740993n, 0n]);
  await assert.rejects(ml('CastMap', [new Map([[0.5, f([1], [])]])]), /safe integer/);
  await assert.rejects(
    ml('CastMap', [
      new Map([
        [1, f([1], [])],
        [1n, f([2], [])],
      ]),
    ]),
    /duplicate integer/,
  );
});
test('ONNX locale-aware string normalization and SequenceMap apply the whole lexical body', async () => {
  const [normalized] = await run(
    'StringNormalizer',
    [new OnnxTensor('string', ['I', 'İ', 'STOP', 'keep'], [1, 4])],
    [p.attr('case_change_action', 'LOWER'), p.attr('locale', 'tr_TR'), p.stringsAttr('stopwords', ['stop'])],
  );
  assert.deepEqual(normalized.shape, [1, 3]);
  assert.deepEqual(normalized.data, ['ı', 'i', 'keep']);
  const body = p.graph(
    [p.node('Add', ['item', 'offset'], ['sum']), p.node('Mul', ['sum', 'sum'], ['squared'])],
    [p.field(1, 'item'), p.field(1, 'offset')],
    [p.field(1, 'squared')],
  );
  const [mapped] = await run(
    'SequenceMap',
    [[i([1]), i([2, 3])], i([4], [])],
    [p.message(p.field(1, 'body'), p.field(20, 5), p.field(6, body))],
  );
  assert.deepEqual(
    mapped.map((t) => [...t.data]),
    [[25n], [36n, 49n]],
  );
});

test('ONNX BitCast preserves noncanonical bool bits in graphs and canonicalizes host truth values', async () => {
  const node = [
    p.node('BitCast', ['x'], ['boolean'], [p.attr('to', 9)]),
    p.node('BitCast', ['boolean'], ['back'], [p.attr('to', 2)]),
  ];
  using model = await loadOnnx(
    p.model(
      p.graph(node, [p.valueInfo('x', 2, [3])], [p.valueInfo('boolean', 9, [3]), p.valueInfo('back', 2, [3])]),
      26,
    ),
  );
  const out = await model.run({ x: new OnnxTensor('uint8', Uint8Array.of(0, 1, 255), [3]) });
  assert.deepEqual([...out.boolean.data], [0, 1, 1]);
  assert.deepEqual([...out.back.data], [0, 1, 255]);
  assert.equal(model.work.liveBytes, 0);
});

test('ONNX zero-width column folding and feature batches never traverse empty metadata rows', async () => {
  const [fold] = await run('Col2Im', [f32([], [1000000000, 0, 0]), i([0, 3]), i([2, 2])]);
  assert.deepEqual(fold.shape, [1000000000, 0, 0, 3]);
  assert.equal(fold.data.length, 0);
  const [vector] = await ml('FeatureVectorizer', [f32([], [1000000000, 0])], [p.intsAttr('inputdimensions', [0])]);
  assert.deepEqual(vector.shape, [1000000000, 0]);
  assert.equal(vector.data.length, 0);
});
test('ONNX map declarations type empty dictionaries and enforce integer-key widths', async () => {
  const scalarType = p.field(1, p.field(1, 11));
  const inputInfo = (kind) =>
    p.message(p.field(1, 'x'), p.field(2, p.field(5, p.message(p.field(1, kind), p.field(2, scalarType)))));
  const bytes = p.model(
    p.graph(
      [p.node('DictVectorizer', ['x'], ['y'], [p.stringsAttr('string_vocabulary', ['a', 'b'])], 'ai.onnx.ml')],
      [inputInfo(8)],
      [p.valueInfo('y', 11, [1, 2])],
    ),
    18,
    [p.field(8, p.message(p.field(1, 'ai.onnx.ml'), p.field(2, 4)))],
  );
  using model = await loadOnnx(bytes);
  assert.deepEqual([...(await model.run({ x: new Map() })).y.data], [0, 0]);
  const identity = p.model(p.graph([p.node('Identity', ['x'], ['y'])], [inputInfo(7)], [p.field(1, 'y')]));
  using exact = await loadOnnx(identity);
  await assert.rejects(exact.run({ x: new Map([[1n << 63n, f([1], [])]]) }), /declared integer dtype/);
  assert.equal(exact.work.liveBytes, 0);
});
