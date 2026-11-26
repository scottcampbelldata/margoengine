import test from 'node:test';
import assert from 'node:assert/strict';
import { KawaseBlur, KAWASE_KERNELS } from '@margoengine/post/kawase-blur';
import { ColorAverage } from '@margoengine/post/color-average';
import { LUT1D, parseCube1D } from '@margoengine/post/lut1d';
import { DepthDownsample } from '@margoengine/post/depth-downsample';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { harness, modules, written } from './support.js';

const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${i}: ${v} != ${b[i]}`));
const calls = (log, name) => log.filter((e) => e[0] === name);
const sizes = (log) => calls(log, 'texture').map((e) => `${e[2].size[0]}x${e[2].size[1]} ${e[2].format}`);
// The harness's own stack capture draws twice a frame (its multisample depth resolve).
const STACK = 2;
const draws = (log) => calls(log, 'pass.draw').length - STACK;
const done = async (h, effect) => {
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
};

test('Kawase presets approximate a Gaussian of sigma = width / 6 up to the 127 px kernel', () => {
  // A pass at offset k samples k and k+1 texels each side: (k^2 + (k+1)^2) / 2 of variance, which adds over passes.
  const sigma = (offsets) => Math.sqrt(offsets.reduce((sum, k) => sum + (k * k + (k + 1) * (k + 1)) / 2, 0));
  for (const [name, expected] of [
    ['very-small', 7 / 6],
    ['small', 25 / 6],
    ['medium', 63 / 6],
    ['large', 127 / 6],
    ['very-large', 391 / 6],
  ]) {
    const s = sigma(KAWASE_KERNELS[name]);
    assert.ok(Math.abs(s / expected - 1) < 0.15, `${name}: sigma ${s} against ${expected}`);
  }
  assert.ok(sigma(KAWASE_KERNELS.huge) > 1.5 * sigma(KAWASE_KERNELS['very-large']));
});

test('KawaseBlur dual draws halvings, doublings and one composite, and keeps its half-size result', async () => {
  const h = harness(),
    effect = KawaseBlur.attach(h.engine);
  const log = h.gpu.record(() => h.frame()),
    [w, ht] = [h.view.c.width, h.view.c.height];
  assert.deepEqual(
    sizes(log).filter((s) => !s.startsWith(`${w}x${ht}`)),
    [2, 4, 8].map((d) => `${w / d}x${ht / d} rgba16float`),
  );
  // Three down, two up, composite.
  assert.equal(draws(log), 6);
  assert.deepEqual([effect.texture.width, effect.texture.height], [w / 2, ht / 2]);
  // Steady frames make no new textures, pipelines or bind groups.
  const steady = h.gpu.record(() => h.frame());
  for (const kind of ['texture', 'renderPipeline', 'group']) assert.equal(calls(steady, kind).length, 0, kind);
  effect.options.levels = 1;
  assert.equal(draws(h.gpu.record(() => h.frame())), 2);
  effect.options.strength = 0;
  const off = h.gpu.record(() => h.frame());
  assert.equal(draws(off), 1, 'last in the stack: one display pass');
  h.engine.restore();
  assert.equal(effect.texture, undefined);
  effect.options.strength = 1;
  h.frame();
  await done(h, effect);
});

test('KawaseBlur kawase runs one pass an offset at the working size, after enough halvings', async () => {
  const h = harness(),
    effect = KawaseBlur.attach(h.engine, { method: 'kawase', resolutionScale: 0.25, size: 'small' });
  const log = h.gpu.record(() => h.frame()),
    [w, ht] = [h.view.c.width, h.view.c.height];
  assert.deepEqual(
    sizes(log).filter((s) => !s.startsWith(`${w}x${ht}`)),
    [
      [2, 0],
      [4, 1],
      [4, 8],
      [4, 9],
    ].map(([d]) => `${w / d}x${ht / d} rgba16float`),
  );
  assert.equal(draws(log), 2 + KAWASE_KERNELS.small.length + 1);
  assert.ok(modules(log).some((s) => s.includes('*0.25;')));
  Object.assign(effect.options, { offsets: [0], resolutionScale: 1, scale: 2 });
  const full = h.gpu.record(() => h.frame());
  assert.equal(draws(full), 2);
  // The one Kawase pass reads the input: offset (0 + 0.5) * 2 input texels.
  // Two passes of 256 B each; slot 0 is the Kawase pass.
  const floats = written(full, 512);
  near([floats[12], floats[13]], [1 / w, 1 / ht]);
  await done(h, effect);
});

test('KawaseBlur off in the middle of an HDR chain copies its input on in one pass', async () => {
  const h = harness(),
    blur = new KawaseBlur({ enabled: false }),
    stack = PostStack.attach(h.engine, [blur, new Bloom()]);
  const off = h.gpu.record(() => h.frame());
  const own = modules(off).filter((s) => s.includes('struct P {map'));
  assert.equal(own.length, 1, 'only the composite, at strength 0');
  assert.ok(!own[0].includes('toDisplay('), 'linear light stays linear for the next stage');
  assert.equal(blur.texture, undefined);
  blur.options.enabled = true;
  h.frame();
  assert.ok(blur.texture);
  stack.dispose();
  await done(h, blur);
});

test('ColorAverage normalises its weights and takes the overlay options', async () => {
  const h = harness(),
    effect = ColorAverage.attach(h.engine);
  let u = written(
    h.gpu.record(() => h.frame()),
    256,
  );
  near([u[0], u[1], ...u.slice(12, 15)], [1, 0, 1 / 3, 1 / 3, 1 / 3]);
  Object.assign(effect.options, { weights: [2, 6, 2], blend: 'multiply', opacity: 0.5 });
  u = written(
    h.gpu.record(() => h.frame()),
    256,
  );
  near([u[0], u[1], ...u.slice(12, 15)], [0.5, 3, 0.2, 0.6, 0.2]);
  effect.options.weights = [0, 0, 0];
  assert.throws(() => h.frame(), RangeError);
  await done(h, effect);
  for (const weights of [
    [1, 1],
    [1, -1, 1],
    [Infinity, 0, 0],
  ])
    assert.throws(() => new ColorAverage({ weights }), RangeError);
});

const CUBE = `# a comment
TITLE "invert"
LUT_1D_SIZE 3
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 2
1 1 1
0.5 0.5 0.5
0 0 0`;

test('parseCube1D reads a 1D .cube table and refuses malformed text with a help link', () => {
  const lut = parseCube1D(CUBE.replaceAll('\n', '\r\n'));
  assert.deepEqual([...lut.data], [1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0]);
  assert.deepEqual(lut.domainMax, [1, 1, 2]);
  for (const [text, type] of [
    [7, TypeError],
    ['', TypeError],
    ['LUT_3D_SIZE 2', TypeError],
    ['LUT_1D_SIZE 2\n0 0 0', TypeError],
    ['LUT_1D_SIZE 2\n0 0\n1 1 1', TypeError],
    ['LUT_1D_SIZE 2\n0 0 0\n1 1 1\n1 1 1', TypeError],
    ['LUT_1D_SIZE 1\n0 0 0', RangeError],
    ['LUT_1D_SIZE 65537', RangeError],
    ['LUT_1D_SIZE 2\n0 0 x\n1 1 1', RangeError],
    ['LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\n0 0 0\n1 1 1', RangeError],
  ])
    assert.throws(
      () => parseCube1D(text),
      (e) => e instanceof type && e.message.includes('https://margoengine.com/errors#arguments'),
      JSON.stringify(text),
    );
});

test('LUT1D uploads a table once per object, wraps long tables and writes its domain', async () => {
  const h = harness(),
    effect = LUT1D.attach(h.engine, { lut: CUBE });
  let log = h.gpu.record(() => h.frame());
  near([...written(log, 256).slice(12, 19)], [0, 0, 0, 3, 1, 1, 0.5]);
  assert.equal(calls(log, 'writeTexture').length, 1);
  assert.equal(
    calls(
      h.gpu.record(() => h.frame()),
      'writeTexture',
    ).length,
    0,
  );
  const data = new Float32Array(2000 * 3);
  effect.setLUT({ data });
  log = h.gpu.record(() => h.frame());
  assert.ok(sizes(log).includes('1024x2 rgba32float'));
  assert.throws(() => effect.setLUT({ data: [1, 2] }), TypeError);
  assert.equal(effect.options.lut.data, data, 'a refused table changes nothing');
  h.engine.restore();
  assert.equal(
    calls(
      h.gpu.record(() => h.frame()),
      'writeTexture',
    ).length,
    1,
  );
  await done(h, effect);
});

test('LUT1D borrows a texture, passes frames through until it has one and after its device is lost', async () => {
  const h = harness();
  const errors = [];
  h.engine.onError = (e) => errors.push(e);
  let supplied;
  const effect = LUT1D.attach(h.engine, { lut: () => supplied });
  assert.equal(
    written(
      h.gpu.record(() => h.frame()),
      256,
    )[0],
    0,
  );
  supplied = h.gpu.device.createTexture({ size: [256, 1], format: 'rgba8unorm', usage: 0x4 });
  const u = written(
    h.gpu.record(() => h.frame()),
    256,
  );
  near([u[0], u[15], u[16]], [1, 256, 1]);
  effect.setLUT(supplied);
  h.frame();
  const fresh = h.lose();
  assert.equal(
    written(
      fresh.record(() => h.frame()),
      256,
    )[0],
    0,
  );
  assert.equal(errors.length, 1);
  supplied.destroy();
  supplied = h.engine.gpu.createTexture({ size: [4, 4], format: 'rgba8unorm-srgb', usage: 0x4 });
  effect.setLUT(supplied);
  assert.throws(() => h.frame(), TypeError);
  supplied.destroy();
  await done(h, effect);
});

test('LUT1D validates its table at construction', () => {
  for (const lut of [undefined, 3, { data: [0, 0, 0, 1] }]) assert.throws(() => new LUT1D({ lut }), TypeError);
  for (const lut of [
    { data: [0, 0, 0] },
    { data: [0, 0, 0, 1, 1, NaN] },
    { data: [0, 0, 0, 1, 1, 1], domainMin: [1, 0, 0] },
    { data: [0, 0, 0, 1, 1, 1], domainMax: [1, 1] },
  ])
    assert.throws(() => new LUT1D({ lut }), RangeError, JSON.stringify(lut));
});

test('DepthDownsample captures its own depth, sizes its output and tells listeners', async () => {
  const h = harness();
  let resizes = 0;
  const effect = DepthDownsample.attach(h.engine);
  const remove = effect.onResize(() => resizes++);
  assert.ok([...h.plugins.keys()].some((k) => k.startsWith('scene-targets:')));
  const log = h.gpu.record(() => h.frame()),
    [w, ht] = [h.view.c.width, h.view.c.height];
  assert.ok(sizes(log).includes(`${w / 2}x${ht / 2} r32float`));
  assert.ok(modules(log).some((s) => s.includes('texture_depth_2d') && s.includes('depths[(n-1u)/2u]')));
  assert.deepEqual([effect.texture.width, effect.texture.height, effect.normalTexture], [w / 2, ht / 2, undefined]);
  const normals = h.gpu.device.createTexture({ size: [8, 8], format: 'rgba16float', usage: 0x4 });
  Object.assign(effect.options, { width: 100, height: 60, mode: 'checkerboard', normal: () => normals });
  const next = h.gpu.record(() => h.frame());
  assert.ok(sizes(next).includes('100x60 r32float') && sizes(next).includes('100x60 rgba16float'));
  assert.deepEqual([...written(next, 16)].length, 4);
  assert.equal(resizes, 2);
  remove();
  effect.options.enabled = false;
  assert.equal(
    calls(
      h.gpu.record(() => h.frame()),
      'writeBuffer',
    ).filter((e) => e[3].length === 32).length,
    0,
  );
  h.engine.restore();
  assert.equal(effect.texture, undefined);
  effect.options.enabled = true;
  h.frame();
  assert.equal(resizes, 2);
  normals.destroy();
  await done(h, effect);
});

test('DepthDownsample reads a supplied depth without a capture and refuses bad sources and options', async () => {
  const h = harness(),
    source = h.gpu.device.createTexture({ size: [64, 32], format: 'r32float', usage: 0x4 });
  let supplied;
  const effect = DepthDownsample.attach(h.engine, { depth: () => supplied, scale: 0.25, mode: 'far' });
  assert.ok(![...h.plugins.keys()].some((k) => k.startsWith('scene-targets:')));
  h.frame();
  assert.equal(effect.texture, undefined);
  supplied = source;
  const log = h.gpu.record(() => h.frame());
  assert.ok(sizes(log).includes('16x8 r32float'));
  assert.ok(modules(log).some((s) => s.includes('var source:texture_2d<f32>')));
  assert.throws(() => effect.add({}), { code: 'state' });
  effect.options.width = 65;
  assert.throws(() => h.frame(), RangeError);
  effect.options.width = 3;
  assert.throws(() => h.frame(), RangeError);
  delete effect.options.width;
  supplied = h.gpu.device.createTexture({ size: [4, 4], format: 'depth32float', sampleCount: 4, usage: 0x4 });
  assert.throws(() => h.frame(), { code: 'state' });
  supplied.destroy();
  source.destroy();
  await done(h, effect);
  for (const o of [{ scale: 0 }, { scale: 2 }, { width: 1.5 }, { mode: 'min' }, { order: NaN }])
    assert.throws(() => new DepthDownsample(o), RangeError, JSON.stringify(o));
  for (const o of [{ depth: 1 }, { normal: 1 }, { enabled: 1 }]) assert.throws(() => new DepthDownsample(o), TypeError);
});
