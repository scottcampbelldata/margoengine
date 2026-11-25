// The integration parameters of Rapier that the own kernel takes: where friction is solved, the friction model, the number of
// relaxing passes, and how the continuous-collision sweep stops.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

test('the parameters read back, take their defaults and refuse what makes no sense', () => {
  const physics = new Physics(null);
  const solver = physics.solver;
  assert.equal(solver.frictionInBiasPass, true);
  assert.equal(solver.internalStabilizationIterations, null);
  assert.equal(solver.frictionModel, 'coulomb');
  assert.equal(solver.minCcdDt, 0);
  assert.ok(Math.abs(solver.ccdTolerance - 0.001) < 1e-9);
  assert.equal(solver.ccdMaxAdvances, 64);
  physics.setSolver({
    frictionInBiasPass: false,
    internalStabilizationIterations: 3,
    frictionModel: 'simplified',
    minCcdDt: 1 / 6000,
    ccdTolerance: 0.01,
    ccdMaxAdvances: 8,
  });
  const set = physics.solver;
  assert.equal(set.frictionInBiasPass, false);
  assert.equal(set.internalStabilizationIterations, 3);
  assert.equal(set.frictionModel, 'simplified');
  assert.ok(Math.abs(set.minCcdDt - 1 / 6000) < 1e-9);
  assert.equal(set.ccdMaxAdvances, 8);
  physics.setSolver({ internalStabilizationIterations: null });
  assert.equal(physics.solver.internalStabilizationIterations, null, 'null is the default again');
  assert.throws(() => physics.setSolver({ frictionModel: 'sticky' }), /frictionModel/);
  assert.throws(() => physics.setSolver({ internalStabilizationIterations: -1 }), /internalStabilizationIterations/);
  assert.throws(() => physics.setSolver({ internalStabilizationIterations: 1.5 }), /internalStabilizationIterations/);
  assert.throws(() => physics.setSolver({ minCcdDt: -1 }), /minCcdDt/);
  assert.throws(() => physics.setSolver({ ccdTolerance: 0 }), /ccdTolerance/);
  assert.throws(() => physics.setSolver({ ccdMaxAdvances: 1e6 }), /ccdMaxAdvances/);
  physics.dispose();
});

test('a block holds on a slope under mu and slides above it with every friction setting', () => {
  const run = (options, tangent) => {
    const c = 1 / Math.sqrt(1 + tangent * tangent),
      physics = new Physics(null, { gravity: [9.81 * tangent * c, -9.81 * c, 0] });
    physics.setSolver(options);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
    const block = physics.addBody(null, {
      position: [0, 0.25, 0],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.5, 0.25, 0.5] },
    });
    for (let i = 0; i < 300; i++) physics.step();
    const x = block.position[0];
    for (let i = 0; i < 300; i++) physics.step();
    const moved = block.position[0] - x;
    physics.dispose();
    return moved;
  };
  for (const options of [
    {},
    { frictionInBiasPass: false },
    { frictionModel: 'simplified' },
    { frictionModel: 'simplified', frictionInBiasPass: false, internalStabilizationIterations: 2 },
    { internalStabilizationIterations: 0 },
  ]) {
    assert.ok(Math.abs(run(options, 0.4)) < 1e-4, `holds at tan 0.4 with ${JSON.stringify(options)}`);
    assert.ok(run(options, 0.6) > 1, `slides at tan 0.6 with ${JSON.stringify(options)}`);
  }
});

test('a continuous-collision sweep stops by the tolerance and advance count it is given', () => {
  const shot = (options) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    physics.setSolver(options);
    physics.addBody(null, {
      type: 'fixed',
      position: [10, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.01, 6, 6] },
    });
    const ball = physics.addBody(null, {
      position: [6, 0, 0],
      linearVelocity: [300, 0, 0],
      ccd: true,
      colliders: { shape: 'sphere', radius: 0.05 },
    });
    physics.step();
    const x = ball.position[0];
    physics.dispose();
    return x;
  };
  const near = shot({});
  assert.ok(near <= 9.94 + 1e-4 && near >= 9.94 - 2e-3, `within a millimetre of the wall: ${near}`);
  const wide = shot({ ccdTolerance: 0.05 });
  assert.ok(wide < 9.94 - 0.02, `a 5 cm tolerance stops further off: ${wide}`);
  assert.equal(shot({ minCcdDt: 1 / 60 }), 6, 'a time floor of a whole step takes no advance');
  assert.equal(shot({ ccdMaxAdvances: 0 }), 6, 'no advances, nothing found');
});

test('a body that leaves the numbers stops the world, or is quarantined and reported when asked', () => {
  const build = (quarantine) => {
    const physics = new Physics(null);
    physics.setSolver({ quarantine });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
    const wild = physics.addBody(null, { position: [5, 1, 0], colliders: { shape: 'sphere', radius: 0.25 } }),
      calm = physics.addBody(null, { position: [0, 0.25, 0], colliders: { shape: 'sphere', radius: 0.25 } });
    wild.setLinearVelocity([1e20, 0, 0]);
    return { physics, wild, calm };
  };
  const stopped = build(false);
  assert.throws(() => stopped.physics.step(), { code: 'failed' });
  stopped.physics.dispose();
  const { physics, wild, calm } = build(true),
    told = [];
  physics.on('quarantine', (event) => told.push(event.body));
  for (let i = 0; i < 60; i++) physics.step();
  assert.deepEqual(told, [wild], 'told once, and which body');
  assert.deepEqual(physics.quarantined, [wild]);
  assert.deepEqual(wild.linearVelocity, [0, 0, 0]);
  assert.ok(
    Math.abs(wild.position[0] - 5) < 1e-6 && Math.abs(wild.position[1] - 1) < 1e-6,
    'left where the last good step ended',
  );
  assert.ok(Math.abs(calm.position[1] - 0.25) < 0.01, 'the world went on');
  assert.equal(physics.solver.quarantine, true);
  physics.dispose();
});

test('contact recycling and clustering read back, refuse bad values and keep a scene standing', () => {
  const physics = new Physics(null);
  assert.equal(physics.solver.contactRecycling, false);
  assert.equal(physics.solver.contactClustering, false);
  physics.setSolver({ contactRecycling: true, contactClustering: true });
  assert.equal(physics.solver.contactRecycling, true);
  assert.ok(Math.abs(physics.solver.contactRecycleDistance - 0.05) < 1e-6, 'the distance is Rapier\'s default');
  assert.ok(Math.abs(physics.solver.contactClusteringAngle - 0.1) < 1e-6);
  physics.setSolver({ contactRecycleDistance: 0.02, contactClusteringAngle: 0.2 });
  assert.ok(Math.abs(physics.solver.contactRecycleDistance - 0.02) < 1e-6);
  assert.ok(Math.abs(physics.solver.contactClusteringAngle - 0.2) < 1e-5);
  physics.setSolver({ contactRecycling: false });
  assert.equal(physics.solver.contactRecycling, false);
  assert.ok(Math.abs(physics.solver.contactRecycleDistance - 0.02) < 1e-6, 'the distance stays for the next time');
  assert.throws(() => physics.setSolver({ contactRecycleDistance: 0 }), /contactRecycleDistance/);
  assert.throws(() => physics.setSolver({ contactClusteringAngle: 2 }), /contactClusteringAngle/);
  physics.dispose();

  const stack = (options) => {
    const world = new Physics(null);
    world.setSolver(options);
    world.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } });
    const boxes = [0, 1, 2, 3].map((k) =>
      world.addBody(null, { position: [0, 0.3 + 0.52 * k, 0], colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25] } }),
    );
    for (let i = 0; i < 240; i++) world.step();
    const ys = boxes.map((box) => box.position[1]);
    world.dispose();
    return ys;
  };
  const plain = stack({}),
    recycled = stack({ contactRecycling: true });
  plain.forEach((y, k) => assert.ok(Math.abs(y - recycled[k]) < 2e-3, `box ${k}: ${y} against ${recycled[k]}`));

  // A trimesh floor of 18 triangles in one plane: with clustering the solver holds a plane on four points, not on every triangle's.
  const meshed = (options) => {
    const world = new Physics(null);
    world.setSolver(options);
    const n = 6,
      cell = 0.4,
      vertices = [],
      indices = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices.push(i * cell - (n * cell) / 2, 0, j * cell - (n * cell) / 2);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j,
          b = (i + 1) * (n + 1) + j;
        indices.push(a, b + 1, b, a, a + 1, b + 1);
      }
    world.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices: new Float32Array(vertices), indices: new Uint32Array(indices) } });
    const box = world.addBody(null, { position: [0.05, 0.26, 0.05], canSleep: false, colliders: { shape: 'box', halfExtents: [0.5, 0.25, 0.5] } });
    for (let i = 0; i < 240; i++) world.step();
    const c = world.kernel.columns;
    let held = 0;
    for (let row = 0; row < c.pairContacts.length; row++) held += c.pairContacts[row];
    const y = box.position[1];
    world.dispose();
    return { held, y };
  };
  const many = meshed({}),
    four = meshed({ contactClustering: true });
  assert.ok(many.held > 4, `without clustering: ${many.held} points`);
  assert.ok(four.held <= 4 && four.held >= 3, `with clustering: ${four.held} points`);
  assert.ok(Math.abs(many.y - 0.25) < 0.01 && Math.abs(four.y - 0.25) < 0.01, `the box rests on both: ${many.y}, ${four.y}`);
});

test('the tree broad phase, its build and rotations and the adaptive margin give the same world', () => {
  const run = (options) => {
    const world = new Physics(null);
    world.setSolver(options);
    world.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [30, 0.5, 30] } });
    const bodies = [];
    for (let i = 0; i < 80; i++)
      bodies.push(
        world.addBody(null, {
          position: [(i % 8) * 1.1, 1 + Math.floor(i / 8) * 1.1, (i % 3) * 0.2],
          colliders: { shape: i % 2 ? 'box' : 'sphere', halfExtents: [0.5, 0.5, 0.5], radius: 0.5 },
        }),
      );
    for (let i = 0; i < 240; i++) world.step();
    const ys = bodies.map((body) => body.position[1]);
    const asleep = bodies.filter((body) => body.sleeping).length;
    world.dispose();
    return { ys, asleep };
  };
  const sweep = run({});
  assert.ok(sweep.ys.every((y) => y > 0.4 && y < 12), 'the pile stands on the floor');
  for (const options of [
    { broadPhase: 'bvh' },
    { broadPhase: 'bvh', bvhBuildStrategy: 'binned' },
    { broadPhase: 'bvh', bvhBuildStrategy: 'ploc', bvhOptimizationStrategy: 'rotations' },
    { adaptiveChangeDetectionMargin: true },
  ]) {
    const other = run(options);
    assert.ok(other.ys.every((y) => y > 0.4 && y < 12), `the pile stands with ${JSON.stringify(options)}`);
    const worst = Math.max(...other.ys.map((y, i) => Math.abs(y - sweep.ys[i])));
    assert.ok(worst < 1.5, `and rests where the sweep's pile does (${worst} m apart): ${JSON.stringify(options)}`);
  }
  const physics = new Physics(null);
  assert.equal(physics.solver.broadPhase, 'sweep');
  assert.equal(physics.solver.bvhBuildStrategy, 'incremental');
  assert.equal(physics.solver.bvhOptimizationStrategy, 'none');
  assert.equal(physics.solver.adaptiveChangeDetectionMargin, false);
  physics.setSolver({ broadPhase: 'bvh', bvhBuildStrategy: 'ploc', bvhOptimizationStrategy: 'rotations', adaptiveChangeDetectionMargin: true });
  assert.deepEqual(
    [physics.solver.broadPhase, physics.solver.bvhBuildStrategy, physics.solver.bvhOptimizationStrategy, physics.solver.adaptiveChangeDetectionMargin],
    ['bvh', 'ploc', 'rotations', true],
  );
  assert.throws(() => physics.setSolver({ broadPhase: 'octree' }), /broadPhase/);
  assert.throws(() => physics.setSolver({ bvhBuildStrategy: 'sah' }), /bvhBuildStrategy/);
  assert.throws(() => physics.setSolver({ bvhOptimizationStrategy: 'sometimes' }), /bvhOptimizationStrategy/);
  physics.dispose();
});

test('switching the broad phase of a running world keeps it going', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [30, 0.5, 30] } });
  const boxes = Array.from({ length: 20 }, (_, i) =>
    physics.addBody(null, { position: [(i % 5) * 1.2, 1 + Math.floor(i / 5) * 1.2, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
  );
  for (let i = 0; i < 60; i++) physics.step();
  physics.setSolver({ broadPhase: 'bvh' });
  for (let i = 0; i < 60; i++) physics.step();
  physics.setSolver({ broadPhase: 'sweep' });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(boxes.every((box) => box.position[1] > 0.4 && box.position[1] < 6), 'every box is still on the floor');
  physics.dispose();
});
