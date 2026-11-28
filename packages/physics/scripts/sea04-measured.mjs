import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FiniteQuayWake } from '../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const here = (name) => new URL(name, new URL("../../../test-results/sea04-measured/", import.meta.url));
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const read = (name) => readFileSync(here(name));
const json = (name) => JSON.parse(read(name));
const write = (name, value) => writeFileSync(here(name), JSON.stringify(value, null, 2) + '\n');
const [command, selected] = process.argv.slice(2);
const variant = process.env.SEA04_MEASURED_VARIANT ?? '';
assert.ok(['', 'crest', 'upstream'].includes(variant));
const tag = variant ? `-${variant}` : '';
const planFile = `sea04-measured-plan${tag}.json`;
const plan = json(planFile);
const planSha = hash(read(planFile));
const loadSha = hash(readFileSync(new URL('../dist/loads.js',import.meta.url)));
const worldSha = hash(readFileSync(new URL('../dist/world.js',import.meta.url)));

function makeGrid(preset) {
  const { dx, layers } = plan.grids[preset];
  const [nx, nz] = plan.domain_m.map((v) => Math.round(v / dx));
  const [x0, z0] = plan.origin_m;
  assert.deepEqual([nx * dx, nz * dx], plan.domain_m);
  return {
    cells: [nx, nz],
    origin: [x0, z0],
    cellSize: dx,
    depths: Array.from({ length: layers + 1 }, (_, i) => (plan.depth * i) / layers),
    sponge: { cells: Math.round(plan.sponge_m / dx), rate: plan.sponge_rate },
    density: 1000,
  };
}

function waterGeometry(grid) {
  const [nx, nz] = grid.cells;
  const [x0, z0] = grid.origin;
  const { cellSize: dx, depths } = grid;
  const radius = plan.cylinder_radius;
  const sections = depths.length - 1;
  const plane = nx * nz;
  const wet = new Uint8Array(plane * sections);
  const openX = new Float64Array(wet.length);
  const openZ = new Float64Array(wet.length);
  let cellsBlocked = 0;
  function fraction(face, start) {
    if (Math.abs(face) >= radius) return 1;
    const chord = Math.sqrt(radius ** 2 - face ** 2);
    const blocked = Math.max(0, Math.min(start + dx, chord) - Math.max(start, -chord));
    return 1 - blocked / dx;
  }
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * dx;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * dx;
      const cell = j * nx + i;
      const theX = x + dx / 2;
      const theZ = z + dx / 2;
      wet[cell] = Number(theX ** 2 + theZ ** 2 >= radius ** 2);
      cellsBlocked += Number(!wet[cell]);
      openX[cell] = fraction(x + dx, z);
      openZ[cell] = fraction(z + dx, x);
    }
  }
  for (let k = 1; k < sections; k++) {
    wet.copyWithin(k * plane, 0, plane);
    openX.copyWithin(k * plane, 0, plane);
    openZ.copyWithin(k * plane, 0, plane);
  }
  return {
    params: { wet, openX, openZ },
    cellsBlocked,
    binaryObstacleArea_m2: cellsBlocked * dx ** 2,
  };
}

function initialState(grid) {
  const h = grid.cellSize;
  const dz = grid.depths[1];
  const dt = 1 / plan.rate;
  const depth = plan.depth;
  const discreteFreq = (k) => {
    const kx = (2 / h) * Math.sin(k * h / 2);
    const a = Math.acosh(1 + (kx * dz) ** 2 / 2);
    return Math.sqrt((2 * plan.gravity / dz) * Math.tanh(a * depth / dz) * Math.tanh(a / 2));
  };
  const mode = plan.modes.map(([omega, re, im]) => {
    const f = (2 / dt) * Math.tan(omega * dt / 2);
    let lower = 0;
    let upper = Math.PI / h;
    assert.ok(discreteFreq(upper) > f);
    for (let i = 0; i < 46; i++) {
      const middle = (upper + lower) / 2;
      if (discreteFreq(middle) < f) lower = middle;
      else upper = middle;
    }
    return { omega, re, im, wavenumber: (upper + lower) / 2, potential: plan.gravity / f };
  });
  const z0 = grid.origin[1];
  const bins = Array.from({ length: grid.cells[1] }, (_, j) => {
    const z = z0 + (j + .5) * h;
    let eta = 0;
    let phi = 0;
    for (const m of mode) {
      const phase = m.omega * (plan.start_s - plan.focus_s) - m.wavenumber * (z - plan.gauge[1]);
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      eta += m.re * cos - m.im * sin;
      phi -= m.potential * (m.re * sin + m.im * cos);
    }
    return [eta, phi];
  });
  return (_x, z) => bins[Math.floor((z - z0) / h)];
}

function evolve(grid, obstacle) {
  const world = new PhysicsWorld({ gravity: [0, -plan.gravity, 0], rate: { num: plan.rate, den: 1 }, memory: worldMemory(false) });
  const wave = new FiniteQuayWake();
  const geometry = obstacle ? waterGeometry(grid) : { params: {}, cellsBlocked: 0, binaryObstacleArea_m2: 0 };
  world.add(wave, { ...grid, ...geometry.params, initial: initialState(grid) });
  assert.ok(wave.wet(...plan.gauge), 'The original WG9 location must remain wet.');
  const incidentEnergy = wave.energy();
  const height = [];
  let maxEnergyResidual = 0;
  let peakIterations = 0;
  for (let tick = 0; tick < plan.time_s.length; tick++) {
    if (tick > 0) world.advance(tick);
    height.push(wave.sample(...plan.gauge).height);
    const work = wave.work();
    maxEnergyResidual = Math.max(maxEnergyResidual, Math.abs(wave.energy() + work.absorbedJoules - incidentEnergy));
    peakIterations = Math.max(peakIterations, work.iterations);
  }
  assert.ok(maxEnergyResidual < 1e-8 * incidentEnergy);
  return {
    height_m: height,
    incidentEnergy_J: incidentEnergy,
    maxEnergyResidual_J: maxEnergyResidual,
    maxProjectionIterations: peakIterations,
    cellsBlockedPerLayer: geometry.cellsBlocked,
    binaryObstacleArea_m2: geometry.binaryObstacleArea_m2,
  };
}

if (command === 'predict') {
  assert.ok(selected in plan.grids);
  const grid = makeGrid(selected);
  console.log('predict', selected, grid.cells, grid.depths.length - 1, 'layers', plan.time_s.length, 'samples');
  const open = evolve(grid, false);
  console.log('open meter RMS against incident', Math.sqrt(open.height_m.reduce((s, a, i) => s + (a - plan.analytical_incident_m[i]) ** 2, 0) / open.height_m.length));
  const cylinder = evolve(grid, true);
  const output = `sea04-measured-prediction-${selected}${tag}.json`;
  write(output, {
    source_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    loads_dist_sha256: loadSha,
    world_dist_sha256: worldSha,
    plan_sha256: planSha,
    results: { [selected]: { grid, open, cylinder } },
  });
  console.log('predictor packet', output, hash(read(output)));
} else if (command === 'freeze') {
  const gridNames = selected ? [selected] : Object.keys(plan.grids);
  const distFingerprints = new Set();
  const packets = Object.fromEntries(gridNames.map((name) => {
    const filename = `sea04-measured-prediction-${name}${tag}.json`;
    const data = json(filename);
    assert.equal(data.plan_sha256,planSha);
    distFingerprints.add(`${data.loads_dist_sha256}/${data.world_dist_sha256}`);
    assert.equal(Object.keys(data.results)[0], name);
    return [filename, hash(read(filename))];
  }));
  assert.equal(distFingerprints.size, 1, 'Grid pair must use identical imported production bundles.');
  const output = `sea04-measured-frozen-predictions${tag}.json`;
  write(output, { plan_sha256: planSha, loaded_bundles_sha256: [...distFingerprints][0],
    prediction_sha256: packets });
  console.log('frozen predictions', hash(read(output)));
} else {
  throw new Error('Pass predict coarse, predict fine, or freeze.');
}
