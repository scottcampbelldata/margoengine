import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Water } from '../dist/index.js';
import { seaState, seaWavelengths, whitecapCoverage } from '../dist/sea-state.js';

// Plan bounds (private elements-real-plan.md, section 2, Water): Hs = 0.0016 sqrt(g F / U^2) U^2 / g, never above the
// fully developed 0.22 U^2 / g; the sea's height is Hs; no fold at any wind from 0 to 40; whitecaps W = 3.84e-6 U^3.41.
const G = 9.81;

// Height of the Gerstner sea at random parametric points: sum of a cos(k d.x - w t + phase), variance sum a^2 / 2.
function heightVariance(waves, samples = 200000) {
  let seed = 12345;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let sum = 0, sum2 = 0;
  for (let n = 0; n < samples; n++) {
    const x = random() * 60000, z = random() * 60000;
    let y = 0;
    for (const w of waves) {
      const k = (2 * Math.PI) / w.wavelength, l = Math.hypot(...w.direction);
      y += w.amplitude * Math.cos(k * ((w.direction[0] * x + w.direction[1] * z) / l) + w.phase);
    }
    sum += y;
    sum2 += y * y;
  }
  return sum2 / samples - (sum / samples) ** 2;
}

test('the sea for U 10 and F 100 km is Hs 1.6 m, peak 6 s, 57 m', () => {
  const sea = seaState(10);
  assert.ok(Math.abs(sea.significantHeight - 1.615) < 0.01, `Hs ${sea.significantHeight}`);
  assert.ok(Math.abs(sea.peakPeriod - 6.05) / 6.05 < 0.05, `Tp ${sea.peakPeriod}`);
  assert.ok(Math.abs(sea.peakWavelength - 57) / 57 < 0.15, `L ${sea.peakWavelength}`);
  assert.equal(sea.fullyDeveloped, false);
});

test('4 x the standard deviation of the generated sea is Hs within 10% at U 3, 8, 15 and 25', () => {
  for (const u of [3, 8, 15, 25]) {
    const sea = seaState(u),
      measured = 4 * Math.sqrt(heightVariance(sea.waves));
    assert.ok(Math.abs(measured - sea.significantHeight) / sea.significantHeight < 0.1, `U ${u}: ${measured} against ${sea.significantHeight}`);
    assert.ok(sea.significantHeight <= (0.22 * u * u) / G + 1e-9);
  }
});

test('the sea never grows past the fully developed 0.22 U^2 / g, however long the fetch', () => {
  for (const u of [3, 10, 25, 40]) {
    const sea = seaState(u, { fetch: 1e7 });
    assert.ok(Math.abs(sea.significantHeight - (0.22 * u * u) / G) < 1e-9);
    assert.equal(sea.fullyDeveloped, true);
    assert.ok(sea.peakPeriod <= (2 * Math.PI * u) / (0.877 * G) * 1.2);
  }
  assert.ok(seaState(10, { fetch: 5000 }).significantHeight < seaState(10, { fetch: 50000 }).significantHeight);
});

test('the real wind of NDBC station 46042 (17.2 m/s, 100 km authored fetch) gives a sea inside the fully developed bound', () => {
  const line = readFileSync(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8').split('\n').find((l) => /^\d{4} /.test(l));
  const speed = Number(line.trim().split(/\s+/)[6]);
  assert.equal(speed, 17.2);
  const sea = seaState(speed);
  assert.ok(sea.significantHeight > 2.5 && sea.significantHeight < (0.22 * speed * speed) / G);
});

test('no wind from 0 to 40 m/s folds the surface, at construction or through setWind', () => {
  const water = new Water({ wind: 0 });
  for (let u = 0; u <= 40; u += 2.5) {
    assert.doesNotThrow(() => new Water({ wind: { speed: u, fetch: 1e7 } }), `U ${u}`);
    assert.doesNotThrow(() => water.setWind({ speed: u, fetch: 1e7 }), `setWind ${u}`);
  }
  assert.throws(() => new Water({ wind: 101 }), RangeError);
  assert.throws(() => new Water({ waves: [{ direction: [1, 0], amplitude: 0.1, wavelength: 5 }] }).setWind(5), TypeError);
  assert.doesNotThrow(() => new Water().setWind(5));
});

test('only amplitudes, directions and steepness change with the wind: the wavelengths are fixed', () => {
  const calm = seaState(2), gale = seaState(25, { direction: [0, 1] });
  assert.deepEqual(calm.waves.map((w) => w.wavelength), gale.waves.map((w) => w.wavelength));
  assert.deepEqual(calm.waves.map((w) => w.wavelength).slice().reverse(), seaWavelengths(8));
  const water = new Water({ wind: 2 }), before = [...water.values.slice(32, 96)];
  water.setWind({ speed: 25, direction: [0, 1] });
  const after = [...water.values.slice(32, 96)];
  for (let i = 0; i < 8; i++) {
    assert.equal(after[i * 8 + 3], before[i * 8 + 3], 'wavenumber');
    assert.equal(after[i * 8 + 5], before[i * 8 + 5], 'frequency');
    assert.equal(after[i * 8 + 6], before[i * 8 + 6], 'phase');
  }
  assert.notDeepEqual(after, before);
  assert.ok(Math.abs(water.values[34] - gale.waves[0].amplitude) < 1e-6, 'the longest train carries the gale');
});

test('wind 0 is a flat sea and the trains of a gale are bigger than a breeze', () => {
  assert.ok(seaState(0).waves.every((w) => w.amplitude === 0));
  assert.equal(seaState(0).significantHeight, 0);
  const max = (u) => Math.max(...seaState(u).waves.map((w) => w.amplitude));
  assert.ok(max(20) > max(10) && max(10) > max(4));
});

test('whitecap coverage is 3.84e-6 U^3.41: 0.1% at 5, 1% at 10, 4% at 15, 10.5% at 20, 22% at 25', () => {
  for (const [u, w] of [[5, 0.001], [10, 0.01], [15, 0.04], [20, 0.105], [25, 0.22]])
    assert.ok(Math.abs(whitecapCoverage(u) - w) / w < 0.2, `U ${u}: ${whitecapCoverage(u)}`);
  assert.equal(whitecapCoverage(0), 0);
  assert.equal(seaState(10).whitecapCoverage, whitecapCoverage(10));
});

test('bad inputs are refused', () => {
  assert.throws(() => seaState(-1), RangeError);
  assert.throws(() => seaState(5, { fetch: 0 }), RangeError);
  assert.throws(() => seaState(5, { trains: 9 }), RangeError);
  assert.throws(() => seaState(5, { direction: [0, 0] }), RangeError);
  assert.throws(() => seaState(Number.NaN), RangeError);
});

test('setWind with a fetch or direction left out or undefined keeps the held ones, and builds the sea from them', () => {
  const held = { fetch: 5000, direction: [0, 1] },
    read = (water) => [...water.values.slice(32, 96)];
  const expected = read(new Water({ wind: { speed: 12, ...held } }));
  for (const next of [{ speed: 12 }, { speed: 12, fetch: undefined }, { speed: 12, direction: undefined }, { speed: 12, fetch: undefined, direction: undefined }]) {
    const water = new Water({ wind: { speed: 4, ...held } });
    water.setWind(next);
    assert.deepEqual(read(water), expected, JSON.stringify(next));
    assert.equal(water.windSea.fetch, 5000);
    assert.deepEqual(water.windSea.direction, [0, 1]);
  }
});
