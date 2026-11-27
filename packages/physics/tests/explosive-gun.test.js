// A gun's firing (FIRE-05): the Noble-Abel gas against Noble and Abel's closed-vessel pressures, and the 6-in. gun of the
// 1911 Encyclopaedia Britannica's "Ballistics", with momentum and energy accounted exactly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { closedVesselPressure, fireGun, HISTORY_WORDS, PROPELLANTS } from '../dist/explosive.js';

const TON = 15.444e6; // a long ton per square inch, Pa
const IN = 0.0254,
  LB = 0.45359237,
  FT = 0.3048;

// Noble and Abel's closed-vessel pressures (tons per square inch) against gravimetric density (1911 Britannica, Table 1).
const density = [
  0.05, 0.06, 0.08, 0.1, 0.12, 0.14, 0.15, 0.16, 0.18, 0.2, 0.22, 0.24, 0.25, 0.26, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55,
  0.6,
];
const pebble = [
  0.855, 1.0, 1.36, 1.76, 2.06, 2.53, 2.73, 2.96, 3.33, 3.77, 4.26, 4.66, 4.88, 5.1, 6.07, 7.35, 8.73, 10.23, 11.25,
  13.62, 15.55,
];
const cordite = [
  3.0, 3.8, 5.4, 7.1, 8.7, 10.5, 11.36, 12.3, 14.2, 16.0, 17.9, 19.8, 20.63, 21.75, 26.0, 31.0, 36.53, 42.2, 48.66,
  55.86, 63.33,
];

test("the Noble-Abel gas gives Noble and Abel's closed-vessel pressures: pebble powder within 5 %, cordite within 14 %", () => {
  density.forEach((g, i) => {
    const p = closedVesselPressure(PROPELLANTS.pebblePowder, g * 1000) / TON;
    assert.ok(Math.abs(p / pebble[i] - 1) < 0.05, `pebble powder at ${g}: ${p} against ${pebble[i]}`);
    const c = closedVesselPressure(PROPELLANTS.cordite, g * 1000) / TON;
    // The lowest densities lose the most heat to the vessel's walls; from 0.08 up the fit is within 8 %.
    assert.ok(Math.abs(c / cordite[i] - 1) < (g < 0.08 ? 0.14 : 0.08), `cordite at ${g}: ${c} against ${cordite[i]}`);
  });
  // Cordite's force against its gas, measured apart: 700 cc a gram at 0 C and 760 mm, at 4758 K, is R T0 = 1.24 MJ/kg.
  const measured = (101325 * 0.7 * 4758) / 273;
  assert.ok(Math.abs(PROPELLANTS.cordite.force / measured - 1) < 0.2, `force ${PROPELLANTS.cordite.force}`);
  assert.throws(() => closedVesselPressure(PROPELLANTS.cordite, 2 / PROPELLANTS.cordite.covolume), /covolume/);
});

// The 6-in. gun: 13 lb 4 oz of size 30 cordite in a 730 cubic inch chamber, 6100 cubic inches of bore, a 100 lb shot, and
// 2150 ft/s in the range table; the mean effective pressure 6.4 tons, the maximum 2 or 3 times it, 16 tons the design limit.
const sixInch = {
  bore: 6 * IN,
  travel: (6100 / (Math.PI * 9)) * IN,
  chamber: 730 * IN ** 3,
  shotMass: 100 * LB,
  charge: 13.25 * LB,
  web: 0.15 * IN,
};

test("the 6-in. gun: cordite's burning rate gives its 2150 ft/s, and the peak pressure is 2 to 3 times the mean as measured", () => {
  const fired = fireGun(sixInch);
  assert.ok(
    Math.abs(fired.muzzleVelocity / FT / 2150 - 1) < 0.005,
    `muzzle velocity ${fired.muzzleVelocity / FT} ft/s`,
  );
  const mean = (0.5 * sixInch.shotMass * fired.muzzleVelocity ** 2) / (6100 * IN ** 3);
  const ratio = fired.peakPressure / mean;
  assert.ok(ratio > 2 && ratio < 3, `peak over mean effective pressure ${ratio}`);
  assert.ok(fired.peakBreech / TON < 16 * 1.03, `breech peak ${fired.peakBreech / TON} tons against the 16 designed`);
  assert.ok(fired.peakBreech > fired.peakPressure && fired.peakPressure > fired.peakBase, 'breech > mean > base');
  assert.ok(fired.burnt === 1 && fired.muzzleTime > 0.005 && fired.muzzleTime < 0.03, `${fired.muzzleTime} s`);
  // The igniter's pressure is a starting value only.
  const low = fireGun({ ...sixInch, ignitionPressure: 1e6 }).muzzleVelocity,
    high = fireGun({ ...sixInch, ignitionPressure: 1e7 }).muzzleVelocity;
  assert.ok(Math.abs(high / low - 1) < 0.01, `${low} against ${high}`);
});

test('the gun recoils with exactly the momentum the shot and the gas carry, and every joule of the charge is accounted', () => {
  for (const recoilMass of [undefined, 7000, 700]) {
    const f = fireGun({ ...sixInch, recoilMass });
    const W = sixInch.shotMass,
      C = sixInch.charge,
      V = f.shotVelocity,
      U = V - f.muzzleVelocity;
    // At the muzzle: gun + shot + gas = 0 (a fixed gun's mounting takes the gun's share).
    const forward = W * V + (C * (U + V)) / 2;
    const gun = recoilMass === undefined ? f.recoilMomentumAtExit : -recoilMass * U;
    assert.ok(Math.abs(gun - forward) < 1e-9 * forward, `momentum ${gun} against ${forward}`);
    assert.ok(Math.abs(f.recoilMomentumAtExit - forward) < 1e-9 * forward);
    // Energy: the gas's internal energy plus the kinetic energy of the shot, gun and gas is all the charge released.
    const M = recoilMass ?? Infinity;
    const ke = 0.5 * W * V * V + (M === Infinity ? 0 : 0.5 * M * U * U) + (C / 6) * (U * U + U * V + V * V);
    const released = (PROPELLANTS.cordite.force * C) / (PROPELLANTS.cordite.gamma - 1);
    assert.ok(Math.abs(f.muzzleGasEnergy + ke - released) < 1e-9 * released, 'energy');
    // The blowdown pushes the gun back further; the history's last momentum is the total.
    assert.ok(f.afterEffect > 0 && f.recoilMomentum > f.recoilMomentumAtExit);
    assert.ok(Math.abs(f.history.at(-1) - f.recoilMomentum) < 1e-6 * f.recoilMomentum);
    for (let i = HISTORY_WORDS; i < f.history.length; i += HISTORY_WORDS)
      assert.ok(f.history[i] > f.history[i - HISTORY_WORDS], 'time increases');
  }
  const light = fireGun({ ...sixInch, recoilMass: 700 }),
    heavy = fireGun({ ...sixInch, recoilMass: 7000 });
  assert.ok(light.recoilVelocity > 5 * heavy.recoilVelocity, 'a lighter gun recoils faster');
  assert.ok(light.muzzleVelocity > heavy.muzzleVelocity, 'and the shot leaves it faster relative to it');
});

test('a gun that cannot fire is refused with the fix', () => {
  assert.throws(() => fireGun({ ...sixInch, chamber: 1e-4 }), /does not fit the chamber/);
  assert.throws(() => fireGun({ ...sixInch, propellant: PROPELLANTS.pebblePowder }), /no burning rate/);
  assert.throws(() => fireGun({ ...sixInch, propellant: { ...PROPELLANTS.cordite, gamma: 3 } }), /gamma/);
  assert.throws(() => fireGun({ ...sixInch, startPressure: 1e12 }), /never reaches the start pressure/);
  assert.throws(() => fireGun({ ...sixInch, bore: -1 }), RangeError);
  assert.throws(() => fireGun({ ...sixInch, form: 9 }), /Form coefficient/);
});
