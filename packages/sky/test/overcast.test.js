// KB-SKY-OVERCAST1: a full overcast draws as one even deck, the CIE overcast gradation of the two-stream light under it.
// The GPU draws the same deck (features-check.mjs overcast, both backends); here its CPU twin against the sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clouds, overcastDeck, DECK_ABOVE, DECK_DEPTH, DECK_VARIATION } from '../dist/clouds.js';
import { cloudTransmission } from '../dist/volumetric-clouds.js';
import { SKY_SETTINGS } from '../dist/settings.js';
import { Sky, overcastShare } from '../dist/index.js';
import { dayLight } from '../dist/day-presets.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

test('the deck lights level ground with the two-stream share of the light above it', () => {
  for (const depth of [1, DECK_DEPTH, 60, 200])
    for (const sunUp of [0.2, Math.SQRT1_2, 1]) {
      // E / pi under the deck: the integral of L cos over the hemisphere, by the midpoint rule in elevation.
      let e = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        const h = ((i + 0.5) / n) * (Math.PI / 2);
        e += overcastDeck([1, 1, 1], sunUp, Math.sin(h), depth)[1] * Math.sin(h) * Math.cos(h) * 2 * Math.PI * (Math.PI / 2 / n);
      }
      const want = cloudTransmission(depth) * DECK_ABOVE * sunUp;
      assert.ok(Math.abs(e / Math.PI / want - 1) < 1e-4, `depth ${depth}, sun ${sunUp}: ${e / Math.PI} vs ${want}`);
    }
});
test('the deck follows the CIE overcast sky: the horizon a third of the zenith, no sun, nothing below the horizon', () => {
  const z = overcastDeck([0.9, 1, 1.1], 0.6, 1)[1],
    h = overcastDeck([0.9, 1, 1.1], 0.6, 0)[1];
  assert.ok(Math.abs(h / z - 1 / 3) < 1e-12);
  assert.deepEqual(overcastDeck([1, 1, 1], -0.1, 1), [0, 0, 0]);
  assert.deepEqual(overcastDeck([1, 1, 1], 0.6, -0.5), overcastDeck([1, 1, 1], 0.6, 0));
  // Colour is the sun's: the deck is grey under a white sun.
  const c = overcastDeck([1, 1, 1], 0.6, 0.5);
  assert.ok(c[0] === c[1] && c[1] === c[2]);
  assert.ok(DECK_VARIATION > 0 && DECK_VARIATION <= 0.15, 'gentle variation');
});
test('clouds.depth is checked and has a slider row', () => {
  for (const depth of [0.5, 201, NaN]) assert.throws(() => clouds.validate({ coverage: 1, depth }), RangeError, String(depth));
  clouds.validate({ coverage: 1, depth: 1 });
  clouds.validate({ coverage: 1, depth: 200 });
  const row = SKY_SETTINGS.find((s) => s.name === 'clouds.depth');
  assert.ok(row, 'clouds.depth row');
  assert.equal(row.default, DECK_DEPTH);
  assert.equal(row.min, 1);
  assert.equal(row.max, 200);
});
test('the engine sun fades out with the deck: none under a full overcast, untouched up to 80 percent cover', () => {
  assert.equal(overcastShare(0.8), 0);
  assert.equal(overcastShare(0.45), 0);
  assert.ok(Math.abs(overcastShare(0.9) - 0.5) < 1e-12);
  assert.equal(overcastShare(1), 1);
  const light = (coverage) => {
    const h = optionalGPU();
    h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
    const sky = new Sky({ sunDirection: [0, Math.SQRT1_2, -Math.SQRT1_2], clouds: { coverage }, lighting: { intensity: 5 } });
    try {
      h.engine.use(sky);
      sky.onPreUpdate(0);
      return sky.lights[0].direction[3];
    } finally {
      sky.dispose();
    }
  };
  const clear = light(0.5);
  assert.ok(clear > 1);
  assert.equal(light(0.8), clear);
  assert.ok(Math.abs(light(0.9) / clear - 0.5) < 1e-6);
  assert.equal(light(1), 0);
  assert.equal(dayLight('overcast').intensity, 0);
});
test('the deck is in the units of the sky it closes over: Preetham 1, Bruneton its own zenith sun (about 2.6)', () => {
  const deck = (model, clouds, extra = {}) => {
    const h = optionalGPU();
    h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
    const sky = new Sky({ sunDirection: [0, Math.SQRT1_2, -Math.SQRT1_2], model, clouds, ...extra });
    try {
      h.engine.use(sky);
      sky.onPreUpdate(0);
      h.context.shader = wgsl;
      h.context.bindings = [];
      h.engine.frameGraph.execute(h.context);
      return sky.values[35];
    } finally {
      sky.dispose();
    }
  };
  assert.equal(deck('preetham', undefined), 0);
  assert.ok(Math.abs(deck('preetham', { coverage: 1 }) - 1 / (1 + 0.075 * DECK_DEPTH)) < 1e-6);
  assert.ok(Math.abs(deck('preetham', { coverage: 1, depth: 60 }) - 1 / (1 + 0.075 * 60)) < 1e-6);
  // Bruneton: 20 x the zenith transmittance (about 0.9 at the ground) over 4 pi x 0.55.
  const ratio = deck('bruneton', { coverage: 1 }) / deck('preetham', { coverage: 1 });
  assert.ok(ratio > 2.5 && ratio < 2.7, `Bruneton over Preetham ${ratio}`);
  const k = overcastDeck([1, 1, 1], 0.5, 1, 20, ratio)[1] / overcastDeck([1, 1, 1], 0.5, 1, 20)[1];
  assert.ok(Math.abs(k - ratio) < 1e-9);
});
test('the look tints the deck with its cloud colour', () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    module = device.createShaderModule,
    codes = [];
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  device.createShaderModule = (d) => (codes.push(d.code), module.call(device, d));
  const sky = new Sky({ clouds: { coverage: 1 }, look: { cloudColor: [1, 0.9, 0.8] } });
  try {
    h.engine.use(sky);
    sky.onPreUpdate(0);
    h.context.shader = wgsl;
    h.context.bindings = [];
    h.engine.frameGraph.execute(h.context);
  } finally {
    sky.dispose();
  }
  assert.ok(codes.some((c) => c.includes('*T)*frame.lookCloud.rgb;')), 'the deck is tinted');
});
