import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, LoopbackNetwork } from '../dist/index.js';
import { Room, RoomsClient, RoomServer } from '../dist/rooms.js';

const schema = defineSchema({
  types: {
    Player: { name: { type: 'string', maxLength: 32 }, x: 'f32' },
    State: { players: { type: 'map', of: 'Player', maxSize: 16 }, turn: 'uint' },
  },
});

class Lobby extends Room {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  events = [];
  onCreate(options) {
    this.setPatchRate(0); // patches by hand in the test (the default is every 50 ms)
    this.setState({ players: new Map(), turn: 0 });
    this.events.push(['create', options.mode]);
    this.onMessage('move', (client, message) => {
      const player = this.state.players.get(this.idOf(client));
      if (player && typeof message?.x === 'number' && Math.abs(message.x) <= 1) player.x += message.x;
    });
    this.onMessage('chat', (client, message) =>
      this.broadcast('chat', { from: client.sessionId, text: String(message) }),
    );
  }
  onAuth(_client, options) {
    return options.token === 'letmein' ? { user: 'ok' } : false;
  }
  onJoin(client, options) {
    this.state.players.set(this.idOf(client), { name: String(options.name), x: 0 });
    this.events.push(['join', options.name]);
  }
  onLeave(client, consented) {
    this.state.players.delete(this.idOf(client));
    this.events.push(['leave', consented]);
  }
  onDispose() {
    this.events.push(['dispose']);
  }
}

function setup() {
  const network = new LoopbackNetwork({ latency: 10 }),
    rooms = new RoomServer().define('lobby', Lobby, { mode: 'duel' });
  network.listen().onconnection = (connection) => rooms.accept(connection);
  const client = new RoomsClient(async () => network.connect());
  const settle = async (ms = 50) => {
    for (let i = 0; i < 10; i++) {
      network.advance(ms / 10);
      await new Promise((done) => setImmediate(done));
    }
  };
  const join = async (method, name, options) => {
    const joining = client[method](name, options, { schema, stateType: 'State' });
    joining.catch(() => {}); // a refusal is asserted by the caller, after the network settles
    await settle();
    return joining;
  };
  return { network, rooms, client, settle, join };
}

test('rooms: joinOrCreate matches clients into one room, syncs state by deltas and relays messages', async () => {
  const { rooms, settle, join } = setup();
  const ada = await join('joinOrCreate', 'lobby', { name: 'Ada', token: 'letmein' });
  const bob = await join('joinOrCreate', 'lobby', { name: 'Bob', token: 'letmein' });
  assert.equal(rooms.rooms.length, 1);
  const room = rooms.rooms[0];
  assert.equal(ada.roomId, bob.roomId);
  assert.notEqual(ada.sessionId, bob.sessionId);
  assert.deepEqual(room.events.slice(0, 3), [
    ['create', 'duel'],
    ['join', 'Ada'],
    ['join', 'Bob'],
  ]);
  room.patch();
  await settle();
  assert.deepEqual([...ada.state.players.values()].map((p) => p.name).sort(), ['Ada', 'Bob']);
  const seen = [];
  bob.onStateChange((state) => seen.push(state.players.get(1)?.x));
  ada.send('move', { x: 1 });
  ada.send('move', { x: 50 }); // refused by the room's own rule
  await settle();
  room.patch();
  await settle();
  assert.deepEqual(seen, [1]);
  const chat = [];
  bob.onMessage('chat', (message) => chat.push(message.text));
  ada.send('chat', 'hello');
  await settle();
  assert.deepEqual(chat, ['hello']);
  // Full: a third client gets a new room.
  const cy = await join('joinOrCreate', 'lobby', { name: 'Cy', token: 'letmein' });
  assert.equal(rooms.rooms.length, 2);
  assert.notEqual(cy.roomId, ada.roomId);
  // joinById reaches a room with space; leaving is consented, the last leave disposes of the room.
  bob.leave();
  await settle();
  assert.deepEqual(room.events.at(-1), ['leave', true]);
  ada.leave();
  await settle();
  assert.deepEqual(room.events.at(-1), ['dispose']);
  assert.equal(rooms.rooms.length, 1);
});

test('rooms: auth, unknown names, full rooms by id, schema mismatch and hostile bytes are refused', async () => {
  const { network, rooms, settle, join } = setup();
  await assert.rejects(join('joinOrCreate', 'lobby', { token: 'nope' }), /refused/);
  await assert.rejects(join('joinOrCreate', 'arena', {}), /no room named 'arena'/);
  await assert.rejects(join('join', 'lobby', { token: 'letmein' }), /no open 'lobby' room/);
  const first = await join('create', 'lobby', { name: 'A', token: 'letmein' });
  await join('joinById', first.roomId, { name: 'B', token: 'letmein' });
  await assert.rejects(join('joinById', first.roomId, { name: 'C', token: 'letmein' }), /refused/);
  const other = defineSchema({ types: { State: { turn: 'uint' } } });
  const client = new RoomsClient(async () => network.connect());
  const mismatch = client.create('lobby', { token: 'letmein' }, { schema: other, stateType: 'State' });
  mismatch.catch(() => {});
  await settle();
  await assert.rejects(mismatch, /schema differs/);
  // Garbage instead of a join, and garbage after joining, close the connection with a protocol error.
  const raw = network.connect();
  let code = 0;
  raw.onclose = (c) => (code = c);
  raw.send(new Uint8Array([48, 9, 9]));
  await settle();
  assert.equal(code, 4001);
  const room = rooms.rooms.find((r) => r.roomId === first.roomId);
  const victim = room.clients[0];
  let closed = 0;
  victim.connection.onclose = ((original) => (c, reason) => {
    closed = c;
    original?.(c, reason);
  })(victim.connection.onclose);
  victim.connection.onmessage(new Uint8Array([49, 200]));
  assert.equal(closed, 4001);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(
    new RoomsClient(async () => network.connect()).joinOrCreate(
      'lobby',
      {},
      { schema, stateType: 'State', signal: controller.signal },
    ),
    /stop/,
  );
  rooms.close();
});

test('rooms: states() is an async iterator of state changes', async () => {
  const { rooms, settle, join } = setup();
  const room = await join('joinOrCreate', 'lobby', { name: 'Ada', token: 'letmein' }),
    controller = new AbortController(),
    turns = [];
  const reading = (async () => {
    for await (const state of room.states({ signal: controller.signal })) turns.push(state.turn);
  })();
  const server = rooms.rooms[0];
  for (const turn of [1, 2, 3]) {
    server.state.turn = turn;
    server.patch();
    await settle();
  }
  controller.abort();
  await reading;
  assert.deepEqual(turns, [1, 2, 3]);
  rooms.close();
});

// Bug 48: a room is joinable only once its onCreate resolved, and a throwing hook or handler closes its client with
// CloseCode.error, reaches RoomServer.onerror and never escapes as an exception or an unhandled rejection.
function harness(Class, options) {
  const network = new LoopbackNetwork({ latency: 10 }),
    rooms = new RoomServer(options).define('game', Class),
    errors = [],
    closes = [];
  rooms.onerror = (error, room) => errors.push([error.message, room?.roomName]);
  network.listen().onconnection = (connection) => rooms.accept(connection);
  // Records the close code each client connection hears, whoever set its onclose.
  const client = new RoomsClient(async () => {
    const connection = network.connect();
    let handler = null;
    const at = closes.push(0) - 1;
    Object.defineProperty(connection, 'onclose', {
      get: () => (code, reason) => {
        closes[at] = code;
        handler?.(code, reason);
      },
      set: (h) => (handler = h),
    });
    return connection;
  });
  const settle = async (ms = 50) => {
    for (let i = 0; i < 10; i++) {
      network.advance(ms / 10);
      await new Promise((done) => setImmediate(done));
    }
  };
  const join = (method = 'joinOrCreate') => {
    const joining = client[method]('game', {}, { schema, stateType: 'State' });
    joining.catch(() => {});
    return joining;
  };
  return { network, rooms, errors, closes, settle, join };
}

/** Collects unhandled rejections while `body` runs. */
async function noUnhandled(body) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await body();
    await new Promise((done) => setTimeout(done, 20));
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(seen, [], 'no unhandled rejection');
}

test('rooms: a join racing a slow onCreate waits for it and never sees a half-made room', async () => {
  let finish;
  class Slow extends Room {
    schema = schema;
    stateType = 'State';
    events = [];
    async onCreate() {
      this.events.push('create');
      await new Promise((done) => (finish = done));
      this.setPatchRate(0);
      this.setState({ players: new Map(), turn: 7 });
      this.events.push('ready');
    }
    onJoin() {
      this.events.push(`join at turn ${this.state.turn}`);
    }
  }
  await noUnhandled(async () => {
    const { rooms, errors, settle, join } = harness(Slow);
    const first = join();
    await settle();
    assert.equal(rooms.rooms.length, 0, 'not listed while onCreate runs');
    const second = join();
    await settle();
    assert.equal(rooms.rooms.length, 0);
    finish();
    await settle();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.roomId, b.roomId, 'the second join waited and joined the same room');
    assert.equal(rooms.rooms.length, 1);
    assert.deepEqual(rooms.rooms[0].events, ['create', 'ready', 'join at turn 7', 'join at turn 7']);
    assert.deepEqual(errors, []);
    rooms.close();
  });
});

test('rooms: a throwing onCreate disposes the room, closes the client with CloseCode.error and reports it', async () => {
  const disposed = [];
  class Broken extends Room {
    schema = schema;
    stateType = 'State';
    async onCreate() {
      this.setState({ players: new Map(), turn: 0 }); // starts the patch timer, which dispose must stop
      throw new Error('no database');
    }
    onDispose() {
      disposed.push(this.roomId);
    }
  }
  await noUnhandled(async () => {
    const { rooms, errors, closes, settle, join } = harness(Broken);
    const joining = join();
    await settle();
    await assert.rejects(joining, (e) => e.name === 'MargoError' && e.code === 'failed' && /4007/.test(e.message));
    assert.deepEqual(closes, [4007]);
    assert.deepEqual(errors, [['no database', undefined]]);
    assert.equal(rooms.rooms.length, 0);
    assert.equal(disposed.length, 1, 'onDispose ran once');
    // RoomServer.create rejects with the same error and leaves nothing behind.
    await assert.rejects(rooms.create('game'), /no database/);
    assert.equal(rooms.rooms.length, 0);
    rooms.close();
  });
});

test('rooms: a throwing onJoin closes that client with CloseCode.error, runs onLeave and reports it', async () => {
  const events = [];
  class Picky extends Room {
    schema = schema;
    stateType = 'State';
    autoDispose = false;
    onCreate() {
      this.setPatchRate(0);
      this.setState({ players: new Map(), turn: 0 });
    }
    async onJoin(client) {
      events.push('join');
      if (this.clients.length === 2) throw new Error('seat broken');
    }
    async onLeave() {
      events.push('leave');
      throw new Error('leave hook broken');
    }
  }
  await noUnhandled(async () => {
    const { rooms, errors, closes, settle, join } = harness(Picky);
    const first = await (async () => {
      const j = join();
      await settle();
      return j;
    })();
    const second = join();
    await settle();
    await second; // the join itself was accepted before onJoin ran
    assert.deepEqual(closes, [0, 4007]);
    assert.deepEqual(events, ['join', 'join', 'leave']);
    assert.deepEqual(errors, [
      ['seat broken', 'game'],
      ['leave hook broken', 'game'],
    ]);
    assert.equal(rooms.rooms[0].clients.length, 1, 'the first client stays');
    first.leave();
    rooms.close();
  });
});

test('rooms: a throwing message handler (sync or async) closes only that client and reports it', async () => {
  class Fragile extends Room {
    schema = schema;
    stateType = 'State';
    onCreate() {
      this.setPatchRate(0);
      this.setState({ players: new Map(), turn: 0 });
      this.onMessage('boom', () => {
        throw new Error('handler broke');
      });
      this.onMessage('later', async () => {
        throw new Error('async handler broke');
      });
      this.onMessage('ok', (client) => client.send('ok'));
    }
  }
  await noUnhandled(async () => {
    const { rooms, errors, closes, settle, join } = harness(Fragile);
    const a = join(),
      b = join(),
      c = join();
    await settle();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    ra.send('boom');
    rb.send('later');
    await settle();
    assert.deepEqual(closes, [4007, 4007, 0]);
    assert.deepEqual(
      errors.map(([message]) => message),
      ['handler broke', 'async handler broke'],
    );
    const replies = [];
    rc.onMessage('ok', () => replies.push('ok'));
    rc.send('ok');
    await settle();
    assert.deepEqual(replies, ['ok'], 'the room keeps serving the other client');
    rooms.close();
  });
});

// Bug 50: RoomServer limits (join timeout, connection cap, room cap, per-client message rate), and room timers that
// throw stop their room instead of throwing uncaught.
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
class Plain extends Room {
  schema = schema;
  stateType = 'State';
  received = 0;
  onCreate() {
    this.setPatchRate(0);
    this.setState({ players: new Map(), turn: 0 });
    this.onMessage('*', () => this.received++);
  }
}
const joined = async (h, method) => {
  const joining = h.join(method);
  await h.settle();
  return joining;
};

test('rooms: a connection that sends no join is closed with CloseCode.timeout after joinTimeout', async () => {
  const h = harness(Plain, { joinTimeout: 30 }),
    raw = h.network.connect();
  let code = 0;
  raw.onclose = (c) => (code = c);
  await h.settle();
  assert.equal(h.rooms.connections, 1);
  // fixed-wait: joinTimeout's real 30 ms timer; Node fires timers in order of expiry, so it comes first
  await wait(60);
  await h.settle();
  assert.equal(code, 4006);
  assert.equal(h.rooms.connections, 0, 'the timed-out connection no longer counts');
  // A client that joins in time is not closed by the timer.
  const room = await joined(h);
  // fixed-wait: past joinTimeout, a timer that must not fire
  await wait(60);
  await h.settle();
  assert.deepEqual(h.closes, [0]);
  assert.equal(h.rooms.connections, 1);
  room.leave();
  await h.settle();
  assert.equal(h.rooms.connections, 0);
  h.rooms.close();
});

test('rooms: connections past maxConnections, joined or joining, are closed with CloseCode.full', async () => {
  const h = harness(Plain, { maxConnections: 2 }),
    member = await joined(h),
    codes = [];
  const raw = [h.network.connect(), h.network.connect()];
  raw.forEach((c, i) => (c.onclose = (code) => (codes[i] = code)));
  await h.settle();
  assert.deepEqual([codes[0], codes[1]], [undefined, 4004], 'one joined plus one joining is the limit');
  assert.equal(h.rooms.connections, 2);
  member.leave();
  await h.settle();
  assert.equal(h.rooms.connections, 1);
  const again = h.network.connect();
  let code = 0;
  again.onclose = (c) => (code = c);
  await h.settle();
  assert.equal(code, 0, 'a freed slot is usable again');
  assert.equal(h.rooms.connections, 2);
  h.rooms.close();
  await h.settle();
  assert.equal(h.rooms.connections, 0, 'close() closes connections still joining');
});

test('rooms: past maxRooms, create rejects and a client create is refused; joinOrCreate still joins', async () => {
  const h = harness(Plain, { maxRooms: 1 }),
    first = await joined(h, 'create');
  await assert.rejects(joined(h, 'create'), /refused.*most rooms \(1\)/);
  const second = await joined(h, 'joinOrCreate');
  assert.equal(second.roomId, first.roomId);
  await assert.rejects(
    h.rooms.create('game'),
    (e) => e.name === 'MargoError' && e.code === 'failed' && /maxRooms/.test(e.message),
  );
  first.leave();
  second.leave();
  await h.settle();
  assert.equal(h.rooms.rooms.length, 0);
  const room = await h.rooms.create('game');
  assert.equal(h.rooms.rooms[0], room, 'a room may be made again once the last one closed');
  h.rooms.close();
});

test('rooms: a client over the message rate is closed with CloseCode.rateLimit; a room may raise its own', async () => {
  // Defaults: bursts of 60.
  const h = harness(Plain),
    a = await joined(h);
  for (let i = 0; i < 100; i++) a.send('spam', i);
  await h.settle();
  assert.deepEqual(h.closes, [4002]);
  assert.equal(h.rooms.rooms.length, 0, 'the room emptied and was disposed');
  // Server-wide limits.
  const s = harness(Plain, { limits: { messagesPerSecond: 5, burst: 3 } }),
    b = await joined(s);
  for (let i = 0; i < 10; i++) b.send('spam', i);
  await s.settle();
  assert.deepEqual(s.closes, [4002]);
  // A room's own limits win over the server's.
  class Chatty extends Plain {
    maxMessagesPerSecond = 1000;
    messageBurst = 200;
  }
  const c = harness(Chatty, { limits: { messagesPerSecond: 5, burst: 3 } }),
    talker = await joined(c);
  for (let i = 0; i < 100; i++) talker.send('chat', i);
  await c.settle();
  assert.deepEqual(c.closes, [0]);
  assert.equal(c.rooms.rooms[0].received, 100);
  talker.leave();
  for (const x of [h, s, c]) x.rooms.close();
});

test('rooms: RoomServer options out of range throw RangeError', () => {
  for (const options of [
    { joinTimeout: 0 },
    { joinTimeout: 'soon' },
    { maxConnections: 1.5 },
    { maxConnections: 0 },
    { maxRooms: Number.POSITIVE_INFINITY },
    { limits: { messagesPerSecond: 0 } },
    { limits: { burst: 0.5 } },
  ])
    assert.throws(() => new RoomServer(options), RangeError, JSON.stringify(options));
  class Bad extends Plain {
    maxMessagesPerSecond = -1;
  }
  return assert.rejects(new RoomServer().define('bad', Bad).create('bad'), RangeError);
});

test('rooms: a throwing simulation step or patch stops its room, reports it and throws nothing uncaught', async () => {
  class Stepper extends Plain {
    onJoin() {
      this.setSimulationInterval(() => {
        throw new Error('step broke');
      }, 5);
    }
  }
  class AsyncStepper extends Plain {
    onJoin() {
      this.setSimulationInterval(async () => {
        throw new Error('async step broke');
      }, 5);
    }
  }
  class BadPatch extends Plain {
    onJoin() {
      this.state.turn = -1; // not a uint: the next timed patch cannot encode it
      this.setPatchRate(5);
    }
  }
  await noUnhandled(async () => {
    for (const [Class, message] of [
      [Stepper, 'step broke'],
      [AsyncStepper, 'async step broke'],
      [BadPatch, undefined],
    ]) {
      const h = harness(Class);
      await joined(h);
      await wait(40);
      await h.settle();
      await wait(40);
      assert.equal(h.errors.length, 1, `${Class.name}: reported once, then stopped`);
      assert.equal(h.errors[0][1], 'game', 'with its room');
      if (message) assert.equal(h.errors[0][0], message);
      assert.deepEqual(h.closes, [4007]);
      assert.equal(h.rooms.rooms.length, 0, 'the room is disposed');
      h.rooms.close();
    }
  });
});

test('rooms: a client that leaves while onAuth runs is not seated', async () => {
  class SlowAuth extends Plain {
    async onAuth() {
      await wait(30);
      return true;
    }
  }
  const h = harness(SlowAuth),
    controller = new AbortController(),
    joining = new RoomsClient(async () => h.network.connect()).joinOrCreate(
      'game',
      {},
      { schema, stateType: 'State', signal: controller.signal },
    );
  joining.catch(() => {});
  await h.settle();
  controller.abort(new Error('gone'));
  await h.settle();
  // fixed-wait: past joinTimeout, a timer that must not bring the aborted join back
  await wait(60);
  await h.settle();
  await assert.rejects(joining, /gone/, 'an aborted join rejects with the abort reason');
  assert.equal(h.rooms.rooms.length, 0, 'no room is left holding a client that already left');
  assert.equal(h.rooms.connections, 0);
  h.rooms.close();
});
