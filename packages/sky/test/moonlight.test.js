import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, moonlight, moonlightColor, cloudTransmittance, MOON_EXTINCTION, MOON_PHASES, moonLook, moonPhase, moonWaning } from '../dist/index.js';
import { Sky as SkyBase } from '../dist/base.js';
import { bruneton } from '../dist/bruneton.js';
import { night } from '../dist/night.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// Krisciunas and Schaefer (PASP 103, 1991), written out here: eq. 20 above the air (foot-candles, 10.7639 lux each),
// eq. 3 for the airmass, 10^(-0.4 k X) through it.
const ks = (phase, up, k = 0.172) => {
  const a = (Math.acos(phase) * 180) / Math.PI,
    X = 1 / Math.sqrt(1 - 0.96 * (1 - up * up));
  return 10 ** (-0.4 * (3.84 + 0.026 * a + 4e-9 * a ** 4)) * 10.7639 * 10 ** (-0.4 * k * X);
};

test('moonlight follows Krisciunas and Schaefer: 0.313 lux full above the air, 0.367 of it at phase 0.75', () => {
  assert.ok(Math.abs(moonlight(1, [0, 1, 0], 0).illuminance - 0.3133) < 5e-4);
  assert.ok(Math.abs(moonlight(0.75, [0, 1, 0], 0).illuminance / moonlight(1, [0, 1, 0], 0).illuminance - 0.367) < 0.002);
  assert.equal(MOON_EXTINCTION, 0.172);
  for (const phase of [1, 0.75, 0, -0.5])
    for (const dir of [[0, 1, 0], [-0.45, 0.42, -1], [1, 0.1, 0]]) {
      const up = dir[1] / Math.hypot(...dir),
        light = moonlight(phase, dir);
      assert.ok(Math.abs(light.illuminance / ks(phase, up) - 1) < 1e-9, `phase ${phase} at ${dir}`);
      assert.ok(Math.abs(light.intensity * luminance(light.color) - light.illuminance) < 1e-12);
      assert.equal(Math.max(...light.color), 1);
    }
  assert.equal(moonlight(1, [1, 0, 0]).illuminance, 0, 'no moonlight from a moon on the horizon');
  assert.equal(moonlight(1, [1, -0.2, 0]).illuminance, 0, 'none from below it');
  for (const bad of [[2, [0, 1, 0]], [0, [0, 0, 0]], [0, [0, 1, 0], -1], [NaN, [0, 1, 0]]])
    assert.throws(() => moonlight(...bad), RangeError);
});

test('a brighter moon is less blue, and below mesopic levels moonlight takes the night blue', () => {
  // A white Lambertian surface under the light has luminance illuminance / pi: rods saturate (no shift) at
  // log10 Y = 0.6 and take over fully (the (0.25, 0.25) blue) at -2 (Jensen et al. 2000).
  const half = moonlight(0, [0, 1, 0]),
    full = moonlight(1, [0, 1, 0], 0);
  assert.ok(Math.log10(half.illuminance / Math.PI) < -2);
  assert.ok(Math.abs(half.color[0] - 0.359) < 0.002 && Math.abs(half.color[1] - 0.503) < 0.002 && half.color[2] === 1);
  assert.ok(full.color[0] > half.color[0] && full.color[1] > half.color[1], 'a brighter moon is less blue');
});

test('the sky lights with the moon it draws: a 0.75 moon 21 degrees up gives 0.078 lux, with no intensity set', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const moonDirection = [-0.45, 0.42, -1],
    sky = new Sky({ hours: 23, timeScale: 0, night: { moonDirection, moonPhase: 0.75 }, lighting: { moon: {} } });
  h.engine.use(sky);
  for (const phase of [0.75, 1, 0, -0.9]) {
    sky.options.night.moonPhase = phase;
    h.frame();
    const lux = sky.lights[1].direction[3] * luminance(sky.lights[1].radiance),
      want = ks(phase, 0.42 / Math.hypot(...moonDirection));
    assert.ok(Math.abs(lux / want - 1) < 1e-4, `phase ${phase}: ${lux} lux against ${want}`);
    assert.deepEqual([...sky.lights[1].radiance], moonlight(phase, moonDirection).color.map(Math.fround));
  }
  sky.options.night.moonPhase = 0.75;
  sky.options.lighting.moon.color = [1, 1, 1];
  h.frame();
  assert.ok(Math.abs(sky.lights[1].direction[3] - ks(0.75, 0.42 / Math.hypot(...moonDirection))) < 1e-6, 'a set colour keeps the lux');
  sky.options.lighting.moon = { intensity: 0.5 };
  h.frame();
  assert.equal(sky.lights[1].direction[3], 0.5, 'a set intensity replaces it');
  sky.options.night = undefined;
  sky.options.lighting.moon = {};
  h.frame();
  const up = sky.moon[1];
  assert.ok(Math.abs(sky.lights[1].direction[3] * luminance(sky.lights[1].radiance) / ks(1, up) - 1) < 1e-4, 'without a night the moon is full');
  sky.options.lighting.moon = { extinction: 3 };
  assert.throws(() => h.frame(), RangeError);
});

test('cloud cover dims the scene moonlight by Kasten and Czeplak and takes it bluer; brightness scales it', () => {
  // Kasten and Czeplak (Solar Energy 24, 1980), written out here: 1 - 0.75 (N/8)^3.4 of the clear-sky illuminance.
  const kc = (cover) => 1 - 0.75 * cover ** 3.4;
  for (const cover of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(cloudTransmittance(cover) - kc(cover)) < 1e-15);
  assert.equal(cloudTransmittance(1), 0.25, 'an overcast sky passes a quarter');
  for (const bad of [-0.1, 1.1, NaN]) assert.throws(() => cloudTransmittance(bad), RangeError);
  assert.deepEqual(moonlightColor(moonlight(0.75, [0, 1, 0]).illuminance), moonlight(0.75, [0, 1, 0]).color);
  assert.throws(() => moonlightColor(-1), RangeError);

  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const moonDirection = [-0.45, 0.42, -1],
    sky = new Sky({ hours: 23, timeScale: 0, night: { moonDirection, moonPhase: 1 }, lighting: { moon: {} } });
  h.engine.use(sky);
  const lux = (light) => light.direction[3] * luminance(light.radiance);
  h.frame();
  const clear = lux(sky.lights[1]);
  assert.ok(Math.abs(lux(sky.moonUnderClouds) / clear - 1) < 1e-6, 'a clear sky passes all of it');
  assert.equal(h.engine.lighting.direction[3], sky.moonUnderClouds.direction[3], 'the engine light takes the moon');
  for (const cover of [0.5, 0.75, 1]) {
    sky.options.lighting.moon = { cloudCover: cover };
    h.frame();
    assert.ok(Math.abs(lux(sky.lights[1]) / clear - 1) < 1e-6, 'above the cloud the moon is as bright');
    assert.ok(Math.abs(lux(sky.moonUnderClouds) / (clear * kc(cover)) - 1) < 1e-5, `cover ${cover}`);
    assert.equal(h.engine.lighting.direction[3], sky.moonUnderClouds.direction[3]);
    assert.deepEqual([...sky.moonUnderClouds.radiance], moonlightColor(clear * kc(cover)).map(Math.fround));
  }
  assert.ok(sky.moonUnderClouds.radiance[0] < sky.lights[1].radiance[0], 'the dimmer light under the cloud is bluer');
  // A scene's own moon: twice as bright, and a set colour that the cloud does not change.
  sky.options.lighting.moon = { brightness: 2 };
  h.frame();
  assert.ok(Math.abs(lux(sky.lights[1]) / (2 * clear) - 1) < 1e-6, 'brightness 2 doubles the moon');
  sky.options.lighting.moon = { intensity: 0.5, color: [1, 1, 1], cloudCover: 1 };
  h.frame();
  assert.equal(sky.lights[1].direction[3], 0.5);
  assert.ok(Math.abs(sky.moonUnderClouds.direction[3] - 0.125) < 1e-7, 'the cloud dims a set intensity too');
  assert.deepEqual([...sky.moonUnderClouds.radiance], [1, 1, 1]);
  // Without cloudCover the sky's own cloud sheet sets it.
  sky.options.lighting.moon = {};
  sky.options.clouds = { coverage: 0.6 };
  h.frame();
  assert.ok(Math.abs(lux(sky.moonUnderClouds) / (clear * kc(0.6)) - 1) < 1e-5, 'the clouds sheet dims it');
  for (const moon of [{ brightness: -1 }, { cloudCover: 2 }, { brightness: NaN }]) {
    sky.options.lighting.moon = moon;
    assert.throws(() => h.frame(), RangeError);
  }
});

// Moon presets (KB-MOON-PRESETS1): named phases, bright and dim, and the red moons, each through the drawn disc
// (uniform 51 to 56 and the waning flag 63) and the light (sky.lights[1]).
const uniforms = (h) => new Float32Array(h.resources.findLast((r) => !r.destroyed && r.size === 256).data).slice();
const presetSky = (night) => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 23, timeScale: 0, night: { moonDirection: [-0.45, 0.42, -1], ...night }, lighting: { moon: {} } });
  h.engine.use(sky);
  return { h, sky, lux: () => sky.lights[1].direction[3] * luminance(sky.lights[1].radiance) };
};
const UP = 0.42 / Math.hypot(-0.45, 0.42, -1);

test('named phases: new to full by the octants (Meeus), the waning ones lit on the left, a number still accepted', () => {
  const c = Math.SQRT1_2,
    want = {
      new: [-1, 1], waxingCrescent: [-c, 1], firstQuarter: [0, 1], half: [0, 1], quarter: [0, 1], waxingGibbous: [c, 1],
      full: [1, 1], waningGibbous: [c, 3], lastQuarter: [0, 3], waningCrescent: [-c, 3],
    };
  assert.deepEqual(Object.keys(MOON_PHASES).sort(), Object.keys(want).sort());
  const { h, sky, lux } = presetSky({});
  for (const [name, [phase, flag]] of Object.entries(want)) {
    sky.options.night.moonPhase = name;
    h.frame();
    const v = uniforms(h);
    assert.equal(v[56], Math.fround(phase), name + ' draws its phase');
    assert.equal(v[63], flag, name + ' lights its limb');
    assert.ok(Math.abs(lux() / ks(phase, UP) - 1) < 1e-4, name + ' lights by its phase');
    assert.equal(moonPhase(name), phase);
    assert.equal(moonWaning(name), flag === 3);
  }
  sky.options.night.moonPhase = 0.3;
  h.frame();
  assert.equal(uniforms(h)[56], Math.fround(0.3));
  assert.equal(uniforms(h)[63], 1, 'a number is waxing');
  sky.options.night.moonLitBySun = true;
  sky.options.night.moonPhase = 'lastQuarter';
  h.frame();
  assert.equal(uniforms(h)[63], 2, 'moonLitBySun turns the limb toward the sun instead');
  for (const bad of ['gibbous', 'Full', '', NaN]) {
    sky.options.night.moonPhase = bad;
    assert.throws(() => h.frame(), RangeError, String(bad));
  }
});

test('the night shader turns the lit limb for a waning moon, in WGSL and the WebGL2 twin', () => {
  assert.ok(night.wgsl.includes('if(frame.sunlight.w>2.5){right=-right;}'));
  assert.ok(night.wgsl.includes('if(abs(frame.sunlight.w-2.0)<0.5)'), 'moonLitBySun is flag 2 alone');
  const code = new SkyBase({ model: 'bruneton', night: {} }, { bruneton, night }).code,
    glsl = translateWGSL({ vertex: { source: code }, fragment: { source: code } }).fragment.source;
  // The flags sit in the uniform's 16th vec4 (index 15, w: values[63]).
  assert.match(glsl, /if \(\(uintBitsToFloat\(_uf0_0\[15\]\.w\) > 2\.5\)\) \{\s*(\w+) = -\1;/);
  assert.match(glsl, /abs\(\(uintBitsToFloat\(_uf0_0\[15\]\.w\) - 2\.0\)\) < 0\.5/);
});

test('bright and dim: a supermoon 1.164 times as bright with a disc 1.079 times as wide, a thin veil halving it', () => {
  const { h, sky, lux } = presetSky({ moonPhase: 'full' });
  h.frame();
  const base = lux(),
    v0 = uniforms(h);
  assert.deepEqual([...v0.slice(52, 55)], [6.4, 7.6, 9.6].map(Math.fround), 'no preset: the night colour');
  sky.options.lighting.moon = { brightness: 'bright' };
  h.frame();
  let v = uniforms(h);
  const perigee = 384400 / 356375;
  assert.ok(Math.abs(lux() / base - perigee ** 2) < 1e-5, 'the light grows by the inverse square of the distance');
  assert.ok(Math.abs(Math.asin(v[55]) / 0.038 - perigee) < 1e-5, 'the disc grows with the distance');
  assert.equal(v[51], Math.fround(Math.cos(0.038 * perigee)));
  assert.deepEqual([...v.slice(52, 55)], [...v0.slice(52, 55)], 'its surface is as bright');
  sky.options.lighting.moon = { brightness: 'dim' };
  h.frame();
  v = uniforms(h);
  assert.ok(Math.abs(lux() / base - 0.5) < 1e-5, 'thin cloud halves the light (USNO Circular 171)');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(v[52 + i] / v0[52 + i] - 0.5 ** (1 / 3)) < 1e-5, 'the disc as the eye judges it');
  assert.equal(v[55], v0[55]);
  sky.options.lighting.moon = { brightness: 2 };
  h.frame();
  assert.ok(Math.abs(uniforms(h)[52] / v0[52] - 2 ** (1 / 3)) < 1e-5, 'a number scales the disc too');
  for (const bad of ['brite', 'Bright']) {
    sky.options.lighting.moon = { brightness: bad };
    assert.throws(() => h.frame(), RangeError);
  }
});

test('red moons: the eclipsed blood moon at 1.06e-4 of the light and the low reddened moon, disc and light', () => {
  const { h, sky, lux } = presetSky({ moonPhase: 'full' });
  h.frame();
  const base = lux(),
    v0 = uniforms(h),
    eclipse = 10 ** (-0.4 * 9.94);
  sky.options.lighting.moon = { color: 'blood' };
  h.frame();
  let v = uniforms(h);
  assert.ok(Math.abs(lux() / base / eclipse - 1) < 1e-4, 'the eclipsed moon gives 1.06e-4 of the light (V -2.8 against -12.74)');
  const blood = [0, 1, 2].map((i) => v[52 + i] / v0[52 + i]);
  assert.ok(blood[0] > 4 * blood[1] && blood[1] > blood[2], 'the disc is red: ' + blood);
  assert.ok(Math.abs(luminance(blood) / eclipse ** (1 / 3) - 1) < 1e-4, 'as bright as the eye judges 1.06e-4 (Stevens)');
  assert.deepEqual([...sky.lights[1].radiance], moonlightColor(lux(), [0, 0, 0], moonLook(1, 'blood').source).map(Math.fround));
  sky.options.lighting.moon = { color: 'reddened' };
  h.frame();
  v = uniforms(h);
  // Kasten and Young's airmass 5 degrees up against the moon's own (Krisciunas and Schaefer), V extinction 0.172.
  const low = 1 / (Math.sin((5 * Math.PI) / 180) + 0.50572 * 11.07995 ** -1.6364),
    f = 10 ** (-0.4 * 0.172 * (low - 1 / Math.sqrt(1 - 0.96 * (1 - UP * UP))));
  assert.ok(Math.abs(low - 10.306) < 0.001);
  assert.ok(Math.abs(lux() / base / f - 1) < 1e-4, 'the light dims as through the air 5 degrees up');
  const orange = [0, 1, 2].map((i) => v[52 + i] / v0[52 + i]);
  assert.ok(orange[0] > orange[1] && orange[1] > orange[2], 'orange: ' + orange);
  assert.ok(orange[1] / orange[0] > blood[1] / blood[0], 'less red than the blood moon');
  assert.ok(Math.abs(luminance(orange) / f ** (1 / 3) - 1) < 1e-4);
  sky.options.lighting.moon = { color: 'blood', brightness: 'bright' };
  h.frame();
  assert.ok(Math.abs(lux() / base / (eclipse * (384400 / 356375) ** 2) - 1) < 1e-4, 'presets combine');
  sky.options.lighting.moon = { color: 'purple' };
  assert.throws(() => h.frame(), RangeError);
});
