import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_PRESETS, applyDayPreset, dayLight, dayPreset, dayPresetNames } from '../dist/presets.js';
import { Sky } from '../../sky/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const close = (a, b, eps, what) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${what}: ${a} against ${b}`));

test('the four presets are frozen, named in order, and give fresh sky options each call', () => {
  assert.deepEqual(dayPresetNames, ['noon', 'goldenHour', 'overcast', 'dawn']);
  assert.deepEqual(Object.keys(DAY_PRESETS), dayPresetNames);
  for (const name of dayPresetNames) {
    assert.ok(Object.isFrozen(DAY_PRESETS[name]) && Object.isFrozen(DAY_PRESETS[name].ambient), name);
    const a = dayPreset(name),
      b = dayPreset(name);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    assert.equal(a.timeScale, 0, 'the clock is held');
    assert.ok(Math.abs(Math.hypot(...a.sunDirection) - 1) < 1e-6);
    assert.equal(a.lighting.intensity, DAY_PRESETS[name].intensity);
  }
  // Noon high in the south, golden hour low in the west, dawn on the eastern horizon.
  assert.ok(dayPreset('noon').sunDirection[1] > 0.9);
  assert.ok(dayPreset('goldenHour').sunDirection[0] < -0.99);
  assert.ok(dayPreset('dawn').sunDirection[0] > 0.99);
  assert.equal(dayPreset('noon').clouds, undefined, 'a clear noon draws no cloud sheet');
  assert.equal(dayPreset('overcast').clouds.coverage, 1);
  assert.throws(() => dayPreset('midnight'), /Unknown day preset "midnight"; use one of noon, goldenHour/);
  assert.throws(() => dayPreset({ ...DAY_PRESETS.noon, elevation: 95 }), /Invalid day preset/);
  assert.throws(() => dayPreset({ ...DAY_PRESETS.noon, ambient: [1, 1] }), /Invalid day preset/);
  assert.throws(() => dayPreset('toString'), /Unknown day preset/, 'inherited names are not presets');
  assert.equal(dayPreset({ ...DAY_PRESETS.noon, elevation: 30 }).sunDirection[1].toFixed(6), '0.500000');
});

test('the light matches the sky: warm and dimmed low down, faint through overcast', () => {
  const noon = dayLight('noon'),
    golden = dayLight('goldenHour'),
    overcast = dayLight('overcast'),
    dawn = dayLight('dawn');
  // At 70 degrees the air takes a few percent; at 5 and 1 degree it reddens the sun (red stays 1, blue falls).
  assert.ok(noon.intensity > 4.8 && noon.intensity <= 5, `noon ${noon.intensity}`);
  assert.equal(Math.max(...golden.color), golden.color[0]);
  assert.ok(golden.color[2] < 0.6 * noon.color[2], `golden hour is warm: ${golden.color}`);
  assert.ok(dawn.color[2] < golden.color[2] && dawn.intensity < golden.intensity, `dawn lower still: ${dawn.color}`);
  // Overcast: the cloud hides the sun, so a tenth of the direct light and a diffuse floor over three times noon's.
  assert.ok(overcast.intensity < 0.15 * noon.intensity);
  assert.ok(overcast.ambient[1] > 3 * noon.ambient[1]);
  // Set in the west below the horizon: no direct light at all.
  assert.equal(dayLight({ ...DAY_PRESETS.goldenHour, elevation: -5 }).intensity, 0);
});

// The sun is set in onPreUpdate; the ambient half needs core's real PBR shader, which the GPU check covers.
const update = (sky) => sky.onPreUpdate(0);
const harness = () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array(4) };
  return h;
};

test('a Sky built from a preset drives the engine sun with exactly the preset light', () => {
  for (const name of dayPresetNames) {
    const h = harness();
    const sky = new Sky(dayPreset(name)),
      light = dayLight(name);
    try {
      h.engine.use(sky);
      update(sky);
      close([...sky.lights[0].direction.slice(0, 3)], light.direction, 1e-6, `${name} direction`);
      close([...sky.lights[0].radiance.slice(0, 3)], light.color, 1e-5, `${name} colour`);
      close([sky.lights[0].direction[3]], [light.intensity], 1e-5, `${name} strength`);
    } finally {
      sky.dispose();
    }
  }
});

test('applyDayPreset switches a running sky, dropping a cloud sheet the preset lacks and keeping fog', () => {
  const h = harness(),
    fog = { depth: () => undefined, density: 0.01 };
  const sky = new Sky({ ...dayPreset('overcast'), fog });
  try {
    h.engine.use(sky);
    update(sky);
    applyDayPreset(sky, 'noon');
    assert.equal(sky.options.clouds, undefined);
    assert.equal(sky.options.fog, fog);
    update(sky);
    close([sky.lights[0].direction[3]], [dayLight('noon').intensity], 1e-5, 'noon after switching');
    applyDayPreset(sky, 'goldenHour');
    assert.equal(sky.options.clouds.coverage, 0.2);
    update(sky);
    close([...sky.lights[0].radiance.slice(0, 3)], dayLight('goldenHour').color, 1e-5, 'golden hour after switching');
    assert.throws(() => applyDayPreset(sky, 'dusk'), /Unknown day preset/);
  } finally {
    sky.dispose();
  }
});
