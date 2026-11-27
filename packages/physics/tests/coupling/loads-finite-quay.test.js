import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { FiniteQuayWake, QuayPotential } from '../../dist/loads.js';
import { SUBMERGED_WAKE_LAYOUT, WAKE_SOURCE_LAYOUT } from '../../dist/sea.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('the layered free surface reproduces a finite-depth mode and converges toward continuous dispersion', () => {
  const length = 3.2,
    depth = 1.2,
    waveNumber = (2 * Math.PI) / length,
    exact = waveNumber * Math.tanh(waveNumber * depth);
  const errors = [];
  for (const nx of [16, 32, 64]) {
    const cellSize = length / nx;
    const layers = (3 * nx) / 8;
    const layerThickness = depth / layers;
    const grid = new QuayPotential({
      cells: [nx, 1],
      cellSize,
      depths: Array.from({ length: layers + 1 }, (_, i) => i * layerThickness),
    });
    const trace = Float64Array.from({ length: nx }, (_, i) => Math.cos(waveNumber * (i + 0.5) * cellSize));
    const rate = new Float64Array(nx);
    grid.project(trace, rate);
    // The cell-centred Neumann cosine mode has horizontal eigenvalue 4 sin²(k dx/2)/dx².
    // The three-term recurrence in depth with the reflected bed then gives an exact discrete normal derivative.
    const horizontal = (2 * Math.sin((waveNumber * cellSize) / 2)) / cellSize;
    const discreteK = Math.acosh(1 + 0.5 * (layerThickness * horizontal) ** 2) / layerThickness;
    const discrete = (2 / layerThickness) * Math.tanh(discreteK * depth) * Math.tanh((discreteK * layerThickness) / 2);
    for (let i = 0; i < nx; i++) close(rate[i], discrete * trace[i]);
    close(
      rate.reduce((sum, value) => sum + value, 0),
      0,
    );
    errors.push(Math.abs(discrete - exact));
  }
  assert.ok(errors[1] < 0.26 * errors[0] && errors[2] < 0.26 * errors[1]);
});

test('only the open lower face transmits the potential under an impermeable apron', () => {
  const grid = new QuayPotential({ cells: [2, 1], cellSize: 1, depths: [0, 0.5, 1], openX: [0, 0, 1, 0] });
  const out = new Float64Array(2);
  grid.project(Float64Array.of(1, 0), out);
  // Five conductances in series: top half-cell, down, across the aperture, up, top half-cell.
  const exact = 1 / (0.25 + 0.5 + 2 + 0.5 + 0.25);
  close(out[0], exact);
  close(out[1], -exact);
  assert.equal(grid.faceFlux('x', 0), 0);
  assert.equal(grid.reaches(0.9, 0.5, 1, 0, 0), false);
  assert.equal(grid.reaches(0.9, 0.5, 1, 0, 2), true);
  close(grid.faceFlux('x', 2), -exact);
  const projected = new Float64Array(2);
  grid.project(Float64Array.of(0, 0), projected, Float64Array.of(0, 0, 0.03, 0));
  close(projected[0] + projected[1], 0.03);
  assert.ok(projected[0] > projected[1] && projected[1] > 0);
});

test('a finite sealed face diverts flux around both tips and the surface operator stays reciprocal', () => {
  const cells = [4, 3];
  const layer = cells[0] * cells[1];
  const openX = new Float64Array(layer * 2).fill(1);
  const face = 1 + cells[0];
  openX[face] = openX[face + layer] = 0;
  const grid = new QuayPotential({ cells, cellSize: 1, depths: [0, 0.5, 2], openX });
  const left = Float64Array.from({ length: layer }, (_, i) => (i % cells[0] < 2 ? 1 : 0));
  const opposite = Float64Array.from({ length: layer }, (_, i) => Math.sin(0.6 * i));
  const leftRate = new Float64Array(layer),
    oppositeRate = new Float64Array(layer);
  grid.project(left, leftRate);
  assert.equal(grid.faceFlux('x', face), 0);
  assert.equal(grid.faceFlux('x', face + layer), 0);
  assert.ok(grid.faceFlux('x', 1) < -0.2 && grid.faceFlux('x', 1 + 2 * cells[0]) < -0.2);
  close(grid.faceFlux('x', 1), grid.faceFlux('x', 1 + 2 * cells[0]));
  grid.project(opposite, oppositeRate);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  close(dot(left, oppositeRate), dot(opposite, leftRate));
  assert.ok(dot(left, leftRate) > 0 && dot(opposite, oppositeRate) > 0);
});

test('a trapped wet pocket and a source inside solid material receive actionable errors', () => {
  const cells = [2, 1];
  const depths = [0, 0.5, 1];
  assert.throws(() => new QuayPotential({ cells, cellSize: 1, depths, wet: [1, 0, 0, 1] }), {
    message: /Connect every wet pocket to the free surface or exclude it/,
  });
  const grid = new QuayPotential({ cells, cellSize: 1, depths, wet: [1, 0, 1, 0] });
  const out = Float64Array.of(4, 2);
  assert.throws(() => grid.project(Float64Array.of(0, 0), out, Float64Array.of(0, 0, 0, 1)), {
    message: /put each finite volume source inside a wet cell/,
  });
  assert.deepEqual(out, Float64Array.of(4, 2));
});

test('the finite quay advances the exact discrete mode and returns its depth pressure with exact replay', () => {
  const cells = [20, 5],
    cellSize = 0.2,
    depth = 1.2,
    layers = 6,
    gravity = 9.81;
  const waveNumber = Math.PI / (cells[0] * cellSize);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0], memory: worldMemory(false) });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    cells,
    cellSize,
    depths: Array.from({ length: layers + 1 }, (_, i) => (i * depth) / layers),
    initial: (x) => [0.04 * Math.cos(waveNumber * x), 0],
    pressureAtDepth: true,
  });
  const start = world.takeSnapshot(),
    energy = wake.energy();
  world.advance(75);
  const horizontal = (2 * Math.sin((waveNumber * cellSize) / 2)) / cellSize,
    dy = depth / layers;
  const vertical = Math.acosh(1 + 0.5 * (dy * horizontal) ** 2) / dy;
  const normal = (2 / dy) * Math.tanh(vertical * depth) * Math.tanh((vertical * dy) / 2);
  const angle = 2 * Math.atan(Math.sqrt(gravity * normal) / 120);
  for (let i = 0; i < cells[0]; i++) {
    const x = (i + 0.5) * cellSize;
    close(wake.heights()[i], 0.04 * Math.cos(waveNumber * x) * Math.cos(75 * angle));
    // Bernoulli pressure uses the time midpoint, with the same harmonic depth profile as the tested mode.
    const distance = 1.5 * dy;
    const headRatio =
      Math.cosh(vertical * (depth - distance)) / (Math.cosh(vertical * depth) * Math.cosh((vertical * dy) / 2));
    const etaMid = 0.02 * Math.cos(waveNumber * x) * (Math.cos(74 * angle) + Math.cos(75 * angle));
    const expected = wake.density * gravity * (distance + headRatio * etaMid);
    close(wake.pressure(x, -distance, 0.5), expected, 1e-8);
    assert.equal(wake.pressure(x, wake.elevation(x, 0.5), 0.5), 0);
  }
  close(wake.energy(), energy, 1e-9);
  const hash = world.hash();
  world.restoreSnapshot(start.bytes);
  world.advance(75);
  assert.equal(world.hash(), hash);
});

test('wet-side height reconstruction keeps both sides of a thin wall independent', () => {
  const cells = [6, 4];
  const plane = cells[0] * cells[1];
  const openX = new Float64Array(plane * 2).fill(1);
  for (let j = 0; j < cells[1]; j++) openX[2 + j * cells[0]] = 0;
  const world = new PhysicsWorld();
  const wake = new FiniteQuayWake();
  world.add(wake, {
    cells,
    cellSize: 1,
    depths: [0, 0.5, 1],
    openX,
    initial: (x) => [x < 3 ? 0.4 : -0.2, 0],
  });
  const left = wake.sample(2.975, 1.5),
    right = wake.sample(3.025, 1.5);
  close(left.height, 0.4);
  close(right.height, -0.2);
  close(left.slope[0], 0);
  close(right.slope[0], 0);
  const mask = wake.surfaceMask();
  assert.equal(mask[2 + cells[0]], 1 | 4);
  assert.equal(mask[3 + cells[0]], 1 | 2 | 4);
  mask.fill(0);
  assert.equal(wake.surfaceMask()[3 + cells[0]], 1 | 2 | 4);
});

test('a finite quay sponge accounts for the energy and signed volume it absorbs', () => {
  const world = new PhysicsWorld();
  const wake = new FiniteQuayWake();
  const cellSize = 0.2;
  world.add(wake, {
    cells: [12, 8],
    cellSize,
    depths: [0, 0.1, 0.25, 0.8],
    sponge: { cells: 2, rate: 3 },
    initial: (x, z) => [0.04 * Math.exp(-10 * ((x - 0.15) ** 2 + (z - 0.3) ** 2)), 0],
  });
  const volume = () => wake.heights().reduce((sum, height) => sum + height, 0) * cellSize ** 2;
  const initialEnergy = wake.energy(),
    initialVolume = volume();
  world.advance(81);
  const { absorbedJoules, absorbedVolume, joules } = wake.work();
  assert.ok(absorbedJoules > 0.05 && absorbedVolume > 0.0001);
  close(joules, 0);
  close(wake.energy() + absorbedJoules, initialEnergy, 1e-9);
  close(volume() + absorbedVolume, initialVolume);
});

test('finite geometry accepts both hull source layouts and accounts for pressure work and conserved volume', () => {
  const field = (name, quantity) => ({ name, quantity, kind: 'surfaceSampleSet', centring: 'particle', unit: 'SI' });
  const surface = field('hull.surface', 'seaSource'),
    submerged = field('hull.submerged', 'submergedSeaSource');
  const cells = [12, 8],
    plane = cells[0] * cells[1],
    cellSize = 0.25;
  const openX = new Float64Array(plane * 3).fill(1);
  const obstacle = 7 + 3 * cells[0];
  openX[obstacle] = openX[obstacle + plane] = 0;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  const wake = new FiniteQuayWake('finiteQuayWake', {
    surface,
    submerged: { field: submerged, depths: [0, 0.26, 0.8] },
  });
  let host, surfaceRegion, submergedRegion;
  const driver = {
    describe: () => ({
      id: 'hull',
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: surface, access: 'write' },
        { field: submerged, access: 'write' },
      ],
    }),
    init(allocated) {
      host = allocated;
      surfaceRegion = host.allocate('surface', 5 * 8, 'f64', WAKE_SOURCE_LAYOUT);
      submergedRegion = host.allocate('submerged', 2 * 5 * 8, 'f64', SUBMERGED_WAKE_LAYOUT);
    },
    step({ tick }) {
      const a = regionWords(host.memory, surfaceRegion),
        b = regionWords(host.memory, submergedRegion);
      a.fill(0);
      b.fill(0);
      if (tick < 20) {
        a.set([0.875, 0.875, 0.27, 300, 0.001]);
        b.set([1.125, 0.875, 0.3, 0, 0.0013, 0.625, 0.875, 0.27, 1, -0.0013]);
      }
    },
    exportPorts: (tick) => [
      { field: surface.name, region: surfaceRegion, tick, cell: host.cell },
      { field: submerged.name, region: submergedRegion, tick, cell: host.cell },
    ],
    importPorts() {},
    stateRegions: () => [surfaceRegion, submergedRegion],
    extraState: () => [],
  };
  world.add(driver, undefined).add(wake, { cells, cellSize, depths: [0, 0.15, 0.45, 1.2], openX });
  const zero = world.takeSnapshot();
  world.advance(46);
  const receipt = wake.work(),
    hash = world.hash(),
    velocity = wake.velocityAt(1.625, -0.2, 0.875);
  assert.ok(Math.abs(velocity[0]) > 1e-5 && Math.abs(receipt.joules) > 0.1);
  close(receipt.displacedVolume, 0.02, 2e-11);
  close(wake.heights().reduce((sum, h) => sum + h, 0) * cellSize ** 2, 0.02, 2e-11);
  close(wake.energy(), receipt.joules, 1e-8);
  world.restoreSnapshot(zero.bytes);
  world.advance(46);
  assert.equal(world.hash(), hash);
  assert.deepEqual(wake.velocityAt(1.625, -0.2, 0.875), velocity);
  assert.deepEqual(wake.work(), receipt);
});

test('a real advancing hull drives the finite wake and its return pressure changes the hull motion', async () => {
  await Physics.load();
  const mesh = {
    vertices: [
      -1, -0.5, -0.5, 1, -0.5, -0.5, 1, 0.5, -0.5, -1, 0.5, -0.5, -1, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5, 0.5, -1, 0.5,
      0.5,
    ],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
  function run(feedback) {
    const density = 1025,
      cellSize = 0.25,
      cells = [32, 20];
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
    using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, substeps: 1 });
    const body = physics.addBody(null, {
      position: [-1, 0, 0.75],
      linearVelocity: [1.25, 0, 0],
      lockRotations: true,
      enabledTranslations: [true, true, false],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: density },
    });
    const hull = new HullSolver('hull', { minimumRadius: cellSize, submergedAdvance: [0, 0.25, 0.5] });
    const wake = new FiniteQuayWake('finite', { surface: hull.wakeSourceField, submerged: hull.submergedWakeSource });
    const openZ = new Float64Array(cells[0] * cells[1] * 3).fill(1);
    for (let x = 6; x < 25; x++) openZ[x + 5 * cells[0]] = 0;
    const sea = feedback ? wake.seaSurface() : { elevation: () => 0, density };
    world.add(new RigidSolver(), { physics });
    world.add(wake, {
      cells,
      cellSize,
      origin: [-4, -2.5],
      depths: [0, 0.25, 0.5, 1.5],
      density,
      openZ,
      pressureAtDepth: true,
    });
    world.add(hull, {
      hulls: [{ row: body.row, mesh }],
      sea,
      addedMass: false,
      radiation: false,
      rollDamping: false,
      drag: false,
      diffraction: false,
      drift: false,
      greenWater: false,
      slamming: false,
    });
    world.couple(['hull', 'finite', 'rigid'], 'staggered');
    const initial = world.takeSnapshot();
    world.advance(24);
    assert.ok(wake.heights().some((height) => Math.abs(height) > 0.001));
    close(wake.energy(), wake.work().joules, 1e-8);
    const expected = world.hash();
    const vertical = body.linearVelocity[1];
    world.restoreSnapshot(initial.bytes);
    world.advance(24);
    assert.equal(world.hash(), expected);
    return vertical;
  }
  const calm = run(false),
    coupled = run(true);
  assert.ok(Math.abs(coupled - calm) > 0.001, `${coupled} and ${calm} m/s`);
});

test('the multilevel estimate leaves the same finite geometry pressure and open lower-face flux', () => {
  const depths = [0, 0.12, 0.27, 0.5, 0.64, 0.82, 1];
  const counts = [];
  for (const side of [28, 56]) {
    const nx = side + 1;
    const nz = side / 2 + 1;
    const plane = nx * nz;
    const layers = depths.length - 1;
    const volume = plane * layers;
    const dx = 14 / side;
    const face = Math.floor(nx / 2);
    const openX = new Float64Array(volume).fill(1);
    const obstacle = (z) => z >= Math.floor(nz / 4) && z <= Math.ceil((3 * nz) / 4);
    const exact = new Float64Array(volume);
    for (let j = 0; j < volume; j++) {
      const x = j % nx;
      const z = Math.floor(j / nx) % nz;
      const layer = Math.floor(j / plane);
      const y = 0.5 * (depths[layer] + depths[layer + 1]);
      exact[j] = Math.cos(2 * x * dx) * (1 - y * y) + 0.35 * Math.cos(z * dx - y);
      if (x === face && obstacle(z)) openX[j] = depths[layer + 1] <= 0.5 ? 0 : 0.7;
    }

    // Independently assemble the physical source by summing each oriented face
    // flux of the prescribed 3D potential. Land cuts use the actual finite span.
    const source = new Float64Array(volume);
    function stamp(a, b, conductance) {
      const volumeRate = conductance * (exact[b] - exact[a]);
      source[a] += volumeRate;
      source[b] -= volumeRate;
    }
    for (let j = 0; j < volume; j++) {
      const layer = Math.floor(j / plane);
      const thickness = depths[layer + 1] - depths[layer];
      if ((j % nx) + 1 < nx) stamp(j, j + 1, thickness * openX[j]);
      if ((Math.floor(j / nx) % nz) + 1 < nz) stamp(j, j + nx, thickness);
      if (layer + 1 < layers) {
        const centreDistance = (depths[layer + 2] - depths[layer]) / 2;
        stamp(j, j + plane, (dx * dx) / centreDistance);
      }
      if (j < plane) source[j] -= (dx * dx * exact[j]) / (depths[1] / 2);
    }
    const grid = new QuayPotential({
      cells: [nx, nz],
      cellSize: dx,
      depths,
      openX,
    });
    const surface = new Float64Array(plane);
    const rise = new Float64Array(plane);
    const bulk = new Float64Array(volume);
    const iterations = grid.project(surface, rise, source, 0, bulk);
    counts.push(iterations);
    for (let j = 0; j < volume; j++) close(bulk[j], exact[j], 2e-10);
    const expectedRise = exact.subarray(0, plane).reduce((sum, value) => sum - value / (depths[1] / 2), 0);
    close(
      rise.reduce((sum, value) => sum + value, 0),
      expectedRise,
      3e-8,
    );
    const slitFace = face + nx * Math.floor(nz / 2);
    assert.equal(grid.faceFlux('x', slitFace, bulk), 0);
    assert.ok(Math.abs(grid.faceFlux('x', slitFace + 3 * plane, bulk)) > 0.01);
    const restored = rise.slice();
    assert.equal(grid.project(surface, rise, source, 0, bulk), iterations);
    assert.deepEqual(rise, restored);
  }
  assert.ok(counts[0] < 40 && counts[1] < 58 && counts[1] < 1.8 * counts[0]);
});

test('a large sealed quay keeps disconnected wet regions separate in the coarse solve', () => {
  const nx = 26;
  const nz = 17;
  const depths = [0, 0.1, 0.25, 0.43, 0.65, 1];
  const plane = nx * nz;
  const volume = plane * (depths.length - 1);
  const wall = 12;
  const openX = Float64Array.from({ length: volume }, (_, i) => (i % nx === wall ? 0 : 1));
  const grid = new QuayPotential({
    cells: [nx, nz],
    cellSize: 0.2,
    depths,
    openX,
  });
  const trace = Float64Array.from({ length: plane }, (_, i) => (i % nx > wall ? Math.cos(i * 0.1) : 0));
  const rise = new Float64Array(plane);
  const bulk = new Float64Array(volume);
  grid.project(trace, rise, undefined, 0, bulk);
  for (let i = 0; i < volume; i++) if (i % nx <= wall) assert.equal(bulk[i], 0);
  assert.ok(bulk.some((value) => Math.abs(value) > 0.1));
  for (let i = 0; i < volume; i++) if (i % nx === wall) assert.equal(grid.faceFlux('x', i), 0);
});
