import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';
export const treeNodes = () => [
  p.intsAttr('nodes_treeids', [0, 0, 0]),
  p.intsAttr('nodes_nodeids', [0, 1, 2]),
  p.intsAttr('nodes_featureids', [0, 0, 0]),
  p.stringsAttr('nodes_modes', ['BRANCH_LEQ', 'LEAF', 'LEAF']),
  p.floatsAttr('nodes_values', [0, 0, 0]),
  p.intsAttr('nodes_truenodeids', [1, 0, 0]),
  p.intsAttr('nodes_falsenodeids', [2, 0, 0]),
];
export const treeVotes = () => [
  p.intsAttr('target_treeids', [0, 0]),
  p.intsAttr('target_nodeids', [1, 2]),
  p.intsAttr('target_ids', [0, 0]),
  p.floatsAttr('target_weights', [2, 7]),
];
export function mlModel(op, attrs, shape, kind = 1, version = 3) {
  const outputs = op.endsWith('Classifier') ? ['y0', 'y1'] : ['y0'];
  return p.model(
    p.graph(
      [p.node(op, ['x'], outputs, attrs, 'ai.onnx.ml')],
      [p.valueInfo('x', kind, shape)],
      outputs.map((name) => p.field(1, name)),
    ),
    18,
    [p.field(8, p.message(p.field(1, 'ai.onnx.ml'), p.field(2, version)))],
  );
}
export const tensorAttribute = (name, kind, values) =>
  p.message(p.field(1, name), p.field(20, 4), p.field(5, p.tensor('', kind, [values.length], values)));
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function exact(a, b, label) {
  check(
    JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v + 'n' : v)) ===
      JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v + 'n' : v)),
    label,
  );
}
function near(a, b, label) {
  check(a.length === b.length, label);
  for (let i = 0; i < b.length; i++)
    check(Math.abs(a[i] - b[i]) <= 1e-6 + 1e-6 * Math.abs(b[i]), `${label} ${i}: ${a[i]} vs ${b[i]}`);
}
export async function mlCases() {
  let checks = 0;
  async function run(op, attrs, values, shape, expected, kind = 1, version = 3) {
    using model = await loadOnnx(mlModel(op, attrs, shape, kind, version));
    const baseline = model.work.liveBytes;
    const constructors = { 1: Float32Array, 7: BigInt64Array, 11: Float64Array };
    const input =
      kind === 10
        ? new OnnxTensor('float16', Uint16Array.from(values), shape)
        : new OnnxTensor({ 1: 'float32', 7: 'int64', 11: 'float64' }[kind], constructors[kind].from(values), shape);
    const result = await model.run({ x: input });
    for (let j = 0; j < expected.length; j++) {
      const value = result[`y${j}`],
        e = expected[j];
      exact(value.shape, e.shape, `${op} shape`);
      exact(value.dtype, e.dtype, `${op} dtype`);
      if (e.dtype === 'float32' || e.dtype === 'float64') near([...value.data], e.data, op);
      else exact([...value.data], e.data, op);
    }
    check(model.work.liveBytes === baseline, `${op} leaked storage`);
    checks++;
  }
  for (const version of [1, 3, 5])
    for (const mode of ['BRANCH_LEQ', 'BRANCH_LT', 'BRANCH_GTE', 'BRANCH_GT', 'BRANCH_EQ', 'BRANCH_NEQ']) {
      const attrs = treeNodes();
      attrs[3] = p.stringsAttr('nodes_modes', [mode, 'LEAF', 'LEAF']);
      const expected = {
        BRANCH_LEQ: [2, 2, 7],
        BRANCH_LT: [2, 7, 7],
        BRANCH_GTE: [7, 2, 2],
        BRANCH_GT: [7, 7, 2],
        BRANCH_EQ: [7, 2, 7],
        BRANCH_NEQ: [2, 7, 2],
      }[mode];
      await run(
        'TreeEnsembleRegressor',
        [...attrs, ...treeVotes()],
        [-1, 0, 1],
        [3, 1],
        [{ dtype: 'float32', shape: [3, 1], data: expected }],
        1,
        version,
      );
    }
  for (const missing of [0, 1])
    await run(
      'TreeEnsembleRegressor',
      [...treeNodes(), ...treeVotes(), p.intsAttr('nodes_missing_value_tracks_true', [missing, 0, 0])],
      [NaN],
      [1, 1],
      [{ dtype: 'float32', shape: [1, 1], data: [missing ? 2 : 7] }],
    );
  await run(
    'TreeEnsembleRegressor',
    [...treeNodes(), ...treeVotes()],
    [],
    [0, 1],
    [{ dtype: 'float32', shape: [0, 1], data: [] }],
  );
  const roots = [
    p.intsAttr('nodes_treeids', [0, 1]),
    p.intsAttr('nodes_nodeids', [0, 0]),
    p.intsAttr('nodes_featureids', [0, 0]),
    p.stringsAttr('nodes_modes', ['LEAF', 'LEAF']),
    p.floatsAttr('nodes_values', [0, 0]),
    p.intsAttr('nodes_truenodeids', [0, 0]),
    p.intsAttr('nodes_falsenodeids', [0, 0]),
  ];
  for (const [agg, expected] of [
    ['SUM', [-3, 6]],
    ['AVERAGE', [-1.5, 3]],
    ['MIN', [-5, 2]],
    ['MAX', [2, 4]],
  ])
    await run(
      'TreeEnsembleRegressor',
      [
        ...roots,
        p.attr('n_targets', 2),
        p.attr('aggregate_function', agg),
        p.intsAttr('target_treeids', [0, 0, 1, 1]),
        p.intsAttr('target_nodeids', [0, 0, 0, 0]),
        p.intsAttr('target_ids', [0, 1, 0, 1]),
        p.floatsAttr('target_weights', [2, 4, -5, 2]),
      ],
      [0],
      [1, 1],
      [{ dtype: 'float32', shape: [1, 2], data: expected }],
    );
  await run(
    'TreeEnsembleRegressor',
    [
      ...treeNodes().filter((_, i) => i !== 4),
      tensorAttribute('nodes_values_as_tensor', 11, Float64Array.of(0, 0, 0)),
      ...treeVotes().slice(0, 3),
      tensorAttribute('target_weights_as_tensor', 11, Float64Array.of(1.25, 8.5)),
    ],
    [-1, 1],
    [2, 1],
    [{ dtype: 'float32', shape: [2, 1], data: [1.25, 8.5] }],
    11,
  );
  const cls = [
    ...treeNodes(),
    p.intsAttr('class_treeids', [0, 0, 0, 0]),
    p.intsAttr('class_nodeids', [1, 1, 2, 2]),
    p.intsAttr('class_ids', [0, 1, 0, 1]),
    p.floatsAttr('class_weights', [0.75, 0.25, 0.125, 0.875]),
    p.stringsAttr('classlabels_strings', ['left', 'right']),
  ];
  for (const version of [1, 3, 5])
    for (const [post, expected] of [
      ['NONE', [0.75, 0.25, 0.125, 0.875]],
      ['LOGISTIC', [0.679178699175393, 0.5621765008857981, 0.5312093733737563, 0.7057850278370112]],
      ['SOFTMAX', [0.6224593312018546, 0.3775406687981454, 0.320821300824607, 0.679178699175393]],
      ['SOFTMAX_ZERO', [0.6224593312018546, 0.3775406687981454, 0.320821300824607, 0.679178699175393]],
    ])
      await run(
        'TreeEnsembleClassifier',
        [...cls, p.attr('post_transform', post)],
        [-1, 1],
        [2, 1],
        [
          { dtype: 'string', shape: [2], data: ['left', 'right'] },
          { dtype: 'float32', shape: [2, 2], data: expected },
        ],
        1,
        version,
      );
  const modern = [
    p.intsAttr('nodes_featureids', [0]),
    p.intsAttr('nodes_truenodeids', [0]),
    p.intsAttr('nodes_falsenodeids', [1]),
    p.intsAttr('nodes_trueleafs', [1]),
    p.intsAttr('nodes_falseleafs', [1]),
    tensorAttribute('nodes_modes', 2, Uint8Array.of(6)),
    tensorAttribute('nodes_splits', 11, Float64Array.of(0)),
    tensorAttribute('membership_values', 11, Float64Array.of(0, 2, NaN)),
    tensorAttribute('leaf_weights', 11, Float64Array.of(2, 7)),
    p.intsAttr('leaf_targetids', [0, 0]),
    p.intsAttr('tree_roots', [0]),
    p.intsAttr('nodes_missing_value_tracks_true', [1]),
  ];
  await run(
    'TreeEnsemble',
    modern,
    [-1, NaN, 0, 2, 3],
    [5, 1],
    [{ dtype: 'float64', shape: [5, 1], data: [7, 2, 2, 2, 7] }],
    11,
    5,
  );
  const sv = [
    p.attr('n_supports', 2),
    p.floatsAttr('support_vectors', [-1, 1]),
    p.floatsAttr('coefficients', [2, 3]),
    p.floatsAttr('rho', [0.25]),
    p.floatsAttr('kernel_params', [0.5, 0.25, 2]),
  ];
  for (const [k, expected] of [
    ['LINEAR', [-0.75, 0.25, 1.25]],
    ['POLY', [1.5625, 0.5625, 2.0625]],
    ['RBF', [2 + 3 * Math.exp(-2) + 0.25, 5 * Math.exp(-0.5) + 0.25, 2 * Math.exp(-2) + 3 + 0.25]],
    [
      'SIGMOID',
      [
        2 * Math.tanh(0.75) + 3 * Math.tanh(-0.25) + 0.25,
        5 * Math.tanh(0.25) + 0.25,
        2 * Math.tanh(-0.25) + 3 * Math.tanh(0.75) + 0.25,
      ],
    ],
  ])
    await run(
      'SVMRegressor',
      [...sv, p.attr('kernel_type', k)],
      [-1, 0, 1],
      [3, 1],
      [{ dtype: 'float32', shape: [3, 1], data: expected }],
    );
  await run(
    'SVMRegressor',
    [p.floatsAttr('coefficients', [2]), p.floatsAttr('rho', [0.25]), p.attr('one_class', 1)],
    [-1, 0, 1],
    [3, 1],
    [{ dtype: 'float32', shape: [3, 1], data: [-1, 1, 1] }],
  );
  for (const [post, expected] of [
    ['LOGISTIC', [0.14804719803168948, 0.5621765008857981, 0.9046505351008906]],
    ['SOFTMAX', [1, 1, 1]],
    ['SOFTMAX_ZERO', [1, 1, 1]],
  ])
    await run(
      'SVMRegressor',
      [p.floatsAttr('coefficients', [2]), p.floatsAttr('rho', [0.25]), p.attr('post_transform', post)],
      [-1, 0, 1],
      [3, 1],
      [{ dtype: 'float32', shape: [3, 1], data: expected }],
    );
  const svm = [
    p.intsAttr('classlabels_ints', [9007199254740993n, 9007199254740995n]),
    p.intsAttr('vectors_per_class', [1, 1]),
    p.floatsAttr('support_vectors', [-1, 1]),
    p.floatsAttr('coefficients', [1, -1]),
    p.floatsAttr('rho', [0.25]),
  ];
  await run(
    'SVMClassifier',
    svm,
    [-1, 0, 1],
    [3, 1],
    [
      { dtype: 'int64', shape: [3], data: [9007199254740993n, 9007199254740993n, 9007199254740995n] },
      { dtype: 'float32', shape: [3, 2], data: [-2.25, 2.25, -0.25, 0.25, 1.75, -1.75] },
    ],
  );
  await run(
    'SVMClassifier',
    [...svm, p.floatsAttr('prob_a', [0]), p.floatsAttr('prob_b', [0])],
    [-1, 0, 1],
    [3, 1],
    [
      { dtype: 'int64', shape: [3], data: [9007199254740993n, 9007199254740993n, 9007199254740995n] },
      { dtype: 'float32', shape: [3, 2], data: Array(6).fill(0.5) },
    ],
  );
  await run(
    'TreeEnsembleRegressor',
    [
      ...treeNodes().filter((_, i) => i !== 4),
      tensorAttribute('nodes_values_as_tensor', 11, Float64Array.of(9007199254740992, 0, 0)),
      ...treeVotes(),
    ],
    [9007199254740992n, 9007199254740993n],
    [2, 1],
    [{ dtype: 'float32', shape: [2, 1], data: [2, 7] }],
    7,
  );
  await run(
    'SVMClassifier',
    [
      p.stringsAttr('classlabels_strings', ['a', 'b']),
      p.floatsAttr('coefficients', [2, -3]),
      p.floatsAttr('rho', [0.25]),
    ],
    [-1, 0, 1],
    [3, 1],
    [
      { dtype: 'string', shape: [3], data: ['b', 'a', 'a'] },
      { dtype: 'float32', shape: [3, 2], data: [-1.75, 3.25, 0.25, 0.25, 2.25, -2.75] },
    ],
  );
  const half = [
    p.intsAttr('nodes_featureids', [0]),
    p.intsAttr('nodes_truenodeids', [0]),
    p.intsAttr('nodes_falsenodeids', [1]),
    p.intsAttr('nodes_trueleafs', [1]),
    p.intsAttr('nodes_falseleafs', [1]),
    tensorAttribute('nodes_modes', 2, Uint8Array.of(0)),
    tensorAttribute('nodes_splits', 10, Uint16Array.of(0)),
    tensorAttribute('leaf_weights', 10, Uint16Array.of(0x4000, 0x4700)),
    p.intsAttr('leaf_targetids', [0, 0]),
    p.intsAttr('tree_roots', [0]),
  ];
  await run(
    'TreeEnsemble',
    half,
    [0xbc00, 0x3c00],
    [2, 1],
    [{ dtype: 'float16', shape: [2, 1], data: [0x4000, 0x4700] }],
    10,
    5,
  );
  return checks;
}
