// What a step did and how long its phases took, read from the 2D world (Rapier's profiler): counts are whole numbers of work
// that do not depend on the machine, timings are milliseconds and stay out of the world's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

const scene = () => {
  const physics = new Physics2D(null);
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20 } });
  for (let i = 0; i < 4; i++)
    physics.addBody(null, { position: [0, 70 - i * 21], colliders: { shape: 'box', width: 20, height: 20 } });
  return physics;
};

test('before the first step every count and every timing reads zero', () => {
  const physics = scene();
  assert.deepEqual(Object.values(physics.counts), new Array(14).fill(0));
  assert.deepEqual(Object.values(physics.timing), new Array(15).fill(0));
  physics.dispose();
});

test('a resting stack counts its contacts, the same for the same inputs, and steps add up', () => {
  const [a, b] = [scene(), scene()];
  for (let i = 0; i < 40; i++) {
    a.step();
    b.step();
    assert.deepEqual(a.counts, b.counts);
  }
  const counts = a.counts;
  assert.equal(counts.steps, 40);
  assert.equal(counts.awake, 4);
  assert.equal(counts.islands, 1);
  assert.ok(counts.pairs >= 4 && counts.manifolds >= 4, `the stack's pairs and manifolds: ${JSON.stringify(counts)}`);
  assert.ok(counts.contactsSolved >= 4, `contacts solved: ${counts.contactsSolved}`);
  assert.equal(counts.blockSolves + counts.sequentialSolves > 0, true, 'two-point contacts were solved');
  assert.ok(counts.colours >= 1);
  a.dispose();
  b.dispose();
});

test('a world that went to sleep has no awake body, no island and no contact to solve', () => {
  const physics = scene();
  for (let i = 0; i < 600; i++) physics.step();
  const counts = physics.counts;
  assert.equal(counts.awake, 0);
  assert.equal(counts.islands, 0);
  assert.equal(counts.contactsSolved, 0);
  assert.equal(counts.steps, 600);
  physics.dispose();
});

test('events counts the events the step produced', () => {
  const physics = new Physics2D(null);
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20 } });
  physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 5 } });
  let seen = 0;
  physics.on('contactstart', () => seen++);
  physics.on('contactend', () => seen++);
  let counted = 0;
  for (let i = 0; i < 120; i++) {
    physics.step();
    counted += physics.counts.events;
  }
  assert.ok(seen >= 1, 'the ball met the floor');
  assert.equal(counted, seen, 'the counts add up to the events the page was told');
  physics.dispose();
});

test('timings are finite, not negative, each inside the step, and a reading leaves the world untouched', () => {
  const [read, quiet] = [scene(), scene()];
  for (let i = 0; i < 90; i++) {
    read.step();
    quiet.step();
    const timing = read.timing;
    for (const [phase, ms] of Object.entries(timing)) {
      assert.ok(Number.isFinite(ms) && ms >= 0, `${phase} is ${ms}`);
      assert.ok(ms <= timing.step, `${phase} is inside the step`);
    }
  }
  assert.deepEqual(read.snapshot(), quiet.snapshot());
  const { assembly, resolution, update, writeback } = read.timing;
  assert.ok(
    assembly + resolution + update + writeback <= read.timing.solver + 1e-3,
    'the four splits are inside the solver',
  );
  assert.ok(read.timing.step > 0, 'the step took some time');
  read.dispose();
  quiet.dispose();
});

test('the sweep is timed by its parts for a body that asks for continuous collision', () => {
  const physics = new Physics2D(null);
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20 } });
  physics.addBody(null, {
    position: [0, 0],
    linearVelocity: [0, 3000],
    ccd: true,
    colliders: { shape: 'circle', radius: 2 },
  });
  let swept = 0;
  for (let i = 0; i < 20; i++) {
    physics.step();
    const { ccdBroad, ccdToi, ccdSolver, ccd } = physics.timing;
    swept += ccdBroad + ccdToi + ccdSolver;
    assert.ok(ccdBroad + ccdToi + ccdSolver <= ccd + 1e-3, 'the sweep splits are inside ccd');
  }
  assert.ok(swept > 0, 'the sweep ran');
  physics.dispose();
});
