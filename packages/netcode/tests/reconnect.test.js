import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode, defineSchema, LoopbackNetwork } from '../dist/index.js';
import { Room, RoomsClient, RoomServer } from '../dist/rooms.js';

const schema = defineSchema({
  types: {
    Player: { x: 'f32', online: 'bool' },
    State: { players: { type: 'map', of: 'Player', maxSize: 8 } },
  },
});
const join = { schema, stateType: 'State' };

class Table extends Room {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  reconnectWindow = 60;
  events = [];
  onCreate() {
    this.setPatchRate(0);
    this.setState({ players: new Map() });
    this.onMessage('move', (client, x) => (this.state.players.get(this.idOf(client)).x = x));
  }
  onJoin(client) {
    this.state.players.set(this.idOf(client), { x: 0, online: true });
    this.events.push('join');
  }
  onDrop(client) {
    this.state.players.get(this.idOf(client)).online = false;
    this.events.push('drop');
  }
  onReconnect(client) {
    this.state.players.get(this.idOf(client)).online = true;
    this.events.push('back');
  }
  onLeave(client, consented) {
    this.state.players.delete(this.idOf(client));
    this.events.push(consented ? 'left' : 'gone');
  }
  onDispose() {
    this.events.push('dispose');
  }
}

/** A server and a pump that delivers loopback messages on real time, so the room's own timers also run. */
function world(Class = Table) {
  const network = new LoopbackNetwork({ latency: 1 }),
    errors = [],
    rooms = new RoomServer().define('table', Class),
    connections = [];
  rooms.onerror = (error) => errors.push(error);
  network.listen().onconnection = (connection) => rooms.accept(connection);
  const pump = setInterval(() => network.advance(5), 1);
  const client = new RoomsClient(async () => {
    const connection = network.connect();
    connections.push(connection);
    return connection;
  });
  const lose = () => connections.at(-1).close(1006, 'link lost');
  return { client, connections, errors, lose, network, rooms, stop: () => (clearInterval(pump), rooms.close()) };
}
// The room's reconnectWindow timer is a mocked setTimeout, so a held seat runs out only when a test calls
// t.mock.timers.tick. With a real 60 ms window a loaded machine (verify runs eight files at once) let seats run out
// between two steps of a test that needed them held. The loopback pump and these waits use setInterval, which stays real.
test.beforeEach((t) => t.mock.timers.enable({ apis: ['setTimeout'] }));
const pause = (ms) =>
  new Promise((r) => {
    const h = setInterval(() => (clearInterval(h), r()), ms);
  });
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await pause(2);
  assert.ok(check(), 'it happened in time');
};

test('reconnect: a dropped player comes back to the same seat, with the whole state', async (t) => {
  const w = world();
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  await until(() => first.state);
  const seat = room.clients[0],
    id = room.idOf(seat);
  seat.userData = 'kept';
  first.send('move', 7);
  await until(() => room.state.players.get(id).x === 7);
  assert.match(first.reconnectionToken, new RegExp(`^${first.roomId}\\.[0-9a-f]{32}$`));
  w.lose();
  await until(() => room.dropped.length === 1);
  assert.deepEqual(room.events, ['join', 'drop']);
  assert.equal(room.clients.length, 0);
  assert.equal(room.state.players.get(id).online, false, 'its place in the game waits');

  const back = await w.client.reconnect(first.reconnectionToken, join);
  await until(() => back.state);
  assert.equal(back.sessionId, first.sessionId, 'the same seat');
  assert.equal(room.clients[0], seat, 'the same RoomClient, so idOf and userData hold');
  assert.equal(seat.userData, 'kept');
  assert.equal(back.state.players.get(id).x, 7, 'a new connection gets the whole state');
  assert.equal(back.state.players.get(id).online, true);
  assert.deepEqual(room.events, ['join', 'drop', 'back']);
  assert.equal(room.dropped.length, 0);
  back.send('move', 9);
  await until(() => room.state.players.get(id).x === 9);
  t.mock.timers.tick(90); // longer than the window, to show the old timer was cancelled
  await pause(10);
  assert.deepEqual(room.events, ['join', 'drop', 'back'], 'the timer of the old drop was cancelled');
});

test('reconnect: when the time runs out the seat goes, onLeave runs and the token is refused', async (t) => {
  const w = world();
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    other = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  assert.equal(room.clients.length, 2);
  other.leave();
  await until(() => room.events.includes('left'));
  w.connections[0].close(1006, 'lost');
  await until(() => room.dropped.length === 1);
  const third = await w.client.joinOrCreate('table', {}, join);
  assert.equal(room.clients.length, 1);
  assert.equal(room.dropped.length, 1, 'the seat is still held before the window ends');
  t.mock.timers.tick(60);
  await until(() => room.events.includes('gone'));
  assert.equal(room.dropped.length, 0);
  await assert.rejects(w.client.reconnect(first.reconnectionToken, join), /seat is gone/);
  third.leave();
});

test('reconnect: a held seat counts as taken, and keeps an empty room alive', async (t) => {
  const w = world();
  t.after(w.stop);
  const one = await w.client.joinOrCreate('table', {}, join),
    two = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  w.connections[1].close(1006, 'lost');
  await until(() => room.dropped.length === 1);
  assert.equal(room.locked, true, 'the seat is reserved');
  await assert.rejects(w.client.join('table', {}, join), /no open/);
  one.leave();
  await until(() => room.clients.length === 0);
  assert.ok(w.rooms.rooms.includes(room), 'alive while a seat is held');
  const back = await w.client.reconnect(two.reconnectionToken, join);
  assert.equal(room.clients.length, 1);
  back.leave();
  await until(() => room.events.includes('dispose'));
});

test('reconnect: a refused join does not dispose of a room whose only seat is held', async (t) => {
  class Picky extends Table {
    onAuth(_client, options) {
      return options.pass === true;
    }
  }
  const w = world(Picky);
  t.after(w.stop);
  const one = await w.client.joinOrCreate('table', { pass: true }, join),
    room = w.rooms.rooms[0];
  w.lose();
  await until(() => room.dropped.length === 1);
  await assert.rejects(w.client.joinById(room.roomId, { pass: false }, join), /refused/);
  assert.ok(w.rooms.rooms.includes(room));
  const back = await w.client.reconnect(one.reconnectionToken, join);
  assert.equal(back.sessionId, one.sessionId);
});

test('reconnect: the empty room is disposed when the last held seat runs out', async (t) => {
  const w = world();
  t.after(w.stop);
  await w.client.joinOrCreate('table', {}, join);
  const room = w.rooms.rooms[0];
  w.lose();
  await until(() => room.dropped.length === 1);
  t.mock.timers.tick(60);
  await until(() => room.events.includes('dispose'));
  assert.deepEqual(room.events, ['join', 'drop', 'gone', 'dispose']);
});

test('reconnect: a new connection takes over when the old one died without the server noticing', async (t) => {
  const w = world();
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0],
    seat = room.clients[0];
  let closed;
  first.onLeave((code) => (closed = code));
  const back = await w.client.reconnect(first.reconnectionToken, join);
  await until(() => closed !== undefined);
  assert.equal(closed, CloseCode.removed);
  assert.equal(room.clients.length, 1);
  assert.equal(room.clients[0], seat);
  assert.deepEqual(room.events, ['join', 'back'], 'no drop and no leave: the seat never emptied');
  assert.equal(w.rooms.connections, 1, 'the old connection is no longer counted');
  back.send('move', 3);
  await until(() => room.state.players.get(room.idOf(seat)).x === 3);
});

test('reconnect: a token works once, and a guess or another room gets nothing', async (t) => {
  class Patient extends Table {
    reconnectWindow = 10_000;
  }
  const w = world(Patient);
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  w.lose();
  await until(() => room.dropped.length === 1);
  const fake = `${first.roomId}.${'0'.repeat(32)}`;
  await assert.rejects(w.client.reconnect(fake, join), /seat is gone/);
  await assert.rejects(w.client.reconnect('nothing', join), /seat is gone/);
  await assert.rejects(w.client.reconnect(`nope.${first.reconnectionToken.split('.')[1]}`, join), /seat is gone/);
  const back = await w.client.reconnect(first.reconnectionToken, join);
  assert.notEqual(back.reconnectionToken, first.reconnectionToken);
  await assert.rejects(w.client.reconnect(first.reconnectionToken, join), /seat is gone/, 'the old token is spent');
});

test('reconnect: leaving on purpose, a kick and a broken rule keep no seat', async (t) => {
  const w = world();
  t.after(w.stop);
  const one = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  await w.client.joinOrCreate('table', {}, join);
  room.clients[1].leave();
  await until(() => room.clients.length === 1);
  assert.equal(room.dropped.length, 0);
  assert.ok(room.events.includes('gone'), 'a kick is a leave at once');
  one.leave();
  await until(() => room.events.includes('left'));
  assert.equal(room.dropped.length, 0);
  await assert.rejects(w.client.reconnect(one.reconnectionToken, join), /seat is gone/);
});

test('reconnect: a room with no reconnectWindow behaves as before and hands out no token', async (t) => {
  class Plain extends Table {
    reconnectWindow = 0;
  }
  const w = world(Plain);
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  assert.equal(first.reconnectionToken, '');
  w.lose();
  await until(() => room.events.includes('gone'));
  assert.deepEqual(room.events, ['join', 'gone', 'dispose']);
});

test('reconnect: a seat held when the room closes gets its onLeave; hooks that throw are reported', async (t) => {
  class Broken extends Table {
    onDrop() {
      throw new Error('drop hook');
    }
    onReconnect() {
      throw new Error('back hook');
    }
  }
  const w = world(Broken);
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  w.lose();
  await until(() => w.errors.length === 1);
  assert.equal(room.dropped.length, 1, 'the seat is held whatever the hook did');
  await w.client.reconnect(first.reconnectionToken, join);
  await until(() => w.errors.length === 2);
  await until(() => room.events.includes('gone'));
  assert.equal(w.connections.at(-1).open, false, 'the hook failed, so the seat is not held again');
  assert.equal(room.dropped.length, 0);

  const v = world();
  t.after(v.stop);
  await v.client.joinOrCreate('table', {}, join);
  const held = v.rooms.rooms[0];
  v.lose();
  await until(() => held.dropped.length === 1);
  held.disconnect();
  await until(() => held.events.includes('gone'));
  assert.deepEqual(held.events, ['join', 'drop', 'gone', 'dispose']);
});

test('reconnect: a held seat outlasts a slow step of the test, as on a loaded machine', async (t) => {
  // Regression: verify on a busy Windows machine took longer than the 60 ms window between two steps, the seat ran
  // out and "a held seat counts as taken" failed. A 100 ms stall stands in for that load.
  const w = world();
  t.after(w.stop);
  const first = await w.client.joinOrCreate('table', {}, join),
    room = w.rooms.rooms[0];
  w.lose();
  await until(() => room.dropped.length === 1);
  for (const end = performance.now() + 100; performance.now() < end; );
  await pause(10);
  assert.equal(room.dropped.length, 1, 'the seat is still held');
  const back = await w.client.reconnect(first.reconnectionToken, join);
  assert.equal(back.sessionId, first.sessionId);
});
