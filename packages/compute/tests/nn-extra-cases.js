import { BatchNorm, GroupNorm, ConvTranspose2d, LSTM, GRU, Upsample, upsample } from '../dist/nn-extra.js';
import { tensor, parameter, Sequential, noGrad } from '../dist/nn.js';

export async function nnExtraCases(c) {
  let checks = 0;
  const eq = (a, b, tol = 1e-5) => {
    if (
      a.length !== b.length ||
      a.some(
        (v, i) =>
          !(
            Object.is(v, b[i]) ||
            (Number.isNaN(v) && Number.isNaN(b[i])) ||
            Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(b[i]))
          ),
      )
    )
      throw Error(`NN extra case ${checks}: ${a} != ${b}`);
    checks++;
  };
  const read = async (a) => Array.from(await a.read());
  const make = (values, shape, grad = false) => (grad ? parameter : tensor)(c.array(values, { shape }));
  {
    using bn = new BatchNorm(c, 2, { momentum: 1 });
    bn.weight.value.write([2, 3]);
    bn.bias.value.write([0.5, -0.5]);
    const x = make([1, 2, 3, 6], [2, 2]);
    using y = bn.forward(x);
    eq(await read(y), [
      0.5 - 2 / Math.sqrt(1.00001),
      -0.5 - 6 / Math.sqrt(4.00001),
      0.5 + 2 / Math.sqrt(1.00001),
      -0.5 + 6 / Math.sqrt(4.00001),
    ]);
    eq(await read(bn.runningMean), [2, 4], 0);
    eq(await read(bn.runningVar), [2, 8], 0);
    bn.eval();
    using z = bn.forward(x);
    eq(await read(z), [
      0.5 - 2 / Math.sqrt(2.00001),
      -0.5 - 6 / Math.sqrt(8.00001),
      0.5 + 2 / Math.sqrt(2.00001),
      -0.5 + 6 / Math.sqrt(8.00001),
    ]);
  }
  {
    using model = new Sequential(new Sequential(new BatchNorm(c, 1, { momentum: null }))),
      clone = new Sequential(new Sequential(new BatchNorm(c, 1, { momentum: null })));
    model.forward(make([1, 3], [2, 1])).dispose();
    model.forward(make([3, 5], [2, 1])).dispose();
    const state = await model.stateDict();
    eq(Array.from(state['layers.0.layers.0.runningMean']), [3], 0);
    eq(Array.from(state['layers.0.layers.0.runningVar']), [2], 0);
    clone.loadStateDict(state);
    eq([clone.layers[0].layers[0].batchesTracked], [2], 0);
    const x = c.array([2, 6], { shape: [2, 1] });
    eq(await read(model.predict(x)), await read(clone.predict(x)), 0);
    const before = (await clone.stateDict())['layers.0.layers.0.runningMean'][0];
    state['layers.0.layers.0.runningMean'][0] = 999;
    eq([(await clone.stateDict())['layers.0.layers.0.runningMean'][0]], [before], 0);
  }
  {
    using gn = new GroupNorm(c, 2, 4, { affine: false });
    const x = make([1, 3, 2, 6, 10, 14, 9, 13], [1, 4, 2]);
    using y = gn.forward(x);
    const a = [1, 3, 2, 6],
      b = [10, 14, 9, 13],
      norm = (v) => {
        const m = v.reduce((a, b) => a + b) / v.length,
          s = v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
        return v.map((x) => (x - m) / Math.sqrt(s + 1e-5));
      };
    eq(await read(y), [...norm(a), ...norm(b)]);
    gn.eval();
    using z = gn.forward(x);
    eq(await read(z), await read(y), 0);
  }
  {
    using layer = new ConvTranspose2d(c, 1, 1, 2, { bias: false });
    layer.weight.value.write([1, 1, 1, 1]);
    const x = make([1, 2, 3, 4], [1, 1, 2, 2], true);
    using y = layer.forward(x);
    eq(await read(y), [1, 3, 2, 4, 10, 6, 3, 7, 4], 0);
    using loss = y.sum();
    loss.backward();
    eq(await read(x.grad), [4, 4, 4, 4], 0);
    eq(await read(layer.weight.grad), [10, 10, 10, 10], 0);
  }
  {
    using layer = new ConvTranspose2d(c, 2, 2, [2, 3], {
      groups: 2,
      stride: [2, 1],
      dilation: [1, 2],
      padding: [1, 1],
      outputPadding: [1, 0],
    });
    const raw = [1, 2, 3, 4, 5, 6, 7, 8],
      weights = Array.from({ length: 12 }, (_, i) => ((i % 5) - 2) / 4);
    layer.weight.value.write(weights);
    layer.bias.value.write([0.25, -0.5]);
    using y = layer.forward(make(raw, [1, 2, 2, 2]));
    const [, co, oh, ow] = y.shape,
      expected = Array.from({ length: co * oh * ow }, (_, i) => (i < oh * ow ? 0.25 : -0.5));
    for (let ch = 0; ch < 2; ch++)
      for (let iy = 0; iy < 2; iy++)
        for (let ix = 0; ix < 2; ix++)
          for (let ky = 0; ky < 2; ky++)
            for (let kx = 0; kx < 3; kx++) {
              const oy = iy * 2 - 1 + ky,
                ox = ix - 1 + kx * 2;
              if (oy >= 0 && oy < oh && ox >= 0 && ox < ow)
                expected[(ch * oh + oy) * ow + ox] += raw[(ch * 2 + iy) * 2 + ix] * weights[(ch * 2 + ky) * 3 + kx];
            }
    eq(await read(y), expected, 0);
    using gap = new ConvTranspose2d(c, 1, 1, 1, { bias: false, stride: 2 });
    gap.weight.value.write([1]);
    using z = gap.forward(make([NaN, 2], [1, 1, 1, 2]));
    eq(await read(z), [NaN, 0, 2], 0);
  }
  {
    const x = make([1, 3], [1, 1, 2]);
    using nearest = upsample(x, { scaleFactor: 2 });
    eq(await read(nearest), [1, 1, 3, 3], 0);
    using linear = upsample(x, { size: 4, mode: 'linear' });
    eq(await read(linear), [1, 1.5, 2.5, 3], 0);
    using aligned = upsample(x, { size: 4, mode: 'linear', alignCorners: true });
    eq(await read(aligned), [1, 5 / 3, 7 / 3, 3]);
    using image = upsample(make([0, 2, 4, 6], [1, 1, 2, 2]), { size: [3, 3], mode: 'bilinear', alignCorners: true });
    eq(await read(image), [0, 1, 2, 2, 3, 4, 4, 5, 6], 0);
    using volume = upsample(make([1, 2], [1, 1, 1, 1, 2]), { scaleFactor: [2, 2, 2], mode: 'trilinear' });
    eq(await read(volume), Array(4).fill([1, 1.25, 1.75, 2]).flat(), 0);
    using bicubic = new Upsample({ size: [5, 7], mode: 'bicubic' });
    using constant = bicubic.forward(make([1, 1, 1, 1], [1, 1, 2, 2]));
    eq(await read(constant), Array(35).fill(1), 3e-7);
    const v = make([1, 3], [1, 1, 2], true);
    using z = upsample(v, { size: 4, mode: 'linear' });
    using loss = z.sum();
    loss.backward();
    eq(await read(v.grad), [2, 2], 0);
  }
  for (const Class of [LSTM, GRU]) {
    using layer = new Class(c, 1, 1, { bias: false });
    layer.cells[0].weightHH.value.write(new Float32Array(Class === LSTM ? 4 : 3));
    layer.cells[0].weightIH.value.write(Class === LSTM ? [1, 0, 1, 0] : [0, 0, 1]);
    const x = make([1, 2], [2, 1, 1], true),
      result = layer.run(x),
      s = (v) => 1 / (1 + Math.exp(-v));
    let h = 0,
      v = 0;
    const expected = [];
    for (const input of [1, 2]) {
      if (Class === LSTM) {
        v = 0.5 * v + s(input) * Math.tanh(input);
        h = 0.5 * Math.tanh(v);
      } else h = 0.5 * Math.tanh(input) + 0.5 * h;
      expected.push(h);
    }
    eq(await read(result.output), expected, 3e-7);
    eq(await read(result.h), [h], 3e-7);
    if (result.c) eq(await read(result.c), [v], 3e-7);
    using loss = result.output.mul(result.output).sum();
    loss.backward();
    const analytic = await read(x.grad),
      numerical = [];
    for (let i = 0; i < 2; i++) {
      const values = [1, 2],
        delta = 1e-3;
      values[i] += delta;
      using plus = noGrad(() => layer.forward(make(values, [2, 1, 1])));
      const pa = await read(plus);
      values[i] -= 2 * delta;
      using minus = noGrad(() => layer.forward(make(values, [2, 1, 1])));
      const ma = await read(minus);
      numerical.push((pa.reduce((a, b) => a + b * b, 0) - ma.reduce((a, b) => a + b * b, 0)) / (2 * delta));
    }
    eq(analytic, numerical, 2e-4);
    result.h.value.dispose();
    result.c?.value.dispose();
    result.output.dispose();
    using bi = new Class(c, 1, 1, { numLayers: 2, bidirectional: true, batchFirst: true, dropout: 0 });
    const stateH = make(Array(8).fill(0.2), [4, 2, 1]),
      stateC = Class === LSTM ? make(Array(8).fill(0.3), [4, 2, 1]) : undefined;
    const padded = bi.run(make([1, 2, 3, 4, 5, 6], [2, 3, 1]), { h: stateH, c: stateC, lengths: [3, 0] });
    eq(padded.output.shape, [2, 3, 2], 0);
    eq((await read(padded.output)).slice(6), Array(6).fill(0), 0);
    const final = await read(padded.h);
    eq([final[1], final[3], final[5], final[7]], [0.2, 0.2, 0.2, 0.2], 1e-7);
    const saved = await bi.stateDict();
    using clone = new Class(c, 1, 1, { numLayers: 2, bidirectional: true, batchFirst: true });
    clone.loadStateDict(saved);
    eq(
      await read(bi.predict(c.array([1, 2], { shape: [1, 2, 1] }))),
      await read(clone.predict(c.array([1, 2], { shape: [1, 2, 1] }))),
      0,
    );
    padded.output.dispose();
    padded.h.value.dispose();
    padded.c?.value.dispose();
  }
  return checks;
}
