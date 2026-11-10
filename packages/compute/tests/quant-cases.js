import { quantize, quantizedTensor, quantizedMatmul, quantizedConv2d } from '../dist/quant.js';

const product = (s) => s.reduce((a, b) => a * b, 1);
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const near = (actual, expected, bound, message) =>
  assert(Math.abs(actual - expected) <= bound, `${message}: ${actual} != ${expected}, bound ${bound}`);
const values = (n, seed) => Array.from({ length: n }, (_, i) => Math.sin(i * 2.19 + seed) * 1.5);
const even = (x) => {
  const n = Math.floor(x);
  return x - n === 0.5 ? n + (Math.abs(n) % 2) : Math.round(x);
};
const clip = (v) => Math.max(-128, Math.min(127, v));

// Independent float64 contraction oracle, with quantization error propagation.
// No loop, indexing helper or rounding implementation is imported from the entry.
async function verify(a, b, output, terms, options, originalA, originalB, biasChannel, note) {
  const [ar, br, yr, yq, aq, bq] = await Promise.all([
    a.dequantize(),
    b.dequantize(),
    output.dequantize(),
    output.read(),
    a.read(),
    b.read(),
  ]);
  const axisChannel = (t, i) =>
    t.axis === undefined ? 0 : Math.floor(i / product(t.shape.slice(t.axis + 1))) % t.shape[t.axis];
  let checks = 0;
  for (let i = 0; i < yr.length; i++) {
    const pairs = terms(i),
      bc = biasChannel(i);
    let exact = 0,
      real = 0,
      error = 0,
      magnitude = 0;
    let channelA = 0,
      channelB = b.axis === undefined ? 0 : bc;
    for (const [ai, bi] of pairs) {
      if (ai < 0) continue;
      channelA = axisChannel(a, ai);
      channelB = axisChannel(b, bi);
      const x = (aq[ai] - a.zeroPoints[channelA]) * a.scales[channelA],
        w = (bq[bi] - b.zeroPoints[channelB]) * b.scales[channelB];
      exact += x * w;
      magnitude += Math.abs(x * w);
      real += originalA[ai] * originalB[bi];
      const ex = a.scales[channelA] / 2,
        ew = b.scales[channelB] / 2;
      error += Math.abs(originalA[ai]) * ew + Math.abs(originalB[bi]) * ex + ex * ew;
      near(ar[ai], x, Math.abs(x) * 2 ** -23, `${note} dequant a`);
      near(br[bi], w, Math.abs(w) * 2 ** -23, `${note} dequant b`);
    }
    const bias = (options.bias?.[bc] ?? 0) * a.scales[channelA] * b.scales[channelB];
    exact += bias;
    real += bias;
    magnitude += Math.abs(bias);
    const scale = output.scales[0],
      zero = output.zeroPoints[0];
    const saturated = (v) => (clip(v / scale + zero) - zero) * scale;
    const rounding = scale / 2 + 8 * 2 ** -24 * (magnitude + Math.abs(exact) + scale * Math.abs(zero));
    near(yr[i], saturated(exact), rounding, `${note} quantized-float oracle ${i}`);
    near(yr[i], saturated(real), error + rounding, `${note} original-float error propagation ${i}`);
    // For dyadic multipliers at these small magnitudes this is an exact integer byte oracle.
    if (a.scales.every((s) => s === 0.125) && b.scales.every((s) => s === 0.25) && scale === 0.5)
      assert(yq[i] === clip(even(exact / scale) + zero), `${note} integer byte oracle ${i}`);
    checks++;
  }
  return checks;
}

/** The same float-reference cases run on TS CPU, WebGPU and the WebGL2 compute layer. */
export async function quantCases(c) {
  let checks = 0;
  {
    using q = quantizedTensor(
      c,
      Int8Array.from({ length: 259 }, (_, i) => i - 128),
      [259],
      { scale: 0.25, zeroPoint: -7 },
    );
    const bytes = await q.read();
    assert(
      bytes.every((v, i) => v === (i % 256) - 128),
      'signed packing, tails and read',
    );
    assert(q.packed.size === 65, 'four bytes packed per storage element');
    using ties = quantize(c, [-1000, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 1000], [8], { scale: 1 });
    assert(String(await ties.read()) === '-128,-2,-2,0,0,2,2,127', 'nearest-even with signed saturation');
    checks += 3;
  }
  for (const [as, bs] of [
    [
      [2, 3],
      [3, 5],
    ],
    [[3], [3]],
    [[3], [2, 3, 5]],
    [[2, 4, 3], [3]],
    [
      [2, 1, 3, 7],
      [1, 3, 7, 5],
    ],
    [
      [1, 0],
      [0, 3],
    ],
    [
      [0, 2, 3],
      [3, 4],
    ],
    [
      [17, 13],
      [13, 19],
    ],
  ])
    for (const perChannel of [false, true]) {
      const av = as.length === 1,
        bv = bs.length === 1,
        ap = av ? [1, ...as] : [...as],
        bp = bv ? [...bs, 1] : [...bs],
        rank = Math.max(ap.length, bp.length),
        m = ap.at(-2),
        k = ap.at(-1),
        n = bp.at(-1);
      while (ap.length < rank) ap.unshift(1);
      while (bp.length < rank) bp.unshift(1);
      const batch = ap.slice(0, -2).map((v, i) => (v === 1 ? bp[i] : v)),
        shape = [...batch, ...(av ? [] : [m]), ...(bv ? [] : [n])],
        aa = values(product(as), 1),
        bb = values(product(bs), 2),
        qa =
          perChannel && !av
            ? { scale: Array(m).fill(0.013), zeroPoint: Array(m).fill(-3), axis: -2 }
            : { scale: 0.125, zeroPoint: -3 },
        qb =
          perChannel && !bv
            ? { scale: Array.from({ length: n }, (_, i) => 0.014 + i * 0.0003), zeroPoint: Array(n).fill(5), axis: -1 }
            : { scale: 0.25, zeroPoint: 5 },
        options = { output: { scale: 0.5, zeroPoint: -9 }, bias: Int32Array.from({ length: n }, (_, i) => i - 2) };
      using a = quantize(c, aa, as, qa);
      using b = quantize(c, bb, bs, qb);
      using y = await quantizedMatmul(a, b, options);
      assert(String(y.shape) === String(shape), 'matmul vector/batch shape');
      const terms = (i) => {
        let batchIndex = Math.floor(i / (m * n)),
          ao = 0,
          bo = 0;
        for (let d = batch.length - 1; d >= 0; d--) {
          const coord = batchIndex % batch[d];
          batchIndex = Math.floor(batchIndex / batch[d]);
          if (ap[d] !== 1) ao += coord * product(ap.slice(d + 1));
          if (bp[d] !== 1) bo += coord * product(bp.slice(d + 1));
        }
        return Array.from({ length: k }, (_, j) => [ao + (Math.floor(i / n) % m) * k + j, bo + j * n + (i % n)]);
      };
      checks += await verify(a, b, y, terms, options, aa, bb, (i) => i % n, 'matmul');
      checks++;
    }
  for (const spec of [
    { input: [2, 2, 4, 5], weights: [3, 2, 2, 3], pad: [1, 2, 0, 1], stride: [2, 1], dilation: [1, 1], groups: 1 },
    { input: [1, 4, 5, 6], weights: [6, 2, 2, 2], pad: [1, 1, 2, 1], stride: [1, 2], dilation: [2, 1], groups: 2 },
    {
      input: [1, 3, 4, 4],
      weights: [6, 1, 3, 3],
      pad: [1, 1, 1, 1],
      stride: [1, 1],
      dilation: [1, 1],
      groups: 3,
      auto: 'same',
    },
    {
      input: [1, 1, 4, 4],
      weights: [1, 1, 3, 3],
      pad: [1, 1, 0, 0],
      stride: [2, 2],
      dilation: [1, 1],
      groups: 1,
      auto: 'same-lower',
    },
    {
      input: [1, 1, 4, 4],
      weights: [1, 1, 2, 2],
      pad: [0, 0, 0, 0],
      stride: [1, 1],
      dilation: [1, 1],
      groups: 1,
      auto: 'valid',
    },
  ])
    for (const perChannel of [false, true]) {
      const {
          input: xs,
          weights: ws,
          pad: [pt, pl, pb, pr],
          stride: [sh, sw],
          dilation: [dh, dw],
          groups,
        } = spec,
        [batch, ci, h, w] = xs,
        [co, cg, kh, kw] = ws,
        oh = Math.floor((h + pt + pb - dh * (kh - 1) - 1) / sh) + 1,
        ow = Math.floor((w + pl + pr - dw * (kw - 1) - 1) / sw) + 1,
        aa = values(product(xs), 5),
        bb = values(product(ws), 4),
        options = {
          output: { scale: 0.5, zeroPoint: 11 },
          bias: Int32Array.from({ length: co }, (_, i) => i * 3 - 2),
          groups,
          stride: [sh, sw],
          dilation: [dh, dw],
          padding: spec.auto ?? [pt, pl, pb, pr],
        };
      using a = quantize(c, aa, xs, { scale: 0.125, zeroPoint: 9 });
      using b = quantize(
        c,
        bb,
        ws,
        perChannel
          ? { scale: Array.from({ length: co }, (_, i) => 0.019 + i * 0.001), zeroPoint: Array(co).fill(-5), axis: 0 }
          : { scale: 0.25, zeroPoint: -5 },
      );
      using y = await quantizedConv2d(a, b, options);
      assert(String(y.shape) === String([batch, co, oh, ow]), 'conv geometry');
      const terms = (i) => {
        const n = Math.floor(i / (co * oh * ow)),
          oc = Math.floor(i / (oh * ow)) % co,
          oy = Math.floor(i / ow) % oh,
          ox = i % ow,
          pairs = [];
        for (let ic = 0; ic < cg; ic++)
          for (let ky = 0; ky < kh; ky++)
            for (let kx = 0; kx < kw; kx++) {
              const iy = oy * sh - pt + ky * dh,
                ix = ox * sw - pl + kx * dw;
              const ai =
                iy < 0 || ix < 0 || iy >= h || ix >= w
                  ? -1
                  : ((n * ci + Math.floor(oc / (co / groups)) * cg + ic) * h + iy) * w + ix;
              pairs.push([ai, ((oc * cg + ic) * kh + ky) * kw + kx]);
            }
        return pairs;
      };
      checks += await verify(a, b, y, terms, options, aa, bb, (i) => Math.floor(i / (oh * ow)) % co, 'conv');
      checks++;
    }
  // Accumulation exceeds f32's exact-integer range, while staying safe in int32.
  {
    using a = quantizedTensor(c, new Int8Array(2001).fill(127), [1, 2001], { scale: 0.125 });
    using b = quantizedTensor(c, new Int8Array(2001).fill(127), [2001, 1], { scale: 0.25 });
    using y = await quantizedMatmul(a, b, { output: { scale: 16384 } });
    near((await y.dequantize())[0], (2001 * 127 * 127) / 32, 8192 + 1, 'large int32 accumulator');
    checks++;
  }
  // Packed output feeds another GPU contraction, without host readback.
  {
    using a = quantizedTensor(c, new Int8Array([1, 2, 3, 4]), [2, 2], { scale: 1 });
    using b = quantizedTensor(c, new Int8Array([1, 0, 0, 1]), [2, 2], { scale: 1 });
    using y = await quantizedMatmul(a, b, { output: { scale: 1 } });
    using z = await quantizedMatmul(y, b, { output: { scale: 1 } });
    assert(String(await z.read()) === '1,2,3,4', 'resident packed output chaining');
    checks++;
  }
  {
    using a = quantizedTensor(c, new Int8Array([-5, -3, -1, 1, 3, 5, 127, -128]), [8, 1], { scale: 1 });
    using b = quantizedTensor(c, new Int8Array([1]), [1, 1], { scale: 1 });
    using y = await quantizedMatmul(a, b, { output: { scale: 2, zeroPoint: 3 } });
    assert(String(await y.read()) === '1,1,3,3,5,5,67,-61', 'requant nearest-even before zero point');
    using saturated = await quantizedMatmul(a, b, { output: { scale: 0.001, zeroPoint: -17 } });
    assert(String(await saturated.read()) === '-128,-128,-128,127,127,127,127,-128', 'output saturation');
    checks += 2;
  }
  {
    using a = quantizedTensor(c, new Int8Array(1), [1, 1, 1, 1], { scale: 1, zeroPoint: -8 });
    using b = quantizedTensor(c, new Int8Array(4), [1, 1, 2, 2], { scale: 1, zeroPoint: 9 });
    using y = await quantizedConv2d(a, b, { output: { scale: 1 } });
    assert(y.size === 0 && (await y.read()).length === 0, 'empty convolution output');
    checks++;
  }
  return checks;
}
