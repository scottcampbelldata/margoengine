import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, LoopbackNetwork } from '../dist/index.js';
import { LobbyRoom, RoomLobby } from '../dist/lobby.js';
import { RoomServer, RoomsClient } from '../dist/rooms.js';

const schema = defineSchema({ types: { State: { count: 'uint' } } });
class Match extends LobbyRoom {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  onCreate() {
    this.setPatchRate(0);
    this.setState({ count: 0 });
    this.setMetadata({ mode: 'duel', rank: 3 });
  }
  onAuth(_client, options) {
    return options.player === 'Ada';
  }
  onJoin(client, options) {
    client.userData = options.player;
    this.state.count++;
  }
}
const connection = () => ({
  open: true,
  onmessage: null,
  onclose: null,
  send() {},
  close(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.onclose?.(code, reason);
  },
});

test('lobby lists joinable metadata, filters, hides private/locked rooms and copies values', async () => {
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match'),
    lobby = new RoomLobby(server);
  const listing = lobby.list({ name: 'match', metadata: { rank: 3 } });
  assert.equal(listing.length, 1);
  listing[0].metadata.rank = 99;
  assert.equal(room.metadata.rank, 3);
  assert.equal(lobby.list({ metadata: { rank: 99 } }).length, 0);
  room.privateRoom = true;
  assert.equal(lobby.list().length, 0);
  room.privateRoom = false;
  room.lock();
  assert.equal(lobby.list().length, 0);
  room.unlock();
  assert.equal(lobby.list().length, 1);
  assert.throws(() => room.setMetadata({ bad: Infinity }), TypeError);
});

test('reserved seats block ordinary joins, count reconnect seats and consume exactly once', async () => {
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match'),
    lobby = new RoomLobby(server);
  room.reconnectWindow = 10000;
  const one = lobby.reserve(room.roomId, { player: 'Ada' });
  const two = lobby.reserve(room.roomId, { player: 'Ada' });
  assert.equal(lobby.list().length, 0);
  assert.throws(() => room.reserve(), /reserve/);
  assert.equal(await room.admit(connection(), 'intruder', { player: 'Ada' }), 'refused');
  const first = connection();
  assert.equal(await room.admit(first, 'one', { seatToken: one.seatToken, player: 'Mallory' }), 'joined');
  assert.equal(room.clients[0].userData, 'Ada');
  assert.equal(await room.admit(connection(), 'replay', { seatToken: one.seatToken }), 'refused');
  first.close(4006, 'drop');
  assert.equal(room.dropped.length, 1);
  assert.equal(await room.admit(connection(), 'two', { seatToken: two.seatToken }), 'joined');
  assert.equal(room.dropped.length + room.clients.length, 2);
});

test('two asynchronous authentications racing for one token cannot overbook', async () => {
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match');
  room.maxClients = 1;
  let finish;
  const auth = new Promise((resolve) => {
    finish = resolve;
  });
  room.onAuth = () => auth;
  const seat = room.reserve({ player: 'Ada' });
  const one = room.admit(connection(), 'one', { seatToken: seat.seatToken });
  const two = room.admit(connection(), 'two', { seatToken: seat.seatToken });
  finish(true);
  assert.deepEqual(await Promise.all([one, two]), ['joined', 'refused']);
  assert.equal(room.clients.length, 1);
});

test('expiration, cancellation, disposal and aborted auth free reservations without replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match');
  room.autoDispose = false;
  const seat = room.reserve({ player: 'Ada' }, 20);
  t.mock.timers.tick(20);
  assert.equal(room.reservedSeats, 0);
  assert.equal(await room.admit(connection(), 'late', { seatToken: seat.seatToken }), 'refused');
  const cancelled = room.reserve();
  assert.equal(room.cancelReservation(cancelled.seatToken), true);
  assert.equal(room.cancelReservation(cancelled.seatToken), false);
  assert.throws(() => room.reserve({}, Infinity), RangeError);
  const held = room.reserve({ player: 'Ada' });
  const disconnected = connection();
  disconnected.open = false;
  assert.equal(await room.admit(disconnected, 'gone', { seatToken: held.seatToken }), 'refused');
  assert.equal(room.reservedSeats, 1);
  room.disconnect();
  assert.equal(room.reservedSeats, 0);
  assert.throws(() => room.reserve(), /reserve/);
});

test('expiry during authentication refuses admission and auto-disposes an empty room', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match');
  let finish;
  room.onAuth = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const seat = room.reserve({ player: 'Ada' }, 10);
  const pending = room.admit(connection(), 'late', { seatToken: seat.seatToken });
  t.mock.timers.tick(10);
  finish(true);
  assert.equal(await pending, 'refused');
  assert.equal(server.rooms.length, 0);
});

test('one-time reservation joins through the existing RoomsClient wire protocol', async () => {
  using server = new RoomServer().define('match', Match);
  const room = await server.create('match');
  room.maxClients = 1;
  const seat = new RoomLobby(server).reserve(room.roomId, { player: 'Ada' });
  const network = new LoopbackNetwork();
  network.listen().onconnection = (c) => server.accept(c);
  const client = new RoomsClient(async () => network.connect());
  const pending = client.joinById(seat.roomId, { seatToken: seat.seatToken }, { schema, stateType: 'State' });
  for (let i = 0; i < 10; i++) {
    network.advance(10);
    await new Promise(setImmediate);
  }
  using joined = await pending;
  assert.equal(joined.roomId, seat.roomId);
  assert.equal(joined.state.count, 1);
});
