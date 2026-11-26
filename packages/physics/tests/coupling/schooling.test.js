import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCHOOL_INTENT_FIELD,
  SCHOOL_KINEMATICS_FIELD,
  SCHOOL_LAYOUT,
  SCHOOL_PREDATORS_FIELD,
  SchoolSolver,
} from '@margoengine/physics/schooling';
import { HeatConduction } from '@margoengine/physics/thermal';
import { isShared, PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const origin = [0, 0, 0];
const still = (position) => ({ position, velocity: origin });
const close = (got, want, epsilon = 32 * Number.EPSILON) => {
  assert.ok(Math.abs(got - want) <= epsilon * Math.max(1, Math.abs(want)), String(got) + ' vs ' + want);
};

function bodyField(field, bodies) {
  let host, region;
  const words = () => new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
  return {
    describe: () => ({
      id: field.name + '-writer',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field, access: 'write' }],
    }),
    init(owner) {
      host = owner;
      region = host.allocate(field.name, bodies.length * 48, 'f64', SCHOOL_LAYOUT);
      for (const [i, body] of bodies.entries()) {
        words().set(body.position, i * 6);
        words().set(body.velocity, i * 6 + 3);
      }
    },
    step(_context, dt) {
      const rows = words();
      for (let i = 0; i < rows.length; i += 6) for (let j = 0; j < 3; j++) rows[i + j] += rows[i + 3 + j] * dt;
    },
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: origin }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('SchoolSolver follows repulsion, topological ranking, visible sectors and stable tie ordering', async () => {
  const p = { maxThrust: 0, velocity: [1, 0, 0] };
  const neighbours = [
    { position: [0, 0, 0], ...p },
    { ...p, position: [0, 0, 1], velocity: [0, 0, 1] },
    { ...p, position: [0, 0, -1], velocity: [0, -1, 0] },
    { ...p, position: [-0.75, 0, 0], velocity: [-1, 0, 0] },
  ];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const school = await SchoolSolver.load();
  world.add(school, {
    members: neighbours,
    neighbours: 1,
    visionDot: 0,
    repulsionRadius: 0.1,
    orientationRadius: 1.5,
    attractionRadius: 4,
  });
  world.advance(1);
  assert.deepEqual(
    school.read(0).intent,
    [0, 0, 1],
    'rear neighbor excluded and lower row wins the equal-distance tie',
  );

  const overlap = await SchoolSolver.load();
  const opposite = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  opposite.add(overlap, { members: [neighbours[0], { ...neighbours[1], position: origin }], neighbours: 1 });
  opposite.advance(1);
  const a = overlap.read(0).intent;
  const b = overlap.read(1).intent;
  assert.equal(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1);
  assert.equal(a[0] * a[0] + a[1] * a[1] + a[2] * a[2], 1);
});

test('BB-4 a point school obeys instantaneous lateral acceleration and local curvature bounds', async () => {
  const school = await SchoolSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  world.add(school, {
    members: [
      {
        position: origin,
        velocity: [2, 0, 0],
        mass: 2,
        maxThrust: 8,
        minimumTurnRadius: 10,
        maxLateralAcceleration: 0.6,
      },
      { position: [0, 1, 0], velocity: [0, 2, 0], maxThrust: 0 },
    ],
    cruiseSpeed: 2,
    responseSeconds: 0.5,
  });
  world.advance(1);
  const { velocity, intent, position } = school.read(0);
  assert.deepEqual(intent, [0, 2, 0]);
  const lat = velocity[1] * 60;
  close(lat, Math.min(0.6, (2 * 2) / 10));
  close(2 - velocity[0], 8 / (2 * Math.sqrt(2)) / 60);
  close(position[0], velocity[0] / 60);
});

test('uniform current gives the exact quadratic coasting law in the local cell', async () => {
  const school = await SchoolSolver.load({ level: 1 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 512 });
  const calls = [];
  world.add(
    school,
    {
      members: [{ position: origin, velocity: [2, 0, 0], mass: 2, dragArea: 0.004, maxThrust: 0 }],
      cellSize: world.cellSize,
      flow: {
        cell: [6, 0, 0],
        medium: 'water',
        sample(x, y, z, t) {
          calls.push([x, y, z, t]);
          return { velocity: [0.5, 0, 0], density: 1000, temperature: 280 };
        },
      },
    },
    [7, 0, 0],
  );
  world.advance(60);
  assert.deepEqual(calls[0], [512, 0, 0, 0]);
  assert.equal(calls.length, 120);
  const u = 1.5;
  const specificDrag = (0.5 * 1000 * 0.004) / 2;
  close(school.read(0).velocity[0], 0.5 + u / (1 + specificDrag * u), 192 * Number.EPSILON);
});

test('a cross-current does not double-count drift as a swimming heading', async () => {
  const school = await SchoolSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  world.add(school, {
    members: [
      { position: origin, velocity: [3, 0, 1] },
      { position: [0, 0, 1], velocity: [3, 0, 1] },
    ],
    flow: {
      cell: origin,
      medium: 'water',
      sample: () => ({ velocity: [3, 0, 0], density: 1000, temperature: 280 }),
    },
  });
  world.advance(60);
  assert.deepEqual(school.read(0).intent, [0, 0, 1]);
  assert.deepEqual(school.read(0).velocity, [3, 0, 1]);
  assert.deepEqual(school.read(1).intent, [0, 0, 1]);
});

const reef = [still([-0.4, 0, 0]), still([0.4, 0, 0]), still([0, 0, -0.4]), still([0, 0, 0.4])];
const predator = { position: [0, -3.5, 0], velocity: [0, 8, 0] };

function reefWorld(school, rate) {
  return new PhysicsWorld({ rate }).add(bodyField(SCHOOL_PREDATORS_FIELD, [predator]), {}, [0, 0, 0]).add(
    school,
    {
      members: reef,
      predatorCount: 1,
      repulsionRadius: 0.12,
      orientationRadius: 0.12,
      attractionRadius: 5,
      predatorRadius: 1.2,
      predictionSeconds: 0.65,
      responseSeconds: 0.3,
    },
    [0, 0, 0],
  );
}

function reefSpread(school) {
  let s = 0;
  for (let i = 0; i < reef.length; i++) {
    const [x, , z] = school.read(i).position;
    s += x * x + z * z;
  }
  return Math.sqrt(s / reef.length);
}

test('BB-6 a predator on a crossing course disperses a school, which tightens after it passes', async () => {
  const school = await SchoolSolver.load({ readPredators: true });
  const world = reefWorld(school, { num: 60, den: 1 });
  const initial = reefSpread(school);
  world.advance(1);
  assert.ok(school.read(0).intent[0] < 0, 'prey acts before the predator reaches the ring');
  world.advance(36);
  const scattered = reefSpread(school);
  assert.ok(scattered > initial, 'steering increased spatial spread ' + scattered + ' vs ' + initial);
  world.advance(136);
  assert.ok(reefSpread(school) < scattered, 'local attraction tightens the group after the predator passes');
});

test('school and predator ports replay at 24, 30 and 60 fps and through snapshot restore', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => SchoolSolver.load({ readPredators: true })));
  frameRateIndependent((rate) => reefWorld(solvers.shift(), rate), { seconds: 2 });
  seekEqualsContinuous(() => reefWorld(solvers.shift(), { num: 24, den: 1 }));
});

test('AVIARY-3 school intent reaches a level bank controller through a versioned port after arena growth', async () => {
  const school = await SchoolSolver.load({ mode: 'intent' });
  const rows = [
    { position: [0, 0, 0], velocity: [4, 0, 0] },
    { position: [0, 0, 1], velocity: [0, 0, 4] },
  ];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 512 });
  let expectedBankNormal;
  let host;
  const controller = {
    describe: () => ({
      id: 'body-controller',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: SCHOOL_INTENT_FIELD, access: 'read' }],
    }),
    init(owner) {
      host = owner;
      host.allocate('memory-grow-test', 300_000, 'u8', 1);
    },
    step(context) {
      const { region } = context.inputs.get(SCHOOL_INTENT_FIELD.name);
      assert.equal(region.layout, SCHOOL_LAYOUT);
      const commands = new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
      assert.deepEqual(Array.from(commands.slice(0, 3)), [0, 0, 4]);
      // Over this one-second response time the controller requests the lateral velocity change.
      // Its lift vector must balance gravity and supply that lateral acceleration.
      const responseSeconds = 1;
      const lateral = (commands[2] - rows[0].velocity[2]) / responseSeconds;
      const gravity = -host.gravity[1];
      const length = Math.sqrt(gravity * gravity + lateral * lateral);
      expectedBankNormal = [0, gravity / length, lateral / length];
    },
    exportPorts: () => [],
    importPorts() {},
    stateRegions: () => [],
    extraState: () => [],
  };
  world
    .add(bodyField(SCHOOL_KINEMATICS_FIELD, rows), {}, [2, 0, 0])
    .add(school, { members: rows, cruiseSpeed: 4, cellSize: world.cellSize }, [1, 0, 0])
    .add(controller, {});
  world.advance(1);
  assert.equal(expectedBankNormal[0], 0);
  close(expectedBankNormal[2] / expectedBankNormal[1], 4 / 9.80665);
  close(school.read(0).position[0], 512 + 4 / 60);
  assert.deepEqual(school.read(0).velocity, [4, 0, 0]);
});

test('independent school instances share arena memory and retain separate scratch and intent fields', async () => {
  const a = await SchoolSolver.load();
  const b = await SchoolSolver.load({ id: 'reef-b', fields: { intent: 'reef-b-intent' } });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  world.add(a, {
    members: Array.from({ length: 800 }, (_, i) => ({
      ...still([i % 20, 0, Math.floor(i / 20)]),
      maxThrust: 0,
    })),
    neighbours: 7,
  });
  world.add(b, {
    members: [{ position: origin, velocity: [0, 1, 0], maxThrust: 0 }],
    cruiseSpeed: 2,
  });
  world.advance(2);
  assert.deepEqual(b.read(0).intent, [0, 2, 0]);
  assert.deepEqual(a.read(799).position, [19, 0, 39]);
  assert.equal(a.exportPorts(1)[0].field, 'schoolIntent');
  assert.equal(b.exportPorts(1)[0].field, 'reef-b-intent');
});

test('school validation tells the caller how to set invalid radii or repair the flow sample', async () => {
  const rate = { num: 60, den: 1 };
  const school = await SchoolSolver.load();
  const members = [still(origin)];
  assert.throws(
    () => new PhysicsWorld({ rate }).add(school, { members, repulsionRadius: 3 }),
    /Set .* radii in ascending order/i,
  );
  const world = new PhysicsWorld({ rate });
  world.add(school, {
    members,
    flow: {
      cell: origin,
      medium: 'air',
      sample: () => ({ velocity: [1, Number.NaN, 0], density: 1.225, temperature: 290 }),
    },
  });
  assert.throws(() => world.advance(1), /Provide a finite velocity triple/i);
});

test('load honours an already-aborted signal', async () => {
  const reason = new Error('stop this school load');
  await assert.rejects(SchoolSolver.load({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
});

test('default shared and explicit plain arenas give the same school and thermal states', async () => {
  const members = [still([0, 0, 0]), { position: [0, 0, 1], velocity: [0, 0, 1] }];
  const run = async (memory) => {
    const school = await SchoolSolver.load();
    const heat = await HeatConduction.load();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory });
    world.add(heat, {
      dimensions: [2, 1, 1],
      cellSize: [1, 1, 1],
      materials: { conductivity: 1, heatCapacity: 2 },
      initialTemperature: [300, 400],
    });
    world.add(school, { members });
    world.advance(30);
    assert.ok(school.read(0).position[2] > 0);
    assert.ok(heat.readTemperature()[0] > 300);
    return world.hash();
  };
  const shared = worldMemory();
  assert.ok(isShared(shared));
  assert.equal(await run(shared), await run(worldMemory(false)));
});
