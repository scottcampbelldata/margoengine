import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloseCode,
  decodeEnvelope,
  encodeEnvelope,
  GameClient,
  GameServer,
  LoopbackNetwork,
  ENVELOPE_VERSION,
} from '../dist/index.js';
import { AdaptiveDelay } from '@margoengine/net/delay';
import { arena, game, schema } from './arena.js';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// A repeatable input script: steer, boost, stop, from a seeded stream per player.
const script = (seed, until) => {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  let x = 0,
    y = 0;
  return (tick) => {
    if (tick > until) return { x: 0, y: 0, boost: false };
    if (tick % 15 === 0) {
      x = next();
      y = next();
    }
    return { x, y, boost: tick % 40 < 10 };
  };
};

// The client's prediction for its tick equals the server's state for that tick once the server gets there.
function assertConverged(world, client) {
  const tick = client.tick,
    predicted = schema.encode('State', client.predicted);
  while (world.server.tick < tick) world.frame();
  const server = world.states.get(tick);
  assert.ok(server, `server state for tick ${tick}`);
  assert.ok(same(predicted, server), `prediction at tick ${tick} equals the server`);
}

test('prediction converges to the server state under latency, jitter, loss, duplication and reordering', async () => {
  const world = arena({ latency: 60, jitter: 25, loss: 0.1, duplicate: 0.05, reorder: 0.05, seed: 11 });
  const client = await world.join({ input: script(5, 240) });
  world.run(12_000);
  assertConverged(world, client);
  const box = client.predicted.boxes.get(client.player);
  assert.ok(box, 'own box exists');
  assert.ok(client.stats.snapshots > 200, `snapshots ${client.stats.snapshots}`);
  assert.ok(client.stats.rtt >= 120 && client.stats.rtt < 200, `rtt ${client.stats.rtt}`);
});

test('a clean link predicts every tick right: no mispredictions once joined', async () => {
  const world = arena({ latency: 40, seed: 3 });
  const client = await world.join({ input: script(9, 1e9) });
  world.run(10_000);
  assert.equal(client.stats.mispredictions, 0);
  assert.equal(client.stats.ignored, 0);
  assert.ok(client.stats.confirmed > 250, `confirmed ${client.stats.confirmed}`);
  assert.equal(world.server.stats.missedInputs, 0);
  assert.equal(world.server.stats.lateInputs, 0);
  // Snapshots go as deltas once the client confirmed one.
  assert.ok(world.server.stats.deltaSnapshots > 0.95 * world.server.stats.snapshots);
  assertConverged(world, client);
});

test('inputs repeated in later messages survive loss: the server misses few ticks at 20% loss', async () => {
  const world = arena({ latency: 50, jitter: 10, loss: 0.2, seed: 21 });
  const client = await world.join({ input: script(2, 1e9) });
  world.run(10_000);
  // Each input rides in up to 8 messages, so a tick is missed only when 8 in a row are lost or the lead is short.
  const missed = world.server.stats.missedInputs;
  assert.ok(missed < 10, `missed ${missed}`);
  // A misprediction happens only after a missed input (the server reused the last one), and one replay fixes it.
  assert.ok(
    client.stats.mispredictions <= 2 * missed,
    `${client.stats.mispredictions} mispredictions, ${missed} missed`,
  );
});

test('interpolation draws other players smoothly between snapshots despite jitter', async () => {
  const world = arena({ latency: 50, jitter: 30, seed: 4 });
  const mover = await world.join({ input: () => ({ x: 1, y: 0, boost: false }) });
  const watcher = await world.join();
  const xs = [];
  for (let i = 0; i < 60; i++) {
    world.frame();
    const box = watcher.interpolated().boxes.get(mover.player);
    if (box) xs.push(box.x);
  }
  assert.ok(xs.length > 50);
  // Steady motion: every frame moves forward, by no more than the box's top speed allows in one frame (with slack).
  for (let i = 1; i < xs.length; i++) {
    const step = xs[i] - xs[i - 1];
    assert.ok(step >= -1e-9, `frame ${i} went back by ${-step}`);
    assert.ok(step <= (19 / 60) * 1.5, `frame ${i} jumped ${step}`);
  }
  // The view lags the server by about the delay, not more than half a second.
  const server = world.server.state.boxes.get(mover.player).x,
    shown = watcher.interpolated().boxes.get(mover.player).x;
  assert.ok(server - shown >= 0 && server - shown < 19 * 0.5, `lag ${server - shown}`);
});

test('an AdaptiveDelay runs the view: smooth, behind what arrived, and closer on a calm link', async () => {
  const run = async (conditions, interpolationDelay) => {
    const world = arena(conditions),
      mover = await world.join({ input: () => ({ x: 1, y: 0, boost: false }) }),
      watcher = await world.join({ interpolationDelay });
    let last = -Infinity,
      hungry = 0,
      frames = 0,
      behind = 0;
    for (let i = 0; i < 600; i++) {
      world.frame();
      const box = watcher.interpolated().boxes.get(mover.player);
      if (i < 120 || !box) continue;
      assert.ok(watcher.viewTick >= last, `view went back at frame ${i}`);
      last = watcher.viewTick;
      frames++;
      behind += watcher.serverTick - watcher.viewTick;
      if (watcher.viewTick > watcher.serverTick) hungry++;
    }
    return { behind: behind / frames, hungry: hungry / frames };
  };
  const calm = await run({ latency: 50, seed: 4 }, new AdaptiveDelay()),
    fixed = await run({ latency: 50, seed: 4 }),
    rough = await run({ latency: 50, jitter: 60, seed: 4 }, new AdaptiveDelay());
  // On a clean link one snapshot interval is enough, where the fixed default holds two.
  assert.ok(calm.behind < fixed.behind, `${calm.behind} against ${fixed.behind}`);
  assert.equal(calm.hungry, 0);
  assert.ok(rough.behind > calm.behind, `${rough.behind} against ${calm.behind}`);
  assert.ok(rough.hungry < 0.03, `hungry ${rough.hungry}`);
});

test('interpolationDelay refuses what is neither ticks nor a view clock', () => {
  assert.throws(() => GameClient.join(game, {}, { input: () => ({}), interpolationDelay: {} }), {
    name: 'TypeError',
    message: /interpolationDelay/,
  });
});

test('soak: 8 clients under loss and jitter for 60 s all stay joined and converge', async (t) => {
  const world = arena({ latency: 80, jitter: 40, loss: 0.05, duplicate: 0.02, reorder: 0.02, seed: 99 });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await world.join({ input: script(100 + i, 1500) }));
  world.run(60_000);
  for (const client of clients) assert.ok(client.open, `client ${client.player} still open`);
  assert.equal(world.server.players.length, 8);
  // Inputs stopped at tick 1500 (50 s) and every box has come to rest: all predictions equal the server.
  for (const client of clients) assertConverged(world, client);
  const s = world.server.stats;
  t.diagnostic(
    `ticks ${s.ticks}, snapshots ${s.snapshots} (${s.deltaSnapshots} deltas), mean snapshot ${Math.round(s.snapshotBytes / s.snapshots)} B, missed ${s.missedInputs}, late ${s.lateInputs}, mispredictions ${clients.map((c) => c.stats.mispredictions).join('/')}`,
  );
  assert.ok(s.deltaSnapshots > 0.8 * s.snapshots);
});

test('the server closes clients that send garbage, flood, or speak another schema', async () => {
  const network = new LoopbackNetwork({ latency: 5 });
  const world = arena({ latency: 5 });
  const codes = [];
  const open = () => {
    const c = world.network.connect();
    c.onclose = (code) => codes.push(code);
    return c;
  };
  const garbage = open();
  garbage.send(new Uint8Array([200, 1, 2]));
  const early = open();
  early.send(encodeEnvelope({ kind: 'ping', time: 1 }));
  const other = open();
  other.send(encodeEnvelope({ kind: 'hello', version: ENVELOPE_VERSION, schema: (schema.hash ^ 1) >>> 0 }));
  const flood = open();
  flood.send(encodeEnvelope({ kind: 'hello', version: ENVELOPE_VERSION, schema: schema.hash }));
  for (let i = 0; i < 100; i++) flood.send(encodeEnvelope({ kind: 'ping', time: i }));
  const big = open();
  big.send(new Uint8Array(5000));
  world.run(200);
  assert.deepEqual(codes.sort(), [
    CloseCode.protocol,
    CloseCode.protocol,
    CloseCode.rateLimit,
    CloseCode.rateLimit,
    CloseCode.mismatch,
  ]);
  assert.equal(world.server.stats.dropped, 5);
  void network;
});

test('inputs out of their schema range close the client; validateInput drops what the game forbids', async () => {
  let refused = 0;
  const world = arena({ latency: 5 }, { validateInput: (input) => !input.boost || (refused++, false) });
  const client = await world.join({ input: () => ({ x: 0, y: 0, boost: true }) });
  world.run(500);
  assert.ok(refused > 5 && world.server.stats.rejectedInputs === refused);
  // Bytes that decode as an envelope but not as an Input: a quantized value over its 8 bits does not exist.
  const bad = world.network.connect();
  let code = 0;
  bad.onclose = (c) => (code = c);
  bad.send(encodeEnvelope({ kind: 'hello', version: ENVELOPE_VERSION, schema: schema.hash }));
  world.run(100);
  bad.send(encodeEnvelope({ kind: 'inputs', ack: 0, first: world.server.tick + 2, inputs: [new Uint8Array([1, 2])] }));
  world.run(100);
  assert.equal(code, CloseCode.protocol);
  assert.ok(client.open);
});

test('a full server refuses the next player; join rejects with a coded error', async () => {
  const world = arena({ latency: 5 }, { maxPlayers: 1 });
  await world.join();
  const late = GameClient.join(game, world.network.connect(), {
    now: () => world.network.time,
    input: () => ({ x: 0, y: 0, boost: false }),
  });
  world.run(100);
  await assert.rejects(
    late,
    (error) => error.name === 'MargoError' && error.code === 'failed' && /4004/.test(error.message),
  );
});

test('join honours an AbortSignal', async () => {
  const world = arena({ latency: 5 });
  const controller = new AbortController();
  const pending = GameClient.join(game, world.network.connect(), {
    now: () => world.network.time,
    input: () => ({ x: 0, y: 0, boost: false }),
    signal: controller.signal,
  });
  controller.abort(new Error('user left'));
  await assert.rejects(pending, /user left/);
});

test('players leave at the next tick; game messages travel both ways', async () => {
  const heard = [];
  const world = arena({ latency: 10 }, { onmessage: (player, type, value) => heard.push([player, type, value.text]) });
  const got = [];
  const a = await world.join({ onmessage: (type, value) => got.push([type, value.text]) });
  const b = await world.join();
  a.send('Chat', { text: 'hi' });
  world.server.send('Chat', { text: 'welcome' });
  world.run(200);
  assert.deepEqual(heard, [[a.player, 'Chat', 'hi']]);
  assert.deepEqual(got, [['Chat', 'welcome']]);
  assert.ok(world.server.state.boxes.has(b.player));
  b.close();
  world.run(200);
  assert.ok(!world.server.state.boxes.has(b.player));
  assert.deepEqual(world.server.players, [a.player]);
  {
    using server = world.server;
    void server;
  }
  world.network.advance(100);
  assert.ok(!a.open);
});

test('client: a join survives a lost first ping', async () => {
  const network = new LoopbackNetwork({ latency: 20 }),
    now = () => network.time,
    server = new GameServer(game, { now });
  network.listen().onconnection = (connection) => server.accept(connection);
  const connection = network.connect(),
    send = connection.send.bind(connection);
  let dropped = 0;
  connection.send = (bytes, channel) => {
    if (decodeEnvelope(bytes).kind === 'ping' && !dropped++) return;
    send(bytes, channel);
  };
  let client;
  GameClient.join(game, connection, { now, input: () => ({ x: 0, y: 0, boost: false }) }).then((c) => (client = c));
  for (let frame = 0; frame < 120 && !client; frame++) {
    network.advance(1000 / 60);
    if (network.time >= (server.tick + 1) * game.tickMs) server.step();
    await null;
  }
  assert.equal(dropped > 0, true);
  assert.ok(client, 'the client joined within 2 s of game time');
});
