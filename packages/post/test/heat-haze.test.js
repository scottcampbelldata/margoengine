// HeatHaze (@margoengine/post/heat-haze), the CPU half: the refractivity of air against Gladstone-Dale and the ideal gas,
// McCaffrey's plume temperatures (about 850 K in the flame, continuous, falling as z^(-5/3) above it), the march's bend
// against an independent fine quadrature of the Gaussian plume's gradient, the 1 - t / tb weighing of a near background
// (Raffel 2015), the eddy noise's unit root-mean-square, and the option checks. The real-GPU half (the scene behind a
// flame ripples, a surface in front of it does not, both backends) is heat-haze-browser.mjs (KB-FLAME-HEATHAZE1).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLADSTONE_DALE_AIR,
  HeatHaze,
  airRefractivity,
  heatHazeNoise,
  plumeBend,
  plumeExcess,
} from '../dist/heat-haze.js';

const near = (got, want, rel, label) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${label}: ${got} against ${want} (within ${rel * 100}%)`);

test('air refractivity: Gladstone-Dale K rho with the ideal gas, 2.72e-4 at 20 C, falling as 1 / T', () => {
  assert.equal(GLADSTONE_DALE_AIR, 2.26e-4);
  // Dry air at 20 C and 101.325 kPa: rho = 1.204 kg/m^3; the published refractivity for visible light is about 2.71e-4.
  near(airRefractivity(293.15), 2.72e-4, 0.01, 'n - 1 at 20 C');
  near(airRefractivity(1000) / airRefractivity(500), 0.5, 1e-12, 'twice as hot, half the refractivity');
  near(airRefractivity(293.15, 50662.5), airRefractivity(293.15) / 2, 1e-12, 'half the pressure, half the refractivity');
  assert.throws(() => airRefractivity(0), RangeError);
  assert.throws(() => airRefractivity(NaN), RangeError);
});

test("plume temperature: McCaffrey's three regions, about 850 K in the flame, continuous, z^(-5/3) in the plume", () => {
  const L = 4;
  near(plumeExcess(0.1, L), 853, 0.01, 'the continuous flame');
  near(plumeExcess(1, L), 853, 0.01, 'still the continuous flame at a quarter of the length');
  // Intermittent: 66.6 K / z* with z* = 0.235 z / L.
  near(plumeExcess(2, L), (293.15 / (2 * 9.80665) / 0.81) * 3.61 / (0.235 * 2 / L), 1e-9, 'the intermittent flame');
  near(plumeExcess(12, L) / plumeExcess(6, L), 2 ** (-5 / 3), 1e-9, 'the plume falls as z^(-5/3)');
  for (let h = 0.01; h < 4 * L; h += 0.01)
    assert.ok(Math.abs(plumeExcess(h + 0.01, L) / plumeExcess(h, L) - 1) < 0.01, `no jump at ${h.toFixed(2)} m`);
  assert.equal(plumeExcess(1, 0), 0, 'no flame, no plume');
});

test('the bend of a ray past a plume matches a fine quadrature of the Gaussian plume, and points away from the hot axis', () => {
  const L = 4,
    plume = { position: [0, 0, 0], length: L, footprint: [0, 0] },
    T0 = 293.15,
    na = airRefractivity(T0);
  for (const h of [3, 6, 9]) {
    // The plume as Heskestad and McCaffrey give it at this height (the source diameter floors at 0.05 m), below the
    // fade over the top fifth of the box (from 2.4 L).
    const D = 0.05,
      z0 = (0.083 * (L + 1.02 * D)) / 0.235 - 1.02 * D,
      dT = plumeExcess(h, L, T0),
      b = 0.12 * Math.sqrt(1 + dT / T0) * (h - z0),
      dn = (r) => {
        const rise = dT * Math.exp(-(r * r) / (b * b));
        return (-na * rise) / (T0 + rise);
      };
    for (const d of [0.3 * b, 0.7 * b, 1.2 * b]) {
      // The exact bend across the ray: the integral along x of d(dn)/dz, by central differences and 20,000 steps.
      let want = 0;
      const step = 0.001,
        e = 1e-5;
      for (let x = -10; x < 10; x += step) want += ((dn(Math.hypot(x, d + e)) - dn(Math.hypot(x, d - e))) / (2 * e)) * step;
      const got = plumeBend(plume, [-60, h, d], [1, 0, 0], { ambient: T0 });
      near(got[2], want, 0.03, `bend at ${h} m, ${(d / b).toFixed(1)} b off the axis`);
      assert.ok(got[2] > 0, 'the ray turns away from the hot (less refractive) axis');
      assert.ok(Math.abs(got[0]) < 1e-12, 'no bend along the ray');
    }
  }
  const across = plumeBend(plume, [-60, 6, 0], [1, 0, 0]);
  assert.ok(Math.abs(across[2]) < 1e-9, 'a ray through the axis is not turned sideways');
  // A 4 m flame bends light by about 1e-4 rad: under a pixel at 60 degrees, a pixel or two at a telephoto's 5 degrees.
  const peak = Math.max(...[0.2, 0.4, 0.6, 0.8].map((d) => plumeBend(plume, [-60, 2, d], [1, 0, 0])[2]));
  assert.ok(peak > 3e-5 && peak < 2e-3, `the bend of real hot air: ${peak} rad`);
});

test('a background near the plume is shifted less (1 - t / tb), one in front of it not at all', () => {
  const plume = { position: [0, 0, 0], length: 4, footprint: [2, 2] },
    far = plumeBend(plume, [-60, 3, 1.4], [1, 0, 0]),
    half = plumeBend(plume, [-60, 3, 1.4], [1, 0, 0], { background: 120 }),
    front = plumeBend(plume, [-60, 3, 1.4], [1, 0, 0], { background: 40 });
  assert.ok(Math.abs(far[2]) > 1e-6, 'the plume bends this ray');
  near(half[2], far[2] * 0.5, 0.05, 'a background twice as far as the plume shifts half as much');
  assert.deepEqual(front, [0, 0, 0], 'a surface in front of the plume is not shifted');
  // A lean carries the plume downwind: the same ray past the leaning plume's top sees it moved.
  const leaning = plumeBend({ ...plume, lean: [0, 0.5] }, [-60, 8, 1.4], [1, 0, 0]),
    upright = plumeBend(plume, [-60, 8, 1.4], [1, 0, 0]);
  assert.ok(Math.abs(leaning[2] - upright[2]) > 0.1 * Math.abs(upright[2]), 'the lean moves the plume');
});

test('the eddy noise has zero mean and unit root-mean-square', () => {
  let s = 0,
    s2 = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) {
    const v = heatHazeNoise(Math.sin(i * 12.9898) * 437.5, Math.sin(i * 78.233) * 437.5, Math.sin(i * 39.425) * 437.5);
    s += v;
    s2 += v * v;
  }
  assert.ok(Math.abs(s / n) < 0.02, `mean ${s / n}`);
  near(Math.sqrt(s2 / n), 1, 0.03, 'root-mean-square');
});

test('HeatHaze options: ranges, kinds, and a stack is needed to set up', () => {
  assert.doesNotThrow(() => new HeatHaze());
  assert.doesNotThrow(() => new HeatHaze({ sources: () => [], strength: 100, turbulence: 0, ambient: 200, steps: 4 }));
  for (const bad of [{ strength: -1 }, { strength: 101 }, { turbulence: 1.5 }, { ambient: 100 }, { steps: 3 }, { steps: 8.5 }])
    assert.throws(() => new HeatHaze(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new HeatHaze({ sources: 4 }), TypeError);
  assert.throws(() => new HeatHaze({ enabled: 'yes' }), TypeError);
  assert.throws(() => new HeatHaze().setup({ gpu: {} }), /PostStack/);
});
