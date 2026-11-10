import fs from 'node:fs';
import * as p from '../tests/onnx-fixtures.js';
const cases = [];
const t = (kind, shape, data) => ({ kind, shape, data });
const f = (data, shape = [data.length]) => t(1, shape, data);
const d = (data, shape = [data.length]) => t(11, shape, data);
const i = (data, shape = [data.length]) => t(7, shape, data);
const str = (data, shape = [data.length]) => t(8, shape, data);
function add(op, inputs, attrs = [], nout = 1, version = 18, domain = '') {
  const id = `${op}-${cases.filter((c) => c.op === op).length}`;
  const names = inputs.map((v, j) => (v === null ? '' : `x${j}`));
  const outputs = Array.from({ length: nout }, (_, j) => `y${j}`);
  const model = p.model(
    p.graph(
      [p.node(op, names, outputs, attrs, domain)],
      inputs.flatMap((v, j) => (v === null ? [] : [p.valueInfo(names[j], v.kind, v.shape)])),
      outputs.map((name) => p.field(1, name)),
    ),
    version,
    domain ? [p.field(8, p.message(p.field(1, domain), p.field(2, version)))] : [],
  );
  cases.push({
    id,
    op,
    version,
    domain,
    model: Buffer.from(model).toString('base64'),
    feeds: Object.fromEntries(inputs.flatMap((v, j) => (v === null ? [] : [[names[j], v]]))),
  });
}
for (const op of ['Celu', 'Shrink', 'Swish']) add(op, [f([-3, -1, 0, 1, 3])], [], 1, op === 'Swish' ? 24 : 18);
for (const sorted of [0, 1])
  for (const a of [undefined, 0, 1])
    add(
      'Unique',
      [i([9, 2, 9, 3, 4, 3], [2, 3])],
      [p.attr('sorted', sorted), ...(a === undefined ? [] : [p.attr('axis', a)])],
      4,
    );
add(
  'ReverseSequence',
  [i([0, 1, 2, 3, 4, 5, 6, 7], [2, 4]), i([3, 2])],
  [p.attr('batch_axis', 0), p.attr('time_axis', 1)],
);
add('CenterCropPad', [f([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [2, 5]), i([1, 8])]);
add('Det', [d([0, 2, 3, 4, 1, 2, 2, 4], [2, 2, 2])]);
for (const op of [
  'ReduceSum',
  'ReduceMean',
  'ReduceL1',
  'ReduceL2',
  'ReduceLogSum',
  'ReduceLogSumExp',
  'ReduceSumSquare',
  'ReduceMin',
  'ReduceMax',
  'ReduceProd',
])
  for (const kind of [1, 7]) add(op, [t(kind, [2, 3], [1, 2, 3, 4, 5, 6]), i([1])], [p.attr('keepdims', 0)], 1);
for (const exclusive of [0, 1])
  for (const reverse of [0, 1])
    add('CumSum', [i([2, 3, 5]), i([0], [])], [p.attr('exclusive', exclusive), p.attr('reverse', reverse)]);
add('DFT', [d([1, 2, 3, 4, 5], [1, 5, 1])], [p.attr('axis', 1)], 1, 17);
add('STFT', [f([1, 2, 3, 4, 5, 6], [1, 6, 1]), i([2], []), f([1, 1, 1, 1])]);
for (const op of ['HannWindow', 'HammingWindow', 'BlackmanWindow'])
  for (const periodic of [0, 1]) add(op, [i([5], [])], [p.attr('periodic', periodic), p.attr('output_datatype', 11)]);
add(
  'MelWeightMatrix',
  [i([2], []), i([8], []), i([8000], []), f([0], []), f([4000], [])],
  [p.attr('output_datatype', 11)],
);
for (const align of [0, 1])
  for (const padding of ['zeros', 'border', 'reflection'])
    for (const mode of ['bilinear', 'bicubic', 'nearest'])
      add(
        'GridSample',
        [f([1, 2, 3, 4, 5, 6], [1, 1, 2, 3]), f([-2, -1, -1, -0.5, 0, 0, 0.5, 0.5, 1, 1, 2, 3], [1, 2, 3, 2])],
        [p.attr('align_corners', align), p.attr('mode', mode), p.attr('padding_mode', padding)],
      );
for (const mode of ['avg', 'max'])
  for (const transform of ['half_pixel', 'output_half_pixel'])
    add(
      'RoiAlign',
      [f([0, 1, 2, 3, 4, 5, 6, 7, 8], [1, 1, 3, 3]), f([-1, -1, 2, 2, 0, 0, 2, 2], [2, 4]), i([0, 0])],
      [
        p.attr('mode', mode),
        p.attr('coordinate_transformation_mode', transform),
        p.attr('sampling_ratio', 2),
        p.attr('output_height', 2),
        p.attr('output_width', 2),
      ],
    );
add(
  'MaxRoiPool',
  [f([0, 1, 2, 3, 4, 5, 6, 7, 8], [1, 1, 3, 3]), f([0, 0, 0, 2, 2], [1, 5])],
  [p.intsAttr('pooled_shape', [2, 2])],
);
add('Col2Im', [f(Array(16).fill(1), [1, 4, 4]), i([3, 3]), i([2, 2])]);
add('NonMaxSuppression', [
  f([0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 2], [1, 3, 4]),
  f([0.9, 0.9, 0.7], [1, 1, 3]),
  i([3], []),
  f([0], []),
]);
for (const reduction of ['none', 'sum', 'mean'])
  for (const op of ['NegativeLogLikelihoodLoss', 'SoftmaxCrossEntropyLoss'])
    add(
      op,
      [f([10000, 10002, 10001, 10000], [2, 2]), i([1, -1]), f([1, 3])],
      [p.attr('ignore_index', -1), p.attr('reduction', reduction)],
      op === 'SoftmaxCrossEntropyLoss' ? 2 : 1,
    );
add('StringConcat', [str(['\u732b', '\u00e9'], [2, 1]), str(['!', '?'])], [], 1, 20);
for (const attrs of [[], [p.attr('maxsplit', 1)], [p.attr('delimiter', ',')]])
  add('StringSplit', [str(['  one  two  gamma  ', 'a,,b', '  '])], attrs, 2, 20);
const ml = (op, inputs, attrs = [], nout = 1) => add(op, inputs, attrs, nout, 4, 'ai.onnx.ml');
ml('Binarizer', [i(['9007199254740992', '9007199254740993'])], [p.floatAttr('threshold', 9007199254740992)]);
ml('Scaler', [i([1, 2, 3, 4], [2, 2])], [p.floatsAttr('offset', [1, 2]), p.floatsAttr('scale', [2, 3])]);
for (const norm of ['L1', 'L2', 'MAX']) ml('Normalizer', [d([-3, -4, 0, 0], [2, 2])], [p.attr('norm', norm)]);
ml('OneHotEncoder', [f([2.9, 99, -1])], [p.intsAttr('cats_int64s', [-1, 2])]);
ml('FeatureVectorizer', [f([2, 3], [1, 2]), f([7], [1, 1])], [p.intsAttr('inputdimensions', [3, 2])]);
ml('ArrayFeatureExtractor', [i(['9007199254740993', 2, 3]), i([2, 0])]);
ml(
  'LabelEncoder',
  [str(['cat', 'dog', 'none'])],
  [p.stringsAttr('keys_strings', ['cat', 'dog']), p.intsAttr('values_int64s', [7, 8])],
);
ml(
  'CategoryMapper',
  [str(['cat', 'dog', 'none'])],
  [p.stringsAttr('cats_strings', ['cat', 'dog']), p.intsAttr('cats_int64s', [7, 8])],
);
for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
  for (const op of ['LinearClassifier', 'LinearRegressor'])
    ml(
      op,
      [f([0, 1, -1, 2, 0.2, 0.7], [3, 2])],
      [
        p.floatsAttr('coefficients', [1, 0, 0, 1]),
        p.floatsAttr('intercepts', [0, 0]),
        p.attr('post_transform', post),
        ...(op === 'LinearClassifier' ? [p.intsAttr('classlabels_ints', [3, 7])] : [p.attr('targets', 2)]),
      ],
      op === 'LinearClassifier' ? 2 : 1,
    );
fs.writeFileSync('test-results/batch-274/oracle-cases.json', JSON.stringify(cases));
console.log({ cases: cases.length });
