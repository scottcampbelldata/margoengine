import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const artifacts = new URL('../../../test-results/sea04-measured/', import.meta.url);
const file = (name) => new URL(`sea04-measured-rabaud-${name}.json`, artifacts);
const read = (name) => readFileSync(file(name));
const json = (name) => JSON.parse(read(name));
const write = (name, data) => writeFileSync(file(name), JSON.stringify(data, null, 2) + '\n');
const digest = (a) => createHash('sha256').update(a).digest('hex');
const plan = json('plan');
const planSha = digest(read('plan'));

function mixedLength(wanted, even) {
  let n = Math.max(4, Math.ceil(wanted));
  for (; n <= 4096; n++) {
    let value = n;
    for (const factor of [2, 3, 5]) while (value % factor === 0) value /= factor;
    if (value === 1 && (!even || n % 2 === 0)) return n;
  }
  throw new Error('Requested physically resolved plan exceeds the supported FFT size.');
}

function predict(test) {
  const L = plan.hull_length_m;
  const U = test.froude * Math.sqrt(plan.gravity * L);
  const lambda = (2 * Math.PI * U ** 2) / plan.gravity;
  const dx = Math.min(L * plan.coarse_max_grid_over_hull_length, lambda / plan.coarse_min_cells_per_transverse_wavelength);
  const nx = mixedLength((plan.relative_x_extent * lambda) / dx, true);
  const nz = mixedLength((plan.relative_z_extent * lambda) / dx, false);
  const sponge = Math.ceil((plan.sponge_width_over_wavelength * lambda) / dx);
  const rate = plan.grid_step_rate_hz;
  const ticks = Math.round((rate * plan.forcing_travel_over_wavelength * lambda) / U);
  const zStart = -(plan.forcing_travel_over_wavelength * lambda) / 2;
  const density = 1025;
  const peakPressure = density * plan.gravity * L * plan.source_pressure_head_over_length;
  const radius = plan.source_radius_over_hull_length * L;
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -plan.gravity, 0], memory: worldMemory(false) });
  const wake = new WakeSolver();
  let lastZ = zStart;
  let sourceTime = 0;
  world.add(wake, {
    cells: [nx, nz],
    cellSize: dx,
    depth: Infinity,
    density,
    sponge,
    sources(t) {
      sourceTime = t;
      lastZ = zStart + U * t;
      const ramp = Math.min(1, U * t / (lambda * plan.source_ramp_over_wavelength));
      return [{ x: 0, z: lastZ, radius, pressure: (peakPressure / 2) * (1 - Math.cos(Math.PI * ramp)), volume: 0 }];
    },
  });
  console.log('advance', test.plot_marker, test.froude, 'grid', nx, nz, 'ticks', ticks);
  world.advance(ticks);
  assert.ok(Math.abs(lastZ + zStart) < (2 * U) / rate);
  const [angleFirst, angleLast, dAngle] = plan.probe_angles_deg;
  const query = { height: 0, slope: [0, 0], velocity: [0, 0, 0] };
  const windows = plan.distance_centres_over_wavelength.map((distance) => {
    const r0 = distance - plan.radial_window_radius_over_wavelength;
    const r1 = distance + plan.radial_window_radius_over_wavelength;
    const angularCrest_m = [];
    let best = { angle_deg: NaN, crest_m: -Infinity };
    for (let a = angleFirst; a <= angleLast; a += dAngle) {
      const theta = (a * Math.PI) / 180;
      let plus = -Infinity;
      let minus = -Infinity;
      for (let k = 0; k < plan.radial_samples; k++) {
        const r = lambda * (r0 + ((r1 - r0) * k) / (plan.radial_samples - 1));
        const x = r * Math.sin(theta);
        const z = lastZ - r * Math.cos(theta);
        assert.ok(x < (dx * nx) / 2 - sponge * dx && Math.abs(z) < (dx * nz) / 2 - sponge * dx);
        plus = Math.max(plus, wake.sample(x, z, query).height);
        minus = Math.max(minus, wake.sample(-x, z, query).height);
      }
      const crest_m = (plus + minus) / 2;
      angularCrest_m.push(crest_m);
      if (crest_m > best.crest_m) best = { angle_deg: a, crest_m };
    }
    assert.ok(best.crest_m > 0 && Number.isFinite(best.angle_deg));
    return { distance_over_lambda: distance, ...best, angularCrest_m };
  });
  const [min,median,max] = windows.map((entry) => entry.angle_deg).sort((a,b) => a-b);
  return {
    ...test, speed_mps: U, transverse_wavelength_m: lambda, dx, cells: [nx,nz],
    sourceTime, ticks, sourceZ: lastZ, radius, sponge, windows,
    predicted_angle_deg: median, radial_window_angles_deg: [min,max],
  };
}

if (process.argv[2] === 'predict') {
  const bundleHashes = () => Object.fromEntries(['sea.js','world.js'].map((asset) => [
    asset, digest(readFileSync(new URL(`../dist/${asset}`, import.meta.url))),
  ]));
  const bundles = bundleHashes();
  const predicted = plan.cases.map(predict);
  assert.deepEqual(bundleHashes(), bundles, 'The built solver changed during the comparison.');
  write('predicted', { plan_sha256: planSha, bundles, predictions: predicted });
  write('freeze', { plan_sha256: planSha, predicted_sha256: digest(read('predicted')) });
  for (const data of predicted) console.log('predicted medians', data.froude, data.predicted_angle_deg, data.radial_window_angles_deg);
} else if (process.argv[2] === 'score') {
  const freeze = json('freeze');
  assert.equal(freeze.plan_sha256, planSha);
  assert.equal(freeze.predicted_sha256, digest(read('predicted')));
  const markers = json('markers');
  const score = json('predicted').predictions.map((data) => {
    const holdout = markers.measured_markers.find((marker) => marker.plot_marker === data.plot_marker);
    assert.equal(holdout.froude, data.froude);
    const measurement = holdout.half_angle_deg;
    return { ...data, digitized_measured_angle_deg: measurement,
      observed_angle_uncertainty_deg: markers.published_angle_uncertainty_deg,
      signed_angle_error_deg: data.predicted_angle_deg - measurement };
  });
  write('score', { source_digitization_sha256: digest(read('markers')), freeze_sha256: digest(read('freeze')), score });
  for (const data of score) {
    console.log('holdout', data.froude, 'measured', data.digitized_measured_angle_deg, 'prediction',
      data.predicted_angle_deg, 'radial range', data.radial_window_angles_deg, 'signed error', data.signed_angle_error_deg);
  }
} else {
  throw new Error('Use predict or score on the fixed Rabaud–Moisy plan.');
}
