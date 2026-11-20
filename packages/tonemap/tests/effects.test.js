import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Tonemap, whiteBalanceMatrix } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const hash = (code) => createHash('sha256').update(code).digest('hex');
const defaultShader = 'a2d836edccced9671def05e04e3a5ec2cdc92ee6947e49ee92759a84545d1377';

function frame(options) {
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, options);
  h.frame();
  const draw = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1);
  return { h, effect, code: draw.fragment.module.code, compute: h.pipelines.filter((p) => p.compute) };
}

// Column-major 3x3 times a vector, and Rec.709 luminance.
const mulM = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[3 + r] * v[1] + m[6 + r] * v[2]);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// The Planckian white at T in linear Rec.709 (Kim et al. 2002 locus, then XYZ to Rec.709), written out here so the
// test does not reuse the package's own maths.
function planckianRGB(t) {
  const x =
      t <= 4000
        ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
        : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039,
    y =
      t <= 2222
        ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
        : t <= 4000
          ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
          : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483,
    X = x / y,
    Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}

test('white balance is exactly neutral at 6500 K and moves blue/red the right way', () => {
  assert.deepEqual(whiteBalanceMatrix(6500, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const warmLight = mulM(whiteBalanceMatrix(3200), [1, 1, 1]),
    coolLight = mulM(whiteBalanceMatrix(10000), [1, 1, 1]);
  assert.ok(warmLight[2] > 1 && warmLight[0] < 1, 'tungsten light is cancelled by adding blue');
  assert.ok(coolLight[0] > 1 && coolLight[2] < 1, 'blue sky light is cancelled by adding red');
  // A grey card lit by the light keeps its luminance exactly at every setting (an earlier per-channel gain gave every
  // temperature but 6500 K 1.0165 times the luminance it meant to keep).
  for (const [kelvin, tint] of [
    [3200, 0],
    [10000, 0],
    [5000, 0.8],
    [8000, -0.8],
    [2000, -1],
    [1667, 0],
    [25000, 1],
    [6499, 0],
    [6501, 0],
    [6500, 0.001],
  ]) {
    const m = whiteBalanceMatrix(kelvin, tint);
    assert.equal(m.length, 9);
    const card = planckianRGB(kelvin);
    assert.ok(Math.abs(luma(mulM(m, card)) / luma(card) - 1) < 1e-12, `luminance at ${kelvin} K, tint ${tint}`);
  }
  // Continuous through the exact identity at 6500 K.
  for (const m of [whiteBalanceMatrix(6499), whiteBalanceMatrix(6501), whiteBalanceMatrix(6500, 0.001)])
    m.forEach((v, i) => assert.ok(Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-3, `${m} next to 6500 K`));
  const magenta = mulM(whiteBalanceMatrix(6500, 1), [1, 1, 1]);
  assert.ok(magenta[1] < 1 && magenta[0] > 1, 'positive tint is magenta');
  assert.throws(() => whiteBalanceMatrix(500), RangeError);
  assert.throws(() => whiteBalanceMatrix(6500, 2), RangeError);
});

test('white balance maps the light colour to neutral over the whole range, below 1903.4 K too', () => {
  // A white surface lit at T has the Planckian colour of T; balanced, it must take the 6500 K white's colour with
  // every channel positive. Below 1903.4 K that colour lies outside Rec.709 (its blue is negative), where a per-channel
  // gain went negative (1667 K gave [-0.87, -4.66, 62.6]) and flipped every colour.
  const ref = planckianRGB(6500);
  for (const kelvin of [1667, 1750, 1903, 1904, 2500, 4000, 9000, 25000]) {
    const m = whiteBalanceMatrix(kelvin),
      out = mulM(m, planckianRGB(kelvin)),
      k = out[1] / ref[1];
    // The package's cone matrices are multiplied out to 8 digits.
    out.forEach((v, i) => assert.ok(Math.abs(v - k * ref[i]) < 1e-6 * Math.abs(k), `${kelvin} K channel ${i}: ${out}`));
    assert.ok(k > 0, `${kelvin} K`);
    // A grey card and the primaries stay non-negative in the green and red they carry (no channel flip).
    for (const c of [
      [0.18, 0.18, 0.18],
      [1, 0, 0],
      [0, 1, 0],
    ])
      assert.ok(luma(mulM(m, c)) > 0, `${kelvin} K keeps ${c} positive`);
  }
  // Monotonic warm-to-cool: the balanced blue of white falls as the light gets bluer.
  let last = Infinity;
  for (let t = 1667; t <= 25000; t += 250) {
    const b = mulM(whiteBalanceMatrix(t), [1, 1, 1])[2];
    assert.ok(b < last, `${t} K`);
    last = b;
  }
});

test('without extras the shader is byte-identical and no effects buffer exists', () => {
  const { h, code, effect } = frame({});
  assert.equal(hash(code), defaultShader);
  assert.equal(h.groups.at(-1).entries.length, 3);
  assert.equal(h.resources.filter((r) => r.size === 64).length, 1, 'only the grading uniform');
  effect.dispose();
});

test('each extra switches in the effects variant with its binding, and compiles nothing else', () => {
  for (const options of [
    { vignette: 0.5 },
    { grain: 0.3 },
    { chromaticAberration: 0.5 },
    { temperature: 4000 },
    { tint: 0.2 },
    { dither: true },
    { dither: 0.5 },
  ]) {
    const { h, code, effect, compute } = frame(options);
    assert.match(code, /@binding\(3\) var<uniform> fx:Fx/);
    assert.doesNotMatch(code, /binding\(4\)/);
    assert.match(code, /fxFinish\(color/);
    assert.match(code, /fxFetch\(pos\)/);
    assert.equal(h.groups.at(-1).entries.length, 4);
    assert.equal(compute.length, 0, 'no metering without autoExposure');
    effect.dispose();
  }
});

test('effects uniform carries the white-balance matrix, vignette, grain, aberration and the view rectangle; frames reseed the grain', () => {
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, {
      temperature: 3200,
      vignette: 0.4,
      vignetteRadius: 0.3,
      vignetteSoftness: 0.6,
      grain: 0.25,
      chromaticAberration: 0.5,
    }),
    seen = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, values) => {
    if (buffer.size === 128 && values.length === 32 && values[3] === Math.fround(0.4))
      seen.push(Float32Array.from(values));
    return write(buffer, offset, values);
  };
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => Object.assign(begin(d), { setViewport() {}, setScissorRect() {} });
  h.context.view = { id: 'a', viewport: [10, 20, 100, 50], index: 0, count: 1 };
  h.frame();
  h.frame();
  const f = seen[0],
    m = whiteBalanceMatrix(3200);
  for (let col = 0; col < 3; col++)
    assert.deepEqual([...f.slice(4 * col, 4 * col + 3)], m.slice(3 * col, 3 * col + 3).map(Math.fround));
  assert.deepEqual([f[3], ...f.slice(12, 16)], [0.4, 0.3, 0.6, 0.25, 0.01].map(Math.fround));
  assert.deepEqual([...f.slice(16, 20)], [10, 20, 100, 50]);
  assert.notEqual(seen[0][20], seen[1][20], 'grain animates');
  const buffers = h.counts.buffers;
  for (let i = 0; i < 20; i++) h.frame();
  assert.equal(h.counts.buffers, buffers, 'steady state allocates nothing');
  effect.options.vignette = 0;
  effect.options.grain = 0;
  effect.options.chromaticAberration = 0;
  effect.options.temperature = 6500;
  h.frame();
  assert.equal(h.groups.at(-1).entries.length, 3, 'turning every extra off returns to the default pipeline');
  effect.dispose();
});

test('autoExposure meters in a compute pass, binds the adapted state and cleans up', async () => {
  const { h, effect, code, compute } = frame({ autoExposure: { min: -3, max: 2, speed: 3, compensation: 0.5 } });
  assert.match(code, /@binding\(4\) var<storage,read> ae:array<f32,2>/);
  assert.match(code, /exp2\(p\.grade\.x\+ae\[0\]\)/);
  assert.equal(compute.length, 1);
  assert.match(compute[0].compute.module.code, /workgroupBarrier/);
  assert.ok(h.groups.some((g) => g.entries.length === 5 && g.entries[4].binding === 4));
  assert.equal(h.counts.compute, 1);
  const before = { ...h.counts };
  for (let i = 0; i < 20; i++) h.frame();
  assert.equal(h.counts.buffers, before.buffers);
  assert.equal(h.counts.groups, before.groups);
  assert.equal(h.counts.compute, 21);
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  await null;
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'every buffer is freed',
  );
});

test('extras validate ranges every frame', () => {
  const bad = [
    { vignette: 2 },
    { vignette: -0.1 },
    { vignetteRadius: 1.5 },
    { grain: Number.NaN },
    { chromaticAberration: 3 },
    { tint: 1.5 },
    { temperature: 100 },
    { autoExposure: { min: 3, max: -3 } },
    { autoExposure: { speed: 0 } },
    { vignetteColor: [1, 0] },
    { vignetteColor: [0, 0, 2] },
    { vignetteCenter: [0.5, -0.1] },
    { vignetteCenter: [0.5, 0.5, 0.5] },
    { vignetteRoundness: 1.5 },
    { vignetteBlend: 'screen' },
    { dither: 2 },
    { dither: 'yes' },
  ];
  for (const options of bad) assert.throws(() => new Tonemap(options), RangeError, JSON.stringify(options));
  const t = new Tonemap({});
  t.options.grain = 5;
  assert.throws(() => t.validate?.() ?? new Tonemap(t.options), RangeError);
});

// Output dithering adds triangular noise to the encoded colour as the last step; its strength is one code value of the
// target. The vignette carries a colour, a blend mode, a centre and a roundness.
test('dither patches the encode step and scales to the target; the vignette carries colour, blend, centre and roundness', () => {
  const { code, effect } = frame({ dither: true });
  assert.match(code, /return vec4f\(fxDither\(select\(color\*12\.92,.*\),pos\),source\.a\);/);
  assert.match(code, /c\+n\*min\(vec3f\(fx\.vp\.w\),min\(c,1\.0-c\)\)/, 'narrowed near 0 and 1');
  effect.dispose();
  for (const [format, dither, step] of [
    ['bgra8unorm', true, 1 / 255],
    ['rgba8unorm', 0.5, 0.5 / 255],
    ['rgb10a2unorm', 1, 1 / 1023],
    ['rgba16float', true, 0],
  ]) {
    const h = gpuHarness(),
      t = Tonemap.attach(h.engine, {
        dither,
        vignette: 1,
        vignetteColor: [0.25, 0.5, 0.75],
        vignetteCenter: [0.3, 0.6],
        vignetteRoundness: 0.7,
        vignetteBlend: 'opaque',
      }),
      seen = [],
      write = h.engine.gpu.queue.writeBuffer;
    Object.defineProperty(h.context, 'format', { get: () => format, set() {} });
    h.engine.gpu.queue.writeBuffer = (buffer, offset, values) => {
      if (buffer.size === 128 && values.length === 32) seen.push(Float32Array.from(values));
      return write(buffer, offset, values);
    };
    h.frame();
    const f = seen.at(-1);
    assert.deepEqual([...f.slice(24, 31)], [0.25, 0.5, 0.75, 1, 0.3, 0.6, 0.7].map(Math.fround), format);
    assert.equal(f[31], Math.fround(step), format);
    t.options.vignetteBlend = 'multiply';
    h.frame();
    assert.equal(seen.at(-1)[27], 0, 'multiply is blend 0');
    t.dispose();
  }
  const { code: vig, effect: e2 } = frame({ vignette: 0.5 });
  assert.match(vig, /select\(color\*mix\(vec3f\(1\),fx\.vc\.rgb,v\),mix\(color,fx\.vc\.rgb,v\),fx\.vc\.w==1\.0\)/);
  e2.dispose();
});
