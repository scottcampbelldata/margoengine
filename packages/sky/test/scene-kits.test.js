import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudTransmittance, moonlight } from '../../sky/dist/moonlight.js';
import { hurricaneLantern } from '../../clustered/dist/flicker.js';
import { STATE_FIELDS, WeatherMachine, assertState, blendStates } from '../../weather/dist/index.js';
import {
  SNOW_ALBEDO,
  fogDensityForVisibility,
  snowBounce,
  snowNight,
  snowfallNames,
  whiteout,
  whiteoutVisibility,
} from '../dist/scene-kits.js';

const deepFrozen = (value, path = 'kit') => {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) deepFrozen(child, `${path}.${key}`);
};

test('the snow night kit is fresh, deeply frozen data', () => {
  const a = snowNight(),
    b = snowNight();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  deepFrozen(a);
  assert.equal(a.name, 'snowNight');
  assert.equal(a.snowfall, 'moderate');
  assert.equal(a.precipitation.precipitation, 'snow');
  assert.equal(a.tonemap.curve, 'agx');
  // structuredClone gives the packages mutable options they can change in place.
  const sky = structuredClone(a.sky);
  sky.night.moonPhase = 0;
  assert.equal(a.sky.night.moonPhase, 0.75);
});

test('fog follows the snowfall: visibility bands of FMH-1, density by Koschmieder', () => {
  assert.deepEqual(snowfallNames, ['light', 'moderate', 'heavy']);
  const kits = snowfallNames.map((snowfall) => snowNight({ snowfall }));
  // Light 5/8 mile (1,006 m) or more, moderate 5/16 (503 m) to 5/8 mile, heavy 5/16 mile or less.
  assert.ok(kits[0].visibility >= 1006);
  assert.ok(kits[1].visibility > 503 && kits[1].visibility < 1006);
  assert.ok(kits[2].visibility <= 503);
  for (const kit of kits) {
    // 2% contrast left at the visibility distance.
    assert.ok(Math.abs(Math.exp(-kit.fog.density * kit.visibility) - 0.02) < 1e-4, kit.snowfall);
  }
  // Heavier snow: more flakes and thicker fog.
  assert.ok(kits[0].precipitation.intensity < kits[1].precipitation.intensity);
  assert.ok(kits[1].precipitation.intensity < kits[2].precipitation.intensity);
  assert.ok(kits[0].fog.density < kits[1].fog.density && kits[1].fog.density < kits[2].fog.density);
  assert.equal(fogDensityForVisibility(3912), 0.001);
});

test('one moon: the sky draws it where the kit says, normalized, above the horizon', () => {
  const kit = snowNight({ moonDirection: [0, 3, -4], moonPhase: 0.2 });
  assert.deepEqual(kit.sky.night.moonDirection, [0, 0.6, -0.8]);
  assert.equal(kit.sky.night.moonPhase, 0.2);
  // The kit sets no moonlight of its own (KB-CABIN-MOON1): `moon: {}` makes the sky light with the moon it draws.
  assert.deepEqual(kit.sky.lighting.moon, {});
  const moon = moonlight(0.2, [0, 0.6, -0.8]);
  assert.ok(moon.illuminance > 0, 'the moon lights the scene');
  // The window is warm against the moonlight: the fire's light far outweighs the moon's.
  assert.ok(kit.hearth.light.intensity * luminance(kit.hearth.light.color) > 20 * moon.illuminance);
  assert.ok(
    kit.hearth.light.color[0] > kit.hearth.light.color[1] && kit.hearth.light.color[1] > kit.hearth.light.color[2],
  );
});

test('the snow bounces the moon up: a ground light of albedo times the snow plane irradiance over pi', () => {
  // Under the eaves and below the sills nothing but the snow lights the logs; without the bounce they were black.
  const kit = snowNight({ moonDirection: [0, 3, -4] }),
    { ambient } = kit.sky.lighting,
    moon = moonlight(kit.sky.night.moonPhase, kit.sky.night.moonDirection);
  assert.equal(SNOW_ALBEDO, 0.85);
  assert.deepEqual(kit.bounce.sky, [0, 0, 0], 'the sky already lights the scene from above');
  assert.equal(kit.bounce.intensity, 1);
  for (let i = 0; i < 3; i++) {
    const irradiance = moon.color[i] * moon.intensity * 0.6 + Math.PI * ambient.night[i];
    assert.ok(Math.abs(kit.bounce.ground[i] - (0.85 * irradiance) / Math.PI) < 1e-12, `channel ${i}`);
    // A surface facing down gets more from the snow than the sky's floor alone gives it.
    assert.ok(kit.bounce.ground[i] > ambient.night[i]);
  }
  // A cold, blue-white snow: the moonlight's colour.
  assert.ok(kit.bounce.ground[2] > kit.bounce.ground[1] && kit.bounce.ground[1] > kit.bounce.ground[0]);
  // The moon higher, the bounce brighter; the moon on the horizon leaves only the sky's share.
  assert.ok(snowNight({ moonDirection: [0, 4, -3] }).bounce.ground[2] > kit.bounce.ground[2]);
  assert.deepEqual(snowBounce([1, 1, 1], [1, 0, 0], [0.1, 0.1, 0.1], 0.5), [0.05, 0.05, 0.05]);
});

test('the fire option scales the fire light and its particle births', () => {
  const one = snowNight(),
    two = snowNight({ fire: 2 });
  assert.equal(two.hearth.light.intensity, 2 * one.hearth.light.intensity);
  assert.equal(two.hearth.fire.rate, 2 * one.hearth.fire.rate);
  assert.equal(two.hearth.embers.rate, 2 * one.hearth.embers.rate);
  assert.equal(two.hearth.steam.rate, one.hearth.steam.rate, 'the kettle steams the same');
  // Each lives long enough to be seen and the capacity holds every live particle at its birth rate, over the whole
  // range of the option: a fixed fire capacity of 4,000 held 7,200 births a second x 0.6 s only up to fire 2.2.
  for (const fire of [0.25, 1, 2, 4])
    for (const part of ['fire', 'embers', 'steam']) {
      const p = snowNight({ fire }).hearth[part];
      assert.ok(
        p.capacity >= p.rate * p.lifetime[1],
        `${part} at fire ${fire}: ${p.capacity} < ${p.rate * p.lifetime[1]}`,
      );
      assert.ok(p.curves.alpha.at(-1) === 0 && p.curves.alpha[0] === 0, `${part} fades in and out`);
    }
});

// The flames' births stay on the fuel's top (their position): within the logs' 0.62 m length and the 0.14 m across
// their tops, and 0.09 m high. The old box reached 0.24 m across, in front of the logs, where the young flames lay over
// the log faces as a haze (packages/sky/test/fire-base-gpu.mjs measures the rise on a GPU).
test('the flames are born on the fuel top, not in front of the logs', () => {
  const {
    emissionExtent: [x, y, z],
    emitter,
  } = snowNight().hearth.fire;
  assert.equal(emitter.shape, 'cone');
  assert.ok(x + emitter.radius <= 0.31, `along the logs ${x + emitter.radius} m`);
  assert.ok(z + emitter.radius <= 0.07, `across the logs ${z + emitter.radius} m`);
  assert.ok(y <= 0.045, `${y} m high`);
});

test('the fire, embers and steam start full on the first frame', () => {
  // A shot's first frame (its warm-up draws that instant without moving the clock) showed an empty grate: the
  // particles were born from time 0 and the flames filled in over their lifetime. Each part prewarms its longest
  // lifetime through @margoengine/vfx/schedule, which the full @margoengine/vfx entry carries; 10,000 steps of 1/60 s
  // is that schedule's limit.
  for (const part of ['fire', 'embers', 'steam']) {
    const p = snowNight().hearth[part];
    assert.equal(p.schedule.prewarm, p.lifetime[1], `${part} prewarms its longest lifetime`);
    assert.ok(p.schedule.prewarm * 60 <= 10000, part);
  }
});

test('the fire burns as flame tongues, not one overexposed blob', () => {
  // Cabin Hearth's first renders: 3,200 soft round discs a second (about 1,760 alive) at intensity 6 piled up over a
  // 0.4 x 0.2 m bed into one white blob. Flames are now streaks along their rise, few enough to stay apart, and orange
  // at birth, so AgX keeps their colour.
  const { fire, embers } = snowNight().hearth;
  for (const [name, p] of [
    ['fire', fire],
    ['embers', embers],
  ]) {
    assert.ok(p.stretch && p.stretch.factor > 0, `${name} particles are streaks`);
    const birth = p.curves.color[0].color;
    assert.ok(birth[2] <= 0.25 * birth[0] && birth[1] <= 0.65 * birth[0], `${name} is orange at birth: ${birth}`);
  }
  const alive = (fire.rate * (fire.lifetime[0] + fire.lifetime[1])) / 2;
  assert.ok(alive <= 900, `flames alive at once: ${alive}`);
  // How bright they may be is measured on the render, not capped here (Scott, 2026-11-16 03:39): the flames are as
  // bright as the light they give, and packages/sky/test/fire-base-gpu.mjs checks that they still burn as separate
  // tongues with orange edges and white only in their cores.
});

test('the kettle steams as one soft plume, not separate bubbles', () => {
  // Cabin Hearth on the 680M: 150 puffs a second (about 330 alive) at a peak opacity of 0.064 each read as a column
  // of separate round bubbles. Many more, fainter puffs overlap into a plume.
  const { steam } = snowNight().hearth;
  const alive = (steam.rate * (steam.lifetime[0] + steam.lifetime[1])) / 2,
    peak = Math.max(...steam.curves.alpha) * steam.color[3];
  assert.ok(alive >= 800, `steam puffs alive at once: ${alive}`);
  assert.ok(peak <= 0.04, `one puff's peak opacity: ${peak}`);
});

test('invalid kit options throw RangeError', () => {
  assert.throws(
    () => snowNight({ snowfall: 'blizzard' }),
    /Unknown snowfall "blizzard"; use one of light, moderate, heavy/,
  );
  assert.throws(() => snowNight({ snowfall: 'constructor' }), /Unknown snowfall/);
  assert.throws(() => snowNight({ moonPhase: 2 }), /Invalid snowNight moonPhase 2/);
  assert.throws(() => snowNight({ fire: 0 }), /Invalid snowNight fire/);
  assert.throws(() => snowNight({ moonDirection: [0, -1, 0] }), /moonDirection/);
  assert.throws(() => snowNight({ moonDirection: [0, Number.NaN, 0] }), /moonDirection/);
  assert.throws(() => fogDensityForVisibility(0), RangeError);
});

// The fog WeatherDrive writes for a state: fogDensity of @margoengine/weather (packages/weather/src/sky-settings.ts).
const driveFog = (s) => 0.0002 * (0.02 / 0.0002) ** Math.min(1, s.fog + 0.15 * Math.max(s.rain, s.snow, s.hail));

test('the whiteout kit is fresh, deeply frozen data with a blizzard and a lull', () => {
  const a = whiteout(),
    b = whiteout();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  deepFrozen(a);
  assert.equal(a.name, 'whiteout');
  assert.equal(a.precipitation.precipitation, 'snow');
  // Every field of the weather's state, so the whiteout example's blendStates(lull, storm) sets a valid state (the kit
  // lacked smoke, humidity and temperature: the blend gave NaN and WeatherMachine.set threw).
  for (const key of Object.keys(STATE_FIELDS)) {
    assert.equal(typeof a.storm[key], 'number', `storm.${key}`);
    assert.equal(typeof a.lull[key], 'number', `lull.${key}`);
  }
  assertState(blendStates({ ...a.lull }, { ...a.storm }, 0.5));
  new WeatherMachine({ ...a.storm }).set(blendStates({ ...a.lull }, { ...a.storm }, 0.3));
  // A blizzard (US National Weather Service): wind of 35 mph (15.6 m/s) or more, a quarter mile (402 m) or less.
  assert.ok(a.storm.wind >= 15.6 && a.visibility <= 402);
  assert.ok(a.lull.wind < a.storm.wind && a.lull.snow < a.storm.snow && a.lullVisibility > a.visibility);
  for (const s of [a.storm, a.lull]) assert.ok(s.fog >= 0 && s.fog <= 1, `fog ${s.fog} in the state's range`);
  // No moon disc or stars through the overcast, but the moon's light still reaches the snow from the same direction.
  assert.deepEqual(a.sky.night.moonColor, [0, 0, 0]);
  assert.equal(a.sky.night.starIntensity, 0);
  // The kit sets no moon number (KB-MOON-EXAMPLES1): the sky derives the light and the storm's overcast dims it.
  assert.deepEqual(a.sky.lighting.moon, { cloudCover: 1 });
  assert.equal(a.sky.lighting.moon.cloudCover, a.storm.cloud);
});

test('the drive gives the kit visibility down to its thickest fog; the kit fog carries the rest', () => {
  for (const options of [{}, { visibility: 300, lullVisibility: 4000 }, { visibility: 400, lullVisibility: 400 }]) {
    const kit = whiteout(options);
    const pairs = [[kit.lull, kit.lullVisibility]];
    if (kit.visibility >= 196) pairs.push([kit.storm, kit.visibility]);
    // Koschmieder: 2% contrast is 3.912 optical depths.
    for (const [state, metres] of pairs)
      assert.ok(Math.abs(driveFog(state) * metres - 3.912) < 1e-9, `the drive's fog leaves 2% contrast at ${metres} m`);
    assert.ok(Math.abs(kit.fog.density * kit.visibility - 3.912) < 1e-9, 'the kit fog starts at the storm');
  }
  // Below 196 m the state asks for the drive's thickest fog and the scene's fog is denser.
  const kit = whiteout();
  assert.equal(kit.visibility, 90);
  assert.ok(Math.abs(driveFog(kit.storm) - 0.02) < 1e-12);
  assert.ok(kit.fog.density > 0.02);
});

test('whiteoutVisibility moves evenly in log distance from the lull to the storm with the smoothstep ease', () => {
  const kit = whiteout({ visibility: 100, lullVisibility: 1600 });
  assert.equal(whiteoutVisibility(kit, 0), 1600);
  assert.ok(Math.abs(whiteoutVisibility(kit, 1) - 100) < 1e-9);
  assert.ok(Math.abs(whiteoutVisibility(kit, 0.5) - 400) < 1e-9, 'halfway is the geometric mean');
  // smoothstep(0.25) = 0.15625: 1600 * (1/16)^0.15625
  assert.ok(Math.abs(whiteoutVisibility(kit, 0.25) - 1600 * (1 / 16) ** 0.15625) < 1e-9);
  assert.throws(() => whiteoutVisibility(kit, 1.5), /Invalid whiteoutVisibility level 1.5/);
});

test('the wind blows toward windDirection in the snow and the fog, and the window is warm', () => {
  const kit = whiteout({ wind: 20, windDirection: Math.PI / 2 });
  assert.ok(Math.abs(kit.precipitation.wind[0] - 20) < 1e-12 && Math.abs(kit.precipitation.wind[1]) < 1e-12);
  assert.deepEqual(
    kit.fog.wind.map((v) => Math.round(v * 1e9) / 1e9),
    [20, 0, 0],
  );
  assert.equal(kit.storm.windDirection, Math.PI / 2);
  const c = kit.window.light.color;
  assert.ok(c[0] > c[1] && c[1] > c[2], 'about 2,000 K');
  // The moon the sky lights the snow with: phase and direction from the kit, a quarter of it through the overcast.
  const moon = moonlight(kit.sky.night.moonPhase, kit.sky.night.moonDirection).illuminance * cloudTransmittance(1);
  assert.ok(kit.window.light.intensity * luminance(c) > 50 * moon, 'the one warm light outweighs the moon');
});

test('invalid whiteout options throw RangeError naming the kit', () => {
  assert.throws(() => whiteout({ wind: 10 }), /Invalid whiteout wind 10; use a number from 16 to 40/);
  assert.throws(() => whiteout({ visibility: 20 }), /Invalid whiteout visibility 20/);
  assert.throws(() => whiteout({ lullVisibility: 9000 }), /Invalid whiteout lullVisibility/);
  assert.throws(() => whiteout({ gust: Number.NaN }), /Invalid whiteout gust/);
});

// KB-CABIN-LANTERN1: the lantern's patch on the snow before the window read mauve, then (at a rated 12 candlepower)
// dusty pink. Its colour was a 3,000 K blackbody's (FIRE_GLOW) and then 12 cd, above any measured lantern. A kerosene
// flame is about 1,900 K. This blackbody comes from Kim et al.'s cubic fit of the Planckian locus (Kim, Kang, Bang, Kim,
// Lee and Lee, "Design of advanced color temperature control system for HDTV applications", J. Korean Physical Society
// 41(6), 2002), independent of the CIE 1931 table the kit's value comes from, then the IEC 61966-2-1 matrix.
function blackbodyLinearSRGB(T) {
  const x = -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991,
    y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683; // 1,667 to 2,222 K
  const [X, Y, Z] = [x / y, 1, (1 - x - y) / y],
    rgb = [
      3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
      0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    ],
    top = Math.max(...rgb);
  return rgb.map((c) => Math.max(0, c / top));
}
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test("the window lantern's colour is a kerosene flame's, a 1,900 K blackbody", () => {
  const { hearth } = snowNight(),
    want = blackbodyLinearSRGB(1900);
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(hearth.lamp.color[k] - want[k]) < 0.003,
      `lamp ${hearth.lamp.color} against the 1,900 K blackbody ${want.map((c) => c.toFixed(4))}`,
    );
  assert.equal(hearth.lamp.flicker.curve, 'candle');
});

// KB-FIRE-GLOW-CCT1: the hearth's glow was [1, 0.48, 0.17], a 3,000 K blackbody, and the whiteout window's lamp
// [1, 0.56, 0.24], about 3,450 K. A wood fire's light is about 1,860 K (Zukauskas et al., IEEE Photonics J. 6(3), 2014,
// the "firelight" source; 1,700 to 2,500 K by Zabiliute et al., Optics Letters 39(3), 2014), a kerosene flame 1,900 K.
test("the hearth glows at a wood fire's 1,860 K and the whiteout window at a kerosene flame's 1,900 K", () => {
  const { light, lamp } = snowNight().hearth,
    window = whiteout().window.light;
  for (const [name, color, kelvin] of [
    ['hearth', light.color, 1860],
    ['window', window.color, 1900],
    ['lamp', lamp.color, 1900],
  ]) {
    const want = blackbodyLinearSRGB(kelvin);
    for (let k = 0; k < 3; k++)
      assert.ok(
        Math.abs(color[k] - want[k]) < 0.003,
        `${name} ${color} against the ${kelvin} K blackbody ${want.map((c) => c.toFixed(4))}`,
      );
  }
  // The colour changed, not the light: the hearth's peak luminous intensity stays 5.11 cd (9 at the old colour's
  // luminance 0.568), the window's 10.09 cd (16 at 0.630).
  assert.ok(Math.abs(light.intensity * luminance(light.color) - 9 * 0.56817) < 1e-9);
  assert.ok(Math.abs(window.intensity * luminance(window.color) - 16 * 0.63046) < 1e-9);
  assert.ok(Math.abs(snowNight({ fire: 2 }).hearth.light.intensity - 2 * light.intensity) < 1e-12);
});

test('the window lantern is the clustered hurricane lantern, out of step with the fire', () => {
  const { lamp } = snowNight().hearth,
    preset = hurricaneLantern({ seed: 5 });
  assert.deepEqual(lamp, {
    color: [...preset.color],
    intensity: preset.intensity,
    range: preset.range,
    radius: preset.radius,
    flicker: { ...preset.flicker },
  });
});

// KB-CABIN-GROUNDEDGE1: the lamp was a point, so the window's jambs threw hard-edged light on the snow. It carries its
// flame's half width (the 22 mm wick over 2), which the scene spreads into its castShadow light: a sphere light whose
// shadow radius gives the penumbra a real flame casts.
test('the window lantern has the size of its flame, so its shadows have a penumbra', () => {
  const { lamp } = snowNight().hearth;
  assert.equal(lamp.radius, 0.011);
});

// Mills (2003, LBNL, goniophotometer): the brightest hurricane lantern gave 82 lm, so as an isotropic point light its
// time-averaged intensity is 82 / 4 pi = 6.5 cd. The candle flicker scales the kit's intensity by 0.8 to 1, so the mean
// over time, not the peak, is the measured light.
test("the window lantern gives a measured hurricane lantern's light, 82 lm (6.5 cd) averaged over its flicker", async () => {
  const { flickerAt } = await import('../../clustered/dist/flicker.js');
  const { lamp } = snowNight().hearth;
  let sum = 0,
    n = 0;
  for (let t = 0; t < 20000; t += 0.0037, n++)
    sum += flickerAt(lamp.flicker.curve, t * lamp.flicker.speed, lamp.flicker.seed);
  const candela = lamp.intensity * luminance(lamp.color) * (sum / n);
  assert.ok(Math.abs(candela - 82 / (4 * Math.PI)) < 0.03, `lamp ${candela.toFixed(3)} cd averaged over its flicker`);
});

// scripts/cabin-hearth-browser-test.mjs holds the lantern at 0.9 and the fire at 0.75 of their kit intensities so a
// frame does not depend on the phase its flickers have reached (KB-CABIN-RUG-RATIO1): those are the flickers' means.
test("the hearth's flickers average 0.9 (the lantern's candle) and 0.75 (the fire)", async () => {
  const { flickerAt } = await import('../../clustered/dist/flicker.js');
  const { lamp, light } = snowNight().hearth;
  for (const [flicker, mean] of [
    [lamp.flicker, 0.9],
    [light.flicker, 0.75],
  ]) {
    let sum = 0,
      n = 0;
    for (let t = 0; t < 20000; t += 0.0037, n++) sum += flickerAt(flicker.curve, t * flicker.speed, flicker.seed);
    assert.ok(Math.abs(sum / n - mean) < 0.005, `${flicker.curve} flicker mean ${(sum / n).toFixed(4)}`);
  }
});

// The point light's window (1 - (d / range)^4)^2 is not physics: the lantern's inverse square must hold where its light
// lands on the snow (3.3 to 4.9 m) and stay within 10% out to where it equals the moonlight (8.3 m).
test("the window lantern's range leaves its inverse square alone where its light matters", () => {
  const { lamp } = snowNight().hearth,
    window = (d) => Math.max(0, 1 - (d / lamp.range) ** 4) ** 2;
  assert.ok(window(4.9) >= 0.989, `window ${window(4.9).toFixed(3)} at 4.9 m`);
  assert.ok(window(8.3) >= 0.9, `window ${window(8.3).toFixed(3)} at 8.3 m`);
});
