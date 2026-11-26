// The fire front's laws, pinned against the papers in the entry's header: Rothermel 1972 with Albini 1976's mixing
// against Anderson 1982's published rates, upslope against downslope by phi_s, head against backing fire by Richards'
// ellipse, fixed steps and settle, the burn texture's cells, smoke segments, embers and structures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUEL_MODELS,
  FireFront,
  BURNING,
  BURNT,
  NO_FUEL,
  UNBURNT,
  ellipseRate,
  crownBehaviour,
  crownRate10,
  fireBehaviour,
  fuelBed,
  slopeFactor,
  windFactor,
  RADIANT_SHARE,
} from '../dist/fire-front.js';
import { RADIANT_FRACTION } from '../dist/smoke.js';

const MPH = 0.44704,
  CHAIN_H = 20.1168 / 3600; // m/s per chain/hour
const near = (a, b, rel, msg) =>
  assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg ?? ''} ${a} vs ${b} (within ${rel * 100}%)`);
// Albini 1976's 1974 computations (the INT-30 nomographs, reprinted unchanged with midflame wind labels in Rothermel 1983,
// INT-143, appendix A) and Anderson 1982's rates taken from them used INT-30 table 7, which prints FM7's live surface-area-
// to-volume ratio as 1,550 1/ft; the standard model (Andrews 2018 table 8a, BehavePlus) and FUEL_MODELS.FM7 use 1,500. The
// comparisons with those 1974 values run FM7 with INT-30's own input, so they compare like with like.
const INT30 = {
  ...FUEL_MODELS,
  FM7: { ...FUEL_MODELS.FM7, classes: FUEL_MODELS.FM7.classes.map((c) => (c.live ? { ...c, sav: 1550 } : c)) },
};

// Andrews 2018 (RMRS-GTR-371), the Rothermel model as BehavePlus computes it, table 8b: each standard fuel model's
// characteristic surface-area-to-volume ratio (1/ft, printed to the unit), bulk density (lb/ft^3) and relative packing
// ratio beta / beta_op (both printed to 0.01). The bounds are the printing: 1 1/ft (the table's loads for FM10 and FM11
// are 3.0 / 5.0 and 4.5 / 5.5 where Anderson 1982 prints 3.01 / 5.01 and 4.51 / 5.51, worth 0.8 1/ft) and half a unit of
// the last printed digit for the bulk density. The packing ratio is held to 0.01: the table prints FM2, FM6 and FM8 at
// 1.14, 0.43 and 5.17 where beta / beta_op of its own printed SAV and bulk density is 1.135, 0.425 and 5.162. KB-FIRE-FM7: FM7 held INT-30's live 1,550 1/ft and gave 1,562 against the standard 1,552.
// Table 22 adds the wind factor at 6 and 12 mi/h midflame for FM2 (20.5, 72.8) and FM9 (12.9, 42.7), printed to 0.1,
// held to 0.5 percent (ours: 20.48, 72.84, 12.95, 42.70).
test('the 13 fuel models against Andrews 2018 tables 8b and 22: characteristic SAV, bulk density, packing, wind factor', () => {
  const table8b = {
    FM1: [3500, 0.03, 0.25],
    FM2: [2784, 0.18, 1.14],
    FM3: [1500, 0.06, 0.21],
    FM4: [1739, 0.12, 0.52],
    FM5: [1683, 0.08, 0.33],
    FM6: [1564, 0.11, 0.43],
    FM7: [1552, 0.09, 0.34],
    FM8: [1889, 1.15, 5.17],
    FM9: [2484, 0.8, 4.5],
    FM10: [1764, 0.55, 2.35],
    FM11: [1182, 0.53, 1.62],
    FM12: [1145, 0.69, 2.06],
    FM13: [1159, 0.89, 2.68],
  };
  for (const [name, [sav, density, packing]] of Object.entries(table8b)) {
    const bed = fuelBed(FUEL_MODELS[name], 0.08, 1, 0.08, 0.08);
    assert.ok(Math.abs(bed.sigma - sav) <= 1, `${name} characteristic SAV ${bed.sigma} vs ${sav}`);
    assert.ok(Math.abs(bed.beta * 32 - density) <= 0.005, `${name} bulk density ${bed.beta * 32} vs ${density}`);
    assert.ok(Math.abs(bed.ratio - packing) <= 0.01, `${name} relative packing ratio ${bed.ratio} vs ${packing}`);
  }
  for (const [name, mph, factor] of [
    ['FM2', 6, 20.5],
    ['FM2', 12, 72.8],
    ['FM9', 6, 12.9],
    ['FM9', 12, 42.7],
  ]) {
    const phi = windFactor(fuelBed(FUEL_MODELS[name], 0.08), mph * MPH);
    assert.ok(Math.abs(phi - factor) <= 0.005 * factor, `${name} wind factor at ${mph} mi/h ${phi} vs ${factor}`);
  }
});

// Anderson 1982 (INT-GTR-122) published rates of spread, chains per hour, at 5 mi/h midflame wind, 8 percent dead fuel
// moisture and 100 percent live (the values and the conditions were read in the report on 2026-11-17, in the text of
// each fuel group). Albini 1976 (INT-30, appendix III, "Nomograph Organization") draws each chart for one "dead fuel
// moisture" held on every dead class; the 0.89 / 0.09 / 0.02 (models 6 and 7) and 0.76 / 0.18 / 0.06 (models 11 to 13)
// blends only turn observed 1, 10 and 100 hour moistures into that one input. Anderson's "8 percent" is that input, so
// every dead class is at 0.08 here. The bound of each is the measured difference rounded up: FM5 is -19.5 percent and
// FM7 +29.6 percent (both read against Albini's own charts below; FM7 with INT-30's input, see INT30). FM13 lands at +4.8
// percent on this convention and is pinned on its own below, not given a wider bound. These are the 1974 computations,
// not the model as published: the published model is pinned against Andrews 2018 above (KB-FIRE-FM7, docs/limits.md).
test('Rothermel with Albini mixing: the rate of spread of each fuel model against the published value', () => {
  const published = {
    FM1: [78, 0.05],
    FM2: [35, 0.08],
    FM3: [104, 0.03],
    FM4: [75, 0.06],
    FM5: [18, 0.2],
    FM6: [32, 0.08],
    FM7: [20, 0.3],
    FM8: [1.6, 0.1],
    FM9: [7.5, 0.02],
    FM10: [7.9, 0.01],
    FM11: [6, 0.08],
    FM12: [13, 0.09],
  };
  for (const [name, [rate, tolerance]] of Object.entries(published)) {
    const b = fireBehaviour(INT30[name], {
      moisture: 0.08,
      moisture10: 0.08,
      moisture100: 0.08,
      liveMoisture: 1,
      wind: 5 * MPH,
    });
    near(b.rate / CHAIN_H, rate, tolerance, name);
  }
});

// FM13 at Anderson's conditions with every dead class at 8 percent: ours 14.15 chains/h against Anderson's 13.5 (+4.8
// percent). Albini 1976 chart 13 ("Heavy logging slash, low windspeeds", printed page 54), read off the scanned page by
// pixel on 2026-11-17, does not give 13.5 either: its reaction intensity at 8 percent is 9.26 thousand Btu/ft^2/min (ours
// 9.21), its 10 mi/h (20 ft) wind line has 1 + phi = 7.42 against the no-wind line (ours 8.72 at 5 mi/h midflame), its
// no-wind rate is about 1.29 times ours, and its end-to-end rate is about 15.6 chains/h. Anderson's own flame length for
// FM13 (10.5 ft) needs about 16.8 chains/h at our intensity, so 13.5 and 10.5 do not sit on one point of the chart. The
// chart's wind lines for FM2 match ours within 1 percent (15.53 against 15.67), so the wind factor itself is right; the
// heavy models (FM4 to FM7, FM13) run 0.79 to 0.92 of ours on the charts. Rothermel 1983 (INT-143) reprints the same
// charts with midflame wind labels, and its wind lines read the same way (FM5 and FM7 about 0.85 of our phi, FM2 equal):
// the 1974 program differs from Rothermel 1972 as published, while Andrews 2018's values (BehavePlus) are ours (the
// test above; KB-FIRE-FM7, closed as a reference difference in docs/limits.md). This pins the measured differences so a
// change to any of them shows.
test('FM13 and the wind lines of Albini 1976 charts 2 and 13: the measured differences', () => {
  const at8 = (name) =>
    fireBehaviour(FUEL_MODELS[name], {
      moisture: 0.08,
      moisture10: 0.08,
      moisture100: 0.08,
      liveMoisture: 1,
      wind: 5 * MPH,
    });
  const fm13 = at8('FM13'),
    fm2 = at8('FM2');
  const overAnderson = fm13.rate / CHAIN_H / 13.5;
  assert.ok(overAnderson > 1.045 && overAnderson < 1.05, `FM13 over Anderson's 13.5: ${overAnderson}`);
  near(fm13.reactionIntensity / 0.18935 / 1000, 9.26, 0.01, 'FM13 reaction intensity against chart 13');
  const windOverChart = (1 + fm13.windFactor) / 7.42;
  assert.ok(windOverChart > 1.16 && windOverChart < 1.19, `FM13 1 + phi over chart 13: ${windOverChart}`);
  near(1 + fm2.windFactor, 15.53, 0.015, 'FM2 1 + phi against chart 2');
});

// The moisture that damps a category is Rothermel 1972's surface-area weighted mean, (Mf)i = sum f_ij (Mf)ij (INT-115,
// the table of heterogeneous fuel equations; Albini 1976 quotes it as 0.89 / 0.09 / 0.02 for model 6). Frandsen's "fine"
// weights exp(-138 / sigma) set only the live moisture of extinction. FM6 has no live fuel, so its reaction intensity with
// 1, 10 and 100 hour moistures of 0.08, 0.09 and 0.10 is the one at their area-weighted mean on every class. The old code
// damped with the fine-weighted mean (0.0835 here, against 0.0813), which gave a lower reaction intensity.
test('the damping moisture of a category is its surface-area weighted mean (Rothermel 1972), not the fine-fuel mean', () => {
  const model = FUEL_MODELS.FM6,
    area = model.classes.map((c) => c.load * c.sav),
    total = area.reduce((s, a) => s + a, 0),
    mean = [0.08, 0.09, 0.1].reduce((s, m, i) => s + (m * area[i]) / total, 0);
  near(mean, 0.89 * 0.08 + 0.09 * 0.09 + 0.02 * 0.1, 0.002, 'the weights are the ones Albini quotes');
  near(fuelBed(model, 0.08, 1, 0.09, 0.1).ir, fuelBed(model, mean, 1, mean, mean).ir, 1e-12, 'reaction intensity');
});

// Albini 1976 (INT-30) chart 5, "Brush (2 ft), low windspeeds" (printed page 34), read off the scanned page by pixel: at
// 10 mi/h at 20 ft (5 mi/h midflame) the chart's reaction intensity (thousand Btu/ft^2/min) and rate of spread (chains/h).
// Rothermel with Albini's mixing reproduces the chart within reading accuracy, so FM5's 18 chains/h in Anderson 1982 is
// not what Albini's own chart gives at 8 percent dead and 100 percent live moisture (about 15). The chart's 100 percent
// live curve also falls steeply to the dead-fuel-only intensity by 8.6 to 8.7 percent dead moisture, where the live moisture of
// extinction 2.9 W' (1 - Mf/Mx) - 0.226 falls to 1.0 (8.72 percent): FM5 at 8 percent sits 0.7 points below that edge,
// where its rate changes by about 4 chains/h a point (limits.md).
test("FM5 against Albini 1976's chart: reaction intensity, rate and the dead moisture where live fuel stops burning", () => {
  const read = [
    // dead, live, reaction intensity, rate
    [0.08, 1, 1.73, 15.0],
    [0.04, 1, 3.09, 27.8],
    [0.04, 0.5, 3.34, 45.6],
  ];
  for (const [m, live, ir, rate] of read) {
    const b = fireBehaviour(FUEL_MODELS.FM5, { moisture: m, moisture10: m, liveMoisture: live, wind: 5 * MPH });
    near(b.reactionIntensity / 0.18935 / 1000, ir, 0.025, `FM5 ${m}/${live} reaction intensity`);
    near(b.rate / CHAIN_H, rate, 0.045, `FM5 ${m}/${live} rate`);
  }
  const ir = (m) => fuelBed(FUEL_MODELS.FM5, m, 1, m, m).ir;
  assert.ok(ir(0.0875) / ir(0.09) < 1.005, 'above 8.72 percent dead moisture only the dead fuel burns');
  assert.ok(ir(0.084) / ir(0.086) > 1.15 && ir(0.086) / ir(0.088) > 1.1, 'below it the live fuel joins in fast');
});

// FM7 (chart 7, "Southern rough, low windspeeds", printed page 38): where the chart has a curve (its 100 percent live curve
// starts at 13 percent dead moisture, so 8 percent cannot be read), its reaction intensity is ours within 2 percent but its
// rate is 0.78 to 0.80 of ours: the chart's propagating flux for FM7 is lower than Rothermel 1972 as published gives, and
// 0.8 times our 25.9 chains/h is Anderson's 20. The model as published, run with the chart's own input (INT30.FM7), gives
// this; Andrews 2018's BehavePlus values are ours (KB-FIRE-FM7, a reference difference in limits.md). This pins the
// measured difference so a change to it shows.
test('FM7 against Albini 1976 chart 7: the measured difference in rate', () => {
  for (const [m, live, rate] of [
    [0.2, 1, 14.65],
    [0.2, 0.5, 18.86],
    [0.24, 0.5, 16.69],
  ]) {
    const b = fireBehaviour(INT30.FM7, {
      moisture: m,
      moisture10: m,
      moisture100: m,
      liveMoisture: live,
      wind: 5 * MPH,
    });
    const ratio = b.rate / CHAIN_H / rate;
    assert.ok(ratio > 1.2 && ratio < 1.32, `FM7 ${m}/${live}: ours over the chart ${ratio}`);
  }
});

// The fuel model table, as printed: loads in tons/acre (table 1 of INT-GTR-122) and, from Albini's table 7, the
// surface-area-to-volume ratios (1/ft), depth (ft) and moisture of extinction (percent), except FM7's live 1,500 1/ft, the
// standard value of Andrews 2018 table 8a (INT-30 prints 1,550; see INT30 above). A typed value that drifts fails here.
test('fuel models hold the values of Anderson 1982 table 1 and Albini 1976 table 7', () => {
  const table = {
    FM1: [[0.74, 3500]],
    FM2: [
      [2, 3000],
      [1, 109],
      [0.5, 30],
      [0.5, 1500],
    ],
    FM3: [[3.01, 1500]],
    FM4: [
      [5.01, 2000],
      [4.01, 109],
      [2, 30],
      [5.01, 1500],
    ],
    FM5: [
      [1, 2000],
      [0.5, 109],
      [2, 1500],
    ],
    FM6: [
      [1.5, 1750],
      [2.5, 109],
      [2, 30],
    ],
    FM7: [
      [1.13, 1750],
      [1.87, 109],
      [1.5, 30],
      [0.37, 1500],
    ],
    FM8: [
      [1.5, 2000],
      [1, 109],
      [2.5, 30],
    ],
    FM9: [
      [2.92, 2500],
      [0.41, 109],
      [0.15, 30],
    ],
    FM10: [
      [3.01, 2000],
      [2, 109],
      [5.01, 30],
      [2, 1500],
    ],
    FM11: [
      [1.5, 1500],
      [4.51, 109],
      [5.51, 30],
    ],
    FM12: [
      [4.01, 1500],
      [14.03, 109],
      [16.53, 30],
    ],
    FM13: [
      [7.01, 1500],
      [23.04, 109],
      [28.05, 30],
    ],
  };
  const depth = {
    FM1: 1,
    FM2: 1,
    FM3: 2.5,
    FM4: 6,
    FM5: 2,
    FM6: 2.5,
    FM7: 2.5,
    FM8: 0.2,
    FM9: 0.2,
    FM10: 1,
    FM11: 1,
    FM12: 2.3,
    FM13: 3,
  };
  const extinction = {
    FM1: 12,
    FM2: 15,
    FM3: 25,
    FM4: 20,
    FM5: 20,
    FM6: 25,
    FM7: 40,
    FM8: 30,
    FM9: 25,
    FM10: 25,
    FM11: 15,
    FM12: 20,
    FM13: 25,
  };
  for (const [name, rows] of Object.entries(table)) {
    const m = FUEL_MODELS[name];
    assert.deepEqual(
      m.classes.map((c) => [c.load, c.sav]),
      rows,
      name,
    );
    assert.equal(m.depth, depth[name], `${name} depth`);
    assert.equal(Math.round(m.extinction * 100), extinction[name], `${name} extinction`);
  }
});

test('moisture, wind and slope move the rate the way Rothermel says; moisture of extinction stops the fire', () => {
  const dry = fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.03 }),
    damp = fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.11 });
  assert.ok(dry.rate0 > 3 * damp.rate0, 'damper fuel spreads slower');
  assert.ok(
    fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.12 }).rate0 < 1e-9,
    'at the moisture of extinction there is no spread',
  );
  const bed = fuelBed(FUEL_MODELS.FM1, 0.06);
  assert.ok(windFactor(bed, 4) > windFactor(bed, 2) && windFactor(bed, 2) > 0);
  near(slopeFactor(bed, 0.8) / slopeFactor(bed, 0.4), 4, 1e-12, 'phi_s grows with the slope squared');
  const flat = fireBehaviour(FUEL_MODELS.FM4, { moisture: 0.06 }),
    steep = fireBehaviour(FUEL_MODELS.FM4, { moisture: 0.06, slope: 0.6 });
  near(steep.rate, flat.rate0 * (1 + steep.slopeFactor), 1e-12);
  assert.ok(steep.flameLength > flat.flameLength, 'flames lengthen with the intensity (Byram)');
  assert.throws(() => fireBehaviour(FUEL_MODELS.FM1, { moisture: -1 }), RangeError);
  assert.throws(() => fuelBed({ name: 'x', classes: [], depth: 1, extinction: 0.2 }, 0.06), RangeError);
});

test('Richards ellipse: the head is the full rate, the flank less, the back slowest; a 1:1 ellipse is a circle', () => {
  const head = ellipseRate(1, 3, 0),
    flank = ellipseRate(1, 3, Math.PI / 2),
    back = ellipseRate(1, 3, Math.PI);
  assert.equal(head, 1);
  assert.ok(flank < head && back < flank);
  near(back, (1 - Math.sqrt(8) / 3) / (1 + Math.sqrt(8) / 3), 1e-12);
  assert.equal(ellipseRate(2, 1, 1.2), 2);
});

// A plain FM1 field with one ignition at the centre, run for `until` seconds.
const field = (extra = {}, until = 600) => {
  const front = FireFront.create({
    size: [800, 800],
    cell: 4,
    fuel: 'FM1',
    moisture: 0.06,
    ignitions: [{ at: [0, 0], radius: 4 }],
    spotting: 0,
    ...extra,
  });
  front.advanceTime(until);
  return front;
};
// Mean spread speed out to a point: distance over the fire time the cell there caught.
const speed = (front, x, z) => {
  const t = front.arrivalTime(x, z);
  assert.ok(t > 0, `the fire reached ${x},${z}`);
  return Math.hypot(x, z) / t;
};

test('no wind, flat: the fire spreads round at the no-wind rate in every direction (16 neighbours keep the grid out of it)', () => {
  const front = field({}, 2400),
    r0 = fuelBed(FUEL_MODELS.FM1, 0.06).rate0;
  for (const [x, z] of [
    [40, 0],
    [0, 40],
    [-40, 0],
    [28, 28],
    [-28, 28],
    [36, 16],
    [16, -36],
  ])
    near(speed(front, x, z), r0, 0.15, `direction ${x},${z}`);
});

test('head fire against backing fire: a wind drives the head at R0 (1 + phi_w) and the back at the ellipse rate', () => {
  const wind = 6,
    front = field({ wind: [wind, 0], windReduction: 0.4 }, 500),
    bed = fuelBed(FUEL_MODELS.FM1, 0.06),
    b = fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.06, wind: wind * 0.4 });
  const head = speed(front, 120, 0),
    back = speed(front, -20, 0),
    flank = speed(front, 0, 40);
  near(head, b.rate, 0.15, 'head');
  near(back, ellipseRate(b.rate, b.lengthToBreadth, Math.PI), 0.3, 'backing');
  assert.ok(head > 4 * back, 'the head outruns the back');
  assert.ok(flank > back && flank < head, 'the flank is between');
  assert.ok(head > bed.rate0 * 2);
});

test('upslope against downslope by phi_s: a fire runs up a 22 degree slope faster than down, by the slope factor', () => {
  const tan = 0.4,
    front = field({ ground: (x) => tan * x }, 400),
    b = fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.06, slope: tan });
  const up = speed(front, 60, 0),
    down = speed(front, -20, 0);
  near(up, b.rate, 0.2, 'uphill');
  assert.ok(up > 3 * down, `uphill ${up} against downhill ${down}`);
  assert.ok(b.slopeFactor > 0.5);
});

test('fixed steps: any split of the same time gives the same fire; the same seed gives the same embers', () => {
  const make = (seed = 1) =>
    FireFront.create({
      size: [400, 400],
      cell: 4,
      fuel: 'FM4',
      wind: [12, 0],
      spotting: 0.05,
      seed,
      ignitions: [{ at: [-100, 0], radius: 8 }],
    });
  const a = make(),
    b = make();
  a.advanceTime(120);
  for (let i = 0; i < 240; i++) b.advanceTime(0.5);
  assert.deepEqual(a.read(), b.read());
  assert.equal(a.time, 120);
  assert.equal(a.spots, b.spots);
  const c = make(9);
  c.advanceTime(120);
  assert.notDeepEqual(c.read(), a.read(), 'another seed throws other embers');
});

test('settle: runs until nothing burns and resolves with the fire time; every caught cell is burnt', async () => {
  const front = FireFront.create({
    size: [200, 200],
    cell: 4,
    fuel: 'FM1',
    moisture: 0.03,
    ignitions: [{ at: [0, 0], radius: 4 }],
  });
  assert.equal(front.active, true);
  const t = await front.settle(40000);
  assert.equal(front.active, false);
  assert.equal(front.burningCells, 0);
  assert.equal(t, front.time);
  assert.equal(front.state(0, 0), BURNT);
  assert.equal(front.state(90, 90), BURNT, 'the whole field burned');
  assert.equal(front.state(500, 0), -1, 'outside the grid');
  const read = front.read();
  for (let i = 3; i < read.length; i += 4) assert.equal(read[i], BURNT);
  await assert.rejects(() => FireFront.create({ ignitions: [{ at: [0, 0] }] }).settle(100, AbortSignal.abort()));
});

test('the burn texture rows: arrival, burn-out, intensity and state per cell; unburnable cells stay out', () => {
  const front = FireFront.create({
    size: [200, 200],
    cell: 4,
    fuel: (x) => (x > 20 && x < 30 ? null : 'FM1'),
    moisture: 0.03,
    ignitions: [{ at: [-60, 0], radius: 4 }],
    spotting: 0,
  });
  front.advanceTime(6000);
  assert.equal(front.state(25, 0), NO_FUEL, 'a road is no fuel');
  assert.equal(front.state(60, 0), UNBURNT, 'a firebreak stops the fire');
  assert.equal(front.state(-60, 0), BURNT);
  const read = front.read(),
    i = Math.floor((0 - front.origin[1]) / front.cell) * front.width + Math.floor((-60 - front.origin[0]) / front.cell);
  assert.ok(read[i * 4] >= 0 && read[i * 4 + 1] > read[i * 4], 'burn-out after arrival');
  assert.equal(read[i * 4 + 3], BURNT);
  // A burnt cell keeps the intensity it burned at (plants left standing read it for their scorch after the front).
  assert.ok(read[i * 4 + 2] > 0, `a burnt cell keeps its fireline intensity: ${read[i * 4 + 2]}`);
  let unburnt = 0;
  for (let k = 0; k < read.length; k += 4) if (read[k + 3] === UNBURNT && read[k + 2] !== 0) unburnt++;
  assert.equal(unburnt, 0, 'an unburnt cell has none');
});

test('smoke segments: heat is 0.7 of the reaction intensity over the burning area, hottest first, at the front', () => {
  const front = FireFront.create({
    size: [400, 400],
    cell: 4,
    fuel: 'FM1',
    wind: [5, 0],
    spotting: 0,
    ignitions: [{ at: [-100, 0], radius: 6 }],
  });
  front.advanceTime(60);
  const segs = front.segments(),
    cells = front.burningCells,
    ir = fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.06 }).reactionIntensity * 1000;
  assert.ok(segs.length >= 1);
  for (let k = 1; k < segs.length; k++) assert.ok(segs[k - 1].heat >= segs[k].heat);
  near(
    segs.reduce((s, g) => s + g.heat, 0),
    0.7 * ir * 16 * cells,
    1e-9,
  );
  assert.ok(segs.every((g) => g.x > -110 && g.x < 200));
});

test('embers: a hot fire in a wind throws embers downwind that start spot fires; no spotting, no embers', () => {
  const spots = [];
  const make = (spotting) =>
    FireFront.create({
      size: [1000, 400],
      cell: 5,
      fuel: 'FM4',
      moisture: 0.04,
      wind: [14, 0],
      spotting,
      seed: 3,
      ignitions: [{ at: [-300, 0], radius: 10 }],
      onSpot: (s) => spots.push(s),
    });
  const calm = make(0);
  calm.advanceTime(120);
  assert.equal(calm.embers, 0);
  const fire = make(0.05);
  fire.advanceTime(120);
  assert.ok(fire.embers > 20 && fire.spots > 0, `embers ${fire.embers}, spot fires ${fire.spots}`);
  assert.ok(
    spots.some((s) => s.ignited && s.to[0] > s.from[0] + 15),
    'a spot fire starts well downwind of its source',
  );
  assert.ok(
    spots.every((s) => s.to[0] >= s.from[0] - 10),
    'no ember goes upwind',
  );
});

test('structures: a building ignites from flame within 1.5 flame lengths and burns for its burn time; one off the path does not', () => {
  const front = FireFront.create({
    size: [400, 200],
    cell: 4,
    fuel: 'FM4',
    moisture: 0.05,
    wind: [4, 0],
    spotting: 0,
    structureBurnTime: 600,
    structureExposure: 20,
    structures: [
      { at: [60, 0], radius: 6 },
      { at: [150, 80], radius: 6 },
    ],
    ignitions: [{ at: [-80, 0], radius: 8 }],
  });
  assert.equal(front.state(60, 0), UNBURNT);
  front.advanceTime(900);
  assert.ok([BURNING, BURNT].includes(front.state(60, 0)), 'the house in the path caught');
  assert.equal(front.state(150, 80), UNBURNT, 'a house off the path did not');
  front.advanceTime(700);
  assert.equal(front.state(60, 0), BURNT);
  const read = front.read(),
    i = Math.floor((0 - front.origin[1]) / 4) * front.width + Math.floor((60 - front.origin[0]) / 4);
  assert.ok(read[i * 4 + 1] - read[i * 4] >= 599, 'it burned for its burn time');
});

test('options are checked: a bad cell, step, moisture, fuel name or ignition throws by name', () => {
  assert.throws(() => FireFront.create({ cell: 0 }), RangeError);
  assert.throws(() => FireFront.create({ step: 99 }), RangeError);
  assert.throws(() => FireFront.create({ moisture: 2 }), RangeError);
  assert.throws(() => FireFront.create({ fuel: 'FM99' }), TypeError);
  assert.throws(() => FireFront.create({ size: [100000, 100000], cell: 1 }), RangeError);
  assert.throws(() => FireFront.create({ ignitions: [{ at: [NaN, 0] }] }), RangeError);
  const f = FireFront.create();
  f.dispose();
  assert.throws(() => f.advanceTime(1), /disposed/);
  assert.throws(() => FireFront.create().advanceTime(-1), RangeError);
});

test('moisture10 and moisture100 set the dead classes apart from the 1-hour value; the default keeps +0.01 and +0.02', () => {
  const base = { moisture: 0.06, wind: 3 },
    def = fireBehaviour(FUEL_MODELS.FM10, base),
    same = fireBehaviour(FUEL_MODELS.FM10, { ...base, moisture10: 0.07, moisture100: 0.08 }),
    wet = fireBehaviour(FUEL_MODELS.FM10, { ...base, moisture10: 0.2, moisture100: 0.2 }),
    flat = fireBehaviour(FUEL_MODELS.FM10, { ...base, moisture10: 0.06, moisture100: 0.06 });
  assert.equal(def.rate, same.rate);
  assert.ok(wet.rate < def.rate && def.rate < flat.rate, 'wetter heavy dead fuel spreads slower');
  assert.throws(() => fireBehaviour(FUEL_MODELS.FM10, { ...base, moisture10: -1 }), RangeError);
});

test('smokeEmission: 0 before ignition, then the fuel burned (heat over 18,622 kJ/kg) times smokeYield grams per kilogram', () => {
  const front = FireFront.create({
    size: [400, 400],
    cell: 4,
    fuel: 'FM1',
    wind: [5, 0],
    spotting: 0,
    ignitions: [{ at: [-100, 0], radius: 6 }],
  });
  assert.equal(front.smokeEmission, 0, 'nothing burns before the first step');
  front.advanceTime(60);
  const segments = front.segments();
  assert.ok(segments.length > 0);
  const watts = segments.reduce((s, x) => s + x.heat, 0) / 0.7;
  near(front.smokeEmission, (15 * watts) / 18.622e6, 1e-9, 'grams per second');
  assert.ok(front.smokeEmission > 5, `a grass fire of this size gives off ${front.smokeEmission} g/s`);
  const double = FireFront.create({
    size: [400, 400],
    cell: 4,
    fuel: 'FM1',
    wind: [5, 0],
    spotting: 0,
    ignitions: [{ at: [-100, 0], radius: 6 }],
    smokeYield: 30,
  });
  double.advanceTime(60);
  near(double.smokeEmission, 2 * front.smokeEmission, 1e-9, 'the yield scales it');
  assert.throws(() => FireFront.create({ smokeYield: -1 }), RangeError);
});

// KB-WEATHER-FIREHAZE1: the front reports the flames' radiant power, the share its smoke columns glow with, so a
// WeatherDrive can light the smoke haze over the fire from below.
test('radiantPower: 0 before ignition, then the radiant 0.3 of the heat release, the share the smoke columns glow with', () => {
  assert.equal(RADIANT_SHARE, RADIANT_FRACTION, 'the front and its smoke columns radiate one share');
  const front = FireFront.create({
    size: [400, 400],
    cell: 4,
    fuel: 'FM1',
    wind: [5, 0],
    spotting: 0,
    ignitions: [{ at: [-100, 0], radius: 6 }],
  });
  assert.equal(front.radiantPower, 0, 'nothing burns before the first step');
  front.advanceTime(60);
  const watts = front.segments().reduce((s, x) => s + x.heat, 0) / 0.7;
  near(front.radiantPower, 0.3 * watts, 1e-9, 'watts');
  // The same fuel burned: the smoke and the light are two shares of one release.
  near(front.radiantPower / front.smokeEmission, (0.3 * 18.622e6) / 15, 1e-9, 'watts per gram of smoke');
});

// KB-FIRE-CROWN1: crown fire. Van Wagner 1977's initiation and active criteria, Rothermel 1991's crown rate, the crown
// fraction burned of the Canadian FBP System (Forestry Canada 1992), bounded against published crown fire rates: Cruz,
// Alexander and Wakimoto 2005's active crown fire model as a cross-check (Rothermel 1991 runs under it, Cruz and
// Alexander 2010) and the Sundance fire's run of about 16 miles in 9 hours (Anderson 1968, 48 m/min).
test('crown fire: Van Wagner 1977 initiation and the 3 / CBD active rate, exactly', () => {
  const canopy = { baseHeight: 4, bulkDensity: 0.12, height: 20 },
    surface = fireBehaviour(FUEL_MODELS.FM10, { moisture: 0.05, wind: 8 }),
    c = crownBehaviour(surface, canopy, 1, 1, 20);
  near(c.initiation, (0.01 * 4 * (460 + 25.9 * 100)) ** 1.5, 1e-9, 'I0 = (0.010 z (460 + 25.9 M))^1.5');
  near(c.activeRate * 60, 3 / 0.12, 1e-9, 'R0 = 3 / CBD m/min');
  // Drier foliage and a lower crown base crown more easily.
  assert.ok(crownBehaviour(surface, canopy, 0.8, 1, 20).initiation < c.initiation);
  assert.ok(crownBehaviour(surface, { ...canopy, baseHeight: 1 }, 1, 1, 20).initiation < c.initiation);
  // Below I0: a surface fire, untouched.
  const weak = fireBehaviour(FUEL_MODELS.FM10, { moisture: 0.12, wind: 0.5 }),
    cw = crownBehaviour(weak, canopy, 1, 1, 2);
  assert.equal(cw.type, 'surface');
  assert.equal(cw.rate, weak.rate);
  assert.equal(cw.fraction, 0);
});

test('crown fire: passive torching blends R_s + CFB (R_c - R_s); active runs at the crown rate with Thomas flames', () => {
  const canopy = FUEL_MODELS.FM10.canopy;
  assert.deepEqual(canopy, { baseHeight: 2, bulkDensity: 0.15, height: 20 });
  for (const fm of ['FM8', 'FM9', 'FM10']) assert.ok(FUEL_MODELS[fm].canopy, `${fm} carries a stand`);
  for (const fm of ['FM1', 'FM4', 'FM12']) assert.equal(FUEL_MODELS[fm].canopy, undefined, `${fm} has no crowns`);
  const surface = fireBehaviour(FUEL_MODELS.FM10, { moisture: 0.05, wind: 4 }),
    rc = crownRate10({ moisture: 0.05, wind: 10 }),
    passive = crownBehaviour(surface, canopy, 1, rc, 10);
  assert.equal(passive.type, 'passive', `R_c ${rc * 60} m/min under 3 / CBD = 20`);
  const r0 = passive.initiation / (surface.firelineIntensity / surface.rate);
  near(passive.fraction, 1 - Math.exp(-0.23 * 60 * (surface.rate - r0)), 1e-9, 'CFB = 1 - exp(-0.23 (R - R0))');
  near(passive.rate, surface.rate + passive.fraction * (rc - surface.rate), 1e-9, 'passive rate');
  const gale = crownBehaviour(
    fireBehaviour(FUEL_MODELS.FM10, { moisture: 0.05, wind: 8 }),
    canopy,
    1,
    crownRate10({ moisture: 0.05, wind: 20 }),
    20,
  );
  assert.equal(gale.type, 'active');
  assert.equal(gale.fraction, 1);
  near(gale.flameLength, 0.0266 * gale.firelineIntensity ** (2 / 3), 1e-9, 'Thomas 1963');
  // Running crown fires release 10 to 100 MW/m, their flames one to two and a half stand heights (Alexander and Cruz).
  assert.ok(gale.firelineIntensity > 1e4 && gale.firelineIntensity < 1e5, `I ${gale.firelineIntensity}`);
  assert.ok(gale.flameLength > 20 && gale.flameLength < 50, `L ${gale.flameLength}`);
  assert.ok(gale.lengthToBreadth > passive.lengthToBreadth);
});

test('crown fire rate in a 20 m/s gale against Rothermel 1991, the Sundance run and Cruz et al. 2005', () => {
  const rc = crownRate10({ moisture: 0.05, wind: 20 }) * 60,
    fm10 = fuelBed(FUEL_MODELS.FM10, 0.05),
    r10 = fm10.rate0 * (1 + windFactor(fm10, (0.4 * 20) / 1.15)) * 60;
  near(rc, 3.34 * r10, 1e-9, 'R_c = 3.34 R10 at 0.4 U20');
  // Cruz, Alexander and Wakimoto 2005: CROS_A = 11.02 U10^0.90 CBD^0.19 exp(-0.17 EFFM), U10 in km/h, m/min.
  const cruz = 11.02 * (20 * 3.6) ** 0.9 * 0.15 ** 0.19 * Math.exp(-0.17 * 5);
  assert.ok(rc > 30 && rc < 160, `crown rate ${rc} m/min against the Sundance mean 48 and published 15 to 160`);
  assert.ok(rc / cruz > 0.25 && rc / cruz <= 1, `Rothermel 1991 ${rc} under Cruz 2005 ${cruz} by less than 4 times`);
});

test('FireFront crowns: under a gale a timber stand burns as a running crown fire at the crown rate; crown: false stays on the ground', () => {
  const make = (crown, fuel = 'FM10', canopy) =>
      FireFront.create({
        size: [2400, 800],
        cell: 8,
        fuel,
        moisture: 0.05,
        wind: [20, 0],
        spotting: 0,
        crown,
        ...(canopy ? { canopy } : {}),
        ignitions: [{ at: [-1100, 0], radius: 16 }],
      }),
    head = (f) => {
      let far = -1e9;
      for (let x = -1196; x < 1200; x += 8) if (f.arrivalTime(x, 4) >= 0) far = Math.max(far, x);
      return far + 1100;
    },
    T = 600,
    crowned = make(true),
    ground = make(false);
  crowned.advanceTime(T);
  ground.advanceTime(T);
  const rc = crownRate10({ moisture: 0.05, wind: 20 });
  assert.ok(crowned.crowningCells > 0, 'crowns burn');
  assert.equal(ground.crowningCells, 0);
  assert.equal(ground.crownFraction(-1000, 4), 0);
  assert.equal(crowned.crownFraction(-1000, 4), 1, 'an active crown fire burned the stand');
  near(head(crowned), rc * T, 0.12, 'the head runs at the crown rate of Rothermel 1991');
  assert.ok(head(crowned) > 2 * head(ground), `crown head ${head(crowned)} m, surface ${head(ground)} m`);
  const f = crowned.flames()[0];
  assert.ok(f.crown > 0.9 && f.flameLength > 20, `crown flame: fraction ${f.crown}, length ${f.flameLength}`);
  assert.ok(ground.flames().every((g) => g.crown === 0));
  // A stand with its crowns out of reach (base 15 m) stays a surface fire.
  const tall = make(true, 'FM10', () => ({ baseHeight: 15, bulkDensity: 0.15, height: 30 }));
  tall.advanceTime(T);
  assert.equal(tall.crowningCells, 0);
  const open = make(true, 'FM10', () => null);
  open.advanceTime(T);
  assert.equal(open.crowningCells, 0, 'a canopy function giving null takes the crowns away');
});

test('conditional crown fire (Scott and Reinhardt 2001): a crown fire runs on into a stand too high to torch from below', () => {
  // FM8's surface fire (72 kW/m in the gale) cannot lift into its 4 m crowns, but its 0.12 kg/m^3 crowns carry a crown
  // fire at the gale's crown rate once one runs in from the FM10 stand upwind.
  const fuel = (x) => (x < -600 ? 'FM10' : 'FM8'),
    mk = (ignite) =>
      FireFront.create({
        size: [2400, 400],
        cell: 8,
        fuel,
        moisture: 0.05,
        wind: [20, 0],
        spotting: 0,
        ignitions: [{ at: [ignite, 0], radius: 16 }],
      }),
    fed = mk(-1100),
    alone = mk(-200);
  fed.advanceTime(900);
  alone.advanceTime(900);
  assert.equal(fed.crownFraction(-520, 4), 1, 'the crown fire went on into FM8');
  assert.equal(alone.crowningCells, 0);
  assert.equal(alone.crownFraction(-150, 4), 0, 'FM8 lit from below stays on the ground');
});

test('crown options are checked: foliarMoisture range, crown a boolean, canopy values', () => {
  assert.throws(() => FireFront.create({ foliarMoisture: 0.1 }), RangeError);
  assert.throws(() => FireFront.create({ crown: 1 }), TypeError);
  assert.throws(
    () => FireFront.create({ size: [64, 64], canopy: () => ({ baseHeight: -1, bulkDensity: 0.1, height: 10 }) }),
    RangeError,
  );
});

// KB-FIRE-SPOTCELL1: embers were thrown per burning cell, so a 4 m grid threw four times the embers of an 8 m grid over
// the same fire (timber-valley's film grid spotted four times as hard as its preview).
test('embers do not depend on the grid: the same fire on 4 m and 8 m cells throws about the same embers', () => {
  const run = (cell) => {
    const f = FireFront.create({
      size: [800, 400],
      cell,
      fuel: 'FM4',
      moisture: 0.04,
      wind: [14, 0],
      spotting: 0.05,
      crown: false,
      seed: 5,
      ignitions: [{ at: [-300, 0], radius: 12 }],
    });
    f.advanceTime(60);
    return f.embers;
  };
  const fine = run(4),
    coarse = run(8);
  assert.ok(coarse > 50, `embers ${coarse}`);
  assert.ok(fine / coarse > 0.6 && fine / coarse < 1.6, `4 m cells ${fine} embers, 8 m cells ${coarse}`);
});

// KB-FIRE-FLATBOX1: a stretch of front was drawn over the axis-aligned box of its burning cells, so a diagonal fire line
// lay on the slopes as a flat glowing rectangle (timber-valley aerial-west); the volume now lies along the line.
test('a diagonal fire line draws as a volume along the line, not over its box', () => {
  // A drip-torch line lit along x = -z, the wind across it toward +x+z.
  const line = [];
  for (let k = -150; k <= 150; k += 6) line.push({ at: [k, -k], radius: 4 });
  const front = FireFront.create({
    size: [800, 800],
    cell: 8,
    fuel: 'FM1',
    moisture: 0.05,
    wind: [5, 5],
    spotting: 0,
    segment: 400,
    crown: false,
    ignitions: line,
  });
  let f;
  for (let t = 0; t < 60 && !(f && f.cells > 30); t += 0.5) {
    front.advanceTime(0.5);
    f = front.flames().find((g) => g.kind === 'front');
  }
  let minX = 1e9,
    maxX = -1e9,
    minZ = 1e9,
    maxZ = -1e9;
  for (let z = -396; z < 400; z += 8)
    for (let x = -396; x < 400; x += 8)
      if (front.state(x, z) === BURNING) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
  const box = (maxX - minX + 8) * (maxZ - minZ + 8),
    area = f.footprint[0] * f.footprint[1],
    along = [Math.cos(f.yaw), -Math.sin(f.yaw)];
  assert.ok(f.footprint[0] > 2 * f.footprint[1], `a line: ${f.footprint}`);
  assert.ok(area < 0.5 * box, `volume ${area} m2 against the box ${box} m2`);
  // The head runs with the wind along +x+z; its line lies across it, along (1, -1).
  assert.ok(Math.abs(along[0] * along[1] + 0.5) < 0.12, `line axis ${along}`);
});
