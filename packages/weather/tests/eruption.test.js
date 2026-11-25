import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Eruption,
  ashFallSpeed,
  mastinHeight,
  mastinRate,
  standardAtmosphere,
  validateEruption,
} from '../dist/eruption.js';

const steady = (o) => {
  const e = new Eruption({ rise: 1, wind: 0, ...o });
  e.seek(3000);
  return e;
};

test('the ICAO standard atmosphere and the fall-speed regimes', () => {
  const [T0, P0] = standardAtmosphere(0),
    [T11, P11] = standardAtmosphere(11000),
    [T20] = standardAtmosphere(20000),
    [T32] = standardAtmosphere(32000);
  assert.equal(T0, 288.15);
  assert.equal(P0, 101325);
  assert.ok(Math.abs(T11 - 216.65) < 1e-9 && Math.abs(T20 - 216.65) < 1e-9 && Math.abs(T32 - 228.65) < 1e-9);
  // ICAO Doc 7488: 22,632 Pa at 11 km.
  assert.ok(Math.abs(P11 - 22632.06) < 0.5, `${P11} Pa at 11 km`);
  assert.ok(
    Math.abs(standardAtmosphere(20000)[1] - 5474.89) < 0.5 && Math.abs(standardAtmosphere(32000)[1] - 868.02) < 0.5,
  );
  // Stokes for 10 micrometres: rho g d^2 / (18 mu) = 7.57 mm/s; a 1 mm grain falls turbulently near 8 m/s.
  const stokes = (2500 * 9.80665 * 1e-10) / (18 * 1.8e-5);
  assert.ok(Math.abs(ashFallSpeed(1e-5, 2500, 1.2) - stokes) / stokes < 1e-12);
  const mm = ashFallSpeed(1e-3, 2500, 1.2);
  assert.ok(mm > 7 && mm < 9, `${mm} m/s for 1 mm`);
  // Thinner air lets a large grain fall faster; a Stokes grain's speed does not depend on the air's density.
  assert.ok(ashFallSpeed(1e-3, 2500, 0.4) > ashFallSpeed(1e-3, 2500, 1.2));
  assert.equal(ashFallSpeed(1e-5, 2500, 0.4), ashFallSpeed(1e-5, 2500, 1.2));
});

test("the column's height follows Mastin et al.'s (2009) fit within its 50 percent band, from 1e4 to 1e9 kg/s", () => {
  // Mastin et al. 2009 (as Costa et al. 2016, Table 2): M = 2500 (H / 2 km)^4.15; its 50 percent confidence band is a
  // factor of 4 in the rate for a height, a factor of 4^(1/4.15) = 1.40 in the height for a rate.
  assert.ok(Math.abs(mastinHeight(mastinRate(12345)) - 12345) < 1e-6);
  const band = 4 ** (1 / 4.15);
  let last = 0;
  for (const M of [1e4, 1e5, 1e6, 1e7, 1e8, 1e9]) {
    const c = steady({ massRate: M }).column(),
      fit = mastinHeight(M);
    assert.ok(!c.collapse, `${M} kg/s is buoyant`);
    assert.ok(
      c.steadyTop / fit < band && fit / c.steadyTop < band,
      `${M} kg/s: ${c.steadyTop} m against Mastin ${fit} m`,
    );
    assert.ok(c.steadyTop > last, 'a stronger eruption stands higher');
    last = c.steadyTop;
  }
  // Sparks 1986: the umbrella spreads at the neutral level, about three quarters of the top.
  for (const M of [1e6, 1e7, 1e8]) {
    const c = steady({ massRate: M }).column(),
      ratio = c.neutral / c.steadyTop;
    assert.ok(ratio > 0.65 && ratio < 0.85, `${M} kg/s: neutral level at ${ratio} of the top`);
    assert.ok(c.buoyantFrom > 0 && c.buoyantFrom < c.neutral, 'the gas-thrust region lies under the buoyant plume');
  }
  // A height asks for Mastin's rate.
  const e = new Eruption({ height: 15000 });
  assert.ok(Math.abs(e.peakRate() - mastinRate(15000)) < 1e-6);
});

test("Costa et al. (2016)'s strong plume reaches near 37 km; the weak plume bends in the wind and stands lower", () => {
  const strong = steady({
    massRate: 1.5e9,
    ventAltitude: 1500,
    exitVelocity: 275,
    exitTemperature: 1053,
    gasFraction: 0.05,
  }).column();
  assert.ok(Math.abs(strong.steadyTop - 37000) / 37000 < 0.15, `strong plume ${strong.steadyTop} m against 37 km`);
  const weak = (wind) =>
    steady({ massRate: 1.5e6, ventAltitude: 1500, exitVelocity: 135, exitTemperature: 1273, gasFraction: 0.03, wind });
  const calm = weak(0).column(),
    windy = weak(10).column();
  assert.ok(windy.steadyTop < calm.steadyTop, `wind ${windy.steadyTop} m, calm ${calm.steadyTop} m`);
  assert.ok(
    Math.abs(windy.steadyTop - 6000) / 6000 < 0.3,
    `weak plume in a 10 m/s wind ${windy.steadyTop} m against 6 km`,
  );
  const top = windy.samples.at(-1).position,
    base = windy.samples[0].position;
  assert.ok(top[2] - base[2] > 1000, 'the plume bends downwind (+Z)');
});

test('too slow and gas-poor a jet collapses as a fountain (Woods 1988); more gas keeps it buoyant', () => {
  const dense = steady({ massRate: 1e8, exitVelocity: 60, gasFraction: 0.01 }).column();
  assert.ok(dense.collapse && dense.neutral === null && dense.buoyantFrom === null);
  assert.ok(dense.steadyTop < 1000, `fountain ${dense.steadyTop} m`);
  assert.equal(steady({ massRate: 1e8, exitVelocity: 60, gasFraction: 0.01 }).umbrella(), null);
  assert.equal(steady({ massRate: 1e8, exitVelocity: 250, gasFraction: 0.05 }).column().collapse, false);
});

test('the top rises over film time; the umbrella spreads as t^(2/3) and drifts with the wind', () => {
  const e = new Eruption({ massRate: 1e7, rise: 1, wind: 0, duration: 36000 });
  e.seek(0);
  assert.equal(e.column().top, 0);
  const tops = [10, 30, 60, 120].map((t) => (e.seek(t), e.column().top));
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] >= tops[i - 1]);
  e.seek(5000);
  assert.equal(e.column().top, e.column().steadyTop);
  // Suzuki and Koyaguchi 2009: R = (3 lambda N q / (2 pi))^(1/3) t^(2/3) for a steady flux.
  const at = (t) => (e.seek(t), e.umbrella());
  const first = (() => {
    for (let t = 1; ; t++) if (at(t)) return t;
  })();
  const r1 = at(first + 600).radius,
    r4 = at(first + 2400).radius,
    ratio = r4 / r1;
  assert.ok(Math.abs(ratio - 4 ** (2 / 3)) / 4 ** (2 / 3) < 0.05, `radius grows ${ratio} times over 4 times the time`);
  assert.ok(r1 > 2000 && r4 < 2e5, `${r1} m, ${r4} m`);
  const w = new Eruption({ massRate: 1e7, rise: 1, wind: 10, windDirection: 90, duration: 36000 });
  w.seek(first + 1200);
  assert.ok(w.umbrella().centre[0] > 5000, 'the umbrella drifts toward +X');
});

test('ash falls downwind, coarse first; the ground holds every kilogram that has landed', () => {
  const e = new Eruption({ massRate: 1e6, rise: 1, duration: 600, wane: 1, wind: 8, grainSize: 0, grainSorting: 1.5 });
  e.seek(400);
  const early = e.ashLoad(4000, 0) + e.ashLoad(0, 4000);
  e.seek(40000);
  const down = e.ashThickness(0, 8000),
    up = e.ashThickness(0, -8000),
    side = e.ashThickness(8000, 0);
  assert.ok(down > 10 * up && down > 10 * side, `downwind ${down} m, upwind ${up}, side ${side}`);
  assert.ok(early >= 0);
  // Integrate the load over a square around the fall: it holds the erupted mass of the classes that have landed.
  let sum = 0;
  const cell = 400;
  for (let x = -60000; x <= 60000; x += cell)
    for (let z = -60000; z <= 240000; z += cell) sum += e.ashLoad(x, z) * cell * cell;
  const landed = e.erupted(40000);
  assert.ok(sum > 0.9 * landed && sum < 1.01 * landed, `ground ${sum} kg of ${landed} kg erupted`);
  // In calm air the deposit is round about the vent.
  const calm = new Eruption({ massRate: 1e6, rise: 1, duration: 600, wane: 1, wind: 0 });
  calm.seek(40000);
  const a = calm.ashLoad(3000, 0),
    b = calm.ashLoad(0, 3000),
    c = calm.ashLoad(-3000, 0);
  assert.ok(Math.abs(a - b) / a < 1e-9 && Math.abs(a - c) / a < 1e-9);
  // The air under the fall is thick with ash while it falls, clear before.
  const f = new Eruption({ massRate: 1e7, rise: 1, wind: 5 });
  f.seek(0);
  const clear = f.visibility(0, 20000);
  f.seek(3000);
  assert.ok(
    f.visibility(0, 20000) < 0.1 * clear,
    `${f.visibility(0, 20000)} m in the fall 20 km downwind, ${clear} m before`,
  );
  assert.ok(f.airAsh(0, 20000) > 0);
});

test('ashEvent fits GroundChange to the deposit: the same thickness at the vent and the same quarter reach downwind', () => {
  const e = new Eruption({ vent: [100, 0, -200], massRate: 1e6, rise: 1, duration: 600, wane: 1, wind: 8 });
  const ev = e.ashEvent();
  assert.equal(ev.kind, 'ash');
  assert.deepEqual(ev.vent, [100, -200]);
  assert.ok(ev.thickness > 0 && ev.half > 0 && ev.elongation >= 1 && ev.elongation <= 12);
  assert.ok(ev.start > 0 && ev.duration > 600);
  e.seek(ev.start + ev.duration);
  assert.ok(Math.abs(e.ashThickness(100, -200) - ev.thickness) / ev.thickness < 1e-6);
  // The event's quarter isopach downwind of the vent: (2g - 1) 2 half; the deposit there is a quarter of the vent's.
  const reach = (2 * ev.elongation - 1) * 2 * ev.half;
  assert.ok(Math.abs(e.ashThickness(100, -200 + reach) / ev.thickness - 0.25) < 0.01);
});

test('plume lightning: deterministic strikes in proportion to the rate, fired once each through the sky', () => {
  const e = new Eruption({ massRate: 1e8, rise: 1, wind: 0, lightningRate: 6, seed: 7 });
  const list = e.strikes(0, 600);
  // 6 per minute at 1e7 kg/s, ten times that at 1e8: 60 a minute, 600 in ten minutes.
  assert.ok(Math.abs(list.length - 600) < 60, `${list.length} strikes`);
  assert.deepEqual(new Eruption({ massRate: 1e8, rise: 1, wind: 0, lightningRate: 6, seed: 7 }).strikes(0, 600), list);
  assert.notDeepEqual(
    new Eruption({ massRate: 1e8, rise: 1, wind: 0, lightningRate: 6, seed: 8 }).strikes(0, 600),
    list,
  );
  assert.ok(list.every((s, i) => s.time > 0 && s.time <= 600 && (i === 0 || s.time >= list[i - 1].time)));
  const vents = list.filter((s) => s.kind === 'vent').length;
  assert.ok(vents > 0.2 * list.length && vents < 0.4 * list.length, `${vents} vent discharges`);
  assert.equal(new Eruption({ start: 100, massRate: 1e8 }).strikes(0, 99).length, 0, 'none before the start');
  assert.equal(new Eruption({ massRate: 1e8, lightningRate: 0 }).strikes(0, 600).length, 0);
  // Split into frames it fires the same strikes once; a seek back fires none again.
  const calls = [];
  const sky = { listener: [0, 0, 5000], strike: (o) => calls.push(o) };
  const f = new Eruption({ massRate: 1e8, rise: 1, wind: 0, lightningRate: 6, seed: 7 });
  for (let t = 0; t < 600; t += 0.4) {
    f.update(0.4);
    f.flashLightning(sky);
  }
  assert.equal(calls.length, e.strikes(0, f.time).length);
  assert.ok(calls.every((o) => o.distance >= 0 && o.strength > 0 && o.strength <= 1));
  f.seek(100);
  assert.equal(f.flashLightning(sky).length, 0);
});

test('deterministic over film time: a seek equals the same time stepped', () => {
  const make = () => new Eruption({ massRate: 3e7, wind: 7, windDirection: 30, rise: 120 });
  const a = make(),
    b = make();
  a.seek(900);
  for (let i = 0; i < 900 / 0.37; i++) b.update(0.37);
  b.seek(900);
  assert.deepEqual(a.column(), b.column());
  assert.deepEqual(a.umbrella(), b.umbrella());
  assert.equal(a.ashLoad(1000, 2000), b.ashLoad(1000, 2000));
});

test('drawPlume adds the column and the umbrella to clouds and takes out what has gone', () => {
  const added = [],
    removed = [];
  const clouds = {
    add(o) {
      const c = { options: { ...o }, matrix: new Float32Array(16) };
      added.push(c);
      return c;
    },
    remove(c) {
      removed.push(c);
      return true;
    },
  };
  const e = new Eruption({ massRate: 1e7, rise: 1, duration: 3600, wane: 1, wind: 0 });
  e.seek(30);
  e.drawPlume(clouds, 8);
  assert.ok(added.length >= 1 && added.length <= 8, `${added.length} column clouds while it rises`);
  e.seek(2000);
  e.drawPlume(clouds, 8);
  assert.equal(added.length, 9, 'eight column segments and the umbrella');
  const u = added.at(-1);
  assert.ok(u.matrix[0] > 1000 && u.matrix[13] > 8000, 'the umbrella is wide and high');
  e.seek(1e6);
  e.drawPlume(clouds, 8);
  assert.ok(removed.length >= 8, 'the column is gone once the vent stops');
  e.clearPlume();
});

test('validation', () => {
  assert.throws(() => new Eruption({ massRate: 0 }), RangeError);
  assert.throws(() => new Eruption({ gasFraction: 0.5 }), RangeError);
  assert.throws(() => new Eruption({ vent: [0, 0] }), TypeError);
  assert.throws(() => new Eruption({ color: [2, 0, 0] }), RangeError);
  assert.throws(() => new Eruption({ seed: 1.5 }), RangeError);
  assert.throws(() => validateEruption(null), TypeError);
  assert.doesNotThrow(() => new Eruption({ height: null }));
  const e = new Eruption();
  assert.throws(() => e.seek(-1), RangeError);
  assert.throws(() => e.update(Number.NaN), RangeError);
});

test('every slider row is read: a value off its default changes the eruption; null wind rows follow the weather', async () => {
  const { ERUPTION_SETTINGS, ERUPTION_LOOKS, applyEruptionSettings, eruptionSettingDefaults, eruptionSettingValues } =
    await import('../dist/settings.js');
  const weather = { state: { wind: 6, windDirection: 0 } };
  const make = (values) => {
    const e = new Eruption({ weather });
    applyEruptionSettings(e, values);
    e.seek(e.options.start ?? 0);
    e.update(900);
    const c = e.column();
    return JSON.stringify([
      c.top,
      c.massRate,
      e.umbrella(),
      e.ashLoad(0, 20000),
      e.ashThickness(0, 20000),
      e.strikes(0, e.time).length,
      e.strikes(0, e.time).filter((s) => s.kind === 'vent').length,
      e.time,
      e.end,
    ]);
  };
  const base = make({});
  for (const row of ERUPTION_SETTINGS) {
    const d = row.default ?? row.min,
      v = d === row.max ? row.min : Math.min(row.max, d === 0 ? row.max / 4 : d * (d < row.max / 2 ? 2 : 0.5));
    const value =
      row.default === null
        ? row.name === 'height'
          ? 20000
          : row.max / 4
        : row.name === 'start'
          ? 100
          : row.name === 'duration'
            ? 600
            : row.name === 'timeScale'
              ? 2
              : row.name === 'airTemperature'
                ? 250
                : row.name === 'tropopause'
                  ? 15000
                  : v;
    assert.notEqual(make({ [row.name]: value }), base, `${row.name} = ${value} changes nothing`);
  }
  assert.equal(Object.keys(eruptionSettingDefaults()).length, ERUPTION_SETTINGS.length);
  const e = new Eruption({ weather });
  applyEruptionSettings(e, ERUPTION_LOOKS.plinian);
  assert.equal(e.options.massRate, 1e8);
  assert.deepEqual(e.windNow().map(Math.round), [0, 6], 'null follows the weather');
  applyEruptionSettings(e, { wind: 2, windDirection: 90 });
  assert.deepEqual(e.windNow().map(Math.round), [2, 0], 'a value overrides it');
  assert.equal(eruptionSettingValues(e).wind, 2);
  assert.throws(() => applyEruptionSettings(e, { nope: 1 }), TypeError);
  assert.throws(() => applyEruptionSettings(e, { massRate: -5 }), RangeError);
  applyEruptionSettings(e, ERUPTION_LOOKS.collapsing);
  e.seek(600);
  assert.ok(e.column().collapse, 'the collapsing look collapses');
});
