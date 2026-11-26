// Physics worlds in netcode (`@margoengine/netcode/physics`), run on real worlds of `@margoengine/physics`: a world rolled
// back by peers under latency, jitter and loss confirms every frame as the world stepped offline does, a snapshot diff carries
// one snapshot to the next exactly and small, and a client interpolates the bodies a server sends.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../physics/dist/index.js';
import { defineSchema, LoopbackNetwork } from '../dist/index.js';
import {
  applySnapshotDiff,
  BODY_STATE_FIELDS,
  BodyInterpolator,
  bodyStates,
  physicsGame,
  snapshotDiff,
} from '../dist/physics.js';
import { RollbackSession } from '../dist/rollback.js';

await Physics.load();

const checksum = (bytes) => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
};
const schema = defineSchema({ types: { Input: { x: 'f32', z: 'f32' } } });

/** The same arena on every peer: a floor, a pile of boxes, and a ball for each player, pushed by its input. */
function arena(players) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  for (let i = 0; i < 6; i++)
    physics.addBody(null, {
      position: [(i % 3) - 1, 0.5 + Math.floor(i / 3), 2],
      colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] },
    });
  const balls = new Map(
    players.map((p, i) => [
      p,
      physics.addBody(null, {
        position: [3 * i - 1.5, 0.5, -2],
        colliders: { shape: 'sphere', radius: 0.5, density: 500 },
      }),
    ]),
  );
  const apply = (inputs) => {
    // In player order, so every peer pushes in the same order.
    for (const [p, input] of [...inputs].sort((a, b) => a[0] - b[0]))
      balls.get(p).applyImpulse([input.x * 2, 0, input.z * 2]);
  };
  return { physics, balls, apply };
}

const steering = (seed) => {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1,
    memo = new Map();
  return (frame) => {
    const key = Math.floor(frame / 15);
    if (!memo.has(key)) memo.set(key, schema.clone('Input', { x: next(), z: next() }));
    return memo.get(key);
  };
};

test('a physics world rolled back by two peers under latency, jitter and loss confirms every frame as it steps offline', (t) => {
  const players = [1, 2],
    inputs = new Map(players.map((p) => [p, steering(p * 7919)])),
    network = new LoopbackNetwork({ latency: 60, jitter: 25, loss: 0.1, duplicate: 0.02, reorder: 0.05, seed: 11 }),
    [ab, ba] = network.pair(),
    links = new Map([
      [1, new Map([[2, ab]])],
      [2, new Map([[1, ba]])],
    ]),
    confirmed = new Map(players.map((p) => [p, new Map()])),
    desyncs = [],
    sessions = players.map((p) => {
      const { physics, apply } = arena(players),
        game = physicsGame({ world: physics, schema, input: 'Input', apply });
      return new RollbackSession(game, {
        players,
        local: p,
        peers: links.get(p),
        input: inputs.get(p),
        now: () => network.time,
        onconfirm: (frame, sum) => confirmed.get(p).set(frame, sum),
        ondesync: (event) => desyncs.push(event),
      });
    });
  for (const end = network.time + 6_000; network.time < end; ) {
    network.advance(1000 / 60);
    for (const s of sessions) s.update();
  }
  const frames = Math.min(...sessions.map((s) => s.confirmed));
  assert.ok(frames > 250, `confirmed ${frames} frames`);
  // Offline: the same world with every input on time (the sessions' input delay is 2 frames).
  const { physics, apply } = arena(players),
    truth = [0];
  for (let f = 1; f <= frames; f++) {
    const map = new Map();
    if (f > 2) for (const p of players) map.set(p, inputs.get(p)(f));
    apply(map);
    physics.step();
    truth.push(checksum(physics.takeSnapshot().bytes));
  }
  for (const p of players)
    for (let f = 1; f <= frames; f++)
      assert.equal(confirmed.get(p).get(f), truth[f], `peer ${p} frame ${f} equals the world stepped offline`);
  const rollbacks = sessions.reduce((n, s) => n + s.stats.rollbacks, 0);
  assert.ok(rollbacks > 10, `rollbacks ${rollbacks}`);
  t.diagnostic(
    `${frames} frames confirmed; rollbacks ${rollbacks}, resimulated ${sessions.reduce((n, s) => n + s.stats.resimulated, 0)}, checksums compared ${sessions.reduce((n, s) => n + s.stats.checked, 0)}`,
  );
  assert.deepEqual(desyncs, []);
  // The worlds moved: the balls were pushed off where they started.
  assert.ok(
    Math.hypot(...physics.getBodies().at(-1).linearVelocity) > 0 || physics.getBodies().at(-1).position[2] !== -2,
  );
});

test('a snapshot diff carries one snapshot to the next exactly, in a sliver of its size', (t) => {
  const { physics, balls, apply } = arena([1]);
  for (let i = 0; i < 120; i++) physics.step();
  const base = physics.takeSnapshot().bytes;
  apply(new Map([[1, { x: 1, z: 0 }]]));
  physics.step();
  const next = physics.takeSnapshot().bytes,
    diff = snapshotDiff(base, next);
  assert.deepEqual(applySnapshotDiff(base, diff), next);
  t.diagnostic(`diff ${diff.byteLength} B of a ${next.byteLength} B snapshot`);
  // The boxes have gone to sleep; one ball rolls: a few hundred bytes of a snapshot that is tens of kilobytes.
  assert.ok(diff.byteLength * 20 < next.byteLength, `${diff.byteLength} of ${next.byteLength} bytes`);
  assert.equal(snapshotDiff(next, next).byteLength < 16, true);
  assert.deepEqual(applySnapshotDiff(next, snapshotDiff(next, next)), next);
  assert.throws(() => snapshotDiff(base, next.subarray(4)), RangeError);
  assert.throws(() => applySnapshotDiff(base, diff.subarray(0, diff.byteLength - 1)), /cut short|runs past/);
  assert.ok(balls.get(1));
});

test('a client interpolates the bodies a server sends, between the states it has', () => {
  // A server's ball thrown up: its states sent ten times a second, read back as the schema sends them.
  const server = new Physics(null),
    ball = server.addBody(null, { colliders: { shape: 'sphere', radius: 0.2 } }),
    wire = defineSchema({
      types: { Body: BODY_STATE_FIELDS, State: { bodies: { type: 'map', of: 'Body', maxSize: 64 } } },
    }),
    client = new BodyInterpolator(),
    truth = [];
  ball.setLinearVelocity([1, 5, 0]);
  for (let tick = 1; tick <= 60; tick++) {
    server.step();
    truth.push({ t: tick / 60, p: [...ball.position] });
    if (tick % 6 === 0) {
      const state = wire.decode('State', wire.encode('State', { bodies: bodyStates([[7, ball]]) }));
      client.push(tick / 60, state.bodies);
    }
  }
  assert.deepEqual(client.ids, [7]);
  // Between two sent states the Hermite curve of positions and velocities follows the ballistic path: within 1 mm (it is
  // exact for a parabola, less what the step's semi-implicit Euler and f32 leave).
  for (const { t, p } of truth.filter((s) => s.t > 0.1 && s.t < 1)) {
    const at = client.sample(t).get(7);
    assert.ok(Math.hypot(at.position[0] - p[0], at.position[1] - p[1], at.position[2] - p[2]) < 1e-3, `at ${t} s`);
  }
  // A proxy is moved to the sampled pose through its next kinematic target.
  const moved = [];
  client.apply(0.55, new Map([[7, { setNextPosition: (p) => moved.push(p), setNextRotation: () => {} }]]));
  assert.equal(moved.length, 1);
  // A body the server stops sending is dropped.
  client.push(1.1, new Map());
  assert.deepEqual(client.ids, []);
});

test('physicsGame checks its world and schema', () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 61.5 });
  assert.throws(() => physicsGame({ world: physics, schema, input: 'Input', apply() {} }), /whole n/);
  physics.fixedTimestep = 1 / 30;
  assert.throws(() => physicsGame({ world: physics, schema, input: 'Nope', apply() {} }), /no struct "Nope"/);
  const game = physicsGame({ world: physics, schema, input: 'Input', apply() {} });
  assert.equal(game.tickRate, 30);
  assert.throws(() => game.schema.encode(game.stateType, new Uint8Array(3)), /bytes of the world/);
});
