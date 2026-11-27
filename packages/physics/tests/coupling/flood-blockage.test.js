import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import {
  DRY,
  FORCING_WORDS,
  ShallowWaterSolver,
  SURFACE_WATER_FIELD,
  SURFACE_WATER_FORCING_FIELD,
} from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_WORDS,
  IMPULSE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';
import { floodBlockageExchange } from '../../dist/loads.js';

const CELL = [0, 0, 0];
const RATE = { num: 60, den: 1 };
const density = 1000;
const interval = 1 / RATE.num;
const area = 2;
const dragCoefficient = 1.24;
const wetArea = 0.7;

function near(actual, expected, bound = 128 * Number.EPSILON * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} != ${expected} within ${bound}`);
}

function kinetic(m, u) {
  return 0.5 * m * u.reduce((energy, value) => energy + value * value, 0);
}

test('SEA-12 matches the implicit quadratic drag solution for finite water and body mass', () => {
  const waterMass = density * area * 0.8;
  const rigidMass = 16;
  const reduced = 1 / (1 / waterMass + 1 / rigidMass);
  const initialSpeed = 1.3;
  const result = floodBlockageExchange({
    cells: [{ index: 6, depth: 0.8, weight: 2, x: 3.5, z: -2, dischargeX: 0.8 * initialSpeed, dischargeZ: 0 }],
    body: {
      centre: [3.5, 1, -2],
      velocity: CELL,
      angularVelocity: CELL,
      inverseMass: 1 / rigidMass,
      inverseInertia: [0, 0, 0, 0, 0, 0],
    },
    cellArea: area,
    density,
    interval,
    dragCoefficient,
    wetArea,
    elevation: 1,
  });
  // For collinear motion, the implicit speed solves q + (gamma dt / m_reduced) q² = q_old.
  const gamma = 0.5 * density * wetArea * dragCoefficient;
  const nextSpeed = (2 * initialSpeed) / (1 + Math.sqrt(1 + (4 * gamma * interval * initialSpeed) / reduced));
  const expected = reduced * (initialSpeed - nextSpeed);
  near(result.bodyImpulse[0], expected);
  near(result.cellImpulses[0][1], -expected);
  assert.equal(result.cellImpulses[0][0], 6);
  near(result.dissipatedEnergy, 0.5 * reduced * (initialSpeed * initialSpeed - nextSpeed * nextSpeed));
});

test('SEA-12 matches cell and body linear/angular impulses and dissipates coupled kinetic energy with eccentric loading', () => {
  const cells = [
    { index: 0, depth: 0.2, weight: 2, x: -1, z: 0.3, dischargeX: 0.8, dischargeZ: -0.17 },
    { index: 3, depth: 0.9, weight: 5, x: 0.4, z: 1.3, dischargeX: 0.15, dischargeZ: 0.64 },
    { index: 4, depth: 0.6, weight: 1, x: 0.4, z: -0.7, dischargeX: -0.35, dischargeZ: 0.24 },
  ];
  const body = {
    centre: [0.15, 0.3, -0.2],
    velocity: [0.1, 0.03, -0.18],
    angularVelocity: [-0.15, 0.27, -0.4],
    inverseMass: 1 / 3,
    inverseInertia: [1.7, 0, 0, 0.9, 0, 1.1],
  };
  const elevation = 0.08;
  const result = floodBlockageExchange({
    body,
    cells,
    elevation,
    dragCoefficient,
    wetArea,
    cellArea: area,
    density,
    interval,
  });
  const [jx, , jz, tx, ty, tz] = result.bodyImpulse;
  const inertia = [1 / 1.7, 1 / 0.9, 1 / 1.1];
  const nextBody = [
    body.velocity[0] + jx * body.inverseMass,
    body.velocity[1],
    body.velocity[2] + jz * body.inverseMass,
  ];
  const nextSpin = body.angularVelocity.map((w, i) => w + [tx, ty, tz][i] / inertia[i]);
  let loss = kinetic(1 / body.inverseMass, body.velocity) - kinetic(1 / body.inverseMass, nextBody);
  loss += body.angularVelocity.reduce(
    (energy, omega, i) => energy + 0.5 * inertia[i] * (omega * omega - nextSpin[i] * nextSpin[i]),
    0,
  );
  const total = [jx, jz, tx, ty, tz];
  const nextWater = [0, 0];
  const barycentre = [0, elevation, 0];
  for (const [i, cell] of cells.entries()) {
    const weight = cell.weight / 8;
    const m = density * cell.depth * area;
    const before = [cell.dischargeX / cell.depth, cell.dischargeZ / cell.depth];
    const [, dx, dz] = result.cellImpulses[i];
    const after = [before[0] + dx / m, before[1] + dz / m];
    const [rx, ry, rz] = [cell.x - body.centre[0], elevation - body.centre[1], cell.z - body.centre[2]];
    total[0] += dx;
    total[1] += dz;
    total[2] += ry * dz;
    total[3] += rz * dx - rx * dz;
    total[4] -= ry * dx;
    loss += kinetic(m, before) - kinetic(m, after);
    nextWater[0] += weight * after[0];
    nextWater[1] += weight * after[1];
    barycentre[0] += weight * cell.x;
    barycentre[2] += weight * cell.z;
  }
  total.forEach((value) => near(value, 0));
  const [rx, ry, rz] = barycentre.map((v, i) => v - body.centre[i]);
  const relativeX = nextWater[0] - (nextBody[0] + nextSpin[1] * rz - nextSpin[2] * ry);
  const relativeZ = nextWater[1] - (nextBody[2] + nextSpin[0] * ry - nextSpin[1] * rx);
  const resistance = 0.5 * density * wetArea * dragCoefficient * interval * Math.hypot(relativeX, relativeZ);
  near(jx, resistance * relativeX);
  near(jz, resistance * relativeZ);
  assert.ok(loss > 0);
  near(loss, result.dissipatedEnergy, 256 * Number.EPSILON * 7000);
});

function coupleWetCell(bodyRow) {
  let host, waterForcing, bodyImpulses;
  return {
    describe() {
      return {
        id: 'flood-drag-exchange',
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: SURFACE_WATER_FIELD, access: 'read' },
          { field: BODIES_FIELD, access: 'read' },
          { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
          { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        ],
      };
    },
    init(solverHost) {
      host = solverHost;
      waterForcing = host.allocate('wet-cell-drag', FORCING_WORDS * 8, 'f64', 1);
      bodyImpulses = host.allocate('wet-cell-body-impulses', host.bodyRows() * IMPULSE_WORDS * 8, 'f64', 1);
    },
    step({ inputs }, dt) {
      const water = regionWords(host.memory, inputs.get(SURFACE_WATER_FIELD.name).region);
      const bodies = regionWords(host.memory, inputs.get(BODIES_FIELD.name).region);
      const [depth, dischargeX, dischargeZ] = water;
      const [cx, cy, cz, ux, uy, uz, wx, wy, wz, inverseMass, xx, xy, xz, yy, yz, zz] = bodies.subarray(
        bodyRow * BODY_WORDS + 7,
        bodyRow * BODY_WORDS + 23,
      );
      const exchange = floodBlockageExchange({
        cells: depth > DRY ? [{ index: 0, x: 0, z: 0, weight: 1, depth, dischargeX, dischargeZ }] : [],
        body: {
          centre: [cx, cy, cz],
          velocity: [ux, uy, uz],
          angularVelocity: [wx, wy, wz],
          inverseMass,
          inverseInertia: [xx, xy, xz, yy, yz, zz],
        },
        cellArea: area,
        density,
        interval: dt,
        dragCoefficient,
        wetArea,
        elevation: cy,
      });
      const force = regionWords(host.memory, waterForcing);
      force.fill(0);
      for (const [, jx, jz] of exchange.cellImpulses) {
        force[0] = jx / (density * area * dt);
        force[1] = jz / (density * area * dt);
      }
      regionWords(host.memory, bodyImpulses).set(exchange.bodyImpulse, bodyRow * IMPULSE_WORDS);
    },
    importPorts() {},
    exportPorts(tick) {
      return [
        { field: SURFACE_WATER_FORCING_FIELD.name, region: waterForcing, cell: CELL, tick },
        { field: BODY_IMPULSES_FIELD.name, region: bodyImpulses, cell: CELL, tick },
      ];
    },
    stateRegions() {
      return [waterForcing, bodyImpulses];
    },
    extraState() {
      return [];
    },
  };
}

async function fixture(depth) {
  await Physics.load();
  const world = new PhysicsWorld({ rate: RATE, gravity: CELL, memory: worldMemory(false) });
  const physics = new Physics(null, { fixedTimestep: interval, gravity: CELL, arena: world.arena });
  const body = physics.addBody(null, {
    position: [0, 0.25, 0],
    linearDamping: 0,
    angularDamping: 0,
    colliders: { shape: 'sphere', radius: 0.25, mass: 16 },
  });
  const coupling = coupleWetCell(body.row);
  const water = new ShallowWaterSolver();
  const bed = bedSurface({ columns: 1, rows: 1, width: 2, depth: 1, centre: [0, 0] }, new Float64Array(4));
  world
    .add(new RigidSolver(), { physics })
    .add(water, {
      bed,
      depth,
      velocity: () => [1.25, -0.375],
      density,
      roughness: 0,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    })
    .add(coupling, {})
    .couple(['flood-drag-exchange', 'water', 'rigid'], 'staggered');
  return { world, body, water, physics };
}

test('a live wet HYDRO-01 cell and a rigid body conserve water volume and horizontal momentum and replay', async () => {
  const { world, body, water, physics } = await fixture(0.75);
  try {
    const mass = 16;
    const volume = water.volume();
    const waterMass = density * volume;
    const initial = water.sample(0, 0).velocity;
    let energy = kinetic(waterMass, initial);
    world.advance(1);
    const snapshot = world.takeSnapshot();
    const check = () => {
      assert.equal(water.volume(), volume);
      const current = water.sample(0, 0).velocity;
      const rigid = body.linearVelocity;
      assert.ok(rigid[0] > 0 && rigid[2] < 0 && current[0] < initial[0] && current[1] > initial[1]);
      // Only the rigid port/kernel rounds momentum to f32.
      near(waterMass * current[0] + mass * rigid[0], waterMass * initial[0], 16 * 2 ** -24 * mass);
      near(waterMass * current[1] + mass * rigid[2], waterMass * initial[1], 16 * 2 ** -24 * mass);
      const nextEnergy = kinetic(waterMass, current) + kinetic(mass, rigid);
      assert.ok(nextEnergy < energy);
      energy = nextEnergy;
    };
    check();
    world.advance(4);
    check();
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(4);
    assert.equal(world.hash(), hash);
  } finally {
    physics.dispose();
  }
});

test('the wet-cell adapter leaves an initially dry cell and its body unchanged', async () => {
  const { world, body, water, physics } = await fixture(0);
  try {
    world.advance(2);
    assert.equal(water.volume(), 0);
    assert.deepEqual(body.linearVelocity, [0, 0, 0]);
  } finally {
    physics.dispose();
  }
});
