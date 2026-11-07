import test from 'node:test';
import assert from 'node:assert/strict';
import { LagCompensation } from '../dist/index.js';
import { arena } from './arena.js';

test('lag compensation: a shot at what the shooter saw hits, though the target has moved on', async () => {
  const lag = new LagCompensation({ history: 64 }),
    shots = [];
  const world = arena({ latency: 80, jitter: 10, seed: 6 }, { onmessage: (player, type, value) => shots.push(value) });
  // Record every tick's boxes as hit circles, as a game's server would after each step.
  const step = world.server.step.bind(world.server);
  world.server.step = () => {
    step();
    lag.record(
      world.server.tick,
      [...world.server.state.boxes].map(([id, box]) => [id, { position: [box.x, box.y], radius: 0.5 }]),
    );
  };
  const target = await world.join({ input: () => ({ x: 0, y: 1, boost: true }) });
  const shooter = await world.join();
  world.run(1500); // the target is at full speed now
  // The shooter aims straight at the target as it is drawn on the shooter's screen, and fires.
  const seen = shooter.interpolated(),
    me = seen.boxes.get(shooter.player),
    them = seen.boxes.get(target.player);
  shooter.send('Shot', {
    tick: shooter.viewTick,
    x: me.x,
    y: me.y,
    dx: them.x - me.x,
    dy: them.y - me.y,
  });
  world.run(300); // the shot reaches the server
  assert.equal(shots.length, 1);
  const shot = shots[0],
    origin = [shot.x, shot.y],
    direction = [shot.dx, shot.dy];
  // Rewound to the shooter's view: a hit on the target.
  const hit = lag.raycast(shot.tick, origin, direction, { ignore: shooter.player });
  assert.equal(hit?.id, target.player);
  // At the server's present the target is far from where it was seen: the same shot misses.
  const now = lag.raycast(world.server.tick, origin, direction, { ignore: shooter.player });
  assert.notEqual(now?.id, target.player);
  const moved = world.server.state.boxes.get(target.player).y - them.y;
  assert.ok(moved > 1, `the target moved ${moved} since the shooter saw it`);
});

test('rewind blends between recorded ticks, clamps to the history and checks its arguments', () => {
  const lag = new LagCompensation({ history: 3 });
  lag.record(10, [[1, { position: [0, 0, 0], radius: 1 }]]);
  lag.record(11, [[1, { position: [2, 0, 0], radius: 1 }]]);
  assert.deepEqual(lag.at(10.5).get(1).position, [1, 0, 0]);
  lag.record(12, [[1, { position: [4, 0, 0], radius: 1 }]]);
  lag.record(13, [[1, { position: [6, 0, 0], radius: 1 }]]);
  assert.deepEqual(lag.range, [11, 13]);
  assert.deepEqual(lag.at(0).get(1).position, [2, 0, 0], 'no rewind past the history');
  const hit = lag.raycast(12, [4, -5, 0], [0, 1, 0]);
  assert.equal(hit.id, 1);
  assert.equal(hit.distance, 4);
  assert.deepEqual(hit.point, [4, -1, 0]);
  assert.equal(lag.raycast(12, [4, -5, 0], [0, 1, 0], { maxDistance: 3 }), undefined);
  assert.equal(lag.raycast(12, [4, -5, 0], [0, -1, 0]), undefined, 'behind the origin');
  assert.equal(lag.raycast(12, [4, 0, 0], [1, 0, 0]).distance, 0, 'from inside');
  assert.throws(() => lag.record(5, []), /older than 13; record ticks in order/);
  assert.throws(() => lag.raycast(12, [0, 0], [0, 0]), /direction is zero/);
  assert.throws(() => lag.record(14, [[1, { position: [0, Number.NaN], radius: 1 }]]), RangeError);
  assert.throws(() => new LagCompensation({ history: 1 }), RangeError);
});

test('at a recorded tick, a shape only the next tick holds does not exist yet', () => {
  const lag = new LagCompensation({ history: 8 }),
    shape = { position: [0, 0], radius: 1 };
  lag.record(1, [[1, shape]]);
  lag.record(2, [[1, shape]]);
  lag.record(3, [
    [1, shape],
    [2, { position: [5, 0], radius: 1 }],
  ]);
  assert.deepEqual([...lag.at(2).keys()], [1]);
  assert.equal(lag.raycast(2, [5, 5], [0, -1]), undefined);
  assert.deepEqual([...lag.at(3).keys()].sort(), [1, 2]);
});

test('the rewind keeps only its history, replacing a repeated tick', () => {
  const lag = new LagCompensation({ history: 2 }),
    shape = (x) => [[1, { position: [x, 0], radius: 1 }]];
  assert.equal(lag.range, undefined);
  lag.record(1, shape(1));
  lag.record(2, shape(2));
  lag.record(2, shape(5));
  assert.deepEqual(lag.range, [1, 2]);
  assert.equal(lag.at(2).get(1).position[0], 5);
  lag.record(3, shape(6));
  assert.deepEqual(lag.range, [2, 3]);
  assert.equal(lag.at(0).get(1).position[0], 5);
  assert.throws(() => lag.record(1, shape(1)), RangeError);
  lag.clear();
  assert.equal(lag.range, undefined);
});
