import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import * as p from './onnx-fixtures.js';

test('ONNX seeded random streams persist per expanded function call site and isolate sessions', async () => {
  const fn = p.message(
    p.field(1, 'Sample'),
    p.field(5, 'result'),
    p.field(7, p.node('RandomUniform', [], ['result'], [p.intsAttr('shape', [17]), p.floatAttr('seed', 3)])),
    p.field(9, p.message(p.field(1, ''), p.field(2, 18))),
    p.field(10, 'fixture'),
  );
  const bytes = p.model(
    p.graph(
      [p.node('Sample', [], ['a'], [], 'fixture'), p.node('Sample', [], ['b'], [], 'fixture')],
      [],
      [p.valueInfo('a', 1, [17]), p.valueInfo('b', 1, [17])],
    ),
    18,
    [p.field(8, p.message(p.field(1, 'fixture'), p.field(2, 1))), p.field(25, fn)],
  );
  using a = await loadOnnx(bytes);
  using b = await loadOnnx(bytes);
  const first = await a.run({});
  const next = await a.run({});
  const isolated = await b.run({});
  assert.deepEqual(first.a.data, first.b.data);
  assert.deepEqual(first.a.data, isolated.a.data);
  assert.deepEqual(next.a.data, next.b.data);
  assert.notDeepEqual(first.a.data, next.a.data);
  assert.ok([...first.a.data, ...next.a.data].every((v) => v >= 0 && v < 1));
  assert.equal(a.work.liveBytes, 0);
});

test('ONNX random distributions, Bernoulli, log-probability multinomial and dropout follow their schemas', async () => {
  const bytes = p.model(
    p.graph(
      [
        p.node(
          'RandomNormal',
          [],
          ['normal'],
          [
            p.intsAttr('shape', [10000]),
            p.floatAttr('mean', 2),
            p.floatAttr('scale', 3),
            p.floatAttr('seed', 12),
            p.attr('dtype', 11),
          ],
        ),
        p.node('Bernoulli', ['prob'], ['bernoulli'], [p.floatAttr('seed', 8), p.attr('dtype', 7)]),
        p.node(
          'Multinomial',
          ['logits'],
          ['sample'],
          [p.floatAttr('seed', 8), p.attr('sample_size', 19), p.attr('dtype', 7)],
        ),
        p.node('Dropout', ['x', 'ratio', 'training'], ['y', 'mask'], [p.attr('seed', 8)]),
      ],
      [
        p.valueInfo('prob', 1, [3]),
        p.valueInfo('logits', 1, [2, 3]),
        p.valueInfo('x', 1, [100]),
        p.valueInfo('ratio', 1, []),
        p.valueInfo('training', 9, []),
      ],
      [
        p.valueInfo('normal', 11, [10000]),
        p.valueInfo('bernoulli', 7, [3]),
        p.valueInfo('sample', 7, [2, 19]),
        p.valueInfo('y', 1, [100]),
        p.valueInfo('mask', 9, [100]),
      ],
    ),
  );
  using m = await loadOnnx(bytes);
  const feeds = {
    prob: f32([0, 1, 0]),
    logits: f32([-Infinity, 0, -Infinity, -Infinity, -Infinity, 0], [2, 3]),
    x: f32(Array(100).fill(2)),
    ratio: f32([0.5], []),
    training: new OnnxTensor('bool', Uint8Array.of(1), []),
  };
  const r = await m.run(feeds);
  assert.deepEqual([...r.bernoulli.data], [0n, 1n, 0n]);
  assert.deepEqual([...r.sample.data], [...Array(19).fill(1n), ...Array(19).fill(2n)]);
  const normal = [...r.normal.data];
  const mean = normal.reduce((a, b) => a + b, 0) / normal.length;
  const variance = normal.reduce((a, b) => a + (b - mean) ** 2, 0) / normal.length;
  assert.ok(Math.abs(mean - 2) < 0.12);
  assert.ok(Math.abs(variance - 9) < 0.5);
  const mask = [...r.mask.data];
  assert.ok(mask.includes(0) && mask.includes(1));
  assert.deepEqual(
    [...r.y.data],
    mask.map((v) => v * 4),
  );
  const inference = await m.run({ ...feeds, training: new OnnxTensor('bool', Uint8Array.of(0), []) });
  assert.deepEqual(inference.y.data, feeds.x.data);
  assert.ok([...inference.mask.data].every((v) => v === 1));
  await assert.rejects(m.run({ ...feeds, prob: f32([0, NaN, 1]) }), /probabilities/);
  await assert.rejects(m.run({ ...feeds, ratio: f32([1], []) }), /ratio/);
  assert.equal(m.work.liveBytes, 0);
});
import { readFile } from 'node:fs/promises';

const f32 = (values, shape = [values.length]) => new OnnxTensor('float32', Float32Array.from(values), shape);
const i64 = (values, shape = [values.length]) => new OnnxTensor('int64', BigInt64Array.from(values, BigInt), shape);
const simple = (op, kind = 1, shape = [3], attrs = []) =>
  p.model(p.graph([p.node(op, ['x'], ['y'], attrs)], [p.valueInfo('x', kind, shape)], [p.valueInfo('y', kind, shape)]));
const data = (v) => Array.from(v.data);
const graphAttribute = (name, graph) => p.message(p.field(1, name), p.field(20, 5), p.field(6, graph));
test('ONNX Model Zoo MNIST-12 matches its unchanged published reference output', async () => {
  const base = new URL('./fixtures/onnx/', import.meta.url);
  using m = await loadOnnx(new URL('mnist-12.onnx', base));
  const input = p.referenceTensor(await readFile(new URL('input_0.pb', base)));
  const expected = p.referenceTensor(await readFile(new URL('output_0.pb', base)));
  const output = await m.run({ [m.inputs[0].name]: new OnnxTensor('float32', input.data, input.shape) });
  const actual = output[m.outputs[0].name];
  assert.deepEqual(actual.shape, expected.shape);
  let max = 0;
  for (let i = 0; i < expected.data.length; i++) {
    const error = Math.abs(actual.data[i] - expected.data[i]);
    max = Math.max(max, error);
    assert.ok(
      error <= 2e-5 + Math.abs(expected.data[i]) * 1e-5,
      `MNIST logit ${i}: ${actual.data[i]} vs ${expected.data[i]}, error ${error}`,
    );
  }
  assert.ok(Number.isFinite(max));
});
test('ONNX model inference owns outputs, validates symbolic shapes and releases run storage', async () => {
  const bytes = p.model(
    p.graph(
      [p.node('MatMul', ['x', 'w'], ['z']), p.node('Relu', ['z'], ['y'])],
      [p.valueInfo('x', 1, ['batch', 2])],
      [p.valueInfo('y', 1, ['batch', 2])],
      [p.tensor('w', 1, [2, 2], Float32Array.of(1, 2, 3, 4))],
    ),
  );
  const model = await loadOnnx(bytes);
  const initial = model.work.liveBytes;
  const output = await model.run({ x: f32([1, 2, -1, -2], [2, 2]) });
  assert.deepEqual(data(output.y), [7, 10, 0, 0]);
  assert.equal(model.work.liveBytes, initial);
  await assert.rejects(model.run({ x: f32([1, 2, 3], [1, 3]) }), /dimension/);
  assert.equal(model.work.liveBytes, initial);
  model.dispose();
  model.dispose();
  assert.deepEqual(data(output.y), [7, 10, 0, 0]);
  await assert.rejects(model.run({ x: f32([1, 2], [1, 2]) }), /disposed/);
});
test('ONNX never narrows int64 or float64 feed/initializer/output storage', async () => {
  const bytes = p.model(
    p.graph(
      [p.node('Add', ['x', 'b'], ['y'])],
      [p.valueInfo('x', 7, [3])],
      [p.valueInfo('y', 7, [3])],
      [p.tensor('b', 7, [], BigInt64Array.of(1n))],
    ),
  );
  using m = await loadOnnx(bytes);
  const output = await m.run({ x: i64([9007199254740993n, -9223372036854775808n, 9223372036854775807n]) });
  assert.deepEqual(data(output.y), [9007199254740994n, -9223372036854775807n, -9223372036854775808n]);
  using d = await loadOnnx(simple('Identity', 11, [2]));
  const exact = Float64Array.of(Math.PI, 1 + 2 ** -40);
  assert.deepEqual((await d.run({ x: new OnnxTensor('float64', exact, [2]) })).y.data, exact);
});
test('ONNX string conditions, raw half storage and input ownership', async () => {
  const bytes = p.model(
    p.graph(
      [p.node('Where', ['c', 'x', 'b'], ['y'])],
      [p.valueInfo('c', 9, [2]), p.valueInfo('x', 8, [2]), p.valueInfo('b', 8, [2])],
      [p.valueInfo('y', 8, [2])],
    ),
  );
  using m = await loadOnnx(bytes);
  const result = await m.run({
    c: new OnnxTensor('bool', Uint8Array.of(1, 0), [2]),
    x: new OnnxTensor('string', ['yes', 'discard'], [2]),
    b: new OnnxTensor('string', ['discard', 'no'], [2]),
  });
  assert.deepEqual(result.y.data, ['yes', 'no']);
  using h = await loadOnnx(simple('Identity', 10, [4]));
  const raw = Uint16Array.of(0x3c00, 0x8000, 0x7e01, 1);
  const feed = new OnnxTensor('float16', raw, [4]);
  raw.fill(0);
  assert.deepEqual((await h.run({ x: feed })).y.data, Uint16Array.of(0x3c00, 0x8000, 0x7e01, 1));
});
test('ONNX load rejects malformed protobuf, unsupported operators, SSA and missing imports', async () => {
  await assert.rejects(loadOnnx(Uint8Array.of(0x3a, 0xff)), /truncated|length|varint/i);
  await assert.rejects(loadOnnx(simple('NotARealOperator')), /unsupported|no kernel/);
  const duplicate = p.model(
    p.graph([p.node('Relu', ['x'], ['x'])], [p.valueInfo('x', 1, [3])], [p.valueInfo('x', 1, [3])]),
  );
  await assert.rejects(loadOnnx(duplicate), /assigned more than once/);
  const unknown = p.model(p.graph([p.node('Relu', ['missing'], ['y'])], [], [p.valueInfo('y', 1, [3])]));
  await assert.rejects(loadOnnx(unknown), /unavailable value/);
  const domain = p.model(
    p.graph([p.node('Relu', ['x'], ['y'], [], 'private')], [p.valueInfo('x', 1, [3])], [p.valueInfo('y', 1, [3])]),
  );
  await assert.rejects(loadOnnx(domain), /no opset import/);
});

test('ONNX unbuilt operators fail at load with a coded operator and opset diagnostic', async () => {
  const groups = [
    ['ai.onnx.ml', 3, ['TreeEnsemble']],
    ['ai.onnx.ml', 5, ['UnknownML']],
    [
      '',
      28,
      [
        'QuantizeLinear',
        'DequantizeLinear',
        'QLinearConv',
        'QLinearMatMul',
        'ConvInteger',
        'MatMulInteger',
        'RegexFullMatch',
        'TfIdfVectorizer',
        'ImageDecoder',
        'DeformConv',
        'Attention',
        'RotaryEmbedding',
        'TensorScatter',
        'CausalConvWithState',
        'NotARealOperator',
      ],
    ],
  ];
  for (const [domain, version, operators] of groups)
    for (const op of operators) {
      const bytes = p.model(
        p.graph([p.node(op, ['x'], ['y'], [], domain)], [p.valueInfo('x', 1, [1])], [p.valueInfo('y', 1, [1])]),
        domain ? 28 : version,
        domain ? [p.field(8, p.message(p.field(1, domain), p.field(2, version)))] : [],
      );
      await assert.rejects(loadOnnx(bytes), (error) => {
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'unsupported');
        assert.ok(error.message.includes(`${domain || 'ai.onnx'}:${op} opset ${version}`));
        assert.ok(error.message.includes('https://margoengine.com/errors#compute'));
        return true;
      });
    }
});
test('ONNX external weights use exact ranges and cancellation with no hidden fetch', async () => {
  const pair = (k, v) => p.field(13, p.message(p.field(1, k), p.field(2, v)));
  const external = p.message(
    p.field(1, 2),
    p.field(2, 1),
    p.field(8, 'b'),
    p.field(14, 1),
    pair('location', 'weights.bin'),
    pair('offset', '4'),
    pair('length', '8'),
  );
  const bytes = p.model(
    p.graph([p.node('Add', ['x', 'b'], ['y'])], [p.valueInfo('x', 1, [2])], [p.valueInfo('y', 1, [2])], [external]),
  );
  let calls = 0;
  using m = await loadOnnx(bytes, {
    externalData: async (r) => {
      calls++;
      assert.equal(r.location, 'weights.bin');
      assert.equal(r.offset, 4);
      assert.equal(r.length, 8);
      return new Uint8Array(Float32Array.of(5, 6).buffer);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(data((await m.run({ x: f32([1, 2]) })).y), [6, 8]);
  await assert.rejects(loadOnnx(bytes), /externalData/);
  await assert.rejects(loadOnnx(bytes, { externalData: async () => new Uint8Array(4) }), /requested bytes/);
  const controller = new AbortController();
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(loadOnnx(bytes, { signal: controller.signal }), /cancel fixture/);
});
test('ONNX sparse initializers validate sorted coordinates and preserve exact values', async () => {
  const sparse = p.message(
    p.field(1, p.tensor('b', 7, [2], BigInt64Array.of(9007199254740993n, 7n))),
    p.field(2, p.tensor('', 7, [2, 1], BigInt64Array.of(0n, 2n))),
    p.field(3, 3),
  );
  const g = p.concat(
    p.graph([p.node('Add', ['x', 'b'], ['y'])], [p.valueInfo('x', 7, [3])], [p.valueInfo('y', 7, [3])]),
    p.field(15, sparse),
  );
  using m = await loadOnnx(p.model(g));
  assert.deepEqual(data((await m.run({ x: i64([0, 0, 0]) })).y), [9007199254740993n, 0n, 7n]);
});
test('ONNX If executes selected lexical branch and never evaluates the other branch', async () => {
  const yes = p.graph([p.node('Relu', ['x'], ['z'])], [], [p.valueInfo('z', 1, [2])]);
  const no = p.graph([p.node('Neg', ['x'], ['z'])], [], [p.valueInfo('z', 1, [2])]);
  const bytes = p.model(
    p.graph(
      [p.node('If', ['condition'], ['y'], [graphAttribute('then_branch', yes), graphAttribute('else_branch', no)])],
      [p.valueInfo('x', 1, [2]), p.valueInfo('condition', 9, [])],
      [p.valueInfo('y', 1, [2])],
    ),
  );
  using m = await loadOnnx(bytes);
  assert.deepEqual(
    data((await m.run({ x: f32([-2, 3]), condition: new OnnxTensor('bool', Uint8Array.of(1), []) })).y),
    [0, 3],
  );
  assert.deepEqual(
    data((await m.run({ x: f32([-2, 3]), condition: new OnnxTensor('bool', Uint8Array.of(0), []) })).y),
    [2, -3],
  );
});
test('ONNX Loop carries state, stacks scans, supports zero iterations and enforces its safety bound', async () => {
  const body = p.graph(
    [
      p.node('Add', ['state', 'one'], ['next']),
      p.node('Identity', ['cond'], ['outCond']),
      p.node('Identity', ['next'], ['scan']),
    ],
    [p.valueInfo('iteration', 7, []), p.valueInfo('cond', 9, []), p.valueInfo('state', 7, [])],
    [p.valueInfo('outCond', 9, []), p.valueInfo('next', 7, []), p.valueInfo('scan', 7, [])],
    [p.tensor('one', 7, [], BigInt64Array.of(1n))],
  );
  const bytes = p.model(
    p.graph(
      [p.node('Loop', ['trip', '', 'initial'], ['last', 'all'], [graphAttribute('body', body)])],
      [p.valueInfo('trip', 7, []), p.valueInfo('initial', 7, [])],
      [p.valueInfo('last', 7, []), p.valueInfo('all', 7, [null])],
    ),
  );
  using m = await loadOnnx(bytes);
  const initial = m.work.liveBytes;
  const output = await m.run({ trip: i64([3], []), initial: i64([5], []) });
  assert.deepEqual(data(output.last), [8n]);
  assert.deepEqual(data(output.all), [6n, 7n, 8n]);
  assert.equal(m.work.liveBytes, initial);
  assert.deepEqual((await m.run({ trip: i64([0], []), initial: i64([5], []) })).all.shape, [0]);
  await assert.rejects(m.run({ trip: i64([3], []), initial: i64([5], []) }, { maxIterations: 2 }), /maxIterations/);
  assert.equal(m.work.liveBytes, initial);
});
test('ONNX Scan handles input/output direction and axis independently', async () => {
  const body = p.graph(
    [p.node('Add', ['state', 'item'], ['next']), p.node('Identity', ['next'], ['sample'])],
    [p.valueInfo('state', 7, []), p.valueInfo('item', 7, [])],
    [p.valueInfo('next', 7, []), p.valueInfo('sample', 7, [])],
  );
  const attrs = [
    graphAttribute('body', body),
    p.attr('num_scan_inputs', 1),
    p.intsAttr('scan_input_directions', [1]),
    p.intsAttr('scan_output_directions', [1]),
  ];
  using m = await loadOnnx(
    p.model(
      p.graph(
        [p.node('Scan', ['initial', 'items'], ['last', 'all'], attrs)],
        [p.valueInfo('initial', 7, []), p.valueInfo('items', 7, [3])],
        [p.valueInfo('last', 7, []), p.valueInfo('all', 7, [3])],
      ),
    ),
  );
  const output = await m.run({ initial: i64([0], []), items: i64([1, 2, 3]) });
  assert.deepEqual(data(output.last), [6n]);
  assert.deepEqual(data(output.all), [6n, 5n, 3n]);
});
test('ONNX sequences and optionals keep containers without leaking run tensors', async () => {
  const nodes = [
    p.node('SequenceConstruct', ['a', 'b'], ['s']),
    p.node('SequenceAt', ['s', 'index'], ['v']),
    p.node('SequenceLength', ['s'], ['n']),
    p.node('Optional', ['v'], ['opt']),
    p.node('OptionalHasElement', ['opt'], ['has']),
    p.node('ConcatFromSequence', ['s'], ['joined'], [p.attr('axis', 0), p.attr('new_axis', 1)]),
  ];
  const optionalType = p.field(
    9,
    p.field(1, p.field(1, p.message(p.field(1, 1), p.field(2, p.field(1, p.field(1, 2)))))),
  );
  const outputOpt = p.message(p.field(1, 'opt'), p.field(2, optionalType));
  using m = await loadOnnx(
    p.model(
      p.graph(
        nodes,
        [p.valueInfo('a', 1, [2]), p.valueInfo('b', 1, [2]), p.valueInfo('index', 7, [])],
        [
          p.valueInfo('v', 1, [2]),
          p.valueInfo('n', 7, []),
          p.valueInfo('has', 9, []),
          p.valueInfo('joined', 1, [2, 2]),
          outputOpt,
        ],
      ),
    ),
  );
  const output = await m.run({ a: f32([1, 2]), b: f32([3, 4]), index: i64([-1], []) });
  assert.deepEqual(data(output.v), [3, 4]);
  assert.deepEqual(data(output.n), [2n]);
  assert.deepEqual(data(output.has), [1]);
  assert.deepEqual(data(output.joined), [1, 2, 3, 4]);
  assert.deepEqual(data(output.opt), [3, 4]);
  assert.equal(m.work.liveBytes, 0);
});
test('ONNX local functions use their own opsets and bind exact reference attributes', async () => {
  const ref = p.message(p.field(1, 'axis'), p.field(20, 2), p.field(21, 'which_axis'));
  const fn = p.message(
    p.field(1, 'Collapse'),
    p.field(4, 'input'),
    p.field(5, 'output'),
    p.field(6, 'which_axis'),
    p.field(7, p.node('Flatten', ['input'], ['output'], [ref])),
    p.field(9, p.message(p.field(1, ''), p.field(2, 18))),
    p.field(10, 'fixture'),
  );
  const bytes = p.model(
    p.graph(
      [p.node('Collapse', ['x'], ['y'], [p.attr('which_axis', -1)], 'fixture')],
      [p.valueInfo('x', 7, [2, 3, 2])],
      [p.valueInfo('y', 7, [6, 2])],
    ),
    18,
    [p.field(8, p.message(p.field(1, 'fixture'), p.field(2, 1))), p.field(25, fn)],
  );
  using m = await loadOnnx(bytes);
  const input = i64(
    Array.from({ length: 12 }, (_, i) => 9007199254740993n + BigInt(i)),
    [2, 3, 2],
  );
  assert.deepEqual((await m.run({ x: input })).y.data, input.data);
});
test('ONNX run cancellation, overlapping run rejection and subsequent reuse', async () => {
  const nodes = Array.from({ length: 30 }, (_, i) => p.node('Identity', [i ? `v${i - 1}` : 'x'], [`v${i}`]));
  using m = await loadOnnx(p.model(p.graph(nodes, [p.valueInfo('x', 1, [3])], [p.valueInfo('v29', 1, [3])])));
  const controller = new AbortController();
  const running = m.run({ x: f32([1, 2, 3]) }, { yieldEvery: 1, signal: controller.signal });
  await assert.rejects(m.run({ x: f32([1, 2, 3]) }), /already running/);
  controller.abort(new Error('stop inference'));
  await assert.rejects(running, /stop inference/);
  assert.equal(m.work.liveBytes, 0);
  assert.deepEqual(data((await m.run({ x: f32([1, 2, 3]) })).v29), [1, 2, 3]);
});
test('ONNX last-use disposal bounds long graph storage and preserves later branch captures', async () => {
  const nodes = Array.from({ length: 80 }, (_, i) => p.node('Neg', [i ? `v${i - 1}` : 'x'], [`v${i}`]));
  const yes = p.graph([p.node('Add', ['v0', 'v79'], ['sum'])], [], [p.valueInfo('sum', 1, [2048])]);
  const no = p.graph([p.node('Identity', ['v79'], ['sum'])], [], [p.valueInfo('sum', 1, [2048])]);
  nodes.push(
    p.node('If', ['condition'], ['y'], [graphAttribute('then_branch', yes), graphAttribute('else_branch', no)]),
  );
  using m = await loadOnnx(
    p.model(
      p.graph(nodes, [p.valueInfo('x', 1, [2048]), p.valueInfo('condition', 9, [])], [p.valueInfo('y', 1, [2048])]),
    ),
    { memoryLimit: 65536 },
  );
  const input = new OnnxTensor('float32', new Float32Array(2048).fill(3), [2048]);
  const output = await m.run({ x: input, condition: new OnnxTensor('bool', Uint8Array.of(1), []) });
  assert.ok(output.y.data.every((v) => Object.is(v, 0)));
  assert.equal(m.work.liveBytes, 0);
});
test('ONNX operator schemas reject unused attributes and input/output arity errors', async () => {
  using m = await loadOnnx(simple('Relu', 1, [3], [p.attr('axis', 0)]));
  await assert.rejects(m.run({ x: f32([1, 2, 3]) }), /unknown operator attribute/);
  assert.equal(m.work.liveBytes, 0);
  const missing = p.model(
    p.graph([p.node('Add', ['x'], ['y'])], [p.valueInfo('x', 1, [3])], [p.valueInfo('y', 1, [3])]),
  );
  using b = await loadOnnx(missing);
  await assert.rejects(b.run({ x: f32([1, 2, 3]) }), /expects 2/);
  assert.equal(b.work.liveBytes, 0);
  const top = p.model(
    p.graph(
      [p.node('TopK', ['x', 'k'], ['y'])],
      [p.valueInfo('x', 1, [3])],
      [p.valueInfo('y', 1, [1])],
      [p.tensor('k', 7, [1], BigInt64Array.of(1n))],
    ),
  );
  using k = await loadOnnx(top);
  await assert.rejects(k.run({ x: f32([1, 2, 3]) }), /outputs/);
  await assert.rejects(
    loadOnnx(
      p.model(p.graph([p.node('Gelu', ['x'], ['y'])], [p.valueInfo('x', 1, [3])], [p.valueInfo('y', 1, [3])]), 13),
    ),
    /no kernel/,
  );
});
test('ONNX numeric and string casts preserve integer64 values and bool NaNs', async () => {
  const bytes = p.model(
    p.graph(
      [p.node('Cast', ['x'], ['s'], [p.attr('to', 8)]), p.node('Cast', ['s'], ['y'], [p.attr('to', 7)])],
      [p.valueInfo('x', 7, [2])],
      [p.valueInfo('y', 7, [2]), p.valueInfo('s', 8, [2])],
    ),
  );
  using m = await loadOnnx(bytes);
  const output = await m.run({ x: i64([9007199254740993n, -1]) });
  assert.deepEqual(output.s.data, ['9007199254740993', '-1']);
  assert.deepEqual(data(output.y), [9007199254740993n, -1n]);
  using b = await loadOnnx(simple('Cast', 1, [3], [p.attr('to', 9)]).slice());
  await assert.rejects(b.run({ x: f32([NaN, -0, -Infinity]) }), /declared/);
});
test('ONNX empty and erased sequences retain their declared tensor dtype', async () => {
  const make = (kind) =>
    p.model(
      p.graph(
        [
          p.node('SequenceEmpty', [], ['empty'], [p.attr('dtype', 7)]),
          p.node('SequenceInsert', ['empty', 'x'], ['seq']),
          p.node('SequenceErase', ['seq'], ['again']),
          p.node('SequenceInsert', ['again', 'y'], ['inserted']),
          p.node('SequenceAt', ['inserted', 'zero'], ['result']),
        ],
        [p.valueInfo('x', 7, [1]), p.valueInfo('y', kind, [1])],
        [p.valueInfo('result', kind, [1])],
        [p.tensor('zero', 7, [], BigInt64Array.of(0n))],
      ),
    );
  using good = await loadOnnx(make(7));
  assert.deepEqual(data((await good.run({ x: i64([3]), y: i64([9007199254740993n]) })).result), [9007199254740993n]);
  using bad = await loadOnnx(make(1));
  await assert.rejects(bad.run({ x: i64([3]), y: f32([4]) }), /element type differs/);
  assert.equal(bad.work.liveBytes, 8);
});
test('ONNX GRU reset placement and LSTM i,o,f,c peepholes follow the serialized schema', async () => {
  const t = (name, shape, values) => p.tensor(name, 11, shape, Float64Array.from(values));
  for (const reset of [0, 1]) {
    const weights = [
      t('w', [1, 3, 1], [0, 0, 1]),
      t('r', [1, 3, 1], [0, 0, 1]),
      t('b', [1, 6], [0, 0, 0, 0, 0, 3]),
      t('h', [1, 1, 1], [2]),
    ];
    using m = await loadOnnx(
      p.model(
        p.graph(
          [
            p.node(
              'GRU',
              ['x', 'w', 'r', 'b', '', 'h'],
              ['', 'last'],
              [p.attr('hidden_size', 1), p.attr('linear_before_reset', reset)],
            ),
          ],
          [p.valueInfo('x', 11, [1, 1, 1])],
          [p.valueInfo('last', 11, [1, 1, 1])],
          weights,
        ),
      ),
    );
    const output = await m.run({ x: new OnnxTensor('float64', Float64Array.of(1), [1, 1, 1]) });
    assert.ok(Math.abs(output.last.data[0] - (1 + 0.5 * Math.tanh(reset ? 3.5 : 5))) < 1e-14);
  }
  const sigmoid = (n) => 1 / (1 + Math.exp(-n));
  for (const coupled of [0, 1]) {
    const weights = [
      t('w', [1, 4, 1], [0, 0, 0, 0]),
      t('r', [1, 4, 1], [0, 0, 0, 0]),
      t('cell', [1, 1, 1], [2]),
      t('p', [1, 3], [1, 2, 3]),
    ];
    using m = await loadOnnx(
      p.model(
        p.graph(
          [
            p.node(
              'LSTM',
              ['x', 'w', 'r', '', '', '', 'cell', 'p'],
              ['', 'last', 'state'],
              [p.attr('hidden_size', 1), p.attr('input_forget', coupled)],
            ),
          ],
          [p.valueInfo('x', 11, [1, 1, 1])],
          [p.valueInfo('last', 11, [1, 1, 1]), p.valueInfo('state', 11, [1, 1, 1])],
          weights,
        ),
      ),
    );
    const output = await m.run({ x: new OnnxTensor('float64', Float64Array.of(0), [1, 1, 1]) });
    const cell = 2 * (coupled ? 1 - sigmoid(2) : sigmoid(6));
    assert.ok(Math.abs(output.state.data[0] - cell) < 1e-14);
    assert.ok(Math.abs(output.last.data[0] - sigmoid(2 * cell) * Math.tanh(cell)) < 1e-14);
  }
});
test('ONNX Resize nearest ties retain integer64 and crop extrapolation follows ROI coordinates', async () => {
  for (const rounding of ['round_prefer_floor', 'round_prefer_ceil']) {
    using m = await loadOnnx(
      p.model(
        p.graph(
          [p.node('Resize', ['x', '', '', 'sizes'], ['y'], [p.attr('nearest_mode', rounding)])],
          [p.valueInfo('x', 7, [2])],
          [p.valueInfo('y', 7, [3])],
          [p.tensor('sizes', 7, [1], BigInt64Array.of(3n))],
        ),
      ),
    );
    const output = await m.run({ x: i64([9007199254740993n, 7n]) });
    assert.deepEqual(
      data(output.y),
      rounding === 'round_prefer_floor' ? [9007199254740993n, 9007199254740993n, 7n] : [9007199254740993n, 7n, 7n],
    );
  }
  using m = await loadOnnx(
    p.model(
      p.graph(
        [
          p.node(
            'Resize',
            ['x', 'roi', '', 'sizes'],
            ['y'],
            [
              p.attr('mode', 'linear'),
              p.attr('coordinate_transformation_mode', 'tf_crop_and_resize'),
              p.floatAttr('extrapolation_value', -7),
            ],
          ),
        ],
        [p.valueInfo('x', 11, [2])],
        [p.valueInfo('y', 11, [5])],
        [p.tensor('roi', 11, [2], Float64Array.of(-1, 2)), p.tensor('sizes', 7, [1], BigInt64Array.of(5n))],
      ),
    ),
  );
  assert.deepEqual(
    data((await m.run({ x: new OnnxTensor('float64', Float64Array.of(0, 4), [2]) })).y),
    [-7, -7, 2, -7, -7],
  );
});
test('ONNX shared function DAG validation visits definitions once and bounds expanded inference work', async () => {
  const fn = (i, double) =>
    p.message(
      p.field(1, `F${i}`),
      p.field(4, 'input'),
      p.field(5, 'output'),
      ...(i === 0
        ? [p.field(7, p.node('Identity', ['input'], ['output']))]
        : [
            ...(double ? [p.field(7, p.node(`F${i - 1}`, ['input'], ['unused'], [], 'dag'))] : []),
            p.field(7, p.node(`F${i - 1}`, ['input'], ['output'], [], 'dag')),
          ]),
      p.field(9, p.message(p.field(1, ''), p.field(2, 18))),
      p.field(9, p.message(p.field(1, 'dag'), p.field(2, 1))),
      p.field(10, 'dag'),
    );
  const make = (depth, double, prime = false) =>
    p.model(
      p.graph(
        [...(prime ? [p.node('F0', ['x'], ['first'], [], 'dag')] : []), p.node(`F${depth}`, ['x'], ['y'], [], 'dag')],
        [p.valueInfo('x', 7, [1])],
        [p.valueInfo('y', 7, [1])],
      ),
      18,
      [
        p.field(8, p.message(p.field(1, 'dag'), p.field(2, 1))),
        ...Array.from({ length: depth + 1 }, (_, i) => p.field(25, fn(i, double))),
      ],
    );
  using small = await loadOnnx(make(4, true));
  assert.equal(small.work.validatedFunctions, 5);
  assert.deepEqual(data((await small.run({ x: i64([9007199254740993n]) })).y), [9007199254740993n]);
  using large = await loadOnnx(make(24, true));
  assert.equal(large.work.validatedFunctions, 25);
  await assert.rejects(large.run({ x: i64([3]) }, { maxNodes: 32 }), /maxNodes/);
  assert.equal(large.work.liveBytes, 0);
  await assert.rejects(loadOnnx(make(64, false, true)), /nesting exceeds 64/);
});
test('ONNX nested sequence Identity preserves shared input graphs and rejects cyclic containers', async () => {
  let type = p.field(1, p.message(p.field(1, 7), p.field(2, p.field(1, p.field(1, 1)))));
  let input = i64([9007199254740993n]);
  for (let i = 0; i < 16; i++) {
    type = p.field(4, p.field(1, type));
    input = [input, input];
  }
  const info = (name) => p.message(p.field(1, name), p.field(2, type));
  using m = await loadOnnx(p.model(p.graph([p.node('Identity', ['x'], ['y'])], [info('x')], [info('y')])));
  const output = await m.run({ x: input });
  assert.equal(output.y[0], output.y[1]);
  let leaf = output.y;
  for (let i = 0; i < 16; i++) leaf = leaf[0];
  assert.deepEqual(data(leaf), [9007199254740993n]);
  assert.equal(m.work.liveBytes, 0);
  const cycle = [];
  cycle.push(cycle);
  await assert.rejects(m.run({ x: cycle }), /acyclic/);
  assert.equal(m.work.liveBytes, 0);
});
test('ONNX built-in domain aliases resolve consistently and duplicate imports reject', async () => {
  const body = p.graph(
    [p.node('Identity', ['x'], ['y'], [], 'ai.onnx')],
    [p.valueInfo('x', 7, [1])],
    [p.valueInfo('y', 7, [1])],
  );
  const alias = p.field(8, p.message(p.field(1, 'ai.onnx'), p.field(2, 18)));
  using m = await loadOnnx(p.message(p.field(1, 10), p.field(7, body), alias));
  assert.deepEqual(data((await m.run({ x: i64([9007199254740993n]) })).y), [9007199254740993n]);
  await assert.rejects(loadOnnx(p.model(body, 18, [alias])), /unique domains/);
});
test('ONNX ReduceMean retains int64 values above 2^53 and at storage extrema', async () => {
  using m = await loadOnnx(
    p.model(p.graph([p.node('ReduceMean', ['x'], ['y'])], [p.valueInfo('x', 7, [2])], [p.valueInfo('y', 7, [1])])),
  );
  for (const n of [9007199254740993n, 9223372036854775807n, -9223372036854775808n])
    assert.deepEqual(data((await m.run({ x: i64([n, n]) })).y), [n]);
});
