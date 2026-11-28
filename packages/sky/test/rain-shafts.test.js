// @margoengine/sky/volumetric-clouds `rain`: the rain shafts' CPU twin (rate, trail, reach, extinction, fall), its
// options, the lazy WGSL and Weather `rainFrom`. The pictures are proved on a real GPU by features-check.mjs rain-shaft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VolumetricClouds,
  cloudRainRate,
  cloudRainBase,
  cloudRainFall,
  rainExtinction,
  withStorm,
  wantsRain,
  loadRainShafts,
} from '@margoengine/sky/volumetric-clouds';
import { Weather, rainFall, rainIntensity } from '@margoengine/sky/weather';

const deck = (rain, wind = [0, 0]) => ({ bottom: 650, top: 1300, coverage: 0.9, wind, rain });

test('extinction is the Marshall-Palmer integral at extinction efficiency 2', () => {
  // sigma = integral of 2 (pi / 4) D^2 N0 e^(-L D) dD, D in mm (1e-6 m^2 per mm^2), N0 = 8000 per m^3 per mm,
  // L = 4.1 R^-0.21 per mm (Marshall and Palmer 1948), by the midpoint rule to 40 mean diameters.
  for (const R of [0.5, 1, 5, 20, 50, 100, 200]) {
    const L = 4.1 * R ** -0.21,
      n = 200000,
      top = 40 / L,
      dD = top / n;
    let sigma = 0;
    for (let i = 0; i < n; i++) {
      const D = (i + 0.5) * dD;
      sigma += 2 * (Math.PI / 4) * D * D * 1e-6 * 8000 * Math.exp(-L * D) * dD;
    }
    assert.ok(Math.abs(rainExtinction(R) / sigma - 1) < 2e-4, `R ${R}: ${rainExtinction(R)} vs ${sigma}`);
  }
  assert.equal(rainExtinction(0), 0);
});

test('the fall speed is that of the strongest cell, as Weather rainFall', () => {
  const o = deck({ cells: [{ x: 0, z: 0, radius: 500, rate: 4 }, { x: 900, z: 0, radius: 500, rate: 30 }] });
  assert.ok(Math.abs(cloudRainFall(o) - rainFall(30)) < 1e-12);
  assert.equal(cloudRainFall(deck({ cells: [] })), 9);
});

test('in still air the shaft hangs straight down from its cell and stops at the base and under its reach', () => {
  const o = deck({ cells: [{ x: 100, z: -200, radius: 800, rate: 20, reach: 150 }] });
  assert.ok(Math.abs(cloudRainRate(o, 100, 400, -200) - 20) < 1e-9);
  assert.ok(Math.abs(cloudRainRate(o, 900, 300, -200) - 20 * Math.exp(-1)) < 1e-9);
  assert.equal(cloudRainRate(o, 100, 650, -200), 0, 'nothing at or over the base');
  assert.equal(cloudRainRate(o, 100, 149, -200), 0, 'virga: nothing under the reach');
  assert.ok(cloudRainRate(o, 100, 150, -200) > 0);
});

test('the shaft trails downwind of its cell by (wind - cell velocity) times the fall time', () => {
  const o = deck({ cells: [{ x: 0, z: 0, radius: 300, rate: 50, velocity: [4, 0] }] }, [14, -2]),
    fall = cloudRainFall(o),
    seconds = 30,
    y = 50,
    tau = (650 - y) / fall,
    cx = 4 * seconds + (14 - 4) * tau,
    cz = -2 * tau;
  assert.ok(Math.abs(cloudRainRate(o, cx, y, cz, seconds) - 50) < 1e-9, 'peak where the water fell to');
  assert.ok(cloudRainRate(o, 4 * seconds, y, 0, seconds) < 50 * Math.exp(-((10 * tau) / 300)) + 1e-9);
  // The base rate is the cell where it is now, with no trail.
  assert.ok(Math.abs(cloudRainBase(o, 4 * seconds, 0, seconds) - 50) < 1e-9);
});

test('rain options are checked', () => {
  const bad = [
    { cells: 'x' },
    { cells: Array.from({ length: 9 }, () => ({ x: 0, z: 0, radius: 100, rate: 1 })) },
    { cells: [{ x: 0, z: 0, radius: 0.5, rate: 1 }] },
    { cells: [{ x: 0, z: 0, radius: 100, rate: 301 }] },
    { cells: [{ x: 0, z: 0, radius: 100, rate: 1, velocity: [1] }] },
    { cells: [{ x: 0, z: 0, radius: 100, rate: 1, reach: -1 }] },
    { cells: [], steps: 3 },
    { cells: [], steps: 16.5 },
    { cells: [], streaks: 2 },
  ];
  for (const rain of bad) assert.throws(() => new VolumetricClouds(deck(rain)), RangeError, JSON.stringify(rain));
  assert.doesNotThrow(() => new VolumetricClouds(deck({ cells: [{ x: 0, z: 0, radius: 100, rate: 1 }], steps: 64 })));
});

test('rainRateAt follows the layer clock and rainSource gives the base rate', () => {
  const clouds = new VolumetricClouds(deck({ cells: [{ x: 0, z: 0, radius: 400, rate: 12, velocity: [5, 0] }] }));
  clouds.advanceTime(20);
  assert.ok(Math.abs(clouds.rainRateAt([100, 300, 0]) - cloudRainRate(clouds.options, 100, 300, 0, 20)) < 1e-12);
  const source = clouds.rainSource();
  assert.equal(source.peak, 12);
  assert.ok(Math.abs(source.fall - rainFall(12)) < 1e-12);
  assert.ok(Math.abs(source.rate(100, 0, 20) - 12) < 1e-9);
});

test('the rain WGSL loads lazily and fills both markers', async () => {
  const dist = readFileSync(new URL('../dist/volumetric-clouds.js', import.meta.url), 'utf8');
  assert.ok(!dist.includes('fn cloudRainAt'), 'clouds without rain do not carry the rain march');
  assert.ok(wantsRain(deck({ cells: [{ x: 0, z: 0, radius: 100, rate: 1 }] })));
  assert.ok(!wantsRain(deck({ cells: [] })) && !wantsRain({}));
  const rain = await loadRainShafts(),
    code = withStorm('a //[rain-fns] b //[rain-call] c', undefined, undefined, rain);
  assert.ok(code.includes('fn cloudRain(') && code.includes('cloudRain(d,sceneFar'));
  assert.ok(!code.includes('//[rain'));
});

test('Weather rainFrom reads the rain at the camera each step', () => {
  let rate = 40;
  const weather = new Weather({ rainFrom: { rainRateAt: () => rate }, fadeSeconds: 0 });
  weather.advanceTime(0.1);
  assert.ok(Math.abs(weather.amount - rainIntensity(40)) < 1e-12);
  rate = 0;
  weather.advanceTime(0.1);
  assert.equal(weather.amount, 0, 'out from under the shaft the rain stops');
  assert.throws(() => new Weather({ rainFrom: {} }).advanceTime(0.1), TypeError);
});
