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
