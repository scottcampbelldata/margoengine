import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { DRY, SHALLOW_BLOCKAGE_LAYOUT, SHALLOW_BLOCKAGE_MOTION_WORDS, ShallowWaterSolver } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { BODY_IMPULSES_FIELD, IMPULSE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';
import {
  blockageGeometry,
  cylinderFootprint,
  cylinderGeometry,
  cylinderPistonDepth,
  prepareFootprint,
} from '../../src/hydro/moving-blockage.ts';
import { seekEqualsContinuous } from './harness.js';

const GRID = { nx: 12, nz: 10, dx: 0.5, dz: 0.4 };
const AREA = GRID.dx * GRID.dz;
const WIDTH = GRID.nx * GRID.dx;
const DEPTH = GRID.nz * GRID.dz;
const RADIUS = 0.15;
const HEIGHT = 0.9;
const DENSITY = 1000;
const RATE = { num: 60, den: 1 };
const CELL = [0, 0, 0];
const G = 9.81;

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} != ${expected} within ${bound}`);
}

function polygonArea() {
  return 32 * RADIUS * RADIUS * Math.sin(Math.PI / 32);
}

function positiveModulo(value, period) {
  return ((value % period) + period) % period;
}

test('SEA-12 time-integrated cylinder apertures exactly match volume swept across both periodic seams', () => {
  const { nx, nz, dx, dz } = GRID;
  const start = [WIDTH - 0.04, DEPTH - 0.06];
  const end = [start[0] + 0.16, start[1] + 0.23];
  const geometry = cylinderGeometry(GRID, cylinderFootprint(RADIUS), RADIUS, start, end);
  const { occupiedStart, occupiedEnd, openX, openZ, walls } = geometry;
  const nxWall = new Array(nx * nz).fill(0);
  const nzWall = new Array(nx * nz).fill(0);
  for (const wall of walls) {
    nxWall[wall.cell] += wall.normal[0];
    nzWall[wall.cell] += wall.normal[1];
  }
  let touched = 0;
  const bound = 256 * Number.EPSILON * AREA;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const i = x + nx * z;
      const fx = dz * (openX[((x + 1) % nx) + nx * z] - openX[i]);
      const fz = dx * (openZ[x + nx * ((z + 1) % nz)] - openZ[i]);
      const swept = AREA * (occupiedEnd[i] - occupiedStart[i]);
      near(swept, (end[0] - start[0]) * fx + (end[1] - start[1]) * fz, bound);
      near(nxWall[i], -fx, bound);
      near(nzWall[i], -fz, bound);
      if (swept !== 0) touched++;
    }
  }
  assert.ok(touched >= 4);
  near(AREA * occupiedStart.reduce((a, b) => a + b, 0), polygonArea(), bound);
  near(AREA * occupiedEnd.reduce((a, b) => a + b, 0), polygonArea(), bound);
});

test('the shallow-water moving piston obeys the bore, rarefaction and dry vacuum branches', () => {
  const c = Math.sqrt(G * HEIGHT);
  const exactlyTwice = c * Math.sqrt(3 / 4);
  near(cylinderPistonDepth(HEIGHT, exactlyTwice, G), 2 * HEIGHT, 32 * Number.EPSILON);
  near(cylinderPistonDepth(HEIGHT, -c, G), 0.25 * HEIGHT, 8 * Number.EPSILON);
  assert.equal(cylinderPistonDepth(HEIGHT, -2 * c, G), 0);
  assert.equal(cylinderPistonDepth(HEIGHT, -3 * c, G), 0);
});

function waterLedger(water, x, z, shape) {
  const centre = [positiveModulo(x + WIDTH / 2, WIDTH), positiveModulo(z + DEPTH / 2, DEPTH)];
  const cells = shape
    ? blockageGeometry(GRID, shape, centre, centre).occupiedStart
    : cylinderGeometry(GRID, cylinderFootprint(RADIUS), RADIUS, centre, centre).occupiedStart;
  const totals = [0, 0];
  let maxHead = 0;
  let energy = 0;
  for (let j = 0; j < GRID.nz; j++) {
    for (let i = 0; i < GRID.nx; i++) {
      const sample = water.sample((i + 0.5) * GRID.dx - WIDTH / 2, (j + 0.5) * GRID.dz - DEPTH / 2);
      const mass = DENSITY * AREA * (1 - cells[i + GRID.nx * j]) * sample.depth;
      const [u, v] = sample.velocity;
      totals[0] += mass * u;
      totals[1] += mass * v;
      const eta = sample.depth - HEIGHT;
      energy += 0.5 * mass * (u * u + v * v) + 0.5 * DENSITY * AREA * (1 - cells[i + GRID.nx * j]) * G * eta * eta;
      maxHead = Math.max(maxHead, Math.abs(eta));
    }
  }
  return { totals, maxHead, energy };
}

async function fixture(initialVelocity, cylinderVelocity, rigid) {
  const startingCentre = [WIDTH / 2 - 0.05, DEPTH / 2 - 0.1];
  const water = await ShallowWaterSolver.withCylinder({
    bodyRow: rigid?.body.row ?? 7,
    centre: startingCentre,
    radius: RADIUS,
  });
  const { motion, reaction } = water.blockageFields;
  const bed = bedSurface(
    { columns: GRID.nx, rows: GRID.nz, width: WIDTH, depth: DEPTH, centre: [0, 0] },
    new Float64Array((GRID.nx + 1) * (GRID.nz + 1)),
  );
  let request;
  let host;
  const driver = {
    id: 'cylinder-driver',
    describe() {
      return {
        id: this.id,
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: motion, access: 'write' },
          { field: reaction, access: 'read' },
        ],
      };
    },
    init(solverHost) {
      host = solverHost;
      request = host.allocate('motion', SHALLOW_BLOCKAGE_MOTION_WORDS * 8, 'f64', SHALLOW_BLOCKAGE_LAYOUT);
    },
    step({ tick }, dt) {
      const x = startingCentre[0] + (tick + 1) * dt * cylinderVelocity[0];
      const z = startingCentre[1] + (tick + 1) * dt * cylinderVelocity[1];
      regionWords(host.memory, request).set([tick + 1, x, z, 0.4]);
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: motion.name, region: request, tick, cell: CELL }];
    },
    stateRegions() {
      return [request];
    },
    extraState() {
      return [];
    },
  };
  const world = new PhysicsWorld({ rate: RATE, gravity: [0, -G, 0] }).add(driver, {}).add(water, {
    bed,
    depth: HEIGHT,
    velocity: () => initialVelocity,
    density: DENSITY,
    sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
  });
  if (rigid) {
    const relay = bodyReactionRelay(reaction, rigid.body.row);
    world.add(new RigidSolver(), { physics: rigid.physics }).add(relay, {});
    world.couple([driver.id, 'water', relay.id, 'rigid'], 'staggered');
  } else world.couple([driver.id, 'water'], 'staggered');

  const ledger = (tick) =>
    waterLedger(
      water,
      startingCentre[0] + (tick * cylinderVelocity[0]) / RATE.num,
      startingCentre[1] + (tick * cylinderVelocity[1]) / RATE.num,
    );

  const receipt = (tick) => {
    const port = water.exportPorts(tick).find((entry) => entry.field === reaction.name);
    return [...regionWords(world.memory, port.region)];
  };
  return { water, world, ledger, receipt };
}

function bodyReactionRelay(reaction, row) {
  let host;
  let region;
  return {
    id: 'cylinder-reaction',
    describe() {
      return {
        id: this.id,
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: reaction, access: 'read' },
          { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        ],
      };
    },
    init(solverHost) {
      host = solverHost;
      region = host.allocate('impulse', 8 * host.bodyRows() * IMPULSE_WORDS, 'f64', 1);
    },
    step({ inputs, tick }) {
      const receipt = inputs.get(reaction.name);
      assert.equal(receipt.tick, tick);
      const words = regionWords(host.memory, receipt.region);
      assert.deepEqual([words[0], words[1]], [tick + 1, row]);
      regionWords(host.memory, region).set(words.subarray(2), row * IMPULSE_WORDS);
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: BODY_IMPULSES_FIELD.name, region, cell: CELL, tick }];
    },
    stateRegions() {
      return [region];
    },
    extraState() {
      return [];
    },
  };
}

test('a translating cylindrical blockage preserves an exactly comoving periodic lake', async () => {
  const velocity = [0.45, 0.48];
  const { world, water, ledger, receipt } = await fixture(velocity, velocity);
  const volume = HEIGHT * (WIDTH * DEPTH - polygonArea());
  const scale = volume * DENSITY;
  for (let tick = 1; tick <= 36; tick++) {
    world.advance(tick);
    const { totals, maxHead } = ledger(tick);
    near(water.volume(), volume, 128 * Number.EPSILON * volume);
    totals.forEach((value, index) => near(value, scale * velocity[index], 256 * Number.EPSILON * scale));
    near(maxHead, 0, 128 * Number.EPSILON * HEIGHT);
    assert.deepEqual(receipt(tick).slice(0, 2), [tick, 7]);
    receipt(tick)
      .slice(2)
      .forEach((value) => near(value, 0, 4096 * Number.EPSILON * DENSITY * G * HEIGHT * AREA));
  }
});

test('a moving full-depth cylinder generates a wave and receives opposite pressure impulse from live HYDRO-01', async () => {
  const { world, water, ledger, receipt } = await fixture([0, 0], [0.5, 0.17]);
  const volume = water.volume();
  const accumulated = [0, 0];
  const initialEnergy = ledger(0).energy;
  let snap;
  for (let tick = 1; tick <= 48; tick++) {
    world.advance(tick);
    if (tick === 12) snap = world.takeSnapshot();
    const [ticket, row, jx, jy, jz] = receipt(tick);
    assert.deepEqual([ticket, row, jy], [tick, 7, 0]);
    accumulated[0] += jx;
    accumulated[1] += jz;
    const { totals } = ledger(tick);
    near(totals[0] + accumulated[0], 0, 512 * Number.EPSILON * DENSITY * volume);
    near(totals[1] + accumulated[1], 0, 512 * Number.EPSILON * DENSITY * volume);
    near(water.volume(), volume, 128 * Number.EPSILON * volume);
  }
  assert.ok(ledger(48).maxHead > 0.01);
  assert.ok(accumulated[0] < 0);
  assert.ok(accumulated[1] < 0);
  const wallWork = -0.5 * accumulated[0] - 0.17 * accumulated[1];
  assert.ok(ledger(48).energy - initialEnergy < wallWork);
  const hash = world.hash();
  world.restoreSnapshot(snap.bytes);
  world.advance(48);
  assert.equal(world.hash(), hash);
});

test('the same-tick cylinder reaction drives the real rigid impulse port', async () => {
  await Physics.load();
  using physics = new Physics(null, { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num });
  const mass = 512;
  const body = physics.addBody(null, {
    position: [WIDTH / 2 - 0.05, 0.4, DEPTH / 2 - 0.1],
    enabledTranslations: [true, false, true],
    lockRotations: true,
    linearDamping: 0,
    colliders: { shape: 'sphere', radius: RADIUS, mass },
  });
  // Prescribe the cylinder path to isolate the rigid reaction port.
  const { world, ledger, receipt } = await fixture([0, 0], [0.31, -0.23], { physics, body });
  const sum = [0, 0];
  for (let tick = 1; tick <= 12; tick++) {
    world.advance(tick);
    const [, , x, , z] = receipt(tick);
    sum[0] += x;
    sum[1] += z;
  }
  assert.ok(sum[0] < 0 && sum[1] > 0);
  const velocity = body.linearVelocity;
  for (const [axis, roundoff] of [
    [0, 32 * 2 ** -24 * Math.abs(sum[0])],
    [1, 32 * 2 ** -24 * Math.abs(sum[1])],
  ]) {
    near(mass * velocity[axis === 0 ? 0 : 2], sum[axis], roundoff);
    near(ledger(12).totals[axis] + mass * velocity[axis === 0 ? 0 : 2], 0, roundoff);
  }
});

async function guidedCylinder(physics, mass, footprint, setup = {}) {
  const { velocity = [0.41, 0, 0.28], depth = HEIGHT } = setup;
  const centre = [WIDTH / 2 - 0.05, DEPTH / 2 - 0.1];
  const body = physics.addBody(null, {
    position: [centre[0], 0.4, centre[1]],
    linearVelocity: velocity,
    enabledTranslations: [true, false, true],
    lockRotations: true,
    canSleep: false,
    angularDamping: 0,
    linearDamping: 0,
    colliders: footprint
      ? { shape: 'box', halfExtents: [0.185, 0.7, 0.145], mass }
      : { shape: 'sphere', radius: RADIUS, mass },
  });
  const binding = { bodyRow: body.row, centre };
  const {
    water,
    predictor,
    reaction: relay,
    order,
  } = await (footprint
    ? ShallowWaterSolver.withRigidFootprint({ ...binding, footprint })
    : ShallowWaterSolver.withRigidCylinder({ ...binding, radius: RADIUS }));
  const bed = bedSurface(
    { columns: GRID.nx, rows: GRID.nz, width: WIDTH, depth: DEPTH, centre: [0, 0] },
    new Float64Array((GRID.nx + 1) * (GRID.nz + 1)),
  );
  const world = new PhysicsWorld({ rate: RATE, gravity: [0, -G, 0] })
    .add(new RigidSolver(), { physics })
    .add(predictor, {})
    .add(water, {
      bed,
      depth,
      density: DENSITY,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    })
    .add(relay, {})
    .couple(order, 'staggered');
  return { body, water, world, predictor };
}

test('the guided rigid footprint predictor and pressure relay reproduce capped seek', async () => {
  await Physics.load();
  const options = { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num };
  using continuous = new Physics(null, options);
  using seeking = new Physics(null, options);
  const models = await Promise.all([guidedCylinder(continuous, 512), guidedCylinder(seeking, 512)]);
  seekEqualsContinuous(() => models.shift().world);
});

test('a guided rigid body feeds the returned pressure reaction into its next cylinder motion', async () => {
  await Physics.load();
  using physics = new Physics(null, { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num });
  const mass = 512;
  const { body, water, world, predictor } = await guidedCylinder(physics, mass);
  const volume = water.volume();
  const [initialX, , initialZ] = body.linearVelocity;
  let energy = 0.5 * mass * (initialX * initialX + initialZ * initialZ);
  const roundoff = 64 * 2 ** -24 * mass;
  let snap;
  let firstMotion;
  for (let i = 1; i <= 24; i++) {
    const [x, , z] = body.position;
    const [vx, , vz] = body.linearVelocity;
    world.advance(i);
    const [{ region }] = predictor.exportPorts(i);
    const [ticket, endX, endZ, , requestVx, requestVz] = regionWords(world.memory, region);
    assert.equal(ticket, i);
    assert.equal(requestVx, vx);
    assert.equal(requestVz, vz);
    near(endX, x + vx / RATE.num, 4 * Number.EPSILON * Math.abs(x));
    near(endZ, z + vz / RATE.num, 4 * Number.EPSILON * Math.abs(z));
    if (i === 1) {
      firstMotion = [requestVx, requestVz];
      assert.ok(body.linearVelocity[0] < vx && body.linearVelocity[2] < vz);
    }
    if (i === 2) {
      assert.ok(requestVx < firstMotion[0] && requestVz < firstMotion[1]);
      assert.notEqual(endX, x + initialX / RATE.num);
    }
    const { totals, energy: fluidEnergy } = waterLedger(water, endX, endZ);
    const [nextX, , nextZ] = body.linearVelocity;
    near(totals[0] + mass * nextX, mass * initialX, roundoff);
    near(totals[1] + mass * nextZ, mass * initialZ, roundoff);
    near(water.volume(), volume, 128 * Number.EPSILON * volume);
    const nextEnergy = fluidEnergy + 0.5 * mass * (nextX * nextX + nextZ * nextZ);
    assert.ok(nextEnergy < energy);
    energy = nextEnergy;
    if (i === 8) snap = world.takeSnapshot();
  }
  const hash = world.hash();
  world.restoreSnapshot(snap.bytes);
  world.advance(24);
  assert.equal(world.hash(), hash);
});

test('a light cylinder outside the passive partitioned regime leaves water and rigid momentum uncommitted', async () => {
  await Physics.load();
  using physics = new Physics(null, { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num });
  const { body, water, world } = await guidedCylinder(physics, 0.05);
  const volume = water.volume();
  const velocity = body.linearVelocity;
  assert.throws(() => world.advance(1), /cylinder step would create coupled energy/);
  assert.equal(water.volume(), volume);
  assert.deepEqual(body.linearVelocity, velocity);
  assert.deepEqual(water.sample(0, 0).velocity, [0, 0]);
  const accepted = water.exportPorts(0).find(({ field }) => field === water.blockageFields.reaction.name);
  assert.equal(regionWords(world.memory, accepted.region)[0], 0);
});

test('a face-aligned rectangular wall has exactly one fluid-side owner through its sweep', () => {
  const grid = { nx: 8, nz: 6, dx: 0.5, dz: 0.5 };
  const rectangle = prepareFootprint([
    [-0.125, -0.0625],
    [-0.125, 0.0625],
    [0.125, 0.0625],
    [0.125, -0.0625],
  ]);
  const start = [1.125, 1.0625];
  const end = [1.125, 1.3125];
  const geometry = blockageGeometry(grid, rectangle, start, end);
  const wallX = new Float64Array(grid.nx * grid.nz);
  const wallZ = new Float64Array(wallX.length);
  let coincidentLength = 0;
  for (const wall of geometry.walls) {
    wallX[wall.cell] += wall.normal[0];
    wallZ[wall.cell] += wall.normal[1];
    if (wall.inward[0] === 1) {
      assert.equal(wall.cell % grid.nx, 1);
      coincidentLength += wall.normal[0];
    }
  }
  near(coincidentLength, 0.125, 8 * Number.EPSILON);
  for (let k = 0; k < wallX.length; k++) {
    const j = Math.floor(k / grid.nx);
    const i = k % grid.nx;
    const netX = 0.5 * (geometry.openX[((i + 1) % grid.nx) + grid.nx * j] - geometry.openX[k]);
    const netZ = 0.5 * (geometry.openZ[i + grid.nx * ((j + 1) % grid.nz)] - geometry.openZ[k]);
    near(netX + wallX[k], 0, 64 * Number.EPSILON);
    near(netZ + wallZ[k], 0, 64 * Number.EPSILON);
    near(0.25 * (geometry.occupiedEnd[k] - geometry.occupiedStart[k]), 0.25 * netZ, 64 * Number.EPSILON);
  }
  near(rectangle.area, 0.25 * 0.125, 8 * Number.EPSILON);
});

test('a convex rectangular pier closes the guided Hydro and rigid feedback loop conservatively', async () => {
  await Physics.load();
  using physics = new Physics(null, { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num });
  const mass = 512;
  const hx = 0.185;
  const hz = 0.145;
  const footprint = [
    [-hx, -hz],
    [-hx, hz],
    [hx, hz],
    [hx, -hz],
  ];
  const shape = prepareFootprint(footprint);
  const { body, water, world, predictor } = await guidedCylinder(physics, mass, footprint);
  const volume = HEIGHT * (WIDTH * DEPTH - 4 * hx * hz);
  const [initialX, , initialZ] = body.linearVelocity;
  let energy = 0.5 * mass * (initialX * initialX + initialZ * initialZ);
  let snap;
  for (let tick = 1; tick <= 24; tick++) {
    const [x, , z] = body.position;
    const [vx, , vz] = body.linearVelocity;
    world.advance(tick);
    const [{ region }] = predictor.exportPorts(tick);
    const [stamp, endX, endZ, , sourceX, sourceZ] = regionWords(world.memory, region);
    assert.equal(stamp, tick);
    assert.equal(sourceX, vx);
    assert.equal(sourceZ, vz);
    near(endX, x + vx / RATE.num, 4 * Number.EPSILON * Math.abs(x));
    near(endZ, z + vz / RATE.num, 4 * Number.EPSILON * Math.abs(z));
    const [nextX, , nextZ] = body.linearVelocity;
    if (tick === 1) assert.ok(nextX < initialX && nextZ < initialZ);
    if (tick === 2) assert.ok(sourceX < initialX && sourceZ < initialZ);
    const fluid = waterLedger(water, endX, endZ, shape);
    near(water.volume(), volume, 128 * Number.EPSILON * volume);
    near(fluid.totals[0] + mass * nextX, mass * initialX, 64 * 2 ** -24 * mass);
    near(fluid.totals[1] + mass * nextZ, mass * initialZ, 64 * 2 ** -24 * mass);
    const nextEnergy = fluid.energy + 0.5 * mass * (nextX * nextX + nextZ * nextZ);
    assert.ok(nextEnergy < energy);
    energy = nextEnergy;
    if (tick === 8) snap = world.takeSnapshot();
  }
  const hash = world.hash();
  world.restoreSnapshot(snap.bytes);
  world.advance(24);
  assert.equal(world.hash(), hash);
});

test('blockage factories require geometry and provide the coded repair', async () => {
  const error = {
    name: 'MargoError',
    code: 'unsupported',
    message: /Provide a moving cylinder radius.+#hydrodynamic-loads/,
  };
  await assert.rejects(ShallowWaterSolver.withCylinder(undefined), error);
  await assert.rejects(ShallowWaterSolver.withRigidCylinder(undefined), error);
  await assert.rejects(ShallowWaterSolver.withRigidFootprint(undefined), error);
});

test('unsupported footprint geometry is refused before cut-cell stepping', async () => {
  await assert.rejects(
    ShallowWaterSolver.withRigidFootprint({
      bodyRow: 0,
      centre: [0, 0],
      footprint: [
        [-1, -1],
        [1, -1],
        [0.2, 0.3],
        [1, 1],
        [-1, 1],
      ],
    }),
    /strictly convex/,
  );
  const { water } = await ShallowWaterSolver.withRigidFootprint({
    bodyRow: 0,
    centre: [0, 0],
    footprint: [
      [-0.25, -0.2],
      [0.25, -0.2],
      [0.25, 0.2],
      [-0.25, 0.2],
    ],
  });
  const bed = bedSurface(
    { columns: GRID.nx, rows: GRID.nz, width: WIDTH, depth: DEPTH, centre: [0, 0] },
    new Float64Array((GRID.nx + 1) * (GRID.nz + 1)),
  );
  assert.throws(
    () =>
      new PhysicsWorld({ gravity: [0, -G, 0] }).add(water, {
        bed,
        depth: HEIGHT,
        sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
      }),
    /exceeds the cut-cell capacity/,
  );
});

test('a nearly capacity-filling guided footprint holds exact rest down to the wet-depth boundary', async () => {
  await Physics.load();
  const hx = 0.219;
  const hz = 0.1792;
  const footprint = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  const openFraction = 1 - (4 * hx * hz) / AREA;
  const frames = 16;
  for (const depth of [HEIGHT, 1.0625 * DRY]) {
    using physics = new Physics(null, { gravity: [0, -G, 0], fixedTimestep: 1 / RATE.num });
    const { body, water, world } = await guidedCylinder(physics, 512, footprint, { velocity: [0, 0, 0], depth });
    const start = water.volume();
    let first;
    for (let tick = 1; tick <= frames; tick++) {
      world.advance(tick);
      if (tick === 1) first = world.takeSnapshot();
      assert.equal(water.volume(), start);
      assert.deepEqual(body.linearVelocity, [0, 0, 0]);
      for (let j = 0; j < GRID.nz; j++) {
        for (let i = 0; i < GRID.nx; i++) {
          const fluid = water.sample((i + 0.5) * GRID.dx - WIDTH / 2, (j + 0.5) * GRID.dz - DEPTH / 2);
          assert.equal(fluid.depth, depth);
          assert.deepEqual(fluid.velocity, [0, 0]);
        }
      }
    }
    const speed = Math.sqrt(G * depth) * (1 / GRID.dx + 1 / GRID.dz);
    const substeps = Math.ceil(speed / (0.4 * openFraction * RATE.num));
    assert.deepEqual(water.work, { steps: frames, substeps: frames * substeps });
    const hash = world.hash();
    world.restoreSnapshot(first.bytes);
    world.advance(frames);
    assert.equal(world.hash(), hash);
  }
});
