// Blast loading (FIRE-04): Kinney and Graham's free-air laws with a Friedlander wave, checked against their own limits and,
// independently, against Ford et al.'s field-measured airborne impulse of surface bursts through the image factor.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  airborneFraction,
  blastAt,
  energyBudget,
  freeAirEquivalent,
  friedlanderDecay,
  impulseSoFar,
  overpressureAt,
  projectedArea,
  reflectedOverpressure,
  scaledOverpressure,
} from '../dist/explosive.js';

const coded = (error) => error?.code === 'unsupported' && error.message.includes('margoengine.com/errors#explosives');

test("a surface burst's impulse, as a free-air blast of its image-doubled air energy, meets Ford et al.'s field-measured law", () => {
  // Ford et al. 2014 through Sonder et al. 2022, eq 9 and Table 6: the airborne impulse of a charge at the surface is
  // pa E^(2/3) b1 g(0) / r, b1 = 1.15e-7 s m J^-2/3, g(0) = 2^(-1/10), measured in the field. Nothing here is fitted to it.
  const pa = 101325;
  for (const energy of [1e5, 1e7, 1e9]) {
    const free = freeAirEquivalent(energyBudget(energy, 0));
    for (const scaled of [0.05, 0.1, 0.3, 1, 3]) {
      const r = scaled * Math.cbrt(energy);
      const ford = (pa * Math.cbrt(energy) ** 2 * 1.15e-7 * 2 ** -0.1) / r;
      const ratio = blastAt(free, r).impulse / ford;
      // Within 15 %: the two laws come from different charges and sites (Sonder et al. note their constants differ).
      assert.ok(Math.abs(ratio - 1) < 0.15, `${energy} J at ${scaled} m J^-1/3: ${ratio}`);
    }
  }
  close(airborneFraction(0), 2 ** -0.15, 'the surface air share');
});

function close(actual, expected, what, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected), `${what}: ${actual} against ${expected}`);
}

test('the Friedlander wave carries exactly the impulse of the law, starting at the peak and ending at the duration', () => {
  for (const r of [3, 10, 50, 300]) {
    const b = blastAt(4.184e6 * 10, r);
    close(impulseSoFar(b, b.duration), b.impulse, `impulse at ${r} m`, 1e-9);
    close(impulseSoFar(b, 10 * b.duration), b.impulse, `after the positive phase at ${r} m`, 1e-9);
    close(overpressureAt(b, 0), b.overpressure, 'peak');
    assert.equal(overpressureAt(b, b.duration * 1.01), 0);
    assert.equal(impulseSoFar(b, -1), 0);
    // The reflected wave has the same shape, scaled by the reflected peak.
    close(impulseSoFar(b, b.duration, true) / b.impulse, b.reflected / b.overpressure, 'reflected impulse', 1e-9);
  }
  for (const k of [0.05, 0.2, 0.45, 0.5, 0.7]) {
    const a = friedlanderDecay(k);
    const f = Math.abs(a) < 1e-3 ? 0.5 - a / 6 + (a * a) / 24 - (a * a * a) / 120 : (a - 1 + Math.exp(-a)) / (a * a);
    close(f, k, `decay for ${k}`, 1e-9);
  }
});

test('the Rankine-Hugoniot reflection doubles a weak shock and tends to eight times a strong one; the shock slows to sound', () => {
  close(reflectedOverpressure(1) / 1, 2, 'weak', 1e-4);
  assert.ok(Math.abs(reflectedOverpressure(1e12) / 1e12 - 8) < 1e-3);
  // Far out the shock runs at the speed of sound, sqrt(1.4 R T).
  const e = 4.184e6 * 100;
  const c0 = Math.sqrt(1.4 * 287.05 * 288.15);
  const t1 = blastAt(e, 2000).arrival,
    t2 = blastAt(e, 3000).arrival;
  assert.ok(Math.abs(1000 / (t2 - t1) / c0 - 1) < 0.01, `far-field speed ${1000 / (t2 - t1)}`);
  // Closer in it is supersonic, and the overpressure falls with distance.
  assert.ok(blastAt(e, 20).arrival < 20 / c0);
  for (let z = 0.5; z < 400; z *= 1.3) assert.ok(scaledOverpressure(z * 1.3) < scaledOverpressure(z));
  // Thinner, colder air: Sachs's factors lower the overpressure in proportion to the ambient pressure, near the far field.
  const high = blastAt(e, 500, { pressure: 50000, temperature: 250 }),
    sea = blastAt(e, 500);
  assert.ok(high.overpressure < sea.overpressure);
  assert.equal(projectedArea([1, 2, 3], [1, 0, 0]), 24);
  assert.throws(() => blastAt(0, 1), coded);
  assert.throws(() => blastAt(1, -1), coded);
  assert.throws(() => blastAt(1, 1, { pressure: -1 }), coded);
  assert.throws(() => friedlanderDecay(1.5), coded);
});
