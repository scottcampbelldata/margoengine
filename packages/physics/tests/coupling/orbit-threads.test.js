import assert from 'node:assert/strict';
import test from 'node:test';
import { OrbitSolver } from '../../dist/orbit.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const farCell = [1_297_000_012, -845_120_011, 922_301_009];
const rate = { num: 60, den: 1 };
const bodies = [
  { position: [0, 0, 0], velocity: [0.02, 0.01, 0], mass: 3 },
  { position: [6, 0, 0.2], velocity: [0, 0.78, -0.01], dragAreaPerMass: 0.01 },
  { position: [-7, 0, -0.3], velocity: [0, -0.78, 0.01], mass: 1, dragAreaPerMass: 0.02 },
  { position: [2, 10, 0], velocity: [-0.7, 0.3, 0] },
  { position: [1, -10, 0.2], velocity: [0.7, 0.18, 0] },
  { position: [2, 10, 0], velocity: [-0.7, 0.3, 0] },
  { position: [11, 1, -0.2], velocity: [-0.01, 0.64, 0], mass: 0.3 },
  { position: [-2, 13, 1], velocity: [-0.77, -0.1, -0.01] },
  { position: [4, 15, 1.1], velocity: [-0.49, 0.12, 0] },
];
const options = {
  bodies,
  gravitationalConstant: 1,
  softening: 0.01,
  substeps: 2,
  primary: { body: 0, radius: 3, j2: 0.02, density: 0.25, scaleHeight: 1.3, angularVelocity: 0.04 },
};

async function make(t, threads, shared, specific = options) {
  const solver = await OrbitSolver.load({ threads });
  t.after(() => solver[Symbol.dispose]());
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate }).add(solver, specific, farCell);
  return { solver, world };
}

function state({ solver, world }, total = bodies.length) {
  return Array.from({ length: total }, (_, i) => solver.sample(i)).concat(solver.elapsedSeconds);
}

function mirrorCounts({ solver, world }, cell) {
  for (const field of [solver.positionField, solver.velocityField, solver.timeField]) {
    const port = world.fields.port(field.name);
    assert.deepEqual(port.cell, cell);
    assert.ok(regionWords(world.memory, port.region).every(Number.isFinite));
  }
}

function expectedWorkerCounts(threads, masses, sweeps) {
  const count = masses.length;
  const massive = masses.filter(Boolean).length;
  const tracers = count - massive;
  if (threads === 1)
    return [
      {
        pairGeometryEvaluations: (massive * tracers + (massive * (massive - 1)) / 2) * sweeps,
        sourceContributions: massive * (count - 1) * sweeps,
      },
    ];
  return Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    const operations =
      masses.slice(start, end).reduce((sum, mass) => sum + massive - Number(Boolean(mass)), 0) * sweeps;
    return { pairGeometryEvaluations: operations, sourceContributions: operations };
  });
}

test('native orbit partitions preserve all candidate rows through a signed far-cell shift and seek', async (t) => {
  const models = await Promise.all([make(t, 1, false), make(t, 1, true), make(t, 2, true), make(t, 4, true)]);
  const baseline = models[0];
  for (const model of models) {
    model.world.advance(5);
    mirrorCounts(model, farCell);
  }
  const checkpoints = models.map(({ world }) => world.takeSnapshot());
  const expectedSweeps = 7;
  for (const model of models) {
    const { world, solver } = model;
    world.shiftOrigin(farCell);
    mirrorCounts(model, [0, 0, 0]);
    world.advance(20);
    const counts = solver.workCounts();
    assert.equal(counts.forceEvaluations, expectedSweeps);
    assert.deepEqual(
      counts.workers,
      expectedWorkerCounts(
        counts.threads,
        bodies.map(({ mass }) => mass),
        expectedSweeps,
      ),
    );
    assert.equal(counts.sourceContributions, 168);
    assert.equal(counts.pairGeometryEvaluations, counts.threads === 1 ? 147 : 168);
  }
  const endpoint = baseline.world.takeSnapshot();
  const accepted = state(baseline);
  for (const [i, model] of models.entries()) {
    const { world } = model;
    assert.deepEqual(world.takeSnapshot().bytes, endpoint.bytes);
    assert.deepEqual(state(model), accepted);
    world.restoreSnapshot(checkpoints[i].bytes);
    mirrorCounts(model, farCell);
    world.shiftOrigin(farCell);
    world.advance(20);
    assert.deepEqual(world.takeSnapshot().bytes, endpoint.bytes);
  }
});

test('sparse orbit work follows interacting masses and preserves SIMD row tails', async (t) => {
  for (const count of [129, 513]) {
    const layout = Array.from({ length: count }, (_, i) => ({
      position: [10 + i, 0.8 * (i % 3), (i % 7) - 3],
      velocity: [0, 0.04 * i, 0],
      mass: i % 64 === 0 ? 5 : 0,
    }));
    const entries = [await make(t, 1, false, { bodies: layout }), await make(t, 4, true, { bodies: layout })];
    const sweeps = 4;
    for (const { solver, world } of entries) {
      world.advance(1);
      const work = solver.workCounts();
      assert.deepEqual(
        work.workers,
        expectedWorkerCounts(
          work.threads,
          layout.map(({ mass }) => mass),
          sweeps,
        ),
      );
      assert.equal(work.sourceContributions, sweeps * layout.filter(({ mass }) => mass).length * (count - 1));
    }
    assert.deepEqual(entries[0].world.takeSnapshot().bytes, entries[1].world.takeSnapshot().bytes);
    console.log('SPACE-01', count, 'bodies', entries[0].solver.workCounts(), entries[1].solver.workCounts());
  }
});

test('a singular threaded substep retains the accepted body rows, elapsed time and work', async (t) => {
  const model = await make(t, 2, true, {
    bodies: [
      { position: [0, 0, 0], mass: 1 },
      { position: [1, 0, 0], velocity: [0.5, 0, 0] },
    ],
    gravitationalConstant: 1,
    timeScale: 60,
    integrator: 'verlet',
  });
  const { solver, world } = model;
  world.advance(1);
  assert.equal(solver.sample(1).position[0], 1);
  assert.equal(solver.sample(1).velocity[0], -0.5);
  const previous = state(model, 2);
  const receipt = solver.workCounts();
  const checkpoint = world.takeSnapshot();
  for (let replay = 0; replay < 2; replay++) {
    assert.throws(() => world.advance(2), {
      name: 'MargoError',
      code: 'state',
      message: /reduce time scale or set softening/,
    });
    assert.deepEqual(state(model, 2), previous);
    assert.deepEqual(solver.workCounts(), receipt);
    mirrorCounts(model, farCell);
    world.restoreSnapshot(checkpoint.bytes);
  }
});

test('threaded orbit loading and disposal give coded corrections', async (t) => {
  await assert.rejects(OrbitSolver.load({ threads: 0 }), {
    name: 'MargoError',
    code: 'state',
    message: /whole number of orbit threads/,
  });
  const solver = await OrbitSolver.load({ threads: 2 });
  t.after(() => solver[Symbol.dispose]());
  assert.throws(() => new PhysicsWorld({ memory: worldMemory(false) }).add(solver, options), {
    name: 'MargoError',
    code: 'unsupported',
    message: /worldMemory\(true\)/,
  });
  const world = new PhysicsWorld({ memory: worldMemory(true), rate }).add(solver, options);
  world.advance(1);
  solver[Symbol.dispose]();
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    code: 'disposed',
    message: /Load a new solver/,
  });
});
