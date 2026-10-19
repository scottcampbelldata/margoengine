// Light parity (Crocotile point and spot lights): decay, angle + penumbra, unlimited range, and receivers without
// local-light shadows. The falloff is the one @margoengine/bvh's vertex-light bake uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// CPU mirror of the definition: window / max(d^decay, 0.01), window = range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1,
// and the cone smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction)), a step when the two are equal.
const attenuation = (d, range, decay = 2) =>
  (range > 0 ? Math.min(Math.max(1 - (d / range) ** 4, 0), 1) ** 2 : 1) / Math.max(d ** decay, 0.01);
const smoothstep = (low, high, x) => {
  if (x < low) return 0;
  if (x >= high) return 1;
  const t = (x - low) / (high - low);
  return t * t * (3 - 2 * t);
};
const cone = (angle, penumbra, cosine) => smoothstep(Math.cos(angle), Math.cos(angle * (1 - penumbra)), cosine);

function harness() {
  const h = optionalGPU();
  Object.assign(h.engine.gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  h.frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return h;
}

test('falloff and cone: the bake numbers (decay 1 at 2 m is 0.5, decay 0 is the window alone, penumbra 0 a step)', () => {
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(close(attenuation(2, 0, 1), 0.5));
  assert.ok(close(attenuation(2, 3, 0), (1 - (2 / 3) ** 4) ** 2));
  assert.ok(close(attenuation(2, 0), 0.25), 'default decay 2 is inverse-square');
  assert.ok(close(attenuation(0.05, 0), 100), 'max(d^decay, 0.01) caps the peak');
  assert.equal(attenuation(3, 3), 0, 'nothing at the range');
  const deg = Math.PI / 180;
  assert.equal(cone(30 * deg, 0, Math.cos(29.9 * deg)), 1);
  assert.equal(cone(30 * deg, 0, Math.cos(30 * deg)), 1, 'hard edge: on the edge is lit');
  assert.equal(cone(30 * deg, 0, Math.cos(30.1 * deg)), 0);
  assert.equal(cone(30 * deg, 0.5, Math.cos(15 * deg)), 1);
  // Inside the penumbra (15 to 30 degrees) the cone falls smoothly, in cosine.
  const fade = [17, 22.5, 28].map((a) => cone(30 * deg, 0.5, Math.cos(a * deg)));
  assert.ok(fade[0] < 1 && fade[0] > fade[1] && fade[1] > fade[2] && fade[2] > 0, `penumbra ${fade}`);
});

test('setLights packs decay, angle and penumbra; lights without them keep the exact old record and shader', () => {
  const h = harness(),
    legacy = [
      { position: [0, 2, 1], range: 5 },
      { position: [1, 2, 1], range: 5, direction: [0, -1, 0], outerAngle: 0.6, innerAngle: 0.3 },
    ],
    lights = new Clustered({ grid: [2, 2, 2] }).setLights(legacy),
    plain = new Clustered({ grid: [2, 2, 2] }).setLights(legacy);
  h.engine.use(lights);
  try {
    h.frame();
    const original = h.context.shader,
      before = lights['data'].slice(0, 32);
    assert.deepEqual(before, plain['data'].slice(0, 32));
    assert.equal(before[13], 0, 'point');
    assert.equal(before[16 + 13], 1, 'spot');
    lights.setLights([
      ...legacy,
      { position: [0, 3, 0], range: 0, decay: 1 },
      { position: [0, 3, 0], range: 8, direction: [0, -2, 0], angle: 0.5, penumbra: 0.25, decay: 0 },
      { position: [0, 3, 0], range: 8, direction: [0, -1, 0], angle: 0.5 },
    ]);
    const data = lights['data'];
    assert.deepEqual(data.slice(0, 32), before, 'old-style lights are packed exactly as before');
    assert.equal(data[32 + 3], Infinity, 'range 0 is unlimited');
    assert.equal(data[32 + 13], -2, 'point with decay 1: -(1 + decay)');
    assert.deepEqual(
      [...data.slice(48 + 8, 48 + 14)],
      [0, -1, 0, Math.cos(0.5), Math.cos(0.375), 2].map(Math.fround),
      'spot: unit direction, cos(angle), cos(angle * (1 - penumbra)), 2 + decay 0',
    );
    assert.equal(data[64 + 13], 4, 'spot with the default decay 2: 2 + decay');
    assert.equal(data[64 + 11], data[64 + 12], 'penumbra 0: outer and inner cosines are equal (a hard edge)');
    h.frame();
    assert.notEqual(h.context.shader, original);
    assert.ok(h.context.shader.includes('let legacy=kind==0.0||kind==1.0;'));
    assert.ok(lights.pbr(2).declarations.includes('max(pow(max(distance,0.0001),decay),0.01)'));
    assert.equal(lights.pbr(2).declarations, clusteredSampling(2, undefined, undefined, false, true));
    lights.setLights(legacy);
    h.frame();
    assert.equal(h.context.shader, original, 'without decay or angle lights the shader is the original again');
    assert.equal(lights.pbr(2).declarations, clusteredSampling(2));
  } finally {
    lights.dispose();
    plain.dispose();
  }
});

test('setLights validates decay, the angle/penumbra cone and unlimited ranges before changing anything', () => {
  const lights = new Clustered({ grid: [2, 2, 2] }),
    spot = { position: [0, 2, 0], range: 5, direction: [0, -1, 0] };
  lights.setLights([{ position: [0, 1, 0], range: 2 }]);
  const before = lights['data'].slice(0, 16);
  for (const [light, type] of [
    [{ position: [0, 1, 0], range: 2, decay: -1 }, RangeError],
    [{ position: [0, 1, 0], range: 2, decay: Number.NaN }, RangeError],
    [{ position: [0, 1, 0], range: -1 }, RangeError],
    [{ position: [0, 1, 0], range: 0, castShadow: true }, RangeError],
    [{ ...spot, angle: 0.5, outerAngle: 0.5 }, TypeError],
    [{ ...spot, outerAngle: 0.5, penumbra: 0.5 }, TypeError],
    [{ ...spot, angle: Math.PI / 2 }, RangeError],
    [{ ...spot, angle: 0 }, RangeError],
    [{ ...spot, angle: 0.5, penumbra: 1.5 }, RangeError],
    [{ ...spot, direction: [0, 0, 0], angle: 0.5 }, RangeError],
    [{ ...spot }, RangeError],
  ])
    assert.throws(() => lights.setLights([{ position: [9, 9, 9], range: 1 }, light]), type, JSON.stringify(light));
  assert.deepEqual(lights['data'].slice(0, 16), before);
  assert.equal(lights['lightCount'], 1);
  lights.dispose();
});

test('add(receiver, {receiveShadow: false}) lights it without local-light shadow terms or bindings', () => {
  const h = harness(),
    lights = new Clustered({ grid: [2, 2, 2], shadows: { maxLights: 1 } }),
    handed = [],
    receiver = () => ({
      addLighting(effect) {
        handed.push(effect);
        return () => handed.push('removed');
      },
    });
  lights.setLights([{ position: [0, 2, 1], range: 6, shadow: true }]);
  h.engine.use(lights);
  try {
    const remove = lights.add(receiver());
    lights.add(receiver(), { receiveShadow: false });
    const [shadowed, unshadowed] = handed;
    assert.equal(shadowed, lights);
    assert.notEqual(unshadowed, lights);
    assert.equal(unshadowed.owner, lights.owner);
    assert.ok(shadowed.pbr(2).declarations.includes('clusterShadowVisibility(light,position,n)'));
    assert.ok(!unshadowed.pbr(2).declarations.includes('clusterShadowVisibility'));
    assert.equal(unshadowed.pbr(2), unshadowed.pbr(2), 'hooks are cached');
    assert.equal(unshadowed.pbr(2).declarations, clusteredSampling(2));
    assert.deepEqual(
      shadowed.bindings().map((entry) => entry.binding),
      [4, 5, 6, 7, 28, 29, 30],
    );
    assert.deepEqual(
      unshadowed.bindings().map((entry) => entry.binding),
      [4, 5, 6, 7],
    );
    assert.equal(unshadowed.bindings(), unshadowed.bindings(), 'a stable bindings array');
    assert.ok(!unshadowed.shader(wgsl).includes('clusterShadowVisibility'));
    assert.ok(lights.shader(wgsl).includes('clusterShadowVisibility'));
    assert.throws(() => lights.add(receiver(), { receiveShadow: 'no' }), TypeError);
    remove();
    assert.equal(handed.at(-1), 'removed');
  } finally {
    lights.dispose();
  }
});
