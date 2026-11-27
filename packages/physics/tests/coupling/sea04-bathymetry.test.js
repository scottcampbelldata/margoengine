import assert from 'node:assert/strict';
import test from 'node:test';
import { FiniteQuayWake } from '../../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const gravity = 9.81;
const density = 1000;
const depths = [0, 0.04, 0.08, 0.12, 0.16];
const deep = depths.at(-1);
const shallow = depths[1];
const amplitude = 0.006;
const rate = 30;
const carrier = Math.PI / 4;

function stepBottom(nx, cellSize, origin) {
  const plane = Uint8Array.from({ length: nx }, (_, i) => Number(origin + (i + 0.5) * cellSize < 0));
  return Uint8Array.from({ length: nx * (depths.length - 1) }, (_, i) => (i < nx ? 1 : plane[i % nx]));
}

function tank(nx, cellSize, origin, step, initial, pressureAtDepth = false) {
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    cells: [nx, 1],
    cellSize,
    depths,
    origin: [origin, 0],
    density,
    wet: step ? stepBottom(nx, cellSize, origin) : undefined,
    initial,
    pressureAtDepth,
  });
  return { world, wake };
}

function dispersion(k, depth) {
  return Math.sqrt(gravity * k * Math.tanh(k * depth));
}

function waveNumber(omega, depth) {
  let lower = 0;
  let upper = (2 * omega) / Math.sqrt(gravity * depth);
  while (dispersion(upper, depth) < omega) upper *= 2;
  for (let i = 0; i < 42; i++) {
    const middle = (lower + upper) / 2;
    if (dispersion(middle, depth) < omega) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function incidentSpectrum() {
  const sigma = 4.6;
  const interval = 0.02;
  return Array.from({ length: 107 }, (_, i) => {
    const k = (i + 0.5) * interval;
    const omega = dispersion(k, deep);
    const weight = (sigma * interval * Math.exp(-0.5 * (sigma * (k - carrier)) ** 2)) / Math.sqrt(2 * Math.PI);
    return { k, omega, weight, kShallow: waveNumber(omega, shallow) };
  });
}

function traceCoefficients(values, modes) {
  let cc = 0;
  let cs = 0;
  let ss = 0;
  let yc = 0;
  let ys = 0;
  values.forEach((value, i) => {
    const [real, imaginary] = modes[i];
    cc += real * real;
    cs += real * imaginary;
    ss += imaginary * imaginary;
    yc += value * real;
    ys += value * imaginary;
  });
  const determinant = cc * ss - cs ** 2;
  assert.ok(determinant > 0);
  const real = (ss * yc - cs * ys) / determinant;
  const imaginary = (cc * ys - cs * yc) / determinant;
  const error = Math.sqrt(
    values.reduce((sum, value, i) => sum + (value - real * modes[i][0] - imaginary * modes[i][1]) ** 2, 0) /
      values.length,
  );
  return { real, imaginary, error };
}

test('SEA-04 reflects and transmits a live long-wave packet at a 4:1 still-water depth step', (t) => {
  // Lamb (1932), Hydrodynamics §176, derived from continuity of elevation
  // and normal volume discharge. Miles (1967), DOI 10.1017/S0022112067002423,
  // §4 discusses this long-wave limit and the phase corrections at finite kh.
  const cDeep = Math.sqrt(gravity * deep);
  const cShallow = Math.sqrt(gravity * shallow);
  const reflection = (cDeep - cShallow) / (cDeep + cShallow);
  const transmission = 1 + reflection;
  const spectrum = incidentSpectrum();
  const launch = -20;
  const incident = (x) => {
    const fade = Math.min(1, Math.max(0, -x));
    let height = 0;
    let potential = 0;
    for (const { k, omega, weight } of spectrum) {
      const phase = k * (x - launch);
      height += weight * Math.cos(phase);
      potential += (weight * gravity * Math.sin(phase)) / omega;
    }
    return [amplitude * fade * height, amplitude * fade * potential];
  };

  const cellSize = 0.125;
  const stepped = tank(576, cellSize, -48, true, incident);
  const uniform = tank(576, cellSize, -48, false, incident);
  const gauges = [-5, 2.5];
  const energy = stepped.wake.energy();
  const initialVolume = stepped.wake.heights().reduce((sum, value) => sum + value, 0) * cellSize ** 2;
  const times = Array.from({ length: 94 }, (_, i) => (440 + 4 * i) / rate);
  const readings = times.map((time) => {
    stepped.world.advance(Math.round(time * rate));
    uniform.world.advance(Math.round(time * rate));
    return [
      (stepped.wake.elevation(gauges[0], cellSize / 2) - uniform.wake.elevation(gauges[0], cellSize / 2)) / amplitude,
      stepped.wake.elevation(gauges[1], cellSize / 2) / amplitude,
      uniform.wake.elevation(gauges[1], cellSize / 2) / amplitude,
    ];
  });
  const expected = (spatialPhase) =>
    times.map((time) => {
      let real = 0;
      let imaginary = 0;
      for (const mode of spectrum) {
        const phase = spatialPhase(mode) - mode.k * launch - mode.omega * time;
        real += mode.weight * Math.cos(phase);
        imaginary -= mode.weight * Math.sin(phase);
      }
      return [real, imaginary];
    });
  const r = traceCoefficients(
    readings.map((row) => row[0]),
    expected(({ k }) => -k * gauges[0]),
  );
  const tr = traceCoefficients(
    readings.map((row) => row[1]),
    expected(({ kShallow }) => kShallow * gauges[1]),
  );
  const flat = traceCoefficients(
    readings.map((row) => row[2]),
    expected(({ k }) => k * gauges[1]),
  );
  const reflected = Math.hypot(r.real, r.imaginary);
  const transmitted = Math.hypot(tr.real, tr.imaginary);
  const reflectedPhase = Math.atan2(r.imaginary, r.real);
  const transmittedPhase = Math.atan2(tr.imaginary, tr.real);
  const outgoingFlux = reflected ** 2 + (cShallow / cDeep) * transmitted ** 2;
  const volume = stepped.wake.heights().reduce((sum, value) => sum + value, 0) * cellSize ** 2;
  const work = stepped.wake.work();
  const energyError = Math.abs(stepped.wake.energy() - energy - work.joules);
  const volumeError = Math.abs(volume - initialVolume - work.displacedVolume);
  t.diagnostic(
    JSON.stringify({
      reflection,
      transmission,
      reflected,
      transmitted,
      reflectedPhase,
      transmittedPhase,
      outgoingFlux,
      energyError,
      volumeError,
    }),
  );
  // The impedance solution checks the sign and magnitude. Its leading-order
  // phase is zero; a one-depth propagation phase at the carrier allows the
  // finite-depth corrections of this kh=0.126 case.
  assert.ok(Math.abs(reflected - reflection) < 0.015 && Math.abs(transmitted - transmission) < 0.025);
  assert.ok(Math.abs(reflectedPhase) < carrier * deep && Math.abs(transmittedPhase) < carrier * deep);
  assert.ok(r.error < 0.015 && tr.error < 0.025);
  assert.ok(Math.hypot(flat.real - 1, flat.imaginary) < 0.015 && flat.error < 0.01);
  assert.ok(Math.abs(outgoingFlux - 1) < 0.025);
  assert.equal(work.joules, 0);
  assert.equal(work.displacedVolume, 0);
  assert.ok(energyError < 1e-9 * energy);
  assert.ok(volumeError < 1e-12);
});

test('SEA-04 finite water reports the local still-water bed and excludes water below the shelf', () => {
  const { wake } = tank(8, 0.125, -0.5, true, undefined, true);
  const sea = wake.seaSurface();
  const z = 0.0625;
  assert.equal(sea.sample(-0.2, z, 0).depth, deep);
  const shelf = sea.sample(0.2, z, 0);
  assert.equal(shelf.density, density);
  assert.equal(sea.water.sample(0.2, -0.02, z, 0).density, density);
  assert.equal(sea.water.sample(0.2, -0.1, z, 0).density, 0);
  assert.equal(sea.pressure(0.2, -0.1, z, 0), 0);
  assert.equal(sea.water.sample(-0.2, -0.1, z, 0).density, density);
  assert.ok(Math.abs(sea.pressure(-0.2, -0.1, z, 0) - density * gravity * 0.1) < 2e-12);
  assert.equal(sea.sample(0.75, z, 0).depth, 0);
  assert.equal(shelf.depth, shallow);
});
