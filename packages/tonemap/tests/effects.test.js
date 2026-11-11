import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Tonemap, whiteBalanceGain } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const hash = (code) => createHash('sha256').update(code).digest('hex');
const defaultShader = '672546811be6922e47f3faa5531e004859899ab5f333c9869f73295de3c49159';

function frame(options) {
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, options);
  h.frame();
  const draw = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1);
  return { h, effect, code: draw.fragment.module.code, compute: h.pipelines.filter((p) => p.compute) };
}

test('white balance is exactly neutral at 6500 K and moves blue/red the right way', () => {
  assert.deepEqual(whiteBalanceGain(6500, 0), [1, 1, 1]);
  const warmLight = whiteBalanceGain(3200),
    coolLight = whiteBalanceGain(10000);
  assert.ok(warmLight[2] > 1 && warmLight[0] < 1, 'tungsten light is cancelled by adding blue');
  assert.ok(coolLight[0] > 1 && coolLight[2] < 1, 'blue sky light is cancelled by adding red');
  for (const g of [warmLight, coolLight, whiteBalanceGain(5000, 0.8), whiteBalanceGain(8000, -0.8)])
    assert.ok(
      Math.abs(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2] - 1) < 0.02 && g.every((v) => v > 0),
      'keeps luminance',
    );
  const magenta = whiteBalanceGain(6500, 1);
  assert.ok(magenta[1] < 1 && magenta[0] > 1, 'positive tint is magenta');
  assert.throws(() => whiteBalanceGain(500), RangeError);
  assert.throws(() => whiteBalanceGain(6500, 2), RangeError);
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

test('effects uniform carries gain, vignette, grain, aberration and the view rectangle; frames reseed the grain', () => {
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
    if (buffer.size === 64 && values.length === 16 && values[3] === Math.fround(0.4))
      seen.push(Float32Array.from(values));
    return write(buffer, offset, values);
  };
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => Object.assign(begin(d), { setViewport() {}, setScissorRect() {} });
  h.context.view = { id: 'a', viewport: [10, 20, 100, 50], index: 0, count: 1 };
  h.frame();
  h.frame();
  const f = seen[0],
    gain = whiteBalanceGain(3200);
  assert.deepEqual([...f.slice(0, 3)], gain.map(Math.fround));
  assert.deepEqual([...f.slice(3, 8)], [0.4, 0.3, 0.6, 0.25, 0.01].map(Math.fround));
  assert.deepEqual([...f.slice(8, 12)], [10, 20, 100, 50]);
  assert.notEqual(seen[0][12], seen[1][12], 'grain animates');
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
  ];
  for (const options of bad) assert.throws(() => new Tonemap(options), RangeError, JSON.stringify(options));
  const t = new Tonemap({});
  t.options.grain = 5;
  assert.throws(() => t.validate?.() ?? new Tonemap(t.options), RangeError);
});
