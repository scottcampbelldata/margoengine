import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { createCpuWasm } from '@margoengine/compute/cpu-wasm';
import { BatchNorm, GroupNorm, ConvTranspose2d, LSTM, GRU, upsample } from '@margoengine/compute/nn-extra';
import { tensor, parameter, noGrad } from '@margoengine/compute/nn';
import { nnExtraCases } from './nn-extra-cases.js';

for (const [name, factory] of [
  ['cpu', () => createCompute({ backend: 'cpu' })],
  ['cpu-wasm', createCpuWasm],
])
  test(`nn-extra analytic, gradient and persistence cases on ${name}`, { timeout: 120000 }, async () => {
    using c = await factory();
    assert.ok((await nnExtraCases(c)) >= 35);
  });

test('nn-extra validates geometry, state and interpolation without accepting malformed options', async () => {
  using c = await createCompute({ backend: 'cpu' });
  assert.throws(() => new BatchNorm(c, 0), RangeError);
  assert.throws(() => new BatchNorm(c, 2, { eps: 0 }), RangeError);
  assert.throws(() => new BatchNorm(c, 2, { momentum: 2 }), RangeError);
  assert.throws(() => new GroupNorm(c, 3, 4), RangeError);
  assert.throws(() => new ConvTranspose2d(c, 3, 4, 2, { groups: 2 }), RangeError);
  assert.throws(() => new ConvTranspose2d(c, 1, 1, 2, { outputPadding: 1 }), RangeError);
  const x = tensor(c.ones([1, 1, 2, 2]));
  assert.throws(() => upsample(x, { size: 4, scaleFactor: 2 }), RangeError);
  assert.throws(() => upsample(x, { size: [0, 2] }), RangeError);
  assert.throws(() => upsample(x, { mode: 'trilinear' }), RangeError);
  using bn = new BatchNorm(c, 1);
  assert.throws(() => bn.forward(tensor(c.ones([1, 1]))), RangeError);
  using lstm = new LSTM(c, 1, 2);
  assert.throws(() => lstm.run(tensor(c.ones([2, 1, 1])), { lengths: [3] }), RangeError);
  using gru = new GRU(c, 1, 2);
  assert.throws(() => gru.run(tensor(c.ones([2, 1, 1])), { c: tensor(c.zeros([1, 1, 2])) }), TypeError);
});

test('nn-extra gradients match finite differences and forward/backward releases all temporary arrays', async () => {
  using c = await createCompute({ backend: 'cpu' });
  const allocate = c.allocate.bind(c);
  let live = 0;
  c.allocate = (...args) => {
    const b = allocate(...args),
      destroy = b.destroy.bind(b);
    live++;
    let freed = false;
    b.destroy = () => {
      if (!freed) {
        freed = true;
        live--;
      }
      destroy();
    };
    return b;
  };
  for (const [layer, values, shape] of [
    [new BatchNorm(c, 2, { momentum: 0.1 }), [0.1, 0.3, 0.7, -0.2, 0.4, 0.9], [3, 2]],
    [new GroupNorm(c, 2, 4), [0.1, 0.3, 0.7, -0.2, 0.4, 0.9, 0.2, 0.6], [1, 4, 2]],
    [new ConvTranspose2d(c, 1, 1, 2, { stride: 2 }), [0.1, 0.3, 0.7, -0.2], [1, 1, 2, 2]],
    [new LSTM(c, 1, 1, { numLayers: 2, bidirectional: true }), [0.1, 0.3], [2, 1, 1]],
    [new GRU(c, 1, 1, { numLayers: 2, bidirectional: true }), [0.1, 0.3], [2, 1, 1]],
  ]) {
    const x = parameter(c.array(values, { shape })),
      baseline = live,
      y = layer.forward(x),
      loss = y.mul(y).sum();
    loss.backward();
    const analytic = Array.from(await x.grad.read());
    for (let i = 0; i < values.length; i++) {
      const v = values.slice(),
        delta = 1e-3;
      v[i] += delta;
      x.value.write(v);
      const p = noGrad(() => layer.forward(x)),
        pa = Array.from(await p.read());
      p.dispose();
      v[i] -= 2 * delta;
      x.value.write(v);
      const m = noGrad(() => layer.forward(x)),
        ma = Array.from(await m.read());
      m.dispose();
      const numerical = (pa.reduce((a, b) => a + b * b, 0) - ma.reduce((a, b) => a + b * b, 0)) / (2 * delta);
      assert.ok(
        Math.abs(analytic[i] - numerical) < 2e-3,
        `${layer.constructor.name} input ${i}: ${analytic[i]} != ${numerical}`,
      );
    }
    x.value.write(values);
    loss.dispose();
    x.zeroGrad();
    for (const p of layer.parameters()) p.zeroGrad();
    assert.equal(live, baseline, `${layer.constructor.name} temporary array leak`);
    layer.dispose();
    x.value.dispose();
  }
  assert.equal(live, 0);
});
