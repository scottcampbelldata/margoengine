import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';

test('Water.sample and sampleHeight evaluate analytical Gerstner swell synchronously with exact derivatives', () => {
  const water = new Water({
    size: [100, 100],
    segments: 128,
    height: 1.25,
    waves: [{ direction: [1, 0.25], amplitude: 0.4, wavelength: 24, steepness: 0.4, phase: 0.5 }],
  });
  water.setTime(3.5);
  const s = water.sample(4.2, -7.1);
  assert.equal(s.time, 3.5);
  assert.equal(s.height, water.sampleHeight(4.2, -7.1));
  assert.ok(Number.isFinite(s.height) && Math.abs(s.height - 1.25) <= 0.45);
  // Normal must be unit-length and match finite-difference surface slope at world (x, z).
  const nLen = Math.hypot(...s.normal);
  assert.ok(Math.abs(nLen - 1) < 1e-6 && s.normal[1] > 0.5);
  const eps = 1e-4;
  const dhdx = (water.sampleHeight(4.2 + eps, -7.1) - water.sampleHeight(4.2 - eps, -7.1)) / (2 * eps);
  const dhdz = (water.sampleHeight(4.2, -7.1 + eps) - water.sampleHeight(4.2, -7.1 - eps)) / (2 * eps);
  const fdLen = Math.hypot(-dhdx, 1, -dhdz);
  const fdNormal = [-dhdx / fdLen, 1 / fdLen, -dhdz / fdLen];
  for (let k = 0; k < 3; k++) {
    assert.ok(
      Math.abs(s.normal[k] - fdNormal[k]) < 1e-4,
      `normal[${k}] mismatch: analytical ${s.normal[k]} vs fd ${fdNormal[k]}`,
    );
  }
  // Explicit time override does not mutate water.time.
  const later = water.sample(4.2, -7.1, 4.0);
  assert.equal(later.time, 4.0);
  assert.equal(water.time, 3.5);
  assert.notEqual(later.height, s.height);

  // Sea level and wave height changes reflect immediately.
  water.setSeaLevel(5);
  assert.ok(Math.abs(water.sampleHeight(4.2, -7.1) - (s.height + 3.75)) < 1e-5);
  water.setWaveHeight(0);
  const flat = water.sample(4.2, -7.1);
  assert.equal(flat.height, 5);
  assert.deepEqual(flat.normal, [0, 1, 0]);
  assert.deepEqual(flat.velocity, [0, 0, 0]);

  // Validation and disposal.
  assert.throws(() => water.sample(NaN, 0), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => water.sample(0, 0, -1), { name: 'MargoError', code: 'unsupported' });
  water.dispose();
  assert.throws(() => water.sample(0, 0), { code: 'disposed' });
});

test('Water.sample supports wind sea, setWind, far-field profile, and WaterSea linear waves', () => {
  // Wind sea + setWind
  const windWater = new Water({ size: [200, 200], segments: 128, wind: 0 });
  assert.equal(windWater.sampleHeight(0, 0, 2), 0);
  windWater.setWind({ speed: 14, direction: [0, 1] });
  let maxAbs = 0;
  for (let i = 0; i < 20; i++) maxAbs = Math.max(maxAbs, Math.abs(windWater.sampleHeight(i * 3, i * 2, 1.5)));
  assert.ok(maxAbs > 0.05, 'wind sea produces nonzero waves');
  windWater.dispose();

  // Far-field incoming tsunami/surge profile outside terrain
  const farWater = new Water({
    size: [200, 200],
    segments: 64,
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
    terrain: { heightmap: () => undefined, origin: [0, 0], size: [100, 100] },
  });
  farWater.setFarField({ sides: { west: true }, profile: [0, 1, 2], range: 100 });
  assert.ok(Math.abs(farWater.sampleHeight(-50, 50) - 1) < 1e-6, '50 m west of origin sits at +1 m');
  assert.ok(Math.abs(farWater.sampleHeight(-100, 50) - 2) < 1e-6, '100 m west sits at +2 m');
  const slopeSample = farWater.sample(-50, 50);
  assert.ok(slopeSample.normal[0] > 0.01 && slopeSample.normal[1] > 0.99, 'far-field slope tilts normal east');
  farWater.dispose();

  // Linear WaterSea (SpectralSea interface)
  const k = (2 * Math.PI) / 40,
    omega = Math.sqrt(9.81 * k),
    amp = 0.75;
  const mockSea = {
    waveComponents(t, out) {
      out.set([k, 0, amp, -omega * t], 0);
      return 1;
    },
  };
  const seaWater = new Water({ size: [100, 100], segments: 128, sea: mockSea });
  const t = 2.0,
    x = 5.0;
  const ss = seaWater.sample(x, 0, t);
  const expectedY = amp * Math.cos(k * x - omega * t);
  const expectedVy = amp * omega * Math.sin(k * x - omega * t);
  assert.ok(Math.abs(ss.height - expectedY) < 1e-5, `sea height ${ss.height} vs ${expectedY}`);
  assert.ok(Math.abs(ss.velocity[1] - expectedVy) < 1e-3, `sea vy ${ss.velocity[1]} vs ${expectedVy}`);
  seaWater.dispose();
});
