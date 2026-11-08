import test from 'node:test';
import assert from 'node:assert/strict';
import { Anamorphic } from '@margoengine/post/anamorphic';
import { PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

// Full-screen passes only (one colour target, no depth): the scene and the stack's own passes have depth or resolve.
const passes = (log) =>
  log.filter(
    (e) => e[0] === 'beginRenderPass' && !e[1].depthStencilAttachment && !e[1].colorAttachments[0]?.resolveTarget,
  ).length;

test('Anamorphic runs a bright pass, `passes` spreads and a composite, with strides 1, 3, 9 ...', async () => {
  const h = harness(),
    effect = new Anamorphic({ passes: 3, intensity: 2, tint: [1, 0.5, 0.25], threshold: 4 });
  const log = h.gpu.record(() => {
    h.engine.use(new PostStack([effect]));
    h.frame();
  });
  assert.equal(passes(log), 5, 'bright, three spreads, composite');
  const v = written(log, 2048);
  assert.deepEqual([...v.subarray(0, 2)], [4, 2], 'threshold and intensity');
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((k) => v[k * 64 + 2]),
    [1, 3, 9, 27, 81, 243],
    'spread strides 3^(k-1)',
  );
  assert.deepEqual([...v.subarray(7 * 64 + 4, 7 * 64 + 7)], [1, 0.5, 0.25], 'composite tint');
  const shaders = modules(log);
  assert.ok(
    shaders.some((c) => c.includes('for(var i=-4;i<=4;i++)')),
    'nine taps per spread',
  );
  assert.ok(
    shaders.some((c) => c.includes('return vec4f(toDisplay(c),s.a);')),
    'alone in the stack it is the last stage: display-encoded',
  );
  // A steady frame creates nothing new.
  const steady = h.gpu.record(() => h.frame());
  assert.equal(steady.filter((e) => e[0] === 'module' || e[0] === 'createTexture').length, 0);
  // Disabled: only the composite (intensity 0) remains, as the last stage must still write the display.
  effect.enabled = false;
  const off = h.gpu.record(() => h.frame());
  assert.equal(passes(off), 1);
  assert.equal(written(off, 2048)[7 * 64 + 1], 0);
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
});

test('Anamorphic checks its options now and every frame, and needs a stack', () => {
  for (const bad of [
    { threshold: 0 },
    { threshold: Number.NaN },
    { intensity: -0.1 },
    { intensity: 11 },
    { passes: 0 },
    { passes: 7 },
    { passes: 2.5 },
    { tint: [1, 1] },
    { tint: [1, 1, 2] },
  ])
    assert.throws(() => new Anamorphic(bad), RangeError);
  assert.throws(() => new Anamorphic({ enabled: 1 }), TypeError);
  assert.throws(() => new Anamorphic().setup({ gpu: {} }), /PostStack/);
  const h = harness(),
    effect = Anamorphic.attach(h.engine);
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('anamorphic'));
  h.frame();
  effect.options.passes = 9;
  assert.throws(() => h.frame(), RangeError);
  effect[Symbol.dispose]();
  effect.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
});
