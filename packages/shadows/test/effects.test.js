import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_BINDING, effectEntries, moveEffects, shadowSampling, validEffects } from '../src/shader.ts';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { cloudShadows, lightPattern } from '../dist/light-function.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
const effect = {
  wgsl: (group, binding) => `@group(${group}) @binding(${binding}) var<uniform> shadowFxTest:vec4f;\n`,
  call: 'shadowFxTest.xyz',
  resources: () => [{ buffer: 'a' }, { buffer: 'b' }],
};
const sky = { cloudLayer: { field: 'fn cloudOctaves(){cloudNoise();cloudHash();}\n', coverage: 0.4, drift: 3, height: 1500 } };

test('no effects leaves the receiver shader as it was', () => {
  for (const filter of ['soft', 'pcf', 'hard']) {
    const plain = shadowSampling(2, filter);
    assert.equal(shadowSampling(2, filter, false, false, false, []), plain);
    assert.ok(!plain.includes('shadowReach'), 'golden GPU proofs pin this text for apps with no effects');
    assert.ok(!plain.includes('shadowFx'));
    assert.equal(new VirtualShadows({ filter, effects: [] }).pbr(2).declarations, new VirtualShadows({ filter }).pbr(2).declarations);
  }
});
test('an effect multiplies the sun in both shadow classes', () => {
  for (const code of [shadowSampling(1, 'hard', false, false, false, [effect]), new VirtualShadows({ filter: 'hard', effects: [effect] }).pbr(1).declarations]) {
    assert.ok(code.includes(`@group(1) @binding(${EFFECT_BINDING}) var<uniform> shadowFxTest`));
    assert.ok(code.includes('*shadowFxTest.xyz;}'));
    assert.ok(code.includes('fn shadowReach()->f32'));
  }
});
test('each effect has eight bindings from EFFECT_BINDING', () => {
  assert.deepEqual(
    effectEntries([effect, effect]).map((e) => e.binding),
    [EFFECT_BINDING, EFFECT_BINDING + 1, EFFECT_BINDING + 8, EFFECT_BINDING + 9],
  );
});
test('a filter effect replaces the named filters', () => {
  const code = shadowSampling(0, { ...effect, body: 'return 0.25;' }, false, false, false, [effect]);
  assert.ok(code.includes('return 0.25;'));
  assert.ok(!code.includes('shadowGolden'));
});
test('moveEffects moves only effect declarations', () => {
  const code = '@group(0) @binding(40) var<uniform> shadowFxA:vec4f;\n@group(0) @binding(41) var shadowFxMap:texture_2d<f32>;\n@group(0) @binding(2) var shadowMap:texture_depth_2d;';
  const moved = moveEffects(code, (binding) => binding + 10);
  assert.ok(moved.includes('@binding(50) var<uniform> shadowFxA'));
  assert.ok(moved.includes('@binding(51) var shadowFxMap'));
  assert.ok(moved.includes('@binding(2) var shadowMap'));
});
test('effects are checked at construction', () => {
  assert.deepEqual(validEffects(undefined), []);
  assert.throws(() => new Shadows({ effects: [{}] }), TypeError);
  assert.throws(() => new VirtualShadows({ effects: 'clouds' }), TypeError);
  assert.doesNotThrow(() => new Shadows({ effects: [effect] }));
});
test('cloudShadows renames the sky field and needs a sky', () => {
  assert.throws(() => cloudShadows({}), TypeError);
  const code = cloudShadows(sky).wgsl(2, 44);
  assert.ok(code.includes('fn shadowFxOctaves44()'));
  assert.ok(!/\bcloud(Hash|Noise|Octaves)\b/.test(code), 'two effects, or a sky in the same module, must not collide');
});
test('cloudShadows without a cloud layer compiles to no shade', () => {
  const code = cloudShadows({ cloudLayer: undefined }).wgsl(0, 40);
  assert.ok(code.includes('fn shadowFxOctaves40('));
});
test('cloudShadows writes the layer and refuses bad settings', () => {
  let written;
  const device = {
    createBuffer: () => ({ destroy() {} }),
    queue: { writeBuffer: (buffer, offset, values) => (written = [...values]) },
  };
  const shade = cloudShadows(sky, { strength: 0.5 });
  shade.setup(device);
  shade.update({ context: { device }, light: [0, 1, 0], changed: false });
  assert.deepEqual(written.slice(4), [Math.fround(0.4), 3, 1500, 0.5]);
  shade.options.strength = 2;
  assert.throws(() => shade.update({ context: { device }, light: [0, 1, 0], changed: false }), RangeError);
});
test('lightPattern lays its mask across the light', () => {
  let written;
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    queue: { writeBuffer: (buffer, offset, values) => (written = [...values]) },
  };
  assert.throws(() => lightPattern({}), TypeError);
  const pattern = lightPattern({ texture: {}, size: 4 });
  pattern.setup(device);
  const l = [0.6, 0.8, 0];
  pattern.update({ context: { device }, light: l, changed: false });
  const right = written.slice(0, 3),
    up = written.slice(4, 7),
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(right, l)) < 1e-6 && Math.abs(dot(up, l)) < 1e-6 && Math.abs(dot(right, up)) < 1e-6);
  assert.ok(Math.abs(dot(up, up) - 1) < 1e-5 && up[1] > 0, 'image up is world up as the sun sees it');
  assert.equal(written[8], 4);
  pattern.options.size = 0;
  assert.throws(() => pattern.update({ context: { device }, light: l, changed: false }), RangeError);
});
test('varianceFilter checks its settings', async () => {
  const { varianceFilter } = await import('../dist/vsm.js');
  assert.throws(() => varianceFilter({ size: 8 }), RangeError);
  const filter = varianceFilter({ blur: 8 });
  assert.ok(filter.body.includes('shadowFxMomentsAt(uv,layer)'), 'the body is read before wgsl runs, so it names no binding');
  const code = shadowSampling(1, filter, false, false, false, [filter]);
  assert.ok(code.includes('fn shadowFxMomentsAt('));
  assert.ok(code.includes('textureSampleCompareLevel(shadowMap,shadowSampler'), "an 'auto' layout must keep the sampler");
  assert.doesNotThrow(() => new Shadows({ filter }));
  assert.throws(() => new Shadows({ filter: { nope: 1 } }), RangeError);
});
test('transmission moves what lets light through to the tint map', async () => {
  const { transmission } = await import('../dist/transmission.js');
  assert.throws(() => transmission({}), TypeError);
  const leaf = { index: 1, transmits: [0.2, 0.4, 0.1] },
    stem = { index: 2 },
    glass = { index: 3, tint: [0.9, 0.9, 0.9] };
  const source = transmission({ shadowPrimitives: [leaf, stem], tintPrimitives: [glass] }, { scale: 2 });
  assert.deepEqual(source.shadowPrimitives, [stem]);
  assert.deepEqual(source.tintPrimitives.map((p) => p.tint), [glass.tint, [0.4, 0.8, 0.2]]);
  assert.throws(() => source.addLighting({ options: {} }), TypeError);
  assert.doesNotThrow(() => source.addLighting({ options: { colored: true } }));
  source.options.scale = -1;
  assert.throws(() => source.tintPrimitives, RangeError);
});
test('a tint expression takes over the light behind a tint caster, and only then', async () => {
  const { transmission } = await import('../dist/transmission.js');
  const { effect } = transmission({ shadowPrimitives: [] });
  const code = shadowSampling(0, 'hard', false, true, false, [effect]);
  assert.ok(/shadowFxSpread40\(through,gap\)/.test(code));
  assert.ok(!shadowSampling(0, 'hard', false, true, false, []).includes('gap'));
});

test("the 'soft' search reads the pool as float on a device at the compatibility level", () => {
  const shadows = new VirtualShadows({ filter: 'soft' }),
    full = shadows.pbr(2).declarations;
  assert.doesNotMatch(full, /shadowDepth/);
  assert.match(full, /textureLoad\(shadowMap/);
  const level = new VirtualShadows({ filter: 'soft' });
  level.device = { features: new Set() };
  const code = level.pbr(2).declarations;
  assert.match(code, /@group\(2\) @binding\(30\) var shadowDepth:texture_2d<f32>/);
  assert.doesNotMatch(code, /textureLoad\(shadowMap/);
  const pcf = new VirtualShadows({ filter: 'pcf' });
  pcf.device = { features: new Set() };
  assert.doesNotMatch(pcf.pbr(2).declarations, /shadowDepth/);
});
