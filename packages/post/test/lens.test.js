import test from 'node:test';
import assert from 'node:assert/strict';
import { Lens } from '@margoengine/post/lens';
import { PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

// Full-screen passes only (one colour target, no depth): the scene and the stack's own passes have depth or resolve.
const passes = (log) =>
  log.filter(
    (e) => e[0] === 'beginRenderPass' && !e[1].depthStencilAttachment && !e[1].colorAttachments[0]?.resolveTarget,
  ).length;

test('Lens runs glow, across, down and a composite, with the distortion, fit and threshold of the options', async () => {
  const h = harness(),
    effect = new Lens({ distortion: 0.5, dirtIntensity: 2, threshold: 3 });
  const log = h.gpu.record(() => {
    h.engine.use(new PostStack([effect]));
    h.frame();
  });
  assert.equal(passes(log), 4, 'glow, across, down, composite');
  const v = written(log, 1024);
  assert.deepEqual(
    [0, 1, 2, 3].map((s) => [v[s * 64], v[s * 64 + 1]]),
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ],
    'axes',
  );
  const aspect = v[3 * 64 + 6];
  assert.deepEqual([...v.subarray(3 * 64 + 2, 3 * 64 + 5)], [3, 2, 0.5], 'threshold, dirt intensity, k');
  assert.ok(Math.abs(v[3 * 64 + 5] - 1 / (1 + (0.5 * (aspect * aspect + 1)) / 4)) < 1e-6, 'barrel fits the corners');
  assert.equal(v[3 * 64 + 7], 0, 'built-in dirt');
  const shaders = modules(log);
  assert.ok(
    shaders.some((c) => c.includes('for(var i=-12;i<=12;i++)')),
    '25 taps per spread',
  );
  assert.ok(
    shaders.some((c) => c.includes('return vec4f(toDisplay(c),s.a);')),
    'last in the stack: display-encoded',
  );
  const steady = h.gpu.record(() => h.frame());
  assert.equal(
    steady.filter((e) => e[0] === 'module' || e[0] === 'createTexture').length,
    0,
    'a steady frame creates nothing',
  );
  // Pincushion keeps the scale; no dirt skips the glow.
  effect.options.distortion = -0.5;
  effect.options.dirtIntensity = 0;
  const pin = h.gpu.record(() => h.frame());
  assert.equal(passes(pin), 1);
  assert.equal(written(pin, 1024)[3 * 64 + 5], 1);
  // Disabled: only the composite (no distortion, no dirt) remains, as the last stage must still write the display.
  effect.enabled = false;
  const off = h.gpu.record(() => h.frame());
  assert.equal(passes(off), 1);
  assert.deepEqual([...written(off, 1024).subarray(3 * 64 + 3, 3 * 64 + 5)], [0, 0]);
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
});

test('Lens checks its options now and every frame, and needs a stack', () => {
  for (const bad of [
    { distortion: 1.5 },
    { distortion: Number.NaN },
    { dirtIntensity: -1 },
    { dirtIntensity: 11 },
    { threshold: -1 },
    { threshold: Number.POSITIVE_INFINITY },
  ])
    assert.throws(() => new Lens(bad), RangeError);
  assert.throws(() => new Lens({ enabled: 1 }), TypeError);
  assert.throws(() => new Lens({ dirt: {} }), TypeError);
  assert.throws(() => new Lens().setup({ gpu: {} }), /PostStack/);
  const h = harness(),
    effect = Lens.attach(h.engine);
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('lens'));
  h.frame();
  effect.options.distortion = 2;
  assert.throws(() => h.frame(), RangeError);
  effect[Symbol.dispose]();
  effect.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
});
