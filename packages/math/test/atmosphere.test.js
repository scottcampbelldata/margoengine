// The standard atmosphere (ISO 2533:1975, ICAO Doc 7488): the published table values, its layers, and air density.
import assert from 'node:assert/strict';
import test from 'node:test';
import { airDensity, standardAtmosphere, standardDensity } from '../dist/atmosphere.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} against ${expected}`);

test('the standard atmosphere gives the ISO 2533 and ICAO Doc 7488 table values', () => {
  // [height m, temperature K, pressure Pa, density kg/m^3] from the published tables.
  for (const [z, T, P, rho] of [
    [-1000, 294.65, 113929, 1.347],
    [0, 288.15, 101325, 1.225],
    [1000, 281.65, 89874.6, 1.1117],
    [5000, 255.65, 54019.9, 0.73612],
    [11000, 216.65, 22632.1, 0.36392],
  ]) {
    const [t, p] = standardAtmosphere(z);
    near(t, T, 1e-9, `temperature at ${z} m`);
    near(p, P, 0.5, `pressure at ${z} m`);
    near(standardDensity(z), rho, 1e-4, `density at ${z} m`);
  }
  // The layers above the tropopause: isothermal to 20 km, then +1 K/km to 32 km, +2.8 K/km to 47 km.
  near(standardAtmosphere(20000)[0], 216.65, 1e-9, 'temperature at 20 km');
  near(standardAtmosphere(32000)[0], 228.65, 1e-9, 'temperature at 32 km');
  near(standardAtmosphere(47000)[0], 270.65, 1e-9, 'temperature at 47 km');
  near(standardAtmosphere(20000)[1], 5474.89, 0.5, 'pressure at 20 km');
  near(standardAtmosphere(32000)[1], 868.02, 0.5, 'pressure at 32 km');
});

test('a shifted sea-level temperature and tropopause, and the ideal-gas density', () => {
  const [T, P] = standardAtmosphere(0, 303.15);
  assert.deepEqual([T, P], [303.15, 101325]);
  near(standardAtmosphere(2000, 303.15)[0], 290.15, 1e-9, 'the lapse keeps from a warm sea level');
  near(standardAtmosphere(12000, 288.15, 12000)[0], 210.15, 1e-9, 'a higher tropopause');
  near(airDensity(288.15, 101325), 1.225, 1e-4, 'sea-level air');
  // Below sea level pressure and density keep rising: the Dead Sea shore at -430 m.
  assert.ok(standardDensity(-430) > standardDensity(0));
});
