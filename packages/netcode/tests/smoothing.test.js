import test from 'node:test';
import assert from 'node:assert/strict';
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '../dist/index.js';
import { CorrectionSmoother } from '../dist/smoothing.js';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Box: {
      x: 'f32',
      y: 'f32',
      turn: { type: 'f32', interpolate: 'angle' },
      hits: 'uint',
      trail: { type: 'array', of: 'f32', maxLength: 4 },
    },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 8 } },
  },
});
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ boxes: new Map() }),
  join: (state, id) => void state.boxes.set(id, { x: 0, y: 0, turn: 3, hits: 0, trail: [0, 0] }),
  leave: (state, id) => void state.boxes.delete(id),
  step(state, inputs, _tick, dt) {
    for (const [id, input] of inputs) {
      const box = state.boxes.get(id);
      if (box) box.x += input.x * dt;
    }
  },
});

async function play({ latency = 30, speed = 3, options = {} } = {}) {
  const network = new LoopbackNetwork({ latency }),
    now = () => network.time,
    server = new GameServer(game, { now });
  network.listen().onconnection = (connection) => server.accept(connection);
  let client,
    next = game.tickMs;
  const frame = () => {
    network.advance(1000 / 60);
    while (network.time >= next) {
      server.step();
      next += game.tickMs;
    }
    client?.update();
  };
  GameClient.join(game, network.connect(), { now, input: () => ({ x: speed }) }).then((c) => (client = c));
  for (let n = 0; n < 200 && !client; n++) {
    frame();
    await null;
  }
  const smooth = new CorrectionSmoother(client, { now, ...options });
  const run = (ms, each) => {
    for (const end = network.time + ms; network.time < end; ) {
      frame();
      each?.(smooth.state());
    }
  };
  run(500);
  /** The server shoves the player: a change no client can predict. */
  const shove = (change) => change(server.state.boxes.get(client.player));
  return { client, network, run, server, shove, smooth };
}

test('smoothing: a correction reaches the screen as a blend, and the simulation is exact at once', async () => {
  const { client, run, server, shove, smooth } = await play({ speed: 3 });
  const me = (state) => state.boxes.get(client.player);
  const before = client.stats.mispredictions;
  let drawn = me(smooth.state()).x,
    biggest = 0,
    gap = 0;
  shove((box) => (box.x += 2));
  run(1000, (state) => {
    biggest = Math.max(biggest, Math.abs(me(state).x - drawn));
    drawn = me(state).x;
    gap = Math.max(gap, Math.abs(me(client.predicted).x - me(state).x));
  });
  assert.ok(client.stats.mispredictions > before, 'the shove did cause a correction');
  assert.ok(gap > 1, `the blend really happened: ${gap}`);
  // Snapping would move the box 2 in one frame. With a 50 ms half life a 16.7 ms frame takes at most 1 - 2^(-1/3) of
  // the error, 0.41, plus the box's own 0.05 a frame.
  assert.ok(biggest < 2 * 0.21 + 0.1 + 0.05, `largest step ${biggest}`);
  assert.equal(smooth.error, 0);
  assert.equal(smooth.state(), client.predicted, 'settled, it hands back the prediction itself');
  // The simulation was never smoothed: it agrees with the server.
  assert.ok(Math.abs(me(client.authoritative).x - server.state.boxes.get(client.player).x) < 0.5);
});

test('smoothing: the drawn value does not move at the moment of a correction, stacked ones included', () => {
  const box = (x) => ({ boxes: new Map([[1, { x, y: 0, turn: 0, hits: 0, trail: [] }]]) }),
    client = { game, predicted: box(0) },
    smooth = new CorrectionSmoother(client, { now: () => 0 }),
    drawn = () => smooth.state().boxes.get(1).x;
  assert.equal(drawn(), 0);
  // Each correction takes the prediction from a to b, at once: the screen stays where it was, whatever the size.
  client.predicted = box(5);
  client.oncorrection(box(0), box(5));
  assert.equal(drawn(), 0);
  assert.equal(smooth.error, 5);
  client.predicted = box(-1);
  client.oncorrection(box(5), box(-1));
  assert.equal(drawn(), 0, 'a second one on top of the first does not jump either');
  assert.equal(smooth.error, 1);
});

test('smoothing: the same time gives the same blend at any frame rate', async () => {
  const shrink = (frames) => {
    let time = 0;
    const client = { game, predicted: { boxes: new Map([[1, { x: 0, y: 0, turn: 0, hits: 0, trail: [] }]]) } },
      smooth = new CorrectionSmoother(client, { now: () => time, halfLife: 40 }),
      at = (x) => ({ boxes: new Map([[1, { x, y: 0, turn: 0, hits: 0, trail: [] }]]) });
    smooth.state();
    client.oncorrection(at(8), at(0));
    for (let i = 0; i < frames; i++) {
      time += 120 / frames;
      smooth.state();
    }
    return smooth.error;
  };
  for (const frames of [1, 3, 10, 120]) assert.ok(Math.abs(shrink(frames) - 1) < 1e-9, `${frames} frames`);
});

test('smoothing: one struct shrinks as one vector, and a fast half life catches big errors up', () => {
  let time = 0;
  const value = (x, y) => ({ boxes: new Map([[1, { x, y, turn: 0, hits: 0, trail: [] }]]) }),
    client = { game, predicted: value(0, 0) },
    smooth = new CorrectionSmoother(client, {
      now: () => time,
      halfLife: 100,
      fast: { from: 1, to: 2, halfLife: 10 },
    });
  smooth.state();
  client.oncorrection(value(30, 40), value(0, 0));
  time = 10;
  const big = smooth.state().boxes.get(1);
  assert.ok(Math.abs(big.x - 15) < 1e-9 && Math.abs(big.y - 20) < 1e-9, 'halved in one fast half life, direction kept');
  smooth.reset();
  client.oncorrection(value(0.6, 0.8), value(0, 0));
  time = 110;
  const small = smooth.state().boxes.get(1);
  assert.ok(Math.abs(small.x - 0.3) < 1e-9, 'a distance of 1 is still on the slow half life');
  assert.ok(Math.abs(small.y - 0.4) < 1e-9);
});

test('smoothing: a jump past snap goes at once, angles go the short way, whole numbers step', () => {
  let time = 0;
  const value = (x, turn, hits = 0) => ({ boxes: new Map([[1, { x, y: 0, turn, hits, trail: [1, 2] }]]) }),
    client = { game, predicted: value(100, -3.1, 7) },
    smooth = new CorrectionSmoother(client, { now: () => time, snap: 10 });
  smooth.state();
  client.oncorrection(value(0, 3.1, 1), value(100, -3.1, 7));
  const shown = smooth.state().boxes.get(1);
  assert.equal(shown.x, 100, 'a teleport is not blended');
  assert.equal(shown.hits, 7, 'a count does not blend');
  // From 3.1 to -3.1 the short way is 0.083 through pi, not 6.2 back through 0.
  assert.ok(Math.abs(shown.turn - (-3.1 - (2 * Math.PI - 6.2))) < 1e-9, `turn ${shown.turn}`);
  assert.ok(smooth.error < 0.1);
});

test('smoothing: an array, an entity that appears or goes, and what is left settling to nothing', () => {
  let time = 0;
  const value = (entries) => ({ boxes: new Map(entries) }),
    box = (x, trail = [0, 0]) => ({ x, y: 0, turn: 0, hits: 0, trail }),
    client = { game, predicted: value([[1, box(0, [1, 1])]]) },
    smooth = new CorrectionSmoother(client, { now: () => time, halfLife: 10 });
  smooth.state();
  client.oncorrection(
    value([
      [1, box(1, [2, 1])],
      [3, box(9)],
    ]),
    value([
      [1, box(0, [1, 1])],
      [2, box(5)],
    ]),
  );
  const shown = smooth.state().boxes;
  assert.deepEqual(shown.get(1).trail, [2, 1]);
  assert.equal(shown.has(2), false, 'the state drawn is the prediction: no ghost is added');
  client.predicted = value([[2, box(5)]]);
  assert.deepEqual([...smooth.state().boxes.keys()], [2], 'an offset of an entity now gone does nothing');
  client.predicted = value([[1, box(0, [1])]]);
  assert.deepEqual(smooth.state().boxes.get(1).trail, [1], 'nor one of an array that changed length');
  time = 1000;
  smooth.state();
  assert.equal(smooth.error, 0);
  assert.equal(smooth.state(), client.predicted);
});

test('smoothing: close and using give the hook back; bad options say what to fix', () => {
  let chained = 0;
  const client = { game, predicted: { boxes: new Map() }, oncorrection: () => chained++ },
    first = client.oncorrection;
  {
    using smooth = new CorrectionSmoother(client);
    assert.notEqual(client.oncorrection, first);
    client.oncorrection(client.predicted, client.predicted);
    assert.equal(chained, 1, 'a hook already there still runs');
    smooth.reset();
  }
  assert.equal(client.oncorrection, first);
  assert.throws(() => new CorrectionSmoother({}), TypeError);
  assert.throws(() => new CorrectionSmoother(client, { halfLife: 0 }), RangeError);
  assert.throws(() => new CorrectionSmoother(client, { snap: 0 }), RangeError);
  assert.throws(() => new CorrectionSmoother(client, { settle: 0 }), RangeError);
  assert.throws(() => new CorrectionSmoother(client, { fast: { from: 2, to: 1, halfLife: 5 } }), RangeError);
});
