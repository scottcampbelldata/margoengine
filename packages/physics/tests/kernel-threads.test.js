// A world's islands solved on worker threads give the bits of one thread (docs/physics-framework.md, section 7, rule 7):
// the same scene on a plain memory stepped with `step`, and on a shared memory stepped with `stepAsync` on 1, 2, 4 and 8
// threads, hash alike after every step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { Arena, worldMemory } from '../dist/world.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

await Physics.load({ threads: true });

/** Separate stacks, a pile of balls, a chain hung from a fixed beam and spinning blocks: dozens of islands. */
function scene(arena) {
  const physics = new Physics(null, arena ? { arena } : {});
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [60, 0.5, 60] },
  });
  for (let stack = 0; stack < 6; stack++)
    for (let level = 0; level < 5; level++)
      physics.addBody(null, {
        position: [stack * 3 - 8, 0.5 + level * 1.01, -6],
        colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
      });
  for (let i = 0; i < 24; i++)
    physics.addBody(null, {
      position: [-4 + (i % 6) * 0.6, 3 + Math.floor(i / 6) * 0.6, 4],
      colliders: { shape: 'sphere', radius: 0.25 },
    });
  const beam = physics.addBody(null, {
    type: 'fixed',
    position: [0, 9, 8],
    colliders: { shape: 'box', halfExtents: [20, 0.1, 0.1] },
  });
  let above = beam;
  for (let link = 0; link < 5; link++) {
    const body = physics.addBody(null, {
      position: [0.1 * link, 8.5 - link, 8],
      colliders: { shape: 'sphere', radius: 0.2 },
    });
    physics.addJoint(above, body, {
      type: 'spherical',
      anchorA: [0, link === 0 ? -0.1 : -0.5, 0],
      anchorB: [0, 0.5, 0],
    });
    above = body;
  }
  for (let i = 0; i < 6; i++)
    physics.addBody(null, {
      position: [-10 + i * 1.5, 2, 0],
      angularVelocity: [3 * i, 20, 1],
      colliders: { shape: 'box', halfExtents: [0.3, 0.2, 0.4] },
    });
  return physics;
}

test('islands stepped on 1, 2, 4 and 8 threads give the bits of a world stepped on one', {
  timeout: 120_000,
}, async () => {
  const serial = scene();
  const threaded = [];
  for (const count of [1, 2, 4, 8]) {
    const physics = scene(new Arena(worldMemory(true)));
    await physics.kernel.useThreads(count);
    assert.equal(physics.kernel.threadCount, count);
    threaded.push(physics);
  }
  let most = 0;
  for (let step = 0; step < 240; step++) {
    serial.kernel.step(1 / 60);
    most = Math.max(most, serial.kernel.counts.islands);
    for (const physics of threaded) {
      await physics.kernel.stepAsync(1 / 60);
      assert.equal(physics.kernel.hash, serial.kernel.hash, `${physics.kernel.threadCount} threads, step ${step}`);
    }
  }
  assert.ok(most >= 8, `at most ${most} islands a step: too few to share out`);
  for (const physics of threaded) {
    physics.kernel.endThreads();
    assert.equal(physics.kernel.threadCount, 1);
    physics.dispose();
  }
  serial.dispose();
});

test('threads need a shared memory and a count from 1 to 64, and a shared memory needs the threaded kernel', async () => {
  const plain = scene();
  await assert.rejects(
    plain.kernel.useThreads(2),
    (error) => error.code === 'state' && /worldMemory\(true\)/.test(error.message),
  );
  const shared = scene(new Arena(worldMemory(true)));
  await assert.rejects(shared.kernel.useThreads(0), rigidCoded);
  await assert.rejects(shared.kernel.useThreads(65), rigidCoded);
  plain.dispose();
  shared.dispose();
});

test('Physics.useThreads and stepAsync match Physics.step bit for bit with events and stepCount', {
  timeout: 120_000,
}, async () => {
  const serial = scene();
  const threaded = scene(new Arena(worldMemory(true)));
  await threaded.useThreads(4);
  assert.equal(threaded.threadCount, 4);
  let serialContacts = 0,
    threadedContacts = 0;
  serial.on('contactstart', () => serialContacts++);
  threaded.on('contactstart', () => threadedContacts++);
  for (let i = 0; i < 60; i++) {
    serial.step();
    await threaded.stepAsync();
    assert.equal(threaded.kernel.hash, serial.kernel.hash, `step ${i}`);
  }
  assert.equal(threaded.stepCount, serial.stepCount);
  assert.ok(serialContacts > 0, 'contact events fired');
  assert.equal(threadedContacts, serialContacts);
  threaded.endThreads();
  assert.equal(threaded.threadCount, 1);
  serial.dispose();
  threaded.dispose();
});
