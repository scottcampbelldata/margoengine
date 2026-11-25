// Precipitation (ATMO-04): fall speeds from each particle's physics against the measured and published ones, drop sizes that
// carry exactly the rate asked for, snow that melts into its rain flake for drop, a snow line that follows the air's
// temperature, rain shafts that slant with the wind and drift with their cells, and the same bits every time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { airDensity, standardAtmosphere } from '@margoengine/math/atmosphere';
import { BoundaryLayerWind } from '../dist/boundary-layer.js';
import {
  airViscosity,
  graupelFallSpeed,
  hailFallSpeed,
  largestRaindrop,
  PrecipitationField,
  rainFallSpeed,
  snowFallSpeed,
  snowFraction,
  WATER_DENSITY,
} from '../dist/precipitation.js';

/** Air at `pressure` Pa and `temperature` K. */
const air = (pressure, temperature) => ({ density: airDensity(temperature, pressure), temperature });

/** A steady wind of `velocity` through the standard atmosphere. */
const steadyWind = (velocity) => ({
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
    const [temperature, pressure] = standardAtmosphere(y);
    out.velocity[0] = velocity[0];
    out.velocity[1] = velocity[1];
    out.velocity[2] = velocity[2];
    out.temperature = temperature;
    out.density = airDensity(temperature, pressure);
    return out;
  },
});

test('raindrops fall at the speeds Gunn and Kinzer measured', () => {
  // Gunn and Kinzer (1949): still air at 1013 hPa and 20 C.
  const lab = air(101325, 293.15);
  for (const [mm, measured] of [
    [1, 4.03],
    [2, 6.49],
    [3, 8.06],
    [4, 8.83],
    [5, 9.09],
  ]) {
    // The drag law runs low by 3 to 7 percent, most at 1 mm (docs/limits.md, "Precipitation").
    const v = rainFallSpeed(mm / 1000, lab);
    assert.ok(v < measured && (measured - v) / measured < 0.07, `${mm} mm: ${v} m/s against ${measured}`);
  }
});

test("a fine droplet falls at Stokes's speed, within the drag law's own correction", () => {
  const lab = air(101325, 293.15),
    d = 5e-6,
    eta = airViscosity(293.15),
    stokes = ((WATER_DENSITY - lab.density) * 9.81 * d * d) / (18 * eta),
    v = rainFallSpeed(d, lab),
    re = (v * d * lab.density) / eta;
  // C_D = 24/Re (1 + 0.15 Re^0.687) + ...: the speed is below Stokes's by about 0.15 Re^0.687, and by under 1e-6 more for
  // the drop's flattening at this size.
  assert.ok(v < stokes && (stokes - v) / stokes < 0.15 * re ** 0.687 + 1e-6, `${v} against ${stokes}`);
});

test('thin air aloft lets a drop fall faster; the largest stable drop is about 7 mm', () => {
  const low = rainFallSpeed(0.002, air(101325, 288.15)),
    high = rainFallSpeed(0.002, air(54020, 255.65));
  assert.ok(high > 1.15 * low && high < 1.35 * low, `${high} aloft against ${low}`);
  const largest = largestRaindrop(air(101325, 293.15));
  assert.ok(largest > 0.0065 && largest < 0.0085, `largest drop ${largest} m`);
});

test("hail and graupel fall as Heymsfield and Wright's power laws give", () => {
  // Their eqs. 7 and 8, at 1000 hPa and -5 C: 12.07 D^0.64 for 0.9 g/cm^3, 5.23 D^0.65 for 0.2, 4.88 D^0.84 for graupel's
  // density law, D in cm and v in m/s.
  const cold = air(100000, 268.15);
  for (const cm of [1, 2, 4, 8]) {
    const hail = hailFallSpeed(cm / 100, cold),
      light = hailFallSpeed(cm / 100, cold, 200);
    assert.ok(Math.abs(hail / (12.07 * cm ** 0.64) - 1) < 0.08, `hail ${cm} cm: ${hail}`);
    assert.ok(Math.abs(light / (5.23 * cm ** 0.65) - 1) < 0.08, `0.2 g/cm^3 ${cm} cm: ${light}`);
  }
  for (const cm of [0.2, 0.3, 0.4, 0.5]) {
    const v = graupelFallSpeed(cm / 100, cold);
    assert.ok(Math.abs(v / (4.88 * cm ** 0.84) - 1) < 0.08, `graupel ${cm} cm: ${v}`);
  }
});

test('snowflakes drift down at about a metre a second, whatever their size', () => {
  const cold = air(100000, 268.15),
    small = snowFallSpeed(0.001, cold),
    large = snowFallSpeed(0.02, cold);
  assert.ok(small > 0.5 && small < 1.6 && large > small && large < 2, `${small} and ${large} m/s`);
  assert.ok(large / small < 1.8, 'a twenty-fold larger flake is less than twice as fast');
});

test('the drops carry exactly the rate asked for, with the Marshall-Palmer intercept', () => {
  const field = new PrecipitationField({ rate: 1, seaLevelTemperature: 293.15 });
  for (const rate of [1, 10, 50]) {
    const f = new PrecipitationField({ rate, seaLevelTemperature: 293.15 }),
      { rain } = f.sample(0, 0, 0, 0),
      ground = air(101325, 293.15);
    // An independent integral of N0 exp(-slope D) m(D) v(D) by the midpoint rule up to the largest drop.
    const largest = largestRaindrop(ground),
      steps = 4000;
    let flux = 0;
    for (let i = 0; i < steps; i++) {
      const d = ((i + 0.5) * largest) / steps,
        mass = (WATER_DENSITY * Math.PI * d ** 3) / 6;
      flux += rain.intercept * Math.exp(-rain.slope * d) * mass * rainFallSpeed(d, ground) * (largest / steps);
    }
    assert.ok(Math.abs((flux * 3600) / rate - 1) < 1e-4, `rate ${rate}: ${flux * 3600} mm/h`);
    assert.ok(Math.abs(rain.slope - 4100 * rate ** -0.21) < 1e-9 * rain.slope);
    assert.ok(Math.abs(rain.intercept / 8e6 - 1) < 0.15, `intercept ${rain.intercept} against 8e6 per m^4`);
    assert.ok(rain.impactRate > 0 && rain.energyFlux > 0 && rain.fallSpeed > 3 && rain.fallSpeed < 9.5);
  }
  assert.equal(field.sample(0, 0, 0, 0).rate, 1);
});

test('snow carries the mass and the number of the drops it melts into', () => {
  // At the 50 percent temperature the rate splits evenly, so the snow and the rain have one rate in one air.
  const sea = 274.15 + 0.0065 * 200,
    field = new PrecipitationField({ rate: 6, seaLevelTemperature: sea }),
    [temperature] = standardAtmosphere(200, sea),
    { rain, snow } = field.sample(0, 200, 0, 0);
  assert.ok(Math.abs(temperature - 274.15) < 1e-9);
  assert.ok(Math.abs(rain.rate - 3) < 1e-9 && Math.abs(snow.rate - 3) < 1e-9);
  assert.ok(
    Math.abs(snow.impactRate / rain.impactRate - 1) < 1e-9,
    `${snow.impactRate} flakes against ${rain.impactRate} drops`,
  );
  assert.ok(
    snow.fallSpeed < 0.5 * rain.fallSpeed && snow.slope < rain.slope,
    'flakes are larger and slower than their drops',
  );
});

test('the snow line follows the air: snow above it, rain below (RITS-8, RITS-9)', () => {
  // A 10 C sea level: the standard lapse rate puts 1.0 C about 1,385 m up.
  const field = new PrecipitationField({ rate: 5, base: 3000, seaLevelTemperature: 283.15 }),
    line = (283.15 - 274.15) / 0.0065,
    at = (y) => field.sample(0, y, 0, 0);
  assert.ok(Math.abs(at(line).snow.rate - 2.5) < 1e-6, `${at(line).snow.rate} mm/h of snow at the line`);
  assert.ok(at(line + 600).snow.rate > 4.9 && at(line - 600).rain.rate > 4.9);
  assert.ok(Math.abs(snowFraction(274.15) - 0.5) < 1e-15 && snowFraction(300) < 1e-7 && snowFraction(250) > 1 - 1e-7);
  // A warmer day lifts it.
  const warm = new PrecipitationField({ rate: 5, base: 3000, seaLevelTemperature: 293.15 });
  assert.ok(warm.sample(0, line, 0, 0).rain.rate > 4.9);
});

test('a rain shaft slants downwind, is anchored in the world and drifts with its cell (RITS-5)', () => {
  const u = 10,
    field = new PrecipitationField({
      cells: [{ centre: [0, 0], radius: 300, rate: 20 }],
      base: 1500,
      wind: steadyWind([u, 0, 0]),
    }),
    top = field.sample(0, 1500, 0, 0);
  assert.equal(top.rate, 20, 'at cloud base the cell is where it is');
  // At the ground the core lies downwind by the wind times the fall time of the median drop: find it.
  let best = -Infinity,
    where = 0;
  for (let x = 0; x <= 6000; x += 10) {
    const rate = field.sample(x, 0, 0, 0).rate;
    if (rate > best) [best, where] = [rate, x];
  }
  assert.ok(where > 1000 && where < 4000 && Math.abs(best - 20) < 0.7, `core at ${where} m with ${best} mm/h`);
  // A moving cell over a place on the ground: it is overhead at 200 s, and its rain lands there one fall time (about five
  // minutes from 1,500 m) later.
  const moving = new PrecipitationField({ cells: [{ centre: [-3000, 0], radius: 300, rate: 20, velocity: [15, 0] }] }),
    series = Array.from({ length: 801 }, (_, i) => moving.sample(0, 0, 0, i).rate),
    peak = series.indexOf(Math.max(...series)),
    // Drops falling 1,500 m at 4 to 7 m/s take 214 to 375 s.
    lag = peak - 200;
  assert.ok(lag > 214 && lag < 375 && series[peak] > 19, `peak ${series[peak]} mm/h at ${peak} s`);
  assert.ok(series[0] < 1e-6 && series[800] < 1e-6, 'dry before the cell comes and after it has gone');
  // Still air: straight down, the same place.
  const still = new PrecipitationField({ cells: [{ centre: [0, 0], radius: 300, rate: 20 }] });
  assert.equal(still.sample(0, 0, 0, 0).rate, 20);
});

test('rain varies from place to place and gusts bend its streaks (EF-7)', () => {
  const wind = new BoundaryLayerWind({ speed: 15, turbulence: { cells: [64, 16, 16], size: [1024, 256, 256] } }),
    field = new PrecipitationField({
      rate: 2,
      cells: [{ centre: [100, 0], radius: 150, rate: 30 }],
      wind,
    }),
    a = field.sample(0, 20, 0, 0),
    b = field.sample(400, 20, 60, 0);
  assert.notEqual(a.rate, b.rate, 'not the same density everywhere');
  assert.notEqual(a.velocity[0], b.velocity[0], 'the gusts are not the same everywhere');
  assert.ok(a.velocity[1] < -3, 'falling');
  assert.ok(a.rain.slope > 0 && a.rain.impactRate > 0, 'with a size distribution and impacts to make rings');
});

test('rain from a source, such as a cloud solver, adds to the field', () => {
  let peak = 12;
  const source = {
      rate: (x) => (x > 0 ? 12 : 0),
      get peak() {
        return peak;
      },
    },
    field = new PrecipitationField({ source, base: 50, seaLevelTemperature: 293.15 });
  assert.equal(field.sample(100, 0, 0, 0).rate, 12);
  assert.equal(field.sample(-100, 0, 0, 0).rate, 0, 'no rate of its own beside a source');
  peak = 30;
  assert.ok(field.sample(100, 0, 0, 0).rain.rate > 0);
  assert.throws(() => new PrecipitationField({ source: { rate: () => -1, peak: 1 } }).sample(0, 0, 0, 0), /0 or more/);
});

test('hail and graupel take their share, at their own sizes and speeds', () => {
  const field = new PrecipitationField({
      rate: 40,
      graupel: { fraction: 0.1, scale: 0.0015 },
      hail: { fraction: 0.2, scale: 0.01 },
      seaLevelTemperature: 298.15,
    }),
    s = field.sample(0, 0, 0, 0);
  assert.ok(
    Math.abs(s.hail.rate - 8) < 1e-12 && Math.abs(s.graupel.rate - 4) < 1e-12 && Math.abs(s.rain.rate - 28) < 1e-9,
  );
  assert.ok(s.hail.fallSpeed > 12 && s.graupel.fallSpeed > 1 && s.graupel.fallSpeed < s.rain.fallSpeed + 3);
  const flux = s.rain.rate * s.rain.fallSpeed + s.graupel.rate * s.graupel.fallSpeed + s.hail.rate * s.hail.fallSpeed;
  assert.ok(Math.abs(-s.velocity[1] - flux / 40) < 1e-12, 'the falling velocity is the mass-weighted one');
});

test('the same place and time give the same bits, in any order', () => {
  const make = () =>
      new PrecipitationField({
        cells: [{ centre: [0, 0], radius: 200, rate: 12, velocity: [3, 1] }],
        wind: new BoundaryLayerWind({ speed: 9, turbulence: { cells: [32, 16, 16], size: [512, 256, 256] } }),
        seaLevelTemperature: 278.15,
      }),
    a = make(),
    b = make(),
    points = [
      [10, 5, 20, 3],
      [-200, 800, 40, 7.5],
      [500, 2, -60, 12],
    ],
    forward = points.map((p) => JSON.stringify(a.sample(...p))),
    backward = points
      .slice()
      .reverse()
      .map((p) => JSON.stringify(b.sample(...p)))
      .reverse();
  assert.deepEqual(forward, backward);
});

test('settings out of range are refused with what to pass', () => {
  assert.throws(() => new PrecipitationField({ rate: -1 }), /0 or more/);
  assert.throws(() => new PrecipitationField({ hail: { fraction: 0.7 }, graupel: { fraction: 0.5 } }), /reduce/);
  assert.throws(() => new PrecipitationField({ cells: [{ centre: [0], radius: 1, rate: 1 }] }), /two finite numbers/);
  assert.throws(() => rainFallSpeed(0), /above 0/);
  assert.throws(() => hailFallSpeed(0.01, undefined, 1000), /917/);
});
