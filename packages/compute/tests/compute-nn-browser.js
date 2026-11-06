// Real-GPU checks of @margoengine/compute/nn: the same network on WebGPU and on the CPU backend, from the same weights,
// must agree on outputs, losses and every gradient, and it must train on the GPU. tests/nn.test.js checks the layers
// against their definitions and central differences on the CPU backend.
import { createCompute } from '@margoengine/compute';
import { Random } from '@margoengine/compute/random';
import {
  Adam,
  AvgPool2d,
  Conv2d,
  Dropout,
  Embedding,
  Flatten,
  GELU,
  LayerNorm,
  Linear,
  MaxPool2d,
  MultiHeadAttention,
  ReLU,
  Sequential,
  crossEntropy,
  tensor,
} from '@margoengine/compute/nn';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
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
const noise = (n, seed) => {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => r() * 2);
};
const near = (a, b, tolerance, label) => {
  assert(a.length === b.length, `${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++)
    if (!(Math.abs(a[i] - b[i]) <= tolerance)) throw new Error(`${label}[${i}]: gpu ${a[i]}, cpu ${b[i]}`);
};

const convNet = (gpu, seed) => {
  const r = new Random(gpu, { seed });
  return new Sequential(
    new Conv2d(gpu, 2, 6, 3, { padding: 1, rng: r }),
    new GELU(),
    new MaxPool2d(2),
    new Conv2d(gpu, 6, 4, 3, { stride: 2, padding: 1, rng: r }),
    new ReLU(),
    new AvgPool2d(2),
    new Flatten(),
    new LayerNorm(gpu, 4 * 2 * 2),
    new Dropout(0.5, { rng: r }),
    new Linear(gpu, 16, 3, { rng: r }),
  );
};

class Block extends Sequential {
  constructor(gpu, seed) {
    const r = new Random(gpu, { seed });
    super();
    this.table = new Embedding(gpu, 11, 16, { rng: r });
    this.attention = new MultiHeadAttention(gpu, 16, 4, { causal: true, rng: r });
    this.norm = new LayerNorm(gpu, 16);
    this.head = new Linear(gpu, 16, 11, { rng: r });
  }
  forward(ids) {
    const x = this.table.forward(ids);
    return this.head.forward(this.norm.forward(x.add(this.attention.forward(x))));
  }
}

async function gradsOf(model) {
  const out = {};
  for (const [name, p] of model.namedParameters()) out[name] = await p.grad.read();
  return out;
}

window.runNnTests = async () => {
  const gpu = await createCompute({ backend: 'webgpu' }),
    cpu = await createCompute({ backend: 'cpu' });
  try {
    await check('a convolutional network agrees with the CPU backend, gradients included', async () => {
      const images = noise(4 * 2 * 16 * 16, 1),
        labels = [0, 2, 1, 2];
      const run = async (context, state) => {
        const model = convNet(context, 5).eval();
        if (state) model.loadStateDict(state);
        const x = tensor(context.array(images, { shape: [4, 2, 16, 16] }));
        using logits = model.forward(x);
        using loss = crossEntropy(logits, context.array(labels, 'u32'));
        loss.backward();
        return {
          model,
          logits: await logits.value.read(),
          loss: await loss.item(),
          grads: await gradsOf(model),
        };
      };
      const a = await run(gpu),
        b = await run(cpu, await a.model.stateDict());
      near(a.logits, b.logits, 1e-4, 'logits');
      near([a.loss], [b.loss], 1e-5, 'loss');
      for (const name of Object.keys(a.grads)) near(a.grads[name], b.grads[name], 1e-4, name);
      a.model.dispose();
      b.model.dispose();
    });
    await check('a causal attention block agrees with the CPU backend, gradients included', async () => {
      const ids = [1, 4, 2, 9, 9, 3, 0, 7, 5, 5, 6, 10],
        targets = [4, 2, 9, 9, 3, 0, 7, 5, 5, 6, 10, 1];
      const run = async (context, state) => {
        const model = new Block(context, 6);
        if (state) model.loadStateDict(state);
        using logits = model.forward(tensor(context.array(ids, { dtype: 'i32', shape: [2, 6] })));
        using loss = crossEntropy(logits, context.array(targets, 'u32'));
        loss.backward();
        return { model, loss: await loss.item(), grads: await gradsOf(model) };
      };
      const a = await run(gpu),
        b = await run(cpu, await a.model.stateDict());
      near([a.loss], [b.loss], 1e-5, 'loss');
      for (const name of Object.keys(a.grads)) near(a.grads[name], b.grads[name], 1e-4, name);
      a.model.dispose();
      b.model.dispose();
    });
    await check('convolution gradients repeat exactly from run to run', async () => {
      const model = convNet(gpu, 7).eval(),
        x = tensor(gpu.array(noise(4 * 2 * 16 * 16, 2), { shape: [4, 2, 16, 16] }), { requiresGrad: true }),
        labels = gpu.array([1, 1, 0, 2], 'u32');
      const once = async () => {
        for (const p of [...model.parameters(), x]) p.zeroGrad();
        using loss = crossEntropy(model.forward(x), labels);
        loss.backward();
        return [await x.grad.read(), ...Object.values(await gradsOf(model))];
      };
      const first = await once(),
        second = await once();
      first.forEach((grad, k) => near(grad, second[k], 0, `gradient ${k}`));
      model.dispose();
    });
    await check('a network trains on the GPU', async () => {
      const r = new Random(gpu, { seed: 8 }),
        n = 32,
        images = new Float32Array(n * 64),
        labels = new Uint32Array(n),
        wobble = rng(9);
      for (let s = 0; s < n; s++) {
        labels[s] = s % 2;
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) images[s * 64 + y * 8 + x] = (labels[s] ? x % 2 : y % 2) + wobble() * 0.2;
      }
      const model = new Sequential(
          new Conv2d(gpu, 1, 4, 3, { padding: 1, rng: r }),
          new ReLU(),
          new MaxPool2d(2),
          new Flatten(),
          new Linear(gpu, 64, 2, { rng: r }),
        ),
        opt = new Adam(model.parameters(), { lr: 0.02 }),
        x = gpu.array(images, { shape: [n, 1, 8, 8] }),
        y = gpu.array(labels);
      let last = Infinity;
      for (let step = 0; step < 60; step++) {
        opt.zeroGrad();
        using loss = crossEntropy(model.forward(tensor(x)), y);
        loss.backward();
        opt.step();
        if (step === 59) last = await loss.item();
      }
      assert(last < 0.05, `loss ${last}`);
      const logits = await model.predict(x).read();
      for (let s = 0; s < n; s++)
        assert((logits[2 * s + 1] > logits[2 * s] ? 1 : 0) === labels[s], `sample ${s} is wrong`);
      opt.dispose();
      model.dispose();
    });
    return { checks };
  } finally {
    gpu.dispose();
    cpu.dispose();
  }
};
