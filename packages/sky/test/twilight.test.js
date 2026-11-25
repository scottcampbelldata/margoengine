// Twilight (KB-TWILIGHT1): the sky lights the scene after sunset by the USNO's measured sky illuminance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, SUN_ILLUMINANCE, twilightIlluminance, twilightColor, cloudTransmittance } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const r = Math.PI / 180,
  luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// Janiczek and DeYoung, USNO Circular 171 (1987), the sky term written out here, h in degrees.
const usno = (h) => {
  const u = Math.sin(h * r),
    x = 753.66156,
    c = Math.cos(Math.asin((x * Math.cos(h * r)) / (x + 1))),
    m = x * (c - u) + c;
  return 133775 * 0.0289 * Math.exp(-0.042 * m) * (1 + ((h + 90) * u) / 57.29578);
};

test('twilight illuminance follows USNO Circular 171: 756 lux at sunset, 2.99 at -6, 0.0044 at -12', () => {
  for (const h of [0, -1, -3, -6, -9, -12, -18])
    assert.ok(Math.abs(twilightIlluminance(h * r) / usno(h) - 1) < 1e-12, `${h}`);
  assert.ok(Math.abs(twilightIlluminance(0) - 756.6) < 0.1);
  assert.ok(Math.abs(twilightIlluminance(-6 * r) - 2.992) < 0.001);
  assert.ok(Math.abs(twilightIlluminance(-12 * r) - 0.004365) < 1e-5);
  assert.ok(Math.abs(SUN_ILLUMINANCE - 133775 * Math.exp(-0.21)) < 1e-9);
  assert.throws(() => twilightIlluminance(NaN), RangeError);
  // Sunlight scattered by the air is blue; past civil twilight the colour holds and the eye's shift takes it bluer.
  const sunset = twilightColor(0),
    civil = twilightColor(6 * r);
  assert.equal(Math.max(...sunset), 1);
  assert.ok(sunset[2] === 1 && civil[2] === 1, 'blue leads');
  assert.deepEqual(twilightColor(12 * r), civil);
});

test('the sky lights the scene through twilight: the engine light takes it once the sun has set', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  // 18.4 hours on the sky's clock puts the sun 6 degrees below the horizon.
  const sky = new Sky({ hours: 18.4, timeScale: 0, lighting: { intensity: SUN_ILLUMINANCE } });
  h.engine.use(sky);
  h.frame();
  const elevation = Math.asin(sky.sun[1]),
    tw = sky.twilightLight,
    horizontal = () => tw.direction[3] * luminance(tw.radiance) * tw.direction[1];
  assert.ok(Math.abs(elevation / r + 6) < 0.01);
  assert.equal(sky.lights[0].direction[3], 0, 'no direct sun');
  // The environment draws the day sky times 1 - night; twilight carries the sky's light times night (0.983 here).
  const share = sky.nightFactor;
  assert.ok(share > 0.98 && share < 1);
  assert.ok(Math.abs(horizontal() / (share * usno(elevation / r)) - 1) < 1e-5, 'the measured lux on the ground');
  assert.ok(Math.abs(tw.direction[1] - Math.SQRT1_2) < 1e-7, '45 degrees up');
  assert.ok(tw.direction[0] * sky.sun[0] > 0 && Math.abs(tw.direction[2]) < 1e-7, "from the sun's side");
  assert.equal(h.engine.lighting.direction[3], tw.direction[3], 'the engine light takes it');
  sky.options.lighting.twilight = { cloudCover: 1, brightness: 2 };
  h.frame();
  assert.ok(
    Math.abs(horizontal() / (share * usno(elevation / r) * 2 * cloudTransmittance(1)) - 1) < 1e-5,
    'cloud and brightness',
  );
  sky.options.lighting.twilight = false;
  h.frame();
  assert.equal(tw.direction[3], 0);
  assert.equal(h.engine.lighting.direction[3], 0, 'off: no light after sunset, as before');
  sky.options.lighting = { twilight: {} };
  h.frame();
  assert.ok(
    Math.abs(horizontal() / ((share * usno(elevation / r)) / SUN_ILLUMINANCE) - 1) < 1e-5,
    'intensity 1: a share of noon',
  );
  sky.options.hours = 12;
  h.frame();
  assert.equal(tw.direction[3], 0, 'none while the sun is up');
  for (const bad of [{ brightness: -1 }, { cloudCover: 2 }, { color: [1, -1, 0] }, 3]) {
    sky.options.hours = 18.4;
    sky.options.lighting.twilight = bad;
    assert.throws(() => h.frame(), RangeError);
  }
});

// Regression (KB-TWILIGHT1): twilight switched on at the full 756 lux the moment the sun's centre crossed the horizon,
// on top of the day sky the environment still drew, and the engine light jumped from the sun to it while bright.
test('twilight grows in with the night blend, so sky light is handed over, never doubled, and never jumps', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 17, timeScale: 0, lighting: { intensity: SUN_ILLUMINANCE } });
  h.engine.use(sky);
  const tw = sky.twilightLight,
    lux = () => tw.direction[3] * luminance(tw.radiance) * tw.direction[1];
  let previous = 0,
    previousGround = 0,
    steps = 0;
  // Sky time from 17.6 h (sun 5 degrees up) to 18.4 h (6 down), every 3.6 s.
  for (let i = 0; i <= 800; i++) {
    sky.options.hours = 17.6 + i / 1000;
    h.frame();
    const elevation = Math.asin(sky.sun[1]),
      share = sky.nightFactor,
      now = lux();
    // The day sky the environment draws (1 - night) and twilight's share (night) of the same sky add to one.
    if (share === 0) assert.equal(now, 0, 'none before the night blend, 4.6 degrees up');
    else assert.ok(Math.abs(now / (share * usno(elevation / r)) - 1) < 1e-5, `${sky.options.hours}`);
    // No step at sunset: within 1% of the 756 lux sky between neighbouring frames.
    assert.ok(Math.abs(now - previous) < 7.6, `step ${now - previous} at ${sky.options.hours}`);
    // And on the ground the engine light, beam plus glow, changes smoothly too: within 0.2% of noon's beam (217 lux) per step.
    const d = h.engine.lighting.direction,
      ground = Math.max(0, d[1]) * d[3] * luminance(h.engine.lighting.radiance);
    if (i)
      assert.ok(Math.abs(ground - previousGround) < 0.002 * SUN_ILLUMINANCE, `ground step at ${sky.options.hours}`);
    if (share > 0 && share < 1) steps++;
    previous = now;
    previousGround = ground;
  }
  assert.ok(steps > 100, 'the blend is crossed gradually');
  assert.ok(Math.abs(sky.nightFactor - 1) < 0.02);
});
