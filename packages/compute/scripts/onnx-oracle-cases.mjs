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
// Follow-up original analytic models, compared only through the external public inference API.
const ta = (name, kind, values) =>
  p.message(p.field(1, name), p.field(20, 4), p.field(5, p.tensor('', kind, [values.length], values)));
const tn = (comparison = 'BRANCH_LEQ') => [
  p.intsAttr('nodes_treeids', [0, 0, 0]),
  p.intsAttr('nodes_nodeids', [0, 1, 2]),
  p.intsAttr('nodes_featureids', [0, 0, 0]),
  p.stringsAttr('nodes_modes', [comparison, 'LEAF', 'LEAF']),
  p.floatsAttr('nodes_values', [0, 0, 0]),
  p.intsAttr('nodes_truenodeids', [1, 0, 0]),
  p.intsAttr('nodes_falsenodeids', [2, 0, 0]),
];
for (const version of [1, 3, 5])
  for (const comparison of ['BRANCH_LEQ', 'BRANCH_LT', 'BRANCH_GTE', 'BRANCH_GT', 'BRANCH_EQ', 'BRANCH_NEQ'])
    add(
      'TreeEnsembleRegressor',
      [f([-1, 0, 1], [3, 1])],
      [
        ...tn(comparison),
        p.attr('n_targets', 1),
        p.intsAttr('target_treeids', [0, 0]),
        p.intsAttr('target_nodeids', [1, 2]),
        p.intsAttr('target_ids', [0, 0]),
        p.floatsAttr('target_weights', [2, 7]),
      ],
      1,
      version,
      'ai.onnx.ml',
    );
for (const aggregate of ['AVERAGE', 'SUM', 'MIN', 'MAX'])
  for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
    add(
      'TreeEnsembleRegressor',
      [f([0], [1, 1])],
      [
        p.intsAttr('nodes_treeids', [0, 1]),
        p.intsAttr('nodes_nodeids', [0, 0]),
        p.intsAttr('nodes_featureids', [0, 0]),
        p.stringsAttr('nodes_modes', ['LEAF', 'LEAF']),
        p.floatsAttr('nodes_values', [0, 0]),
        p.intsAttr('nodes_truenodeids', [0, 0]),
        p.intsAttr('nodes_falsenodeids', [0, 0]),
        p.attr('n_targets', 2),
        p.attr('aggregate_function', aggregate),
        p.attr('post_transform', post),
        p.intsAttr('target_treeids', [0, 0, 1, 1]),
        p.intsAttr('target_nodeids', [0, 0, 0, 0]),
        p.intsAttr('target_ids', [0, 1, 0, 1]),
        p.floatsAttr('target_weights', [2, 4, -5, 2]),
        p.floatsAttr('base_values', [0.25, -0.5]),
      ],
      1,
      3,
      'ai.onnx.ml',
    );
for (const version of [1, 3, 5])
  for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
    add(
      'TreeEnsembleClassifier',
      [f([-1, 0, 1], [3, 1])],
      [
        ...tn(),
        p.intsAttr('class_treeids', [0, 0, 0, 0]),
        p.intsAttr('class_nodeids', [1, 1, 2, 2]),
        p.intsAttr('class_ids', [0, 1, 0, 1]),
        p.floatsAttr('class_weights', [0.75, 0.25, 0.125, 0.875]),
        p.stringsAttr('classlabels_strings', ['west', 'east']),
        p.attr('post_transform', post),
      ],
      2,
      version,
      'ai.onnx.ml',
    );
for (const weights of [
  [0.2, 0.7],
  [-2, 3],
])
  for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
    add(
      'TreeEnsembleClassifier',
      [f([-1, 0, 1], [3, 1])],
      [
        ...tn(),
        p.intsAttr('class_treeids', [0, 0]),
        p.intsAttr('class_nodeids', [1, 2]),
        p.intsAttr('class_ids', [0, 0]),
        p.floatsAttr('class_weights', weights),
        p.intsAttr('classlabels_int64s', [10, 20]),
        p.attr('post_transform', post),
      ],
      2,
      3,
      'ai.onnx.ml',
    );
for (const kind of [1, 11])
  for (const ag of [0, 1, 2, 3])
    for (const branch of [0, 1, 2, 3, 4, 5, 6]) {
      const Type = kind === 1 ? Float32Array : Float64Array;
      add(
        'TreeEnsemble',
        [t(kind, [3, 1], [-1, 0, 1])],
        [
          p.attr('n_targets', 1),
          p.attr('aggregate_function', ag),
          p.intsAttr('nodes_featureids', [0]),
          p.intsAttr('nodes_truenodeids', [0]),
          p.intsAttr('nodes_falsenodeids', [1]),
          p.intsAttr('nodes_trueleafs', [1]),
          p.intsAttr('nodes_falseleafs', [1]),
          ta('nodes_modes', 2, Uint8Array.of(branch)),
          ta('nodes_splits', kind, Type.of(0)),
          ta('leaf_weights', kind, Type.of(2, 7)),
          ...(branch === 6 ? [ta('membership_values', kind, Type.of(0, 1, NaN))] : []),
          p.intsAttr('leaf_targetids', [0, 0]),
          p.intsAttr('tree_roots', [0]),
        ],
        1,
        5,
        'ai.onnx.ml',
      );
    }
for (const kernel of ['LINEAR', 'POLY', 'RBF', 'SIGMOID'])
  for (const one of [0, 1])
    add(
      'SVMRegressor',
      [f([-1, 0, 1], [3, 1])],
      [
        p.attr('n_supports', 2),
        p.floatsAttr('support_vectors', [-1, 1]),
        p.floatsAttr('coefficients', [2, 3]),
        p.floatsAttr('rho', [0.25]),
        p.attr('kernel_type', kernel),
        p.floatsAttr('kernel_params', [0.5, 0.25, 2]),
        p.attr('one_class', one),
      ],
      1,
      1,
      'ai.onnx.ml',
    );
for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
  add(
    'SVMRegressor',
    [f([-1, 0, 1], [3, 1])],
    [
      p.floatsAttr('coefficients', [2]),
      p.floatsAttr('rho', [0.25]),
      p.floatsAttr('kernel_params', [0, 0, 0]),
      p.attr('post_transform', post),
    ],
    1,
    1,
    'ai.onnx.ml',
  );
for (const kernel of ['LINEAR', 'POLY', 'RBF', 'SIGMOID'])
  for (const calibrated of [false, true])
    for (const classes of [2, 3, 4]) {
      const pairs = (classes * (classes - 1)) / 2;
      add(
        'SVMClassifier',
        [f([-1, 0, 1], [3, 1])],
        [
          p.intsAttr(
            'classlabels_ints',
            Array.from({ length: classes }, (_, i) => 10 + i),
          ),
          p.intsAttr('vectors_per_class', Array(classes).fill(1)),
          p.floatsAttr(
            'support_vectors',
            Array.from({ length: classes }, (_, i) => i - 1),
          ),
          p.floatsAttr(
            'coefficients',
            Array.from({ length: (classes - 1) * classes }, (_, i) => ((i % 3) - 1) * 0.5),
          ),
          p.floatsAttr('rho', Array(pairs).fill(0.25)),
          p.attr('kernel_type', kernel),
          p.floatsAttr('kernel_params', [0.5, 0.25, 2]),
          ...(calibrated
            ? [p.floatsAttr('prob_a', Array(pairs).fill(-1)), p.floatsAttr('prob_b', Array(pairs).fill(0))]
            : []),
        ],
        2,
        1,
        'ai.onnx.ml',
      );
    }
for (const post of ['NONE', 'LOGISTIC', 'SOFTMAX', 'SOFTMAX_ZERO'])
  add(
    'SVMClassifier',
    [f([-1, 0, 1], [3, 1])],
    [
      p.stringsAttr('classlabels_strings', ['a', 'b']),
      p.floatsAttr('coefficients', [2, -3]),
      p.floatsAttr('rho', [0.25]),
      p.floatsAttr('kernel_params', [0, 0, 0]),
      p.attr('post_transform', post),
    ],
    2,
    1,
    'ai.onnx.ml',
  );

// Preserve external outputs unchanged; these independent expectations cover known provider
// deviations from the top-class and declared post-transform contracts.
for (const c of cases) {
  if (c.op === 'TreeEnsembleClassifier' && Number(c.id.split('-')[1]) < 12) {
    c.normativeReason =
      'Full class-score vectors select the largest raw score; the external binary shortcut selects east for all these rows.';
    c.normativeOutputs = { 0: { kind: 8, shape: [3], data: ['west', 'west', 'east'] } };
  }
  if (c.op === 'SVMClassifier' && Number(c.id.split('-')[1]) >= 24) {
    c.normativeReason =
      'A linear classifier selects the largest raw class score, with first-class ties; external binary shortcut returns b for all rows.';
    c.normativeOutputs = { 0: { kind: 8, shape: [3], data: ['b', 'a', 'a'] } };
  }
  if (['SVMRegressor-9', 'SVMRegressor-10', 'SVMRegressor-11'].includes(c.id)) {
    const data = c.id === 'SVMRegressor-9' ? [0.14804719803168948, 0.5621765008857981, 0.9046505351008906] : [1, 1, 1];
    c.normativeReason =
      'Apply the declared LOGISTIC or single-target SOFTMAX transform; external CPU provider returns raw regression scores.';
    c.normativeOutputs = {
      0: { kind: 1, shape: [3, 1], data: Buffer.from(Float32Array.from(data).buffer).toString('base64') },
    };
  }
}

fs.writeFileSync('test-results/batch-274/oracle-cases.json', JSON.stringify(cases));
console.log({ cases: cases.length });
