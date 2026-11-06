import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { Random } from '@margoengine/compute/random';
import {
  Adam,
  AdamW,
  AvgPool2d,
  Conv1d,
  Conv2d,
  Dropout,
  Embedding,
  Flatten,
  GELU,
  LayerNorm,
  LeakyReLU,
  Linear,
  MaxPool2d,
  MultiHeadAttention,
  ReLU,
  SGD,
  Sequential,
  SiLU,
  Sigmoid,
  Softmax,
  Tanh,
  crossEntropy,
  dropout,
  mseLoss,
  noGrad,
  parameter,
  scaledDotProductAttention,
  tensor,
} from '@margoengine/compute/nn';

// Runs on the CPU backend, which uses the same code as the GPU; tests/compute-nn-browser.js compares the two.

const gpuOf = async (t) => {
  const gpu = await createCompute({ backend: 'cpu' });
  t.after(() => gpu.dispose());
  return gpu;
};
const rng = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296 - 0.5;
  };
};
const noise = (n, seed = 1, scale = 2) => {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => r() * scale);
};
const near = (a, b, tolerance, label = '') => {
  assert.equal(a.length, b.length, `${label} length`);
  for (let i = 0; i < a.length; i++)
    assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `${label}[${i}]: ${a[i]} against ${b[i]}`);
};

/**
 * Checks `backward` against central differences of the scalar sum(run() * weights), for every leaf given. f32 limits
 * how fine the step can be, hence the tolerance.
 */
async function gradCheck(gpu, leaves, run, { step = 1e-2, tolerance = 2e-2 } = {}) {
  const shape = (() => {
    using out = run();
    return out.shape;
  })();
  const size = shape.reduce((a, b) => a * b, 1),
    seed = gpu.array(noise(size, 77, 1), { shape });
  const value = async () => {
    using out = run();
    using total = out.mul(seed).sum();
    return total.item();
  };
  for (const leaf of leaves) leaf.zeroGrad();
  {
    using out = run();
    using total = out.mul(seed).sum();
    total.backward();
  }
  for (const leaf of leaves) {
    const analytic = await leaf.grad.read(),
      base = await leaf.value.read();
    for (let i = 0; i < base.length; i++) {
      const at = (d) => {
        const next = base.slice();
        next[i] += d;
        leaf.value.write(next);
        return value();
      };
      const numeric = ((await at(step)) - (await at(-step))) / (2 * step);
      leaf.value.write(base);
      const scale = Math.max(1, Math.abs(numeric));
      assert.ok(
        Math.abs(numeric - analytic[i]) <= tolerance * scale,
        `element ${i}: backward ${analytic[i]}, numeric ${numeric}`,
      );
    }
  }
}

const leaf = (gpu, shape, seed) =>
  parameter(gpu.array(noise(shape.reduce((a, b) => a * b, 1), seed), { shape }));

test('element-wise, reshape, permute and reducing methods have the right gradients', async (t) => {
  const gpu = await gpuOf(t);
  const a = leaf(gpu, [3, 4], 1),
    b = leaf(gpu, [4], 2),
    c = leaf(gpu, [3, 1], 3);
  await gradCheck(gpu, [a, b, c], () => a.add(b).mul(c).sub(a.mul(0.5)).div(c.mul(c).add(2)));
  await gradCheck(gpu, [a], () => a.reshape(2, 6).permute(1, 0).reshape(4, 3).sum({ axis: 0 }));
  await gradCheck(gpu, [a], () => a.mean({ axis: 1, keepdims: true }).add(a));
  await gradCheck(gpu, [a], () => a.max({ axis: 1 }));
  await gradCheck(gpu, [a], () => a.mul(a).add(1).rsqrt().add(a.exp()).add(a.mul(a).add(1).log()));
});

test('matmul sends gradients to both sides, through batches that broadcast', async (t) => {
  const gpu = await gpuOf(t);
  const a = leaf(gpu, [2, 3, 4], 4),
    b = leaf(gpu, [4, 5], 5);
  await gradCheck(gpu, [a, b], () => a.matmul(b));
  const c = leaf(gpu, [2, 5, 3], 6);
  await gradCheck(gpu, [a, c], () => c.matmul(a));
  assert.throws(() => leaf(gpu, [3], 7).matmul(b), RangeError);
});

test('activations have the right values and gradients', async (t) => {
  const gpu = await gpuOf(t);
  const x = leaf(gpu, [2, 5], 8),
    values = await x.value.read(),
    read = async (f) => (await f(x).value.read()).slice();
  const sigmoid = (v) => 1 / (1 + Math.exp(-v));
  near(await read((v) => v.relu()), [...values].map((v) => Math.max(v, 0)), 1e-6, 'relu');
  near(await read((v) => v.leakyRelu(0.2)), [...values].map((v) => (v > 0 ? v : 0.2 * v)), 1e-6, 'leaky');
  near(await read((v) => v.sigmoid()), [...values].map(sigmoid), 1e-6, 'sigmoid');
  near(await read((v) => v.tanh()), [...values].map(Math.tanh), 1e-6, 'tanh');
  near(await read((v) => v.silu()), [...values].map((v) => v * sigmoid(v)), 1e-6, 'silu');
  const gelu = (v) => 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v ** 3)));
  near(await read((v) => v.gelu()), [...values].map(gelu), 1e-6, 'gelu');
  for (const f of [
    (v) => v.relu(),
    (v) => v.leakyRelu(0.2),
    (v) => v.sigmoid(),
    (v) => v.tanh(),
    (v) => v.silu(),
    (v) => v.gelu(),
    (v) => v.softmax(),
    (v) => v.softmax(0),
    (v) => v.logSoftmax(),
  ])
    await gradCheck(gpu, [x], () => f(x));
  for (const Layer of [ReLU, LeakyReLU, GELU, SiLU, Sigmoid, Tanh, Softmax]) {
    const y = new Layer().forward(x);
    assert.deepEqual(y.shape, [2, 5]);
    y.dispose();
  }
});

test('softmax rows sum to 1 and stay finite on huge logits', async (t) => {
  const gpu = await gpuOf(t);
  const x = tensor(gpu.array([1000, 1001, 1002, -1000, 0, 1000], { shape: [2, 3] }));
  const y = await x.softmax().value.read(),
    logs = await x.logSoftmax().value.read();
  near([y[0] + y[1] + y[2], y[3] + y[4] + y[5]], [1, 1], 1e-6, 'row sums');
  for (const v of logs) assert.ok(Number.isFinite(v));
});

// Direct convolution, as the definition states it.
function convolve(input, n, c, h, w, weight, out, kh, kw, bias, { stride = [1, 1], padding = [0, 0], dilation = [1, 1] }) {
  const oh = Math.floor((h + 2 * padding[0] - dilation[0] * (kh - 1) - 1) / stride[0]) + 1,
    ow = Math.floor((w + 2 * padding[1] - dilation[1] * (kw - 1) - 1) / stride[1]) + 1,
    result = new Float32Array(n * out * oh * ow);
  for (let b = 0; b < n; b++)
    for (let o = 0; o < out; o++)
      for (let y = 0; y < oh; y++)
        for (let x = 0; x < ow; x++) {
          let sum = bias ? bias[o] : 0;
          for (let k = 0; k < c; k++)
            for (let i = 0; i < kh; i++)
              for (let j = 0; j < kw; j++) {
                const sy = y * stride[0] - padding[0] + i * dilation[0],
                  sx = x * stride[1] - padding[1] + j * dilation[1];
                if (sy >= 0 && sy < h && sx >= 0 && sx < w)
                  sum += input[((b * c + k) * h + sy) * w + sx] * weight[((o * c + k) * kh + i) * kw + j];
              }
          result[((b * out + o) * oh + y) * ow + x] = sum;
        }
  return { result, oh, ow };
}

test('Conv2d equals the definition for every geometry', async (t) => {
  const gpu = await gpuOf(t),
    [n, c, h, w, out] = [2, 3, 7, 6, 4];
  const data = noise(n * c * h * w, 9),
    x = tensor(gpu.array(data, { shape: [n, c, h, w] }));
  for (const [kernel, options] of [
    [3, {}],
    [3, { padding: 1 }],
    [[3, 2], { stride: [2, 1], padding: [1, 0] }],
    [2, { dilation: 2 }],
    [3, { stride: 2, padding: 2, dilation: 2 }],
    [1, {}],
  ]) {
    const conv = new Conv2d(gpu, c, out, kernel, { ...options, rng: new Random(gpu, { seed: 1 }) });
    const pairOf = (v, d) => (v === undefined ? [d, d] : typeof v === 'number' ? [v, v] : v);
    const [kh, kw] = pairOf(kernel);
    const expected = convolve(
      data,
      n,
      c,
      h,
      w,
      await conv.weight.value.read(),
      out,
      kh,
      kw,
      await conv.bias.value.read(),
      { stride: pairOf(options.stride, 1), padding: pairOf(options.padding, 0), dilation: pairOf(options.dilation, 1) },
    );
    using y = conv.forward(x);
    assert.deepEqual(y.shape, [n, out, expected.oh, expected.ow]);
    near(await y.value.read(), expected.result, 1e-5, `kernel ${kernel}`);
    conv.dispose();
  }
});

test('Conv2d sends gradients to input, weights and bias, padding and stride included', async (t) => {
  const gpu = await gpuOf(t);
  const x = leaf(gpu, [2, 2, 5, 4], 10);
  for (const options of [{ padding: 1 }, { stride: 2, padding: 1 }, { dilation: 2, padding: 2 }]) {
    const conv = new Conv2d(gpu, 2, 3, 3, { ...options, rng: new Random(gpu, { seed: 2 }) });
    await gradCheck(gpu, [x, conv.weight, conv.bias], () => conv.forward(x));
    conv.dispose();
  }
});

test('Conv1d is a 2D convolution of height 1', async (t) => {
  const gpu = await gpuOf(t);
  const conv = new Conv1d(gpu, 2, 3, 3, { padding: 1, stride: 2, rng: new Random(gpu, { seed: 3 }) }),
    data = noise(2 * 2 * 9, 11),
    x = leaf(gpu, [2, 2, 9], 11);
  x.value.write(data);
  const { result } = convolve(
    data,
    2,
    2,
    1,
    9,
    await conv.conv.weight.value.read(),
    3,
    1,
    3,
    await conv.conv.bias.value.read(),
    { stride: [1, 2], padding: [0, 1] },
  );
  using y = conv.forward(x);
  assert.deepEqual(y.shape, [2, 3, 5]);
  near(await y.value.read(), result, 1e-5);
  await gradCheck(gpu, [x, conv.conv.weight], () => conv.forward(x));
  conv.dispose();
});

test('pooling takes the window maximum or mean, and pads max pools with minus infinity', async (t) => {
  const gpu = await gpuOf(t);
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((v) => -v),
    x = tensor(gpu.array(data, { shape: [1, 1, 4, 4] }));
  const pool = new MaxPool2d(2);
  assert.deepEqual([...(await pool.forward(x).value.read())], [-1, -3, -9, -11]);
  const padded = new MaxPool2d(3, { stride: 2, padding: 1 });
  assert.deepEqual([...(await padded.forward(x).value.read())], [-1, -2, -5, -6]);
  const mean = new AvgPool2d(2);
  assert.deepEqual([...(await mean.forward(x).value.read())], [-3.5, -5.5, -11.5, -13.5]);
  // A maximum has a kink where two values meet, so the check's data stays further apart than its step.
  const spaced = Float32Array.from({ length: 96 }, (_, k) => ((k * 37) % 96) * 0.05 - 2.4),
    stacked = parameter(gpu.array(spaced, { shape: [2, 3, 4, 4] }));
  await gradCheck(gpu, [stacked], () => mean.forward(stacked));
  await gradCheck(gpu, [stacked], () => pool.forward(stacked));
  await gradCheck(gpu, [stacked], () => padded.forward(stacked));
  assert.throws(() => new MaxPool2d(2, { padding: 2 }), RangeError);
  for (const m of [pool, padded, mean]) m.dispose();
});

test('a window that does not fit, a wrong channel count and a wrong rank are refused by name', async (t) => {
  const gpu = await gpuOf(t);
  const conv = new Conv2d(gpu, 1, 1, 5);
  assert.throws(() => conv.forward(tensor(gpu.zeros([1, 1, 3, 3]))), /does not fit/);
  assert.throws(() => conv.forward(tensor(gpu.zeros([1, 2, 8, 8]))), /takes \[n, 1, h, w\]/);
  assert.throws(() => new Conv1d(gpu, 1, 1, 3).forward(tensor(gpu.zeros([4, 4]))), /takes \[n, channels, length\]/);
  assert.throws(() => new Conv2d(gpu, 1, 1, 0), /kernelSize/);
  conv.dispose();
});

test('Linear is x W^T + b and leaves out the bias on request', async (t) => {
  const gpu = await gpuOf(t);
  const layer = new Linear(gpu, 3, 2, { rng: new Random(gpu, { seed: 4 }) });
  layer.weight.value.write([1, 2, 3, 4, 5, 6]);
  layer.bias.value.write([10, 20]);
  const x = tensor(gpu.array([1, 0, -1, 2, 2, 2], { shape: [2, 3] }));
  assert.deepEqual([...(await layer.forward(x).value.read())], [8, 18, 22, 50]);
  assert.equal(new Linear(gpu, 3, 2, { bias: false }).parameters().length, 1);
  const input = leaf(gpu, [2, 4, 3], 13);
  await gradCheck(gpu, [input, layer.weight, layer.bias], () => layer.forward(input));
});

test('LayerNorm normalizes the last dimension, and its gradients hold', async (t) => {
  const gpu = await gpuOf(t);
  const norm = new LayerNorm(gpu, 6),
    x = leaf(gpu, [3, 6], 14);
  const y = await norm.forward(x).value.read();
  for (let r = 0; r < 3; r++) {
    const row = [...y.slice(r * 6, r * 6 + 6)],
      mean = row.reduce((a, b) => a + b) / 6,
      variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / 6;
    assert.ok(Math.abs(mean) < 1e-5 && Math.abs(variance - 1) < 1e-3, `row ${r}: ${mean}, ${variance}`);
  }
  norm.weight.value.write(noise(6, 15));
  await gradCheck(gpu, [x, norm.weight, norm.bias], () => norm.forward(x), { tolerance: 3e-2 });
});

test('Embedding looks rows up and adds gradients of repeated ids', async (t) => {
  const gpu = await gpuOf(t);
  const table = new Embedding(gpu, 4, 3, { rng: new Random(gpu, { seed: 5 }) }),
    rows = await table.weight.value.read(),
    ids = tensor(gpu.array([2, 0, 2, 3], { dtype: 'i32', shape: [2, 2] }));
  using y = table.forward(ids);
  assert.deepEqual(y.shape, [2, 2, 3]);
  near(await y.value.read(), [...rows.slice(6, 9), ...rows.slice(0, 3), ...rows.slice(6, 9), ...rows.slice(9, 12)], 0);
  await gradCheck(gpu, [table.weight], () => table.forward(ids));
  table.weight.zeroGrad();
  using total = y.sum();
  total.backward();
  assert.deepEqual([...(await table.weight.grad.read())], [1, 1, 1, 0, 0, 0, 2, 2, 2, 1, 1, 1]);
});

// Attention as the definition states it, one head of [t, d].
function attend(q, k, v, t, s, d, causal) {
  const out = new Float32Array(t * d);
  for (let i = 0; i < t; i++) {
    const scores = [];
    for (let j = 0; j < s; j++) {
      let dot = 0;
      for (let e = 0; e < d; e++) dot += q[i * d + e] * k[j * d + e];
      scores.push(causal && j > i ? -Infinity : dot / Math.sqrt(d));
    }
    const top = Math.max(...scores),
      weights = scores.map((x) => Math.exp(x - top)),
      total = weights.reduce((a, b) => a + b);
    for (let j = 0; j < s; j++)
      for (let e = 0; e < d; e++) out[i * d + e] += (weights[j] / total) * v[j * d + e];
  }
  return out;
}

test('scaled dot-product attention equals the definition, causal or not', async (t) => {
  const gpu = await gpuOf(t),
    [tq, ts, d] = [4, 6, 3];
  const q = noise(tq * d, 16),
    k = noise(ts * d, 17),
    v = noise(ts * d, 18);
  const Q = leaf(gpu, [1, tq, d], 16),
    K = leaf(gpu, [1, ts, d], 17),
    V = leaf(gpu, [1, ts, d], 18);
  for (const causal of [false, true]) {
    using y = scaledDotProductAttention(Q, K, V, { causal });
    near(await y.value.read(), attend(q, k, v, tq, ts, d, causal), 1e-5, `causal ${causal}`);
    await gradCheck(gpu, [Q, K, V], () => scaledDotProductAttention(Q, K, V, { causal }));
  }
});

test('MultiHeadAttention: heads split the projection, a causal layer cannot see ahead, gradients reach every weight', async (t) => {
  const gpu = await gpuOf(t);
  const attention = new MultiHeadAttention(gpu, 4, 2, { causal: true, rng: new Random(gpu, { seed: 6 }) }),
    data = noise(2 * 3 * 4, 19),
    x = leaf(gpu, [2, 3, 4], 19);
  x.value.write(data);
  assert.equal(attention.parameters().length, 8);
  const first = await attention.forward(x).value.read();
  const changed = data.slice();
  changed[2 * 4] += 5; // batch 0, position 2.
  x.value.write(changed);
  const second = await attention.forward(x).value.read();
  near(first.slice(0, 8), second.slice(0, 8), 1e-6, 'earlier positions');
  assert.ok(Math.abs(first[8] - second[8]) > 1e-4, 'the changed position moved');
  x.value.write(data);
  await gradCheck(gpu, [x, attention.query.weight, attention.key.weight, attention.value.weight], () =>
    attention.forward(x),
  );
  assert.throws(() => new MultiHeadAttention(gpu, 5, 2), /split evenly/);
  const other = leaf(gpu, [2, 5, 4], 20),
    plain = new MultiHeadAttention(gpu, 4, 2, { rng: new Random(gpu, { seed: 7 }) });
  using cross = plain.forward(x, other);
  assert.deepEqual(cross.shape, [2, 3, 4]);
});

test('crossEntropy equals the definition, for 2D and 3D logits, and rejects a wrong label count', async (t) => {
  const gpu = await gpuOf(t);
  const logits = leaf(gpu, [4, 3], 21),
    labels = gpu.array([0, 2, 1, 1], 'u32'),
    x = await logits.value.read();
  let expected = 0;
  [0, 2, 1, 1].forEach((label, r) => {
    const row = [...x.slice(r * 3, r * 3 + 3)];
    expected -= row[label] - Math.log(row.reduce((a, b) => a + Math.exp(b), 0));
  });
  using loss = crossEntropy(logits, labels);
  near([await loss.item()], [expected / 4], 1e-5);
  await gradCheck(gpu, [logits], () => crossEntropy(logits, labels));
  const seq = leaf(gpu, [2, 2, 3], 22);
  await gradCheck(gpu, [seq], () => crossEntropy(seq, labels));
  assert.throws(() => crossEntropy(logits, gpu.array([0], 'u32')), /labels/);
});

test('mseLoss takes tensors or arrays', async (t) => {
  const gpu = await gpuOf(t);
  const p = parameter(gpu.array([1, 2, 3, 5]));
  using loss = mseLoss(p, gpu.array([1, 2, 3, 3]));
  assert.equal(await loss.item(), 1);
  loss.backward();
  assert.deepEqual([...(await p.grad.read())], [0, 0, 0, 1]);
});

test('SGD and its momentum follow the update rule', async (t) => {
  const gpu = await gpuOf(t);
  const p = parameter(gpu.array([1, -2])),
    array = p.value,
    opt = new SGD([p], { lr: 0.1, momentum: 0.9, weightDecay: 0.01 }),
    host = [1, -2],
    velocity = [0, 0];
  for (let step = 0; step < 5; step++) {
    opt.zeroGrad();
    using loss = p.mul(p).sum();
    loss.backward();
    opt.step();
    for (let i = 0; i < 2; i++) {
      const g = 2 * host[i] + 0.01 * host[i];
      velocity[i] = step ? 0.9 * velocity[i] + g : g;
      host[i] -= 0.1 * velocity[i];
    }
  }
  near(await p.value.read(), host, 1e-5);
  assert.equal(p.value, array, 'updates in place');
  const plain = parameter(gpu.array([3]));
  plain.accumulate(gpu.array([2]));
  new SGD([plain], { lr: 0.5 }).step();
  assert.deepEqual([...(await plain.value.read())], [2]);
  opt.dispose();
});

test('Adam and AdamW follow their update rules; decay differs as the papers say', async (t) => {
  const gpu = await gpuOf(t);
  for (const [Optimizer, decoupled] of [
    [Adam, false],
    [AdamW, true],
  ]) {
    const p = parameter(gpu.array([1, -2, 0.5])),
      opt = new Optimizer([p], { lr: 0.05, weightDecay: 0.1 }),
      host = [1, -2, 0.5],
      m = [0, 0, 0],
      v = [0, 0, 0];
    for (let step = 1; step <= 6; step++) {
      opt.zeroGrad();
      using loss = p.mul(p).sum();
      loss.backward();
      opt.step();
      for (let i = 0; i < 3; i++) {
        const g = 2 * host[i] + (decoupled ? 0 : 0.1 * host[i]);
        m[i] = 0.9 * m[i] + 0.1 * g;
        v[i] = 0.999 * v[i] + 0.001 * g * g;
        const update = (0.05 * m[i]) / (1 - 0.9 ** step) / (Math.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8);
        host[i] = (decoupled ? host[i] * (1 - 0.05 * 0.1) : host[i]) - update;
      }
    }
    near(await p.value.read(), host, 1e-5, Optimizer.name);
    opt.dispose();
  }
  assert.throws(() => new Adam([]), RangeError);
  assert.throws(() => new Adam([parameter(gpu.zeros(1))], { lr: 0 }), RangeError);
});

test('an optimizer skips parameters without a gradient and takes a new learning rate', async (t) => {
  const gpu = await gpuOf(t);
  const used = parameter(gpu.array([1])),
    unused = parameter(gpu.array([5])),
    opt = new SGD([used, unused], { lr: 1 });
  opt.lr = 0.25;
  using loss = used.sum();
  loss.backward();
  opt.step();
  assert.deepEqual([...(await used.value.read()), ...(await unused.value.read())], [0.75, 5]);
});

test('a small network learns XOR', async (t) => {
  const gpu = await gpuOf(t),
    rand = new Random(gpu, { seed: 8 });
  using model = new Sequential(new Linear(gpu, 2, 8, { rng: rand }), new Tanh(), new Linear(gpu, 8, 1, { rng: rand }));
  using opt = new Adam(model.parameters(), { lr: 0.05 });
  const x = gpu.array([0, 0, 0, 1, 1, 0, 1, 1], { shape: [4, 2] }),
    y = gpu.array([0, 1, 1, 0], { shape: [4, 1] });
  let last = Infinity;
  for (let step = 0; step < 300; step++) {
    opt.zeroGrad();
    using loss = mseLoss(model.forward(tensor(x)), y);
    loss.backward();
    opt.step();
    last = await loss.item();
  }
  assert.ok(last < 0.005, `loss ${last}`);
  near(await model.predict(x).read(), [0, 1, 1, 0], 0.2);
});

test('a small convolutional network learns to tell two patterns apart', async (t) => {
  const gpu = await gpuOf(t),
    rand = new Random(gpu, { seed: 9 }),
    r = rng(10);
  using model = new Sequential(
    new Conv2d(gpu, 1, 4, 3, { padding: 1, rng: rand }),
    new ReLU(),
    new MaxPool2d(2),
    new Flatten(),
    new Linear(gpu, 4 * 3 * 3, 2, { rng: rand }),
  );
  using opt = new AdamW(model.parameters(), { lr: 0.02 });
  const n = 16,
    images = new Float32Array(n * 36),
    labels = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    labels[s] = s % 2;
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 6; x++)
        images[s * 36 + y * 6 + x] = (labels[s] ? x % 2 : y % 2) + r() * 0.2; // stripes one way or the other.
  }
  const x = gpu.array(images, { shape: [n, 1, 6, 6] }),
    y = gpu.array(labels);
  let last = Infinity;
  for (let step = 0; step < 60; step++) {
    opt.zeroGrad();
    using loss = crossEntropy(model.forward(tensor(x)), y);
    loss.backward();
    opt.step();
    last = await loss.item();
  }
  assert.ok(last < 0.05, `loss ${last}`);
  const logits = await model.predict(x).read();
  for (let s = 0; s < n; s++) assert.equal(logits[2 * s + 1] > logits[2 * s] ? 1 : 0, labels[s], `sample ${s}`);
});

test('a training loop allocates nothing that outlives its step', async (t) => {
  const gpu = await gpuOf(t);
  let live = 0;
  const empty = gpu.empty.bind(gpu),
    track = gpu.track.bind(gpu),
    forget = gpu.forget.bind(gpu);
  gpu.empty = (...args) => (live++, empty(...args));
  gpu.track = (array) => (live++, track(array));
  gpu.forget = (array) => (live--, forget(array));
  const rand = new Random(gpu, { seed: 11 }),
    model = new Sequential(
      new Conv2d(gpu, 1, 2, 3, { padding: 1, rng: rand }),
      new GELU(),
      new MaxPool2d(2),
      new Flatten(),
      new LayerNorm(gpu, 2 * 2 * 2),
      new Dropout(0.1, { rng: rand }),
      new Linear(gpu, 8, 2, { rng: rand }),
    ),
    attention = new MultiHeadAttention(gpu, 8, 2, { causal: true, rng: rand }),
    table = new Embedding(gpu, 5, 8, { rng: rand }),
    params = [...model.parameters(), ...attention.parameters(), ...table.parameters()],
    opt = new Adam(params, { lr: 0.01 }),
    x = gpu.array(noise(2 * 16, 23), { shape: [2, 1, 4, 4] }),
    ids = gpu.array([1, 2, 3, 4], { dtype: 'i32', shape: [2, 2] }),
    labels = gpu.array([0, 1], 'u32');
  const step = () => {
    opt.zeroGrad();
    using a = crossEntropy(model.forward(tensor(x)), labels);
    a.backward();
    using b = attention.forward(table.forward(tensor(ids))).mul(0.5).mean();
    b.backward();
    opt.step();
  };
  step(); // Tables and optimizer state are made once.
  step();
  const settled = live;
  for (let k = 0; k < 5; k++) step();
  assert.equal(live, settled);
  using out = noGrad(() => model.eval().forward(tensor(x)));
  out.dispose();
  const y = model.predict(x);
  assert.equal(live, settled + 1, 'predict keeps only its result');
  y.dispose();
  model.train();
  assert.equal(live, settled);
  opt.zeroGrad();
  opt.dispose();
  model.dispose();
  attention.dispose();
  table.dispose();
  for (const a of [x, ids, labels]) a.dispose();
  assert.equal(live, 0);
});

test('noGrad records nothing and backward says why', async (t) => {
  const gpu = await gpuOf(t);
  const p = parameter(gpu.array([1, 2]));
  const y = noGrad(() => p.mul(2).sum());
  assert.equal(y.requiresGrad, false);
  assert.throws(() => y.backward(), /depends on a parameter/);
  assert.throws(() => p.mul(2).backward(), /needs a seed/);
  const seeded = p.mul(3);
  seeded.backward(gpu.array([1, 2]));
  assert.deepEqual([...(await p.grad.read())], [3, 6]);
  assert.throws(() => tensor([1, 2]), /GpuArray/);
});

test('gradients add up over several backward calls until zeroGrad, also where a tensor is used twice', async (t) => {
  const gpu = await gpuOf(t);
  const p = parameter(gpu.array([2]));
  for (let k = 0; k < 2; k++) {
    using loss = p.mul(p).add(p).sum();
    loss.backward();
  }
  assert.deepEqual([...(await p.grad.read())], [10]);
  p.zeroGrad();
  assert.equal(p.grad, undefined);
});

test('a network deeper than the call stack differentiates', async (t) => {
  const gpu = await gpuOf(t);
  const p = parameter(gpu.array([1]));
  let y = p;
  for (let k = 0; k < 20_000; k++) y = y.add(1);
  using loss = y.sum();
  loss.backward();
  assert.deepEqual([...(await p.grad.read())], [1]);
  y.dispose();
});

test('Dropout scales what it keeps, repeats by seed, and is off in evaluation', async (t) => {
  const gpu = await gpuOf(t);
  const x = parameter(gpu.ones(10000));
  const y = await dropout(x, 0.25, new Random(gpu, { seed: 1 })).value.read();
  const kept = y.filter((v) => v !== 0);
  near([...new Set(kept)], [1 / 0.75], 1e-6);
  assert.ok(Math.abs(kept.length / 10000 - 0.75) < 0.02, `kept ${kept.length}`);
  const again = await dropout(x, 0.25, new Random(gpu, { seed: 1 })).value.read();
  assert.deepEqual(y, again);
  const layer = new Dropout(0.5).eval();
  assert.equal(layer.forward(x), x);
  assert.throws(() => new Dropout(1), RangeError);
});

test('state dictionaries restore a network, and refuse a wrong one', async (t) => {
  const gpu = await gpuOf(t);
  const make = (seed) => {
    const rand = new Random(gpu, { seed });
    return new Sequential(new Linear(gpu, 3, 2, { rng: rand }), new LayerNorm(gpu, 2));
  };
  const a = make(1),
    b = make(2),
    x = gpu.array(noise(6, 24), { shape: [2, 3] });
  const state = await a.stateDict();
  assert.deepEqual(Object.keys(state), ['layers.0.weight', 'layers.0.bias', 'layers.1.weight', 'layers.1.bias']);
  b.loadStateDict(state);
  near(await b.predict(x).read(), await a.predict(x).read(), 0);
  assert.throws(() => b.loadStateDict({}), /no parameter layers.0.weight/);
  assert.throws(() => b.loadStateDict({ ...state, 'layers.0.bias': [1] }), /has 1 values/);
});

test('train and eval reach nested layers', async (t) => {
  const gpu = await gpuOf(t);
  const inner = new Dropout(0.5),
    model = new Sequential(new Sequential(inner));
  model.eval();
  assert.equal(inner.training, false);
  model.train();
  assert.equal(inner.training, true);
  gpu.check();
});
