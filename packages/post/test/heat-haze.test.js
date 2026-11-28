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
  inferiorMirageAngle,
  mirageRay,
  plumeBend,
  plumeExcess,
} from '../dist/heat-haze.js';
import { harness } from './support.js';

const near = (got, want, rel, label) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${label}: ${got} against ${want} (within ${rel * 100}%)`);

test('air refractivity: Gladstone-Dale K rho with the ideal gas, 2.72e-4 at 20 C, falling as 1 / T', () => {
  assert.equal(GLADSTONE_DALE_AIR, 2.26e-4);
  // Dry air at 20 C and 101.325 kPa: rho = 1.204 kg/m^3; the published refractivity for visible light is about 2.71e-4.
  near(airRefractivity(293.15), 2.72e-4, 0.01, 'n - 1 at 20 C');
  near(airRefractivity(1000) / airRefractivity(500), 0.5, 1e-12, 'twice as hot, half the refractivity');
  near(
    airRefractivity(293.15, 50662.5),
    airRefractivity(293.15) / 2,
    1e-12,
    'half the pressure, half the refractivity',
  );
  assert.throws(() => airRefractivity(0), RangeError);
  assert.throws(() => airRefractivity(NaN), RangeError);
});

test("plume temperature: McCaffrey's three regions, about 850 K in the flame, continuous, z^(-5/3) in the plume", () => {
  const L = 4;
  near(plumeExcess(0.1, L), 853, 0.01, 'the continuous flame');
  near(plumeExcess(1, L), 853, 0.01, 'still the continuous flame at a quarter of the length');
  // Intermittent: 66.6 K / z* with z* = 0.235 z / L.
  near(plumeExcess(2, L), ((293.15 / (2 * 9.80665) / 0.81) * 3.61) / ((0.235 * 2) / L), 1e-9, 'the intermittent flame');
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
      for (let x = -10; x < 10; x += step)
        want += ((dn(Math.hypot(x, d + e)) - dn(Math.hypot(x, d - e))) / (2 * e)) * step;
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
  for (const bad of [
    { strength: -1 },
    { strength: 101 },
    { turbulence: 1.5 },
    { ambient: 100 },
    { steps: 3 },
    { steps: 8.5 },
  ])
    assert.throws(() => new HeatHaze(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new HeatHaze({ sources: 4 }), TypeError);
  assert.throws(() => new HeatHaze({ enabled: 'yes' }), TypeError);
  assert.throws(() => new HeatHaze().setup({ gpu: {} }), /PostStack/);
});

test('a cell-centred temperature field uploads air refractivity and releases its resources on disable', async () => {
  const h = harness();
  h.gpu.device.limits.maxTextureDimension3D = 16;
  const ambient = 293.15;
  const kelvin = new Float64Array([ambient, 2 * ambient, ambient / 2, ambient]);
  let reads = 0;
  const uploads = [];
  const write = h.gpu.device.queue.writeTexture;
  h.gpu.device.queue.writeTexture = (destination, data, layout, size) => {
    if (destination.texture.dimension === '3d') uploads.push({ values: Array.from(data), layout, size });
    write(destination, data, layout, size);
  };
  const haze = HeatHaze.attach(h.engine, {
    temperatureVolume: () => {
      reads++;
      return { origin: [-0.5, 0, 0], dimensions: [2, 2, 1], cellSize: [0.5, 0.25, 1], kelvin };
    },
  });
  try {
    h.frame();
    const refractivity = airRefractivity(ambient);
    assert.equal(reads, 1);
    assert.deepEqual(uploads, [
      {
        values: [0, Math.fround(-refractivity / 2), Math.fround(refractivity), 0],
        layout: { bytesPerRow: 8, rowsPerImage: 2 },
        size: [2, 2, 1],
      },
    ]);
    assert.equal(h.live().filter((resource) => resource.dimension === '3d').length, 1);
    haze.options.enabled = false;
    h.frame();
    await Promise.resolve();
    assert.equal(reads, 1, 'disabled haze does not sample or upload the field');
    assert.equal(h.live().filter((resource) => resource.dimension === '3d').length, 0);
  } finally {
    haze.dispose();
  }
});

test('temperature volumes reject invalid grids before creating a 3D texture', () => {
  const h = harness();
  h.gpu.device.limits.maxTextureDimension3D = 3;
  const grid = { origin: [0, 0, 0], dimensions: [1, 1, 1], cellSize: [1, 1, 1], kelvin: [293.15] };
  const haze = HeatHaze.attach(h.engine);
  try {
    for (const bad of [
      { dimensions: [4, 1, 1] },
      { origin: [2 ** 30, 0, 0] },
      { cellSize: [0, 1, 1] },
      { kelvin: [0] },
      { kelvin: [NaN] },
      { kelvin: [] },
    ]) {
      haze.options.temperatureVolume = { ...grid, ...bad };
      assert.throws(() => h.frame(), RangeError);
      assert.equal(h.live().filter((resource) => resource.dimension === '3d').length, 0);
    }
  } finally {
    haze.dispose();
  }
});

test('temperature volume textures release on resize and are rebuilt after device restoration', async () => {
  const h = harness();
  h.gpu.device.limits.maxTextureDimension3D = 16;
  const first = { origin: [0, 0, 0], dimensions: [1, 1, 1], cellSize: [0.5, 1, 1], kelvin: [800] };
  const haze = HeatHaze.attach(h.engine, { temperatureVolume: first });
  try {
    h.frame();
    const texture = h.live().find((resource) => resource.dimension === '3d');
    assert.ok(texture);
    haze.options.temperatureVolume = { ...first, dimensions: [2, 1, 1], kelvin: [800, 900] };
    h.frame();
    await Promise.resolve();
    assert.ok(texture.destroyed, 'the previous shape retires its 3D texture');
    const resized = h.live().find((resource) => resource.dimension === '3d');
    assert.ok(resized);
    const restored = h.lose();
    restored.device.limits.maxTextureDimension3D = 16;
    await Promise.resolve();
    assert.ok(resized.destroyed, 'a device loss releases its own volume');
    const frames = restored.record(() => h.frame());
    assert.ok(
      frames.some((entry) => entry[0] === 'texture' && entry[2]?.dimension === '3d'),
      'the restored device allocates its own volume',
    );
    assert.ok(
      frames.some((entry) => entry[0] === 'writeTexture'),
      'the restored device receives the current field',
    );
  } finally {
    haze.dispose();
  }
});

test('hot ground: the mirage edge is acos(n_hot / n_air) (Hagen et al. 2026: 0.17 degree for 5 K) and grows as the root of the excess', () => {
  const deg = (r) => (r * 180) / Math.PI,
    T0 = 303.15,
    na = 1 + airRefractivity(T0),
    nh = 1 + airRefractivity(T0 + 5);
  near(inferiorMirageAngle(5, { ambient: T0 }), Math.acos(nh / na), 1e-4, 'far eye against Hagen equation 13');
  near(deg(inferiorMirageAngle(5, { ambient: T0, eye: 0.1 })), 0.167, 0.01, 'Hagen et al. 10 cm lens, 5 K');
  near(inferiorMirageAngle(20, { ambient: T0 }) / inferiorMirageAngle(5, { ambient: T0 }), 2, 0.03, 'four times the excess');
  assert.equal(inferiorMirageAngle(0), 0);
  near(inferiorMirageAngle(5, { strength: 2 }) / inferiorMirageAngle(5), Math.SQRT2, 1e-5, 'strength scales the change of n (under the arctangent)');
  assert.throws(() => inferiorMirageAngle(61), RangeError);
});

test('hot ground: the closed-form ray lands or turns as an exact Snell integration of the layer does', () => {
  const T0 = 303.15,
    ground = { excess: 5, depth: 0.02 },
    eye = 1.1,
    na = 1 + airRefractivity(T0),
    nh = 1 + airRefractivity(T0 + 5),
    n = (y) => na - (na - nh) * Math.exp(-y / 0.02);
  // The exact ray keeps n cos(theta); walk it down in 10 micrometre steps.
  const exact = (slope) => {
    const K = n(eye) * Math.cos(Math.atan(slope));
    let y = eye,
      x = 0;
    while (y > 0) {
      const c = K / n(y - 5e-6);
      if (c >= 1) return { lands: false, range: x };
      x += 1e-5 / (Math.sqrt(1 - c * c) / c);
      y -= 1e-5;
    }
    return { lands: true, range: x };
  };
  const edge = inferiorMirageAngle(5, { ambient: T0, eye });
  for (const f of [0.5, 0.9, 1.01, 1.1, 2, 5]) {
    const slope = Math.tan(f * edge),
      got = mirageRay(ground, eye, slope, { ambient: T0 }),
      want = exact(slope);
    assert.equal(got.lands, want.lands, `${f} x the edge lands as the exact ray does`);
    near(got.range, want.range, 0.003, `range at ${f} x the edge`);
  }
  // No excess is the straight ray.
  near(mirageRay({ excess: 0 }, 1.5, 0.01).range, 150, 1e-6, 'no excess, straight');
  assert.throws(() => mirageRay({ excess: 5, depth: 0 }, 1, 0.01), RangeError);
});

test('hot ground options are checked when set and every frame', () => {
  assert.throws(() => new HeatHaze({ ground: { excess: 70 } }), RangeError);
  assert.throws(() => new HeatHaze({ ground: { excess: 5, depth: 3 } }), RangeError);
  assert.throws(() => new HeatHaze({ ground: { excess: 5, wind: [Infinity, 0] } }), RangeError);
  assert.doesNotThrow(() => new HeatHaze({ ground: { excess: 18, depth: 0.03, height: 0.03 } }));
  assert.doesNotThrow(() => new HeatHaze({ ground: () => undefined }));
});
