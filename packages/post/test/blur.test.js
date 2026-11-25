import test from 'node:test';
import assert from 'node:assert/strict';
import { Blur, MAX_BLUR_RADIUS, MAX_BLUR_SAMPLES } from '@margoengine/post/blur';
import { PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

// Full-screen passes only (one colour target, no depth): the scene and the stack's own passes have depth or resolve.
const passes = (log) =>
  log.filter(
    (e) => e[0] === 'beginRenderPass' && !e[1].depthStencilAttachment && !e[1].colorAttachments[0]?.resolveTarget,
  ).length;
/** The two 256 B uniform slices of the frame's 512 B write: [ints of the slice, floats after them]. */
const slices = (log) => {
  const e = log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 1024),
    b = Buffer.from(e[3], 'hex');
  return [0, 256].map((o) => [
    [...new Int32Array(b.buffer, b.byteOffset + o, 4)],
    [...new Float32Array(b.buffer, b.byteOffset + o + 16, 8)],
  ]);
};

test('Blur runs one pass across and one down, with the kind, radius and region of the options', async () => {
  const h = harness(),
    effect = new Blur({ kind: 'box', radius: 4.4, region: [0, 0.25, 0.5, 1] });
  const log = h.gpu.record(() => {
    h.engine.use(new PostStack([effect]));
    h.frame();
  });
  assert.equal(passes(log), 2);
  const [across, down] = slices(log);
  assert.deepEqual(across[0], [1, 0, 4, 1], 'horizontal, radius rounded to 4, box');
  assert.deepEqual(across[1].slice(0, 4), [0, 0, 1, 1], 'the horizontal pass blurs everything');
  assert.deepEqual(down[0], [0, 1, 4, 1], 'vertical');
  assert.deepEqual(down[1].slice(0, 6), [0, 0.25, 0.5, 1, 1280, 720], 'the vertical pass picks the region');
  assert.ok(
    modules(log).some((c) => c.includes('return vec4f(toDisplay(out.rgb),out.a);')),
    'alone in the stack the vertical pass writes the display',
  );
  // Gaussian: sigma radius / 3; a steady frame creates nothing new.
  effect.options.kind = 'gaussian';
  effect.radius = 9;
  const steady = h.gpu.record(() => h.frame());
  assert.equal(steady.filter((e) => e[0] === 'module' || e[0] === 'createTexture').length, 0);
  assert.equal(slices(steady)[1][0][3], 0);
  assert.equal(slices(steady)[1][1][6], 3);
  // Radius 0 or disabled as the last stage: one display pass with a one-tap kernel.
  effect.radius = 0;
  const zero = h.gpu.record(() => h.frame());
  assert.equal(passes(zero), 1);
  assert.equal(slices(zero)[1][0][2], 0);
  effect.radius = 3;
  effect.enabled = false;
  assert.equal(passes(h.gpu.record(() => h.frame())), 1);
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
});

test('Blur checks its options now, on radius and every frame, and needs a stack', () => {
  for (const bad of [
    { kind: 'disc' },
    { strength: 1.1 },
    { strength: Number.NaN },
    { samples: 1 },
    { samples: 2.5 },
    { samples: MAX_BLUR_SAMPLES + 1 },
    { center: [0.5] },
    { center: [0.5, 11] },
    { innerRadius: -1 },
    { falloff: 11 },
    { decay: 1.5 },
    { rays: 9 },
    { threshold: -1 },
    { radius: -1 },
    { radius: MAX_BLUR_RADIUS + 1 },
    { radius: Number.NaN },
    { region: [0, 0, 1] },
    { region: [0.5, 0, 0.5, 1] },
    { region: [0, 0, 1, 1.5] },
  ])
    assert.throws(() => new Blur(bad), RangeError);
  assert.throws(() => new Blur({ enabled: 'yes' }), TypeError);
  assert.throws(() => new Blur().setup({ gpu: {} }), /PostStack/);
  assert.equal(MAX_BLUR_RADIUS, 64);
  const h = harness(),
    effect = Blur.attach(h.engine, { radius: 2 });
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('blur'));
  assert.throws(() => (effect.radius = 65), RangeError);
  assert.equal(effect.radius, 2, 'a rejected radius keeps the old one');
  h.frame();
  effect.options.region = [1, 1, 0, 0];
  assert.throws(() => h.frame(), RangeError);
  effect[Symbol.dispose]();
  effect.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
});

test('Blur zoom and spin draw one pass with the centre, view and defaults, and live options', async () => {
  const h = harness(),
    effect = new Blur({ kind: 'zoom' });
  const values = (log) => {
    const e = log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 160),
      b = Buffer.from(e[3], 'hex');
    return [
      [...new Float32Array(b.buffer, b.byteOffset, 18)].map((v) => Math.round(v * 1000) / 1000),
      [...new Int32Array(b.buffer, b.byteOffset + 72, 2)],
    ];
  };
  const log = h.gpu.record(() => {
    h.engine.use(new PostStack([effect]));
    h.frame();
  });
  assert.equal(passes(log), 1);
  // view rect, region, centre, target size, strength, inner radius, falloff, decay, rays, threshold; samples, spin.
  const rest = [0, 0, 1280, 720, 0, 0, 1, 1, 0.5, 0.5, 1280, 720, 0.1, 0, 0.2, 1, 0, 1];
  assert.deepEqual(values(log), [rest, [32, 0]]);
  assert.ok(modules(log).some((c) => c.includes('textureSampleLevel') && c.includes('toDisplay')));
  Object.assign(effect.options, {
    kind: 'spin',
    center: [0.25, 0.75],
    samples: 8,
    strength: 0.5,
    rays: 2,
  });
  const spin = h.gpu.record(() => h.frame());
  assert.deepEqual(values(spin)[0].slice(8, 17), [0.25, 0.75, 1280, 720, 0.5, 0, 0.2, 1, 2]);
  assert.deepEqual(values(spin)[1], [8, 1]);
  const steady = h.gpu.record(() => h.frame());
  assert.equal(steady.filter((e) => ['module', 'createTexture', 'group', 'sampler'].includes(e[0])).length, 0);
  // Strength 0 is the one-tap pass-through; a gaussian after a zoom still works.
  effect.options.strength = 0;
  assert.equal(passes(h.gpu.record(() => h.frame())), 1);
  effect.options.kind = 'gaussian';
  assert.equal(passes(h.gpu.record(() => h.frame())), 2);
  Object.assign(effect.options, { kind: 'zoom', strength: 0.2 });
  const fresh = h.lose();
  assert.equal(passes(fresh.record(() => h.frame())), 1);
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
});
