// The explosive source (FIRE-05): a charge's energy, Gurney metal speeds against Kennedy's equations and measurements, and
// the air share of a buried charge against measured blasts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  airborneFraction,
  chargeEnergy,
  energyBudget,
  EXPLOSIVES,
  GURNEY_FRACTION,
  gurneyVelocity,
  metalSpeed,
  SONDER_CRATER_LAW,
  scaledCraterRadius,
  scaledDepth,
  TNT_JOULES_PER_KG,
  tntEquivalent,
} from '../dist/explosive.js';

const close = (actual, expected, relative, what) =>
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), `${what}: ${actual} against ${expected}`);

test("Gurney's equations take Kennedy's closed forms, and the asymmetric sandwich reduces to the others", () => {
  const g = 2400;
  close(metalSpeed(g, 'cylinder', 1), g / Math.sqrt(1.5), 1e-12, 'cylinder at M/C 1');
  close(metalSpeed(g, 'sphere', 1), g / Math.sqrt(1.6), 1e-12, 'sphere at M/C 1');
  close(metalSpeed(g, 'flatSandwich', 1), g / Math.sqrt(4 / 3), 1e-12, 'flat sandwich at M/C 1');
  close(metalSpeed(g, 'openFacedSandwich', 1), g / Math.sqrt(28 / 12 + 1), 1e-12, 'open-faced sandwich at M/C 1');
  for (const m of [0.21, 0.7, 2.5, 10]) {
    // No tamper: the asymmetric sandwich is the open-faced one (Kennedy eq 9 with N/C = 0).
    close(metalSpeed(g, 'asymmetricSandwich', m, 0), metalSpeed(g, 'openFacedSandwich', m), 1e-12, `no tamper at ${m}`);
    // A tamper equal to the plate: a symmetric sandwich of twice the metal.
    if (m >= 0.4)
      close(
        metalSpeed(g, 'asymmetricSandwich', m / 2, m / 2),
        metalSpeed(g, 'flatSandwich', m),
        1e-12,
        `equal tamper at ${m}`,
      );
    // More metal goes slower, in every geometry.
    for (const shape of ['cylinder', 'sphere', 'flatSandwich', 'openFacedSandwich'])
      assert.ok(metalSpeed(g, shape, m * 0.99) > metalSpeed(g, shape, m), `${shape} slows with metal at ${m}`);
  }
});

test("the Gurney velocity from the heat of detonation is within Kennedy's 10 % of each measured one but nitromethane's", () => {
  for (const [key, explosive] of Object.entries(EXPLOSIVES)) {
    const estimated = gurneyVelocity({ name: explosive.name, heatOfDetonation: explosive.heatOfDetonation });
    const error = Math.abs(estimated - explosive.gurney) / explosive.gurney;
    // Kennedy's Table 2: E / dHd lies in 0.61 to 0.76 for all but nitromethane (0.56), so E = 0.7 dHd misses it.
    if (key === 'nitromethane') assert.ok(error > 0.1, `nitromethane is Kennedy's exception: ${error}`);
    else assert.ok(error < 0.1, `${explosive.name}: estimated ${estimated} m/s against measured ${explosive.gurney}`);
    assert.equal(gurneyVelocity(explosive), explosive.gurney);
  }
  assert.equal(GURNEY_FRACTION, 0.7);
});

test('a charge releases its mass times its heat of detonation, and TNT equivalence is at 4.184 MJ/kg', () => {
  assert.equal(chargeEnergy(10, EXPLOSIVES.rdx), 10 * 1.51 * 4.184e6);
  assert.equal(tntEquivalent(TNT_JOULES_PER_KG * 3), 3);
  assert.throws(() => chargeEnergy(0), RangeError);
  assert.throws(() => chargeEnergy(-1), RangeError);
  assert.throws(() => tntEquivalent(Number.NaN), RangeError);
  assert.throws(() => metalSpeed(2400, 'cylinder', 0.1), /0\.2 to 10/);
  assert.throws(() => metalSpeed(2400, 'cylinder', 11), RangeError);
  assert.throws(() => metalSpeed(2400, 'cone', 1), TypeError);
  assert.throws(() => scaledDepth(-1, 1e6), RangeError);
});

test("the air share falls with scaled depth from 0.90 at the surface, and Sonder et al.'s 23 measured blasts lie in its band", () => {
  // At the surface g = 2^(-1/10), so the share is 2^(-3/20).
  close(airborneFraction(0), 2 ** -0.15, 1e-12, 'surface share');
  for (let d = 0; d < 8e-3; d += 2e-4) assert.ok(airborneFraction(d + 2e-4) < airborneFraction(d), `falls at ${d}`);
  // Sonder et al. 2022, Table 3: airborne energy as a percent of blast energy, against reduced scaled depth (1e-3 m J^-1/3).
  const measured = [
    [0.99, 3.95],
    [0.89, 3.95],
    [1.03, 3.95],
    [0.39, 4.72],
    [0.59, 4.21],
    [0.25, 4.62],
    [1.81, 3.95],
    [7.47, 2.67],
    [7.64, 2.3],
    [0.83, 3.95],
    [6.62, 2.44],
    [1.41, 3.95],
    [1.44, 3.95],
    [3.69, 3.95],
    [0.72, 4.33],
    [1.56, 4.0],
    [1.01, 5.05],
    [1.33, 3.95],
    [5.41, 2.91],
    [0.84, 3.95],
    [5.78, 2.93],
    [1.46, 3.95],
    [6.6, 3.22],
  ];
  const logs = measured.map(([percent, d]) => Math.log(percent / 100 / airborneFraction(d * 1e-3)));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const spread = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1));
  // The two studies' reference charges differ (Sonder et al. section 2.2.1): the measured shares sit a factor 1.84 above
  // the law with a spread of 1.6. Every blast lies inside the mean plus or minus 2.5 spreads, and the mean inside a factor 2.
  assert.ok(mean > 0 && mean < Math.log(2), `mean log ratio ${mean}`);
  for (const [i, value] of logs.entries())
    assert.ok(Math.abs(value - mean) < 2.5 * spread, `blast ${i}: log ratio ${value}, mean ${mean}, spread ${spread}`);
});

test('Fauld (Fielder and Guest 1967): 5.34 million lb of TNT at a Baldwin scaled depth of 1.7 ft/lb^(1/3) keeps almost all its energy in the ground', () => {
  const poundsTnt = 5.34e6,
    kilograms = poundsTnt * 0.45359237,
    energy = kilograms * TNT_JOULES_PER_KG;
  // Baldwin's scaled depth H / W^(1/3) = 1.7 in feet and pounds gives the charge centre's depth.
  const depth = 1.7 * Math.cbrt(poundsTnt) * 0.3048;
  assert.ok(depth > 85 && depth < 95, `the charge centre is ${depth} m down (the stores were 200 to 400 ft down)`);
  const budget = energyBudget(energy, depth);
  close(budget.tntEquivalent, kilograms, 1e-12, 'TNT equivalent');
  // 4.2e-3 m J^-1/3: the depth that digs the largest crater (Goto et al. 2001; Sonder et al. 2022).
  assert.ok(budget.scaledDepth > 4.0e-3 && budget.scaledDepth < 4.3e-3, `scaled depth ${budget.scaledDepth}`);
  assert.ok(budget.air / energy < 0.01 && budget.air / energy > 0.002, `air share ${budget.air / energy}`);
  close(budget.air + budget.ground, energy, 1e-12, 'every joule accounted');
  // A surface charge sends most of its energy into the air.
  assert.ok(energyBudget(energy, 0).air / energy > 0.85);
});

test("the crater law has Sonder et al.'s shape: r0 at the surface, its largest radius at the optimal depth, smaller past it", () => {
  const law = SONDER_CRATER_LAW;
  close(scaledCraterRadius(0), law.surfaceRadius, 1e-12, 'surface');
  close(scaledCraterRadius(law.optimalDepth), law.maxRadius, 1e-12, 'optimal depth');
  for (let d = 0; d < 1.2e-2; d += 1e-4)
    assert.ok(scaledCraterRadius(d) <= law.maxRadius * (1 + 1e-12), `no larger than the largest at ${d}`);
  assert.ok(scaledCraterRadius(8e-3) < scaledCraterRadius(5e-3));
  assert.throws(() => scaledCraterRadius(-1), RangeError);
  assert.throws(() => scaledCraterRadius(1e-3, { ...law, surfaceRadius: 1 }), /surfaceRadius/);
});

test('every joule of a buried charge is in the air, the ground shock, the crater work or heat', () => {
  for (const depth of [0, 0.2, 0.5, 1, 2, 5]) {
    const b = energyBudget(4.184e6, depth);
    close(b.air + b.groundShock + b.craterWork + b.heat, b.energy, 1e-12, `sum at ${depth} m`);
    close(b.groundShock + b.craterWork + b.heat, b.ground, 1e-12, `ground at ${depth} m`);
    for (const part of ['air', 'groundShock', 'craterWork', 'heat']) assert.ok(b[part] >= 0, `${part} at ${depth} m`);
    close(b.groundShock, 0.15 * b.ground, 1e-12, 'default seismic coupling');
  }
  // A charge in the air: all of it is blast; the ground gets it through FIRE-04.
  const air = energyBudget(4.184e6, 0, {}, true);
  assert.equal(air.air, air.energy);
  assert.equal(air.craterWork + air.groundShock + air.heat + air.craterRadius, 0);
  assert.throws(() => energyBudget(1e6, 1, { seismicCoupling: 2 }), /0 to 1/);
  assert.throws(() => energyBudget(1e6, 1, { density: 0 }), RangeError);
  assert.throws(() => energyBudget(1e6, 1, { craterRadius: -1 }), RangeError);
});

test("Sonder et al.'s blasts: the model's seismic share lies in their measured elastic band of 10 to 17 % of each blast", () => {
  // Sonder et al. 2022, section 3.3.3: airborne plus seismic energy was about 17 % of each blast for pads 1, 2 and 4 and
  // about 10 % for pad 3; the airborne part of each (Table 3) is at most 7.6 %. Their charges were about 0.43 MJ.
  for (const d of [2.3e-3, 2.9e-3, 3.95e-3, 4.33e-3, 5.05e-3]) {
    const energy = 4.3e5;
    const b = energyBudget(energy, d * Math.cbrt(energy));
    const share = b.groundShock / energy;
    assert.ok(share > 0.1 && share < 0.17, `seismic share ${share} at scaled depth ${d}`);
  }
});

test('Fauld: in its measured 250 m crater the least crater work is a fifth of the energy, and the crater law overshoots it in rock', () => {
  const kilograms = 5.34e6 * 0.45359237,
    energy = kilograms * TNT_JOULES_PER_KG,
    depth = 1.7 * Math.cbrt(5.34e6) * 0.3048;
  // Fielder and Guest 1967: a crater about 250 m across, in gypsum (alabaster) with marl, about 2300 kg/m^3.
  const measured = energyBudget(energy, depth, { craterRadius: 125, density: 2300 });
  const share = measured.craterWork / energy;
  assert.ok(share > 0.1 && share < 0.3, `crater work share ${share}`);
  assert.ok(measured.heat > measured.craterWork, 'most of the ground share is heat');
  // Sonder et al.'s law was fitted in loose ground; in Fauld's rock it gives a crater about 30 % wider than measured
  // (docs/limits.md), which is why the budget takes a surveyed or solved radius.
  const predicted = energyBudget(energy, depth).craterRadius * 2;
  assert.ok(predicted > 250 && predicted < 340, `law diameter ${predicted} m against 250 m`);
});
