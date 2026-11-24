import test from 'node:test';
import assert from 'node:assert/strict';
import { LensFlare, PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const dispatches = (log) => log.filter((e) => e[0] === 'pass.dispatchWorkgroups').length;

for (const samples of [4, 1])
  test(`LensFlare follows the engine light by default, tests the stack depth and adds to the HDR frame (${samples}x)`, async () => {
    const h = harness({ samples }),
      flare = new LensFlare({ intensity: 0.5, occlusionRadius: 20 });
    const log = h.gpu.record(() => {
      h.engine.use(new PostStack([flare]));
      h.frame();
    });
    const v = written(log, 144),
      light = h.engine.lighting;
    // Camera matrix, eye and half the far distance, unit sun direction and strength (w times intensity), size, colour.
    const k = Math.hypot(...light.direction.subarray(0, 3));
    assert.deepEqual([...v.subarray(20, 23)], [...light.direction.subarray(0, 3)].map((d) => Math.fround(d / k)));
    assert.equal(v[23], light.direction[3] * 0.5);
    assert.equal(v[19], 250, 'half of the 500 far distance');
    assert.deepEqual([...v.subarray(24, 28)], [1280, 720, 20, 1]);
    assert.deepEqual([...v.subarray(28, 31)], [...light.radiance.subarray(0, 3)]);
    assert.equal(dispatches(log), 1, 'one occlusion dispatch');
    const occlusion = modules(log).find((c) => c.includes('var<storage,read_write> visible'));
    assert.match(occlusion, /textureLoad\(depth,q,0\)<=s\.depth/, 'nearer geometry hides the sun (reversed-Z)');
    const composite = modules(log).find((c) => c.includes('const GHOSTS'));
    assert.match(composite, /return vec4f\(toDisplay\(c\),s\.a\);/, 'last stage: display-encoded');
    // Strength 0 (a sun below the horizon) or disabled: no occlusion pass, the frame passes through.
    light.direction[3] = 0;
    assert.equal(dispatches(h.gpu.record(() => h.frame())), 0);
    light.direction[3] = 3;
    flare.enabled = false;
    assert.equal(dispatches(h.gpu.record(() => h.frame())), 0);
    h.engine.removePlugin('post:stack');
    await null;
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('LensFlare takes the sun from a callback (sky.lights[0].direction) and validates', () => {
  const h = harness(),
    sun = new Float32Array([0, 1, -1, 2]),
    flare = new LensFlare({ sun: () => sun, color: [1, 0.5, 0.25] });
  h.engine.use(new PostStack([flare]));
  const v = written(
    h.gpu.record(() => h.frame()),
    144,
  );
  assert.deepEqual([...v.subarray(20, 24)], [0, Math.fround(Math.SQRT1_2), -Math.fround(Math.SQRT1_2), Math.fround(2 * 0.1)]);
  assert.deepEqual([...v.subarray(28, 31)], [1, 0.5, 0.25]);
  sun.fill(0);
  assert.throws(() => h.frame(), { name: 'MargoError', code: 'state', message: /nonzero direction/ });
  for (const options of [{ intensity: -1 }, { intensity: 11 }, { occlusionRadius: 0 }, { color: [1, 1] }, { sun: 1 }])
    assert.throws(() => new LensFlare(options), RangeError);
  const alone = harness();
  assert.throws(() => alone.engine.use(new LensFlare()), { name: 'MargoError', code: 'state', message: /attach/ });
  const attached = LensFlare.attach(alone.engine);
  assert.ok(alone.engine.hasPlugin('post:stack') && alone.engine.hasPlugin('lens-flare'));
  attached.dispose();
  assert.ok(!alone.engine.hasPlugin('post:stack'));
});

test('LensFlare from a point light: its position projects as is, white by default, and validates (KB6250c)', () => {
  const h = harness(),
    point = new Float32Array([1, 2, -3, 4]),
    flare = new LensFlare({ position: () => point, intensity: 0.5 });
  h.engine.use(new PostStack([flare]));
  const log = h.gpu.record(() => h.frame()),
    v = written(log, 144);
  assert.deepEqual([...v.subarray(20, 24)], [1, 2, -3, 2], 'the point as given (not normalized), w times intensity');
  assert.deepEqual([...v.subarray(28, 32)], [1, 1, 1, 1], 'white, and the point flag');
  const composite = modules(log).find((c) => c.includes('fn sunPosition'));
  assert.match(composite, /select\(f\.eye\.xyz\+f\.sun\.xyz\*f\.eye\.w,f\.sun\.xyz,f\.color\.w>0\.5\)/);
  point[0] = Number.NaN;
  assert.throws(() => h.frame(), { name: 'MargoError', code: 'state', message: /finite point/ });
  assert.throws(() => new LensFlare({ position: () => point, sun: () => point }), RangeError);
  assert.throws(() => new LensFlare({ position: 1 }), RangeError);
});

test('LensFlare elements replace the built-in flare: one binding per texture, values every frame, rebuilt on change', async () => {
  const h = harness(),
    ring = h.gpu.device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 4 }),
    glow = h.gpu.device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 4 }),
    elements = [
      { texture: glow, size: 512 },
      { size: 60, distance: 0.6, color: [1, 0.5, 0.25] },
      { texture: ring, size: 90, distance: 0.7 },
    ],
    flare = new LensFlare({ position: () => [0, 6, 0], elements });
  h.engine.use(new PostStack([flare]));
  let log = h.gpu.record(() => h.frame());
  const v = written(log, 144);
  assert.equal(v[23], 1, 'intensity 1 by default with elements');
  const composite = modules(log).find((c) => c.includes('var<storage,read> elements'));
  assert.ok(composite && !composite.includes('GHOSTS[i]'), 'the elements replace the built-in glow and ghosts');
  assert.match(composite, /var image0:texture_2d<f32>;.*var image1:texture_2d<f32>;/s);
  assert.ok(!composite.includes('image2'), 'one texture binding per textured element');
  assert.match(composite, /textureSampleLevel\(image1,flareSampler,uv,0\.0\);light\+=t\.rgb\*t\.a\*elements\[5\]\.rgb;/);
  const values = written(log, 96);
  assert.deepEqual(
    [...values],
    [0, 512, 0, 0, 1, 1, 1, 0, 0.6, 60, 0, 0, 1, 0.5, 0.25, 0, 0.7, 90, 0, 0, 1, 1, 1, 0].map(Math.fround),
  );
  const groups = log.filter((e) => e[0] === 'group').length;
  // Steady frames: one element write, no new pipeline or bind group.
  log = h.gpu.record(() => h.frame());
  assert.equal(log.filter((e) => e[0] === 'group' || e[0] === 'renderPipeline').length, 0);
  assert.ok(written(log, 96));
  // A new texture rebuilds the group only; a new layout (texture removed) rebuilds the pipeline too.
  elements[2] = { ...elements[2], texture: glow };
  log = h.gpu.record(() => h.frame());
  assert.equal(log.filter((e) => e[0] === 'group').length, 1);
  assert.equal(log.filter((e) => e[0] === 'renderPipeline').length, 0);
  elements[2] = { size: 90, distance: 0.7 };
  log = h.gpu.record(() => h.frame());
  assert.equal(log.filter((e) => e[0] === 'renderPipeline').length, 1);
  assert.ok(groups > 0);
  for (const bad of [
    [{ size: 0 }],
    [{ size: 9000 }],
    [{ size: 10, distance: Number.NaN }],
    [{ size: 10, color: [1, 1] }],
    [{ size: 10, texture: {} }],
    Array.from({ length: 17 }, () => ({ size: 1 })),
    // The frame's texture plus 16 images is 17 sampled textures in one fragment stage, over a default device's 16.
    Array.from({ length: 16 }, () => ({ size: 1, texture: glow })),
  ])
    assert.throws(() => new LensFlare({ elements: bad }), RangeError);
  new LensFlare({ elements: [...Array.from({ length: 15 }, () => ({ size: 1, texture: glow })), { size: 1 }] });
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(
    h.live().filter((r) => r !== ring && r !== glow),
    [],
    'disposal releases every resource it made (the caller owns the textures)',
  );
});
