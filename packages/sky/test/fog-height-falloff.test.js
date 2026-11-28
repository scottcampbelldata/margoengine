// Exponential height fog (Fauld recut, 2026-11-24): with the haze the same at every height, drone shots at 300 to
// 600 m looked through ground-level winter haze over their whole path and read as grey fields of fog. With
// `scaleHeight` the density falls by e every scaleHeight metres above `base`, integrated along the ray.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fogOpticalDepth } from '../dist/index.js';
import { fog } from '../dist/fog.js';

const depth = () => undefined;

test('no scaleHeight keeps the old homogeneous fog', () => {
  const f = { density: 0.0005, start: 0 };
  assert.equal(fogOpticalDepth(f, 800, 600, 80), 0.4);
  assert.equal(fogOpticalDepth({ ...f, scaleHeight: 0 }, 800, 600, 80), 0.4);
});

test('a level ray at the base has the full density; a drone looking down sees thinner haze', () => {
  const f = { density: 0.0005, start: 0, scaleHeight: 400, base: 80 };
  assert.ok(Math.abs(fogOpticalDepth(f, 800, 80, 80) - 0.4) < 1e-9, 'level at base');
  const down = fogOpticalDepth(f, 800, 600, 80);
  // exp(-520/400) (1 - exp(520/400)) / (-520/400): the mean density along the ray, about 0.55 of the base's
  const want = 0.4 * Math.exp(-1.3) * ((1 - Math.exp(1.3)) / -1.3);
  assert.ok(Math.abs(down - want) < 1e-9, `${down} vs ${want}`);
  assert.ok(down < 0.25, `down ${down}`);
  // the same ray reversed (looking up from the ground) crosses the same air
  assert.ok(Math.abs(fogOpticalDepth(f, 800, 80, 600) - down) < 1e-9);
  // nearly level rays take the series form, continuous with the closed form
  assert.ok(Math.abs(fogOpticalDepth(f, 800, 200, 200.39) - fogOpticalDepth(f, 800, 200, 200.41)) < 1e-4);
});

test('the fog option checks scaleHeight and base', () => {
  fog.validate({ depth, scaleHeight: 400, base: -20 });
  assert.throws(() => fog.validate({ depth, scaleHeight: -1 }), RangeError);
  assert.throws(() => fog.validate({ depth, scaleHeight: Number.NaN }), RangeError);
  assert.throws(() => fog.validate({ depth, base: Number.POSITIVE_INFINITY }), RangeError);
});

// KB-SKY-HAZEBELOW1: a ray below the horizon takes the haze's colour times fogBelowLight of its own ray.
test('fogBelowLight: 1 at and above the horizon and for no decay, 1 / (1 + k down) for a long ray, 1 for a short one', async () => {
  const { fogBelowLight } = await import('../dist/index.js');
  assert.deepEqual(fogBelowLight([0.5, 0.5, 0.5], 0.2, 20), [1, 1, 1]);
  assert.deepEqual(fogBelowLight([0.5, 0.5, 0.5], 0, 20), [1, 1, 1]);
  assert.deepEqual(fogBelowLight([0, 0, 0], -0.4, 20), [1, 1, 1]);
  const far = fogBelowLight([0.3, 0.45, 0.7], -0.4, 60);
  [0.3, 0.45, 0.7].forEach((k, i) => assert.ok(Math.abs(far[i] - 1 / (1 + 0.4 * k)) < 1e-12, `${far[i]}`));
  // The series below an optical depth of 1e-3 meets the closed form above it.
  const a = fogBelowLight([0.5, 0.5, 0.5], -0.5, 0.000999)[0],
    b = fogBelowLight([0.5, 0.5, 0.5], -0.5, 0.001001)[0];
  assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  // The exact in-scatter of a ray of optical depth x in light falling as e^(-c tau) along it, over the opacity.
  const x = 0.8,
    c = 0.45 * 0.3,
    want = (1 - Math.exp(-x * (1 + c))) / ((1 + c) * (1 - Math.exp(-x)));
  assert.ok(Math.abs(fogBelowLight([0.45, 0.45, 0.45], -0.3, x)[1] - want) < 1e-12);
});

test('the fog option checks lightDecay', () => {
  fog.validate({ depth, lightDecay: [0, 0.4, 1] });
  assert.throws(() => fog.validate({ depth, lightDecay: [-0.1, 0, 0] }), RangeError);
  assert.throws(() => fog.validate({ depth, lightDecay: [0, Number.NaN, 0] }));
  assert.throws(() => fog.validate({ depth, lightDecay: [0, 0] }));
});

// KB-SKY-HAZETINT1 (Above the Treeline look round 6): a sky-coloured haze took the horizon's own colour at every distance,
// so far ranges under clear mountain air faded to the white-grey horizon and never turned blue.
test('fogAirLight: a thin haze is bluer than the horizon, a thick one is the horizon, and off or green is 1', async () => {
  const { fogAirLight, FOG_RAYLEIGH } = await import('../dist/index.js');
  const thin = fogAirLight(FOG_RAYLEIGH, 4e-5, 3500, 0.6);
  assert.equal(thin[1], 1);
  assert.ok(thin[2] > 1.15 && thin[0] < 0.93, `thin clear-air haze 15 km out: ${thin}`);
  const thick = fogAirLight(FOG_RAYLEIGH, 4e-5, 3500, 40);
  for (const v of thick) assert.ok(Math.abs(v - 1) < 1e-6, `a haze that hides fully is the horizon's colour: ${thick}`);
  for (const v of fogAirLight([0, 0, 0], 4e-5, 3500, 0.6)) assert.equal(v, 1);
  // Dense fog is mostly aerosol: the air's share is small, so it stays the sky's colour.
  const fog = fogAirLight(FOG_RAYLEIGH, 0.01, 0, 0.6);
  for (const v of fog) assert.ok(Math.abs(v - 1) < 0.003, `dense fog: ${fog}`);
  // Higher eyes look through thinner air: less tint.
  assert.ok(fogAirLight(FOG_RAYLEIGH, 4e-5, 8000, 0.6)[2] < thin[2]);
});
