// The explosive kernel on worker threads (FIRE-05): each thread flies a fixed partition of the fragments over the world's
// shared memory, the main thread the last; 1, 2, 4 and 8 threads give the same bits, and the work count shows the split.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { ExplosionSolver } from '../../dist/explosive.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const shape = { columns: 32, rows: 32, width: 400, depth: 400, centre: [0, 0] };
const charges = [
  { position: [0, 30, 0], time: 0.05, mass: 20, case: { mass: 40, fragments: 1000, geometry: 'sphere' } },
  { position: [50, 25, -40], time: 0.3, mass: 5, case: { mass: 8, fragments: 202 } },
];

async function run(threads) {
  const solver = await ExplosionSolver.load({ terrain: shape, threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0], memory: worldMemory(true) });
  world.add(new TerrainBed(), { ...shape, elevations: (x) => 0.2 * x });
  world.add(solver, { charges, seed: 7 });
  const frames = [];
  for (const frame of [3, 30, 120, 600]) {
    world.advance(frame);
    frames.push(solver.fragments());
  }
  const result = { frames, counts: solver.counts, hash: world.hash(), threads: solver.threads };
  solver.endThreads();
  return result;
}

const bits = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

test('1, 2, 4 and 8 threads fly the fragments to the same bits, and each thread flies its own fixed share', async () => {
  const one = await run(1);
  assert.equal(one.threads, 1);
  for (const threads of [2, 4, 8]) {
    const many = await run(threads);
    assert.equal(many.threads, threads);
    many.frames.forEach((f, i) => assert.ok(bits(f).equals(bits(one.frames[i])), `${threads} threads, check ${i}`));
    assert.equal(many.hash, one.hash, `${threads} threads: the world hash`);
    assert.equal(many.counts.fragmentSteps, one.counts.fragmentSteps, 'the same work in all');
    const split = many.counts.threadSteps;
    assert.equal(split.length, threads);
    assert.equal(
      split.reduce((a, b) => a + b, 0),
      one.counts.fragmentSteps,
    );
    // Fixed partitions of 1202 fragments: every thread did a share of the work.
    for (const [k, steps] of split.entries()) assert.ok(steps > 0, `thread ${k} flew nothing`);
  }
});

test('threads need shared world memory and a sensible count', async () => {
  const solver = await ExplosionSolver.load({ threads: 2 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => world.add(solver, { charges }), /worldMemory\(true\)/);
  solver.endThreads();
  await assert.rejects(ExplosionSolver.load({ threads: 0 }), /from 1 to 64/);
});
