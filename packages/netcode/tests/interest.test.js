import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvelope, defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '../dist/index.js';
import { InterestManager } from '../dist/interest.js';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Thing: { x: 'f32', y: 'f32', z: 'f32', n: 'uint' },
    Item: { x: 'f32', y: 'f32', label: { type: 'string', maxLength: 64 } },
    State: {
      things: { type: 'map', of: 'Thing', maxSize: 4000 },
      items: { type: 'map', of: 'Item', maxSize: 64 },
      round: 'uint',
    },
  },
});

/** A world of `count` entities with ids from 1000 on a line 1 apart; each counts up every tick when `moving`. */
function world({ count = 200, moving = true, spacing = 1 } = {}) {
  return defineGame({
    schema,
    state: 'State',
    input: 'Input',
    tickRate: 30,
    initial: () => {
      const things = new Map();
      for (let i = 0; i < count; i++) things.set(1000 + i, { x: i * spacing, y: 0, z: 0, n: 0 });
      return { things, items: new Map(), round: 0 };
    },
    join: (state, id) => void state.things.set(id, { x: 0, y: 0, z: 0, n: 0 }),
    leave: (state, id) => void state.things.delete(id),
    step(state, inputs) {
      state.round++;
      if (moving) for (const [id, thing] of state.things) if (id >= 1000) thing.n++;
      for (const [id, input] of inputs) {
        const me = state.things.get(id);
        if (me) me.x += input.x;
      }
    },
  });
}

const position = (t) => [t.x, t.y];

/** A server with clients on a loopback network; every snapshot message each client got is kept. */
async function play(game, serverOptions, { conditions = {}, clients = 1, input = () => ({ x: 0 }) } = {}) {
  const network = new LoopbackNetwork(conditions),
    now = () => network.time,
    server = new GameServer(game, { now, ...serverOptions }),
    wires = [];
  network.listen().onconnection = (connection) => {
    const send = connection.send.bind(connection),
      wire = [];
    wires.push(wire);
    connection.send = (bytes, channel) => {
      const message = decodeEnvelope(bytes);
      if (message.kind === 'snapshot') wire.push({ size: bytes.length, ...message });
      send(bytes, channel);
    };
    server.accept(connection);
  };
  const joined = [];
  let next = game.tickMs;
  const frame = () => {
    network.advance(1000 / 60);
    while (network.time >= next) {
      server.step();
      next += game.tickMs;
    }
    for (const client of joined) if (client.open) client.update();
  };
  const run = (ms, each) => {
    for (const end = network.time + ms; network.time < end; ) {
      frame();
      each?.();
    }
  };
  for (let i = 0; i < clients; i++) {
    let client;
    GameClient.join(game, network.connect(), { now, input }).then((c) => (client = c));
    for (let n = 0; n < 2000 && !client; n++) {
      frame();
      await null;
    }
    assert.ok(client, 'client joined');
    joined.push(client);
  }
  return { network, server, clients: joined, wires, run };
}

test('interest: a client gets only what is within the radius, and nothing else reaches its wire', async () => {
  const game = world({ count: 100 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 10 }),
    { clients, run, wires } = await play(game, { view: interest.view });
  run(500);
  const ids = [...clients[0].authoritative.things.keys()].sort((a, b) => a - b),
    me = clients[0].player;
  assert.deepEqual(ids, [me, ...Array.from({ length: 11 }, (_, i) => 1000 + i)]);
  // Decoded from the bytes themselves, not read from the client: a hidden entity is never sent at all.
  const full = wires[0].find((m) => m.baseline === 0);
  assert.ok(full.data.length < 16 * 20, `${full.data.length} bytes holds no more than the visible entities`);
  assert.equal(schema.decode('State', full.data).things.has(1050), false);
});

test('interest: the grid gives exactly the circle, in 2D and 3D, at any cell size', () => {
  const game = world({ count: 0 });
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 100;
  for (const dims of [2, 3])
    for (const cell of [1, 3.7, 12, 500]) {
      const things = new Map();
      for (let id = 1; id <= 400; id++)
        things.set(id, { x: random(), y: random(), z: dims === 3 ? random() : 0, n: 0 });
      const state = { things, items: new Map(), round: 0 },
        at = dims === 3 ? (t) => [t.x, t.y, t.z] : position,
        interest = new InterestManager(game, { collections: { things: { position: at } }, radius: 15, cell });
      const seen = [...interest.view(state, 1).things.keys()].sort((a, b) => a - b),
        me = things.get(1);
      const expected = [...things]
        .filter(([, t]) => Math.hypot(t.x - me.x, t.y - me.y, dims === 3 ? t.z - me.z : 0) <= 15)
        .map(([id]) => id)
        .sort((a, b) => a - b);
      assert.deepEqual(seen, expected, `dims ${dims} cell ${cell}`);
      assert.ok(expected.length > 1 && expected.length < 400);
    }
});

test('interest: an entity on the edge stays until the leave radius, then goes', () => {
  const game = world({ count: 0 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 10, leaveRadius: 12 }),
    me = { x: 0, y: 0, z: 0, n: 0 };
  const at = (x) => ({
    things: new Map([
      [1, me],
      [2, { x, y: 0, z: 0, n: 0 }],
    ]),
    items: new Map(),
    round: 0,
  });
  const seen = (x) => interest.view(at(x), 1).things.has(2);
  assert.equal(seen(11), false, 'outside the radius it does not enter');
  assert.equal(seen(10), true);
  assert.equal(seen(11.5), true, 'inside the leave radius it stays');
  assert.equal(seen(12.5), false);
  assert.equal(seen(11.5), false, 'and it must come back inside the radius to enter again');
});

test('interest: every snapshot on the wire stays within the budget, with loss, jitter and a full first snapshot', async () => {
  for (const budget of [200, 500, 1200]) {
    const game = world({ count: 300, spacing: 0.1 }),
      interest = new InterestManager(game, { collections: { things: { position } }, radius: 40, budget }),
      { run, wires, server } = await play(
        game,
        { view: interest.view },
        { conditions: { latency: 50, jitter: 20, loss: 0.1, seed: 4 }, clients: 3 },
      );
    run(3000);
    for (const wire of wires) {
      assert.ok(wire.length > 60);
      for (const message of wire) assert.ok(message.size <= budget, `${message.size} bytes against ${budget}`);
    }
    // The limit bites, or the test proves nothing: the same world without one sends far more.
    assert.ok(Math.max(...wires[0].map((m) => m.size)) > budget * 0.6);
    for (const player of server.players) {
      const stats = interest.stats(player);
      assert.equal(stats.over, 0);
      assert.ok(stats.bytes <= budget);
    }
  }
});

test('interest: without a budget a moving world goes out in full, so the budget is what cut it', async () => {
  const game = world({ count: 300, spacing: 0.1 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40 }),
    { run, wires, clients } = await play(game, { view: interest.view }, { conditions: { latency: 50 } });
  run(1000);
  assert.ok(Math.max(...wires[0].map((m) => m.size)) > 2000);
  // With no limit a value in flight is brought up to date at once rather than repeated.
  assert.equal(clients[0].authoritative.things.get(1000).n, clients[0].authoritative.round - 1 + 1);
});

test('interest: nothing starves, and what matters more is fresher', async () => {
  const game = world({ count: 100, spacing: 0.2 }),
    interest = new InterestManager(game, {
      collections: { things: { position, priority: (_t, id) => (id === 1050 ? 10 : 1) } },
      radius: 40,
      budget: 120,
    }),
    { run, clients } = await play(game, { view: interest.view }, { conditions: { latency: 30 } }),
    client = clients[0],
    changes = new Map(),
    worst = new Map(),
    was = new Map();
  run(500);
  run(8000, () => {
    const state = client.authoritative;
    for (const [id, thing] of state.things) {
      if (was.get(id) === thing.n) continue;
      was.set(id, thing.n);
      changes.set(id, (changes.get(id) ?? 0) + 1);
      worst.set(id, Math.max(worst.get(id) ?? 0, state.round - thing.n));
    }
  });
  for (let id = 1000; id < 1100; id++) assert.ok((changes.get(id) ?? 0) >= 2, `${id} kept being updated`);
  const others = [...changes].filter(([id]) => id >= 1000 && id !== 1050).map(([, n]) => n),
    mean = others.reduce((a, b) => a + b) / others.length;
  assert.ok(changes.get(1050) > 3 * mean, `${changes.get(1050)} updates against a mean of ${mean}`);
});

test('interest: a held-back entity never goes back to an older value on the client', async () => {
  const game = world({ count: 120, spacing: 0.1 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40, budget: 300 }),
    { run, clients } = await play(game, { view: interest.view }, { conditions: { latency: 80, jitter: 10, seed: 2 } }),
    client = clients[0],
    newest = new Map();
  let seenTick = 0,
    held = 0;
  run(6000, () => {
    if (client.serverTick === seenTick) return;
    seenTick = client.serverTick;
    for (const [id, thing] of client.authoritative.things) {
      if (id < 1000) continue;
      const before = newest.get(id) ?? 0;
      assert.ok(thing.n >= before, `entity ${id} went from ${before} back to ${thing.n}`);
      if (thing.n === before) held++;
      newest.set(id, thing.n);
    }
  });
  assert.ok(held > 1000, 'entities really were held back');
});

test('interest: entities near the edge of the budget still converge once the world stops', async () => {
  const game = world({ count: 150, spacing: 0.1, moving: false }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40, budget: 150 }),
    { run, clients, server } = await play(game, { view: interest.view }, { conditions: { latency: 40, loss: 0.2, seed: 9 } });
  run(5000);
  const held = clients[0].authoritative.things;
  assert.equal(held.size, server.state.things.size - 0);
  for (const [id, thing] of server.state.things) assert.deepEqual(held.get(id), thing);
});

test('interest: the own entity goes at any budget, and `over` says when the fixed part does not fit', async () => {
  const game = world({ count: 40, spacing: 0.1 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40, budget: 1 }),
    { run, clients, server } = await play(game, { view: interest.view }, { input: () => ({ x: 0.25 }) });
  run(1000);
  const me = clients[0].player;
  assert.ok(clients[0].authoritative.things.get(me).x > 0);
  assert.equal(clients[0].authoritative.things.size, 1);
  assert.ok(interest.stats(server.players[0]).over > 0);
});

test('interest: other fields and unmanaged maps go whole, and count against the budget', async () => {
  const game = world({ count: 40, spacing: 0.1 });
  const label = 'x'.repeat(60),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40, budget: 300 }),
    things = game.initial().things,
    items = new Map([[1, { x: 900, y: 900, label }]]),
    state = { things, items, round: 3 };
  things.set(1, { x: 0, y: 0, z: 0, n: 0 });
  const seen = interest.view(state, 1);
  assert.equal(seen.round, 3);
  assert.equal(seen.items.size, 1, 'a map that is not managed goes whole');
  assert.ok(schema.encode('State', seen).length + 21 <= 300);
  assert.ok(seen.things.size < 41, 'and takes its share of the budget');
});

test('interest: always, visible and focus', () => {
  const game = world({ count: 0 }),
    things = new Map([
      [1, { x: 0, y: 0, z: 0, n: 0 }],
      [2, { x: 500, y: 0, z: 0, n: 0 }],
      [3, { x: 3, y: 0, z: 0, n: 1 }],
      [4, { x: 4, y: 0, z: 0, n: 0 }],
    ]),
    state = { things, items: new Map(), round: 0 };
  const keys = (options) =>
    [...new InterestManager(game, { radius: 10, ...options }).view(state, 1).things.keys()].sort((a, b) => a - b);
  const rules = (extra) => ({ collections: { things: { position, ...extra } } });
  assert.deepEqual(keys(rules({})), [1, 3, 4]);
  assert.deepEqual(keys(rules({ always: (_t, id) => id === 2 })), [1, 2, 3, 4]);
  assert.deepEqual(keys(rules({ visible: (t) => t.n === 0 })), [1, 4], 'a hidden entity stays hidden, near or not');
  assert.deepEqual(keys({ ...rules({}), focus: () => [500, 0] }), [1, 2], 'the own entity goes wherever the camera is');
  assert.deepEqual(keys({ ...rules({}), self: () => 3 }), [1, 3, 4]);
});

test('interest: a budget function follows each player, and two collections share one budget', () => {
  const game = world({ count: 0 }),
    things = new Map([[1, { x: 0, y: 0, z: 0, n: 0 }]]),
    items = new Map();
  for (let id = 2; id < 30; id++) things.set(id, { x: id / 10, y: 0, z: 0, n: 0 });
  for (let id = 2; id < 30; id++) items.set(id, { x: id / 10, y: 0, label: 'crate' });
  const state = { things, items, round: 0 },
    interest = new InterestManager(game, {
      collections: { things: { position }, items: { position } },
      radius: 40,
      budget: (player) => (player === 1 ? 200 : 2000),
    });
  const small = interest.view(state, 1),
    big = interest.view(state, 2);
  assert.ok(schema.encode('State', small).length + 21 <= 200);
  assert.ok(small.items.size > 0 && small.things.size > 1, 'both collections get a share');
  assert.ok(big.things.size + big.items.size > small.things.size + small.items.size);
});

test('interest: a player that left is forgotten', async () => {
  const game = world({ count: 10 }),
    interest = new InterestManager(game, { collections: { things: { position } }, radius: 40 }),
    { run, clients } = await play(game, { view: interest.view }, { clients: 2 });
  run(200);
  const gone = clients[0].player;
  assert.ok(interest.stats(gone));
  clients[0].close();
  run(500);
  assert.equal(interest.stats(gone), undefined);
  assert.ok(interest.stats(clients[1].player));
});

test('interest: a bad option or a bad value says what to fix', () => {
  const game = world({ count: 0 }),
    collections = { things: { position } },
    make = (options) => new InterestManager(game, options);
  assert.throws(() => make({ collections, radius: 0 }), RangeError);
  assert.throws(() => make({ collections, radius: 5, leaveRadius: 4 }), RangeError);
  assert.throws(() => make({ collections, radius: 5, cell: 0 }), RangeError);
  assert.throws(() => make({ collections, radius: 5, budget: 0 }), RangeError);
  assert.throws(() => make({ collections: {}, radius: 5 }), TypeError);
  assert.throws(() => make({ collections: { round: { position } }, radius: 5 }), /not a map of structs/);
  assert.throws(() => make({ collections: { things: {} }, radius: 5 }), /position/);
  const state = (x) => ({ things: new Map([[1, { x, y: 0, z: 0, n: 0 }]]), items: new Map(), round: 0 });
  assert.throws(() => make({ collections: { things: { position: () => [1] } }, radius: 5 }).view(state(0), 1), RangeError);
  assert.throws(() => make({ collections, radius: 5 }).view(state(Number.NaN), 1), /not finite/);
  assert.throws(() => make({ collections, radius: 5, budget: () => 0 }).view(state(0), 1), RangeError);
  const two = state(0);
  two.things.set(2, { x: 1, y: 0, z: 0, n: 0 });
  assert.throws(
    () => make({ collections: { things: { position, priority: () => -1 } }, radius: 5 }).view(two, 1),
    /priority/,
  );
});
