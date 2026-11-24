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
