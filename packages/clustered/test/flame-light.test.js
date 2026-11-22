import test from 'node:test';
import assert from 'node:assert/strict';
import { flameLight, hurricaneLantern, flameFlickerMean, flickerAt } from '../dist/flicker.js';

const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const meanOf = (curve, speed = 1, seed = 0) => {
  let sum = 0,
    n = 0;
  for (let t = 0; t < 20000; t += 0.0037, n++) sum += flickerAt(curve, t * speed, seed);
  return sum / n;
};

test('the flame curves average 0.9 (candle) and 0.75 (fire), as flameFlickerMean says', () => {
  for (const curve of ['candle', 'fire']) assert.ok(Math.abs(meanOf(curve) - flameFlickerMean[curve]) < 0.005, curve);
});

// Mills (LBNL, 2003): the brightest kerosene hurricane lantern measured gave 82 lm, 6.5 cd over 4 pi sr. Its flame is
// about 1,900 K: x 0.5378, y 0.4112 by Planck x CIE 1931 (CIE 018:2019 table), [1, 0.2326, 0] in linear sRGB.
test('a hurricane lantern is a 1,900 K flame giving 82 lm (6.5 cd) averaged over its candle flicker', () => {
  const lantern = hurricaneLantern({ seed: 5 });
  assert.ok(
    Math.abs(lantern.color[1] - 0.2326) < 0.003 && lantern.color[0] === 1 && lantern.color[2] === 0,
    `${lantern.color}`,
  );
  const candela =
    lantern.intensity * luminance(lantern.color) * meanOf('candle', lantern.flicker.speed, lantern.flicker.seed);
  assert.ok(Math.abs(candela - 82 / (4 * Math.PI)) < 0.03, `${candela} cd`);
  assert.deepEqual(lantern.flicker, { curve: 'candle', speed: 0.6, seed: 5 });
  assert.equal(lantern.range, 18);
  assert.ok(Object.isFrozen(lantern));
});

// KB-CABIN-GROUNDEDGE1: a point lantern gave hard shadow edges. Its flame is as wide as its 22 mm flat wick (Mills,
// LBNL 2003), so it is a sphere light of radius 0.011 m, whose LocalShadows penumbra behind an edge d_o away on a
// receiver at d_r is 2 x 0.011 x (d_r - d_o) / d_o wide (scripts/clustered-shadow-gpu-check.js holds PCSS to that).
test('a hurricane lantern is as big as its flame: radius 11 mm, half its 22 mm wick', () => {
  assert.equal(hurricaneLantern().radius, 0.011);
  assert.equal(flameLight({ kelvin: 1900, lumens: 1, range: 1 }).radius, 0, 'a flame light without a size is a point');
  assert.equal(flameLight({ kelvin: 1900, lumens: 1, range: 1, radius: 0.05 }).radius, 0.05);
  for (const radius of [-0.01, Number.NaN, Infinity])
    assert.throws(() => flameLight({ kelvin: 1900, lumens: 1, range: 1, radius }), RangeError);
});

test('flameLight derives colour and strength from temperature and lumens, and rejects bad input', () => {
  const fire = flameLight({ kelvin: 1860, lumens: 64, range: 9, curve: 'fire' });
  assert.ok(Math.abs(fire.intensity * luminance(fire.color) * 0.75 - 64 / (4 * Math.PI)) < 1e-9);
  assert.ok(fire.color[1] < 0.24, 'a 1,860 K fire is far redder than a 3,000 K bulb (green 0.48)');
  for (const bad of [
    { kelvin: 1000, lumens: 1, range: 1 },
    { kelvin: 1900, lumens: -1, range: 1 },
    { kelvin: 1900, lumens: 1, range: 0 },
    { kelvin: 1900, lumens: 1, range: 1, curve: 'strobe' },
  ])
    assert.throws(() => flameLight(bad), RangeError);
});

// KB-CABIN-EDGE-SOFT2: a frosted or sooted globe glows over its whole glass, so the lantern's light leaves a sphere with
// the Dietz Blizzard globe's side-on area (171 mm tall, 86 and 70 mm across): radius sqrt(0.171 x 0.078 / pi).
import { HURRICANE_GLOBE_RADIUS } from '../dist/flicker.js';
test("a hurricane lantern's globe sets its size: clear is the flame, frosted and sooted the globe", () => {
  assert.equal(hurricaneLantern({ globe: 'clear' }).radius, 0.011);
  assert.ok(Math.abs(HURRICANE_GLOBE_RADIUS - Math.sqrt((0.171 * (0.086 + 0.07)) / 2 / Math.PI)) < 0.0005);
  for (const globe of ['frosted', 'sooted']) {
    const lamp = hurricaneLantern({ globe });
    assert.equal(lamp.radius, HURRICANE_GLOBE_RADIUS);
    assert.deepEqual(
      [lamp.intensity, lamp.color],
      [hurricaneLantern().intensity, hurricaneLantern().color],
      'the same light',
    );
  }
  assert.throws(() => hurricaneLantern({ globe: 'smoked' }), RangeError);
});

// KB-CABIN-BLOOM1: the Cabin Hearth lantern's flame was a lit cone, as dark as the iron round it, so nothing bloomed.
// A flame shows its light's radiance: luminous intensity over projected area. The hurricane lantern's 6.5 cd (Mills,
// LBNL 2003) over its 11 mm flame, pi 0.011^2 m2, is 17,170 cd/m2 averaged over its candle flicker.
test('flameEmission: a hurricane lantern flame shows 17,000 cd/m2, its intensity over its projected area', async () => {
  const { flameEmission } = await import('../dist/flicker.js'),
    lantern = hurricaneLantern(),
    emission = flameEmission(lantern),
    mean = emission.emissiveIntensity * luminance(emission.emissive) * flameFlickerMean.candle;
  assert.ok(Math.abs(mean - 82 / (4 * Math.PI) / (Math.PI * 0.011 ** 2)) < 1, `${mean} cd/m2`);
  assert.ok(mean > 17000 && mean < 17300, `${mean}`);
  assert.deepEqual(emission.emissive, [...lantern.color]);
  assert.ok(Object.isFrozen(emission));
  // Its own area: an ellipsoid 2 cm across and 4 cm tall shows pi 0.01 x 0.02 from the side.
  assert.equal(
    flameEmission(lantern, Math.PI * 0.01 * 0.02).emissiveIntensity,
    lantern.intensity / (Math.PI * 0.01 * 0.02),
  );
  for (const [light, area] of [
    [{ ...lantern, radius: 0 }, undefined],
    [lantern, 0],
    [lantern, NaN],
    [{ ...lantern, intensity: -1 }, undefined],
  ])
    assert.throws(() => flameEmission(light, area), RangeError);
});

test('animateFlicker flickers each light emitter with its light and puts its steady value back', async () => {
  const { animateFlicker } = await import('../dist/flicker.js');
  let frame;
  const engine = { onFrame: (f) => ((frame = f), () => (frame = undefined)) },
    clustered = { setLights() {} },
    lights = [
      { position: [0, 0, 0], range: 5, intensity: 4, flicker: { curve: (t) => t } },
      { position: [1, 0, 0], range: 5, intensity: 2 },
    ],
    flame = { emissiveIntensity: 1000 },
    steadyLamp = { emissiveIntensity: 50 };
  const stop = animateFlicker(engine, clustered, lights, { emitters: [flame, steadyLamp] });
  assert.equal(flame.emissiveIntensity, 0, 'scaled by the curve at time 0');
  frame(0, 0.5);
  assert.equal(flame.emissiveIntensity, 500);
  assert.equal(steadyLamp.emissiveIntensity, 50, 'a light without a flicker leaves its emitter alone');
  stop();
  assert.equal(flame.emissiveIntensity, 1000);
  assert.throws(() => animateFlicker(engine, clustered, [lights[0]], { emitters: [flame, flame] }), RangeError);
});
