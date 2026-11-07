// @margoengine/scenery/aurora: the emission lines' colours and luminance, their vertical profiles, the curtains' column
// and the draw. That the GPU march gives the same light as this column on screen is proved on a real GPU by
// scenery-check.mjs (aurora).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MargoError } from '@margoengine/math/errors';
import { AURORA_LINES, Aurora, auroraColumn, auroraProfile } from '../dist/aurora.js';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const near = (actual, expected, bound, what) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected}, bound ${bound}`);
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const rad = Math.PI / 180;
const north = (elevation) => [0, Math.sin(elevation * rad), -Math.cos(elevation * rad)];

test('the lines: oxygen green and red, the nitrogen ion blue, by luminance', () => {
  const { green, red, blue } = AURORA_LINES;
  assert.deepEqual(
    [green, red, blue].map((l) => l.wavelength),
    [557.7, 630.0, 427.8],
  );
  for (const l of [green, red, blue]) near(luminance(l.color), 1, 1e-12, `${l.wavelength} luminance`);
  // 557.7 nm is a yellowish green, 630.0 nm red, 427.8 nm violet blue.
  assert.ok(green.color[1] > 3 * green.color[0] && green.color[2] === 0, `green ${green.color}`);
  assert.ok(red.color[0] > 0 && red.color[1] === 0 && red.color[2] === 0, `red ${red.color}`);
  assert.ok(blue.color[2] > 5 * blue.color[0] && blue.color[1] === 0, `blue ${blue.color}`);
  // 1 kR of 557.7 nm: 1e9 / (4 pi) photons per cm2 per second per steradian of 3.562e-19 J at 683 x 0.997 lm/W.
  near(green.luminance, 1.931e-4, 0.002e-4, 'green cd/m2 per kR');
  // As sky brightness (the V-band rule 10.8e4 x 10^(-0.4 S) cd/m2): 1 kR of green is sky of 21.9 mag per square arcsecond.
  near(2.5 * Math.log10(10.8e4 / green.luminance), 21.87, 0.01, 'green as V mag per square arcsecond');
  // Per photon the red line is dimmer to the eye: lower y-bar (0.265) and less energy.
  near(red.luminance / green.luminance, (0.265 / 0.9973) * (557.7 / 630), 0.003, 'red over green');
  assert.ok(Object.isFrozen(AURORA_LINES) && Object.isFrozen(green) && Object.isFrozen(green.color));
});

test('the profiles: each integrates to 1, green sharp below 100 km, red above 150 km', () => {
  const sums = [0, 0, 0];
  for (let h = 0; h < 2000; h += 0.05) auroraProfile(h).forEach((v, i) => (sums[i] += v * 0.05));
  sums.forEach((s, i) => near(s, 1, 1e-4, `profile ${i}`));
  const at = (h) => auroraProfile(h);
  // Peaks at 110, 230 and 105 km.
  for (const [i, peak] of [
    [0, 110],
    [1, 230],
    [2, 105],
  ])
    assert.ok(at(peak)[i] > at(peak - 1)[i] && at(peak)[i] > at(peak + 1)[i], `peak ${i}`);
  // The green line's sharp lower border: under 1% of its peak at 85 km, still 13% 30 km above it.
  assert.ok(at(85)[0] < 0.01 * at(110)[0] && at(140)[0] > 0.13 * at(110)[0]);
  // The red line is quenched low down: under 1% of its peak at 120 km.
  assert.ok(at(120)[1] < 0.01 * at(230)[1]);
  // With the default 0.2 ratio, red outshines green above 180 km and green rules below 150 km.
  assert.ok(0.2 * at(180)[1] > at(180)[0] && 0.2 * at(150)[1] < at(150)[0]);
});

test('the column: the line ratios straight up, redder higher up, nothing through the Earth', () => {
  // Straight up anywhere in a curtain the emission is the same at every height, so the columns keep the ratios
  // (red loses the 1.2% of its profile above 450 km).
  let found = 0;
  for (let n = 100; n < 260; n += 0.5) {
    const c = auroraColumn([0, 0, -n * 1000], [0, 1, 0], 0, {}, 2000);
    if (c[0] < 0.5) continue;
    found++;
    near(c[1] / c[0], 0.2 * 0.988, 0.002, `red ratio at ${n} km`);
    near(c[2] / c[0], 0.3, 0.002, `blue ratio at ${n} km`);
  }
  assert.ok(found > 10, `${found} curtains overhead`);
  // Looking north from the origin, the light of higher elevations comes from higher up: the red share grows.
  const share = (e) => {
    const c = auroraColumn([0, 0, 0], north(e), 0);
    return c[0] > 0 ? c[1] / c[0] : null;
  };
  const low = share(25),
    high = share(70);
  assert.ok(low !== null && high !== null && high > 3 * low, `red share ${low} at 25, ${high} at 70 degrees`);
  assert.deepEqual(auroraColumn([0, 0, 0], north(-5), 0), [0, 0, 0]);
  // Linear in intensity; the shape moves with time and is the same at the same time.
  const a = auroraColumn([0, 0, 0], north(30), 0, { intensity: 10 }),
    b = auroraColumn([0, 0, 0], north(30), 0, { intensity: 30 });
  near(b[0], 3 * a[0], 1e-9 * b[0], 'linear');
  assert.deepEqual(auroraColumn([0, 0, 0], north(30), 5), auroraColumn([0, 0, 0], north(30), 5));
  assert.notDeepEqual(auroraColumn([0, 0, 0], north(30), 5), auroraColumn([0, 0, 0], north(30), 0));
  assert.throws(() => auroraColumn([0, 0, 0], [0, 0, 0], 0), TypeError);
});

test('invalid options throw', () => {
  for (const bad of [{ intensity: -1 }, { red: 11 }, { arcs: 0 }, { arcs: 1.5 }, { thickness: 0 }, { seed: -1 }])
    assert.throws(() => new Aurora(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new Aurora(null), TypeError);
  const aurora = new Aurora();
  assert.throws(() => aurora.onPreUpdate(-1), RangeError);
  aurora.options.speed = 1000;
  assert.throws(() => aurora.onPreUpdate(0), RangeError);
  assert.throws(
    () => new Aurora().setup({}),
    (e) => e instanceof MargoError && e.code === 'unsupported',
  );
  const gone = new Aurora();
  gone.dispose();
  assert.throws(
    () => gone.setup({ gpu: {} }),
    (e) => e instanceof MargoError && e.code === 'disposed',
  );
});

test('the aurora moves with time and fades with the night', () => {
  const sky = { options: {}, nightFactor: 1 },
    aurora = new Aurora({ sky, speed: 2 });
  aurora.onPreUpdate(1.5);
  assert.equal(aurora.time, 3);
  const h = tracedGPU();
  h.engine.use(aurora);
  const draws = () => h.commands().filter((c) => c.startsWith('draw 6 '));
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(draws(), ['draw 6 1']);
  sky.nightFactor = 0;
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  sky.nightFactor = 1;
  aurora.options.intensity = 0;
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(draws(), ['draw 6 1'], 'nothing by day or at intensity 0');
  aurora.dispose();
});
