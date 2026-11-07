// @margoengine/sky/presets: Earth and Mars for the Hillaire entries, each value traced to its source, and the sun's
// light through Mars's air on the CPU. The Martian sky's colour is proved on a real GPU by features-check.mjs presets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EARTH, MARS, marsAtmosphere } from '@margoengine/sky/presets';
import { HillaireSky, EARTH_ATMOSPHERE } from '@margoengine/sky/hillaire';
import { atmosphereParameters } from '@margoengine/sky/hillaire';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const close = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance * Math.abs(b), `${label}: ${a} against ${b}`);

test('Earth is the Hillaire default, sun included', () => {
  assert.equal(EARTH.atmosphere, EARTH_ATMOSPHERE);
  assert.equal(EARTH.sunIlluminance, 20);
  assert.ok(Object.isFrozen(EARTH) && Object.isFrozen(MARS));
});

test('Mars takes its size, air and light from the Mars Fact Sheet and Sneep and Ubachs 2005', () => {
  const a = MARS.atmosphere;
  assert.equal(a.bottomRadius, 3389.5);
  assert.equal(a.topRadius - a.bottomRadius, 100, 'nine scale heights of air');
  assert.equal(a.rayleighHeight, 11);
  // 636 Pa at 214 K: 2.153e23 molecules per cubic metre.
  const n = 636 / (1.380649e-23 * 214);
  close(n, 2.153e23, 1e-3, 'number density');
  // CO2's 12.4e-27 cm^2 at 532 nm, as 1 / lambda^4: per km at 680, 550 and 440 nm.
  for (const [c, l] of [680, 550, 440].entries()) close(a.rayleigh[c], 12.4e-31 * (532 / l) ** 4 * n * 1000, 1e-12, `rayleigh ${l}`);
  close(a.rayleigh[1], 2.336e-4, 1e-3, 'green Rayleigh per km');
  // About 58 times thinner than Earth's air at 550 nm: 1.6% of the pressure, twice the cross section per molecule.
  close(EARTH_ATMOSPHERE.rayleigh[1] / a.rayleigh[1], 58.0, 0.01, 'Earth over Mars');
  // The vertical Rayleigh optical depth at 550 nm is 0.0026: the blue of a clear Earth sky is nearly absent.
  close(a.rayleigh[1] * 11 * (1 - Math.exp(-100 / 11)), 0.00257, 0.01, 'Rayleigh optical depth');
  assert.deepEqual(a.ozone, [0, 0, 0]);
  assert.deepEqual(a.groundAlbedo, [0.25, 0.25, 0.25], 'the Bond albedo');
  close(MARS.sunIlluminance, 20 * (586.2 / 1361.0), 1e-3, 'sunlight at 1.52 AU');
});

test('Martian dust: the optical depth given, red scattered more than blue, forward scattering 0.67', () => {
  for (const tau of [0, 0.5, 2, 10]) {
    const a = marsAtmosphere(tau);
    for (let c = 0; c < 3; c++)
      if (tau) close((a.mie[c] + a.mieAbsorption[c]) * a.mieHeight, tau, 1e-12, `tau ${tau} column ${c}`);
      else assert.equal(a.mie[c] + a.mieAbsorption[c], 0);
    if (tau)
      assert.deepEqual(
        [0, 1, 2].map((c) => Math.round((a.mie[c] / (a.mie[c] + a.mieAbsorption[c])) * 1000) / 1000),
        [0.975, 0.94, 0.9],
        'single scattering albedo, red to blue',
      );
    assert.equal(a.mieG, 0.67);
  }
  assert.deepEqual(MARS.atmosphere, marsAtmosphere(0.5));
  for (const bad of [-0.1, 10.5, Number.NaN, '1'])
    assert.throws(() => marsAtmosphere(bad), /Invalid Mars dust optical depth; use a number from 0 to 10/);
});

test('any atmosphere may give Mie scattering and absorption per channel', () => {
  const a = atmosphereParameters({ mie: [0.01, 0.02, 0.03], mieAbsorption: 0.001 });
  assert.deepEqual(a.mie, [0.01, 0.02, 0.03]);
  for (const bad of [{ mie: [0.1, -0.1, 0] }, { mieAbsorption: [0.1, 0.1] }, { mie: [0.1, Number.NaN, 0] }, { mie: -1 }])
    assert.throws(() => atmosphereParameters(bad), /mie/, JSON.stringify(bad));
});

test('the sun through Mars overhead: dust takes the same share of each channel and dims a low sun almost alike', () => {
  const h = tracedGPU();
  const sky = new HillaireSky({ ...MARS, sunDirection: [0, 1, 0] });
  h.engine.use(sky);
  h.frame();
  const a = MARS.atmosphere;
  for (let c = 0; c < 3; c++) {
    const depth = a.rayleigh[c] * 11 * (1 - Math.exp(-100 / 11)) + 0.5 * (1 - Math.exp(-100 / 11));
    close(sky.sunTransmittance[c], Math.exp(-depth), 1e-4, `channel ${c}`);
  }
  sky.options.sunDirection = [Math.cos((5 * Math.PI) / 180), Math.sin((5 * Math.PI) / 180), 0];
  h.frame();
  const [r, g, b] = sky.sunTransmittance;
  // Grey dust extinction: the low sun dims nearly alike in every channel, a little more in blue by the CO2.
  assert.ok(r > b && b > 0.8 * r && r < 0.05, `sunset ${[r, g, b]}`);
  sky.dispose();
});
