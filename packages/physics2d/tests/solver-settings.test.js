// The solver's settings on the 2D world (Rapier's integration parameters and block solver): each one is read back, changes
// what the step does in a way a count shows, and a refused value changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

const stack = (options) => {
  const physics = new Physics2D(null, options);
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20 } });
  const boxes = [];
  for (let i = 0; i < 4; i++)
    boxes.push(
      physics.addBody(null, { position: [0, 70 - i * 21], colliders: { shape: 'box', width: 20, height: 20 } }),
    );
  return { physics, boxes };
};

test('a new world reads its defaults back', () => {
  const { physics } = stack();
  const solver = physics.solver;
  assert.equal(solver.substeps, 4);
  assert.equal(solver.iterations, 1);
  assert.equal(solver.blockSolver, true);
  assert.equal(solver.canSleep, true);
  assert.equal(solver.jointGeometricStiffness, true);
  assert.equal(solver.maxCcdSubsteps, 1);
  assert.equal(solver.minCcdDt, 0);
  assert.ok(
    Math.abs(solver.ccdTolerance - 0.005 / physics.scale) < 1e-6 / physics.scale,
    `ccdTolerance is 5 mm: ${solver.ccdTolerance}`,
  );
  assert.equal(solver.ccdMaxAdvances, 32);
  assert.equal(solver.warmStart, 1);
  assert.equal(solver.allowedPenetration, 0);
  assert.ok(
    Math.abs(solver.predictionDistance - 0.02 / physics.scale) < 1e-6 / physics.scale,
    `predictionDistance is 2 cm: ${solver.predictionDistance}`,
  );
  assert.equal(solver.staticContactHertz, null);
  assert.equal(solver.staticContactDamping, null);
  for (const [name, value] of Object.entries(solver))
    assert.ok(typeof value === 'boolean' || value === null || Number.isFinite(value), name);
  physics.dispose();
});

test('every setting reads back as it was set, speeds in world units a second', () => {
  const { physics } = stack({ pixelsPerMeter: 50 });
  const wanted = {
    substeps: 6,
    iterations: 3,
    contactHertz: 20,
    contactDamping: 5,
    contactMaxPush: 150,
    restitutionThreshold: 25,
    sleepThreshold: 4,
    sleepTime: 1,
    canSleep: false,
    blockSolver: false,
    jointHertz: 40,
    jointDamping: 3,
    jointMaxPush: 200,
    jointGeometricStiffness: false,
    maxCcdSubsteps: 3,
    minCcdDt: 0.002,
    ccdTolerance: 0.1,
    ccdMaxAdvances: 100,
    warmStart: 0.5,
    allowedPenetration: 0.5,
    predictionDistance: 2,
    staticContactHertz: 10,
    staticContactDamping: 2,
  };
  physics.setSolver(wanted);
  for (const [name, value] of Object.entries(physics.solver)) {
    if (typeof value === 'number')
      assert.ok(Math.abs(value - wanted[name]) <= 1e-4 * Math.abs(wanted[name]), `${name}: ${value}`);
    else assert.equal(value, wanted[name], name);
  }
  physics.dispose();
});

test('the block solver takes the two-point contacts together, and with it off they go one point at a time and still rest', () => {
  const on = stack();
  const off = stack();
  off.physics.setSolver({ blockSolver: false });
  for (let i = 0; i < 40; i++) {
    on.physics.step();
    off.physics.step();
  }
  const counted = [on.physics.counts, off.physics.counts];
  for (let i = 0; i < 260; i++) {
    on.physics.step();
    off.physics.step();
  }
  assert.ok(counted[0].blockSolves > 0 && counted[0].sequentialSolves === 0, JSON.stringify(counted[0]));
  assert.ok(counted[1].blockSolves === 0 && counted[1].sequentialSolves > 0, JSON.stringify(counted[1]));
  // Both stacks rest where four boxes of 20 stand on a floor whose top is at 90: the top box's centre at 20.
  for (const { boxes } of [on, off]) {
    assert.ok(Math.abs(boxes[3].position[1] - 20) < 0.5, `top box at ${boxes[3].position[1]}`);
    assert.ok(Math.abs(boxes[3].position[0]) < 0.2, `top box leaned to ${boxes[3].position[0]}`);
  }
  on.physics.dispose();
  off.physics.dispose();
});

test('substeps and iterations set how much work a step does: the solves a stack takes follow them', () => {
  const solves = (options) => {
    const { physics } = stack();
    physics.setSolver(options);
    for (let i = 0; i < 30; i++) physics.step();
    const { blockSolves, sequentialSolves } = physics.counts;
    physics.dispose();
    return blockSolves + sequentialSolves;
  };
  const base = solves({});
  assert.equal(solves({ substeps: 8 }), 2 * base);
  assert.equal(
    solves({ iterations: 2 }),
    2 * base,
    'two pushing passes and two relaxing ones solve twice as many contacts',
  );
});

test('a world that may not sleep stays awake, and one that may goes to sleep', () => {
  const awake = stack();
  awake.physics.setSolver({ canSleep: false });
  const asleep = stack();
  for (let i = 0; i < 400; i++) {
    awake.physics.step();
    asleep.physics.step();
  }
  assert.equal(awake.physics.counts.awake, 4);
  assert.equal(asleep.physics.counts.awake, 0);
  awake.physics.dispose();
  asleep.physics.dispose();
});

test('a refused value throws a RangeError that says how to fix it and changes nothing', () => {
  const { physics } = stack();
  const before = physics.solver;
  for (const options of [
    { substeps: 0 },
    { substeps: 2.5 },
    { iterations: 70000 },
    { contactHertz: -1 },
    { sleepTime: Number.NaN },
    { jointMaxPush: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => physics.setSolver({ blockSolver: false, ...options }),
      (error) => error instanceof RangeError && /Solver \w+ must be/.test(error.message),
    );
    assert.deepEqual(physics.solver, before, `nothing changed for ${JSON.stringify(options)}`);
  }
  physics.dispose();
  assert.throws(() => physics.setSolver({}), { code: 'disposed' });
});

test('the settings are part of a snapshot: a restore brings them back with the bodies', () => {
  const { physics } = stack();
  physics.setSolver({ iterations: 3, blockSolver: false });
  const bytes = physics.snapshot();
  physics.setSolver({ iterations: 1, blockSolver: true });
  physics.restore(bytes);
  assert.equal(physics.solver.iterations, 3);
  assert.equal(physics.solver.blockSolver, false);
  physics.dispose();
});

test('the kernel refuses what the wrapper would, on its own: a count out of range, a flag that is neither 0 nor 1, a negative or unknown setting', () => {
  const { physics } = stack();
  const before = physics.solver;
  const { exports } = physics.kernel;
  const refused = (which, value) => exports.world_set_setting(physics.handle, which, value) < 0;
  assert.ok(refused(0, 0) && refused(0, 2.5) && refused(0, 65536) && refused(1, -1), 'counts');
  assert.ok(refused(9, 2) && refused(8, 0.5) && refused(13, -1), 'flags');
  assert.ok(
    refused(2, -1) && refused(4, -0.5) && refused(12, Number.NaN) && refused(7, Number.POSITIVE_INFINITY),
    'amounts',
  );
  assert.ok(
    refused(14, -1) && refused(14, 2.5) && refused(14, 65536),
    'the continuous collision limit is a whole number from 0',
  );
  assert.ok(!refused(14, 0), 'and 0 turns it off');
  physics.setSolver({ maxCcdSubsteps: 1 });
  assert.ok(
    refused(16, 0) && refused(16, 1e-8) && refused(17, 4097) && refused(17, 2.5) && refused(15, -1),
    'the continuous collision tolerances',
  );
  assert.ok(!refused(17, 0) && !refused(15, 0), 'whose 0 is allowed');
  physics.setSolver({ ccdMaxAdvances: 32, minCcdDt: 0 });
  assert.ok(
    refused(18, 1.5) &&
      refused(18, -0.1) &&
      refused(19, -1) &&
      refused(20, Number.NaN) &&
      refused(21, -2) &&
      refused(22, -0.5),
    'a warm start out of 0 to 1, a negative depth or a spring below 0 other than -1',
  );
  assert.ok(refused(23, 1) && refused(99, 1), 'a setting that does not exist');
  assert.deepEqual(physics.solver, before);
  physics.dispose();
});

test('the contact spring for fixed bodies goes back to following the contact spring with null', () => {
  const { physics } = stack();
  physics.setSolver({ staticContactHertz: 5, staticContactDamping: 1 });
  assert.equal(physics.solver.staticContactHertz, 5);
  physics.setSolver({ staticContactHertz: null, staticContactDamping: null });
  assert.equal(physics.solver.staticContactHertz, null);
  assert.equal(physics.solver.staticContactDamping, null);
  physics.dispose();
});

test('a warm start out of 0 to 1 or a negative depth is refused and changes nothing', () => {
  const { physics } = stack();
  assert.throws(() => physics.setSolver({ substeps: 2, warmStart: 1.5 }), RangeError);
  assert.throws(() => physics.setSolver({ allowedPenetration: -1 }), RangeError);
  assert.throws(() => physics.setSolver({ staticContactHertz: -2 }), RangeError);
  assert.equal(physics.solver.substeps, 4);
  assert.equal(physics.solver.warmStart, 1);
  physics.dispose();
});

test('an allowed penetration lets the resting stack sink by about that depth at each contact', () => {
  const rest = (allowedPenetration) => {
    const { physics, boxes } = stack({ pixelsPerMeter: 100 });
    physics.setSolver({ allowedPenetration });
    for (let i = 0; i < 240; i++) physics.step();
    const y = boxes[0].position[1];
    physics.dispose();
    return y;
  };
  // Y is down: a box that sinks into the floor has a larger y. 1 px is 1 cm at 100 px a metre.
  const sink = rest(1) - rest(0);
  assert.ok(Math.abs(sink - 1) < 0.2, `the bottom box sinks ${sink} px for 1 px allowed`);
});

test('a soft spring for fixed bodies sinks a dropped box into the floor further on its first landing', () => {
  const deepest = (staticContactHertz) => {
    const physics = new Physics2D(null, { pixelsPerMeter: 100 });
    physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20 } });
    const box = physics.addBody(null, { position: [0, 0], colliders: { shape: 'box', width: 20, height: 20 } });
    physics.setSolver({ staticContactHertz, staticContactDamping: staticContactHertz === null ? null : 0.5 });
    let y = -Infinity;
    for (let i = 0; i < 60; i++) {
      physics.step();
      y = Math.max(y, box.position[1]);
    }
    physics.dispose();
    return y;
  };
  assert.ok(deepest(2) > deepest(null) + 1, `soft ${deepest(2)} against ${deepest(null)}`);
});
