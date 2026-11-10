import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineSchema } from '../dist/index.js';
import { LobbyRoom } from '../dist/lobby.js';
import { RoomNode, MemoryPresence, MemoryPresenceStore, openSqlitePresence, StorePresence } from '../dist/presence.js';
import { RoomServer, RoomsClient } from '../dist/rooms.js';
import { openWebSocket } from '../dist/websocket.js';

const schema = defineSchema({ types: { State: { joined: 'uint' } } });
class Match extends LobbyRoom {
  schema = schema;
  stateType = 'State';
  maxClients = 1;
  onCreate() {
    this.setPatchRate(0);
    this.setState({ joined: 0 });
    this.setMetadata({ mode: 'duel' });
  }
}
test('two RoomServers discover, filter and route reservations through in-memory presence', async () => {
  using presence = new MemoryPresence({ pollInterval: 1 });
  using one = new RoomServer().define('match', Match),
    two = new RoomServer().define('match', Match);
  const room = await one.create('match');
  await using a = new RoomNode(one, { presence, endpoint: 'wss://a.example.com' });
  await using b = new RoomNode(two, { presence, endpoint: 'wss://b.example.com' });
  const running = a.run();
  await a.sync();
  await b.sync();
  const rows = await b.list({ name: 'match', metadata: { mode: 'duel' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].processId, a.processId);
  rows[0].metadata.mode = 'wrong';
  assert.equal((await b.list())[0].metadata.mode, 'duel');
  assert.equal((await b.list({ metadata: { mode: 'other' } })).length, 0);
  const seat = await b.reserve(room.roomId, { player: 'Ada' });
  assert.equal(seat.endpoint, 'wss://a.example.com');
  assert.equal(seat.roomId, room.roomId);
  await assert.rejects(b.reserve(room.roomId), /reserve/);
  await a.sync();
  assert.equal((await b.list()).length, 0);
  await a.close();
  await running;
  assert.equal((await presence.processes()).length, 1);
  await assert.rejects(b.reserve(room.roomId), /no longer/);
});

test('atomic claims are once-only, namespaces isolate, expiry removes dead processes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const store = new MemoryPresenceStore();
  using presence = new StorePresence(store);
  await presence.publish({ processId: 'a', endpoint: 'ws://a', rooms: [] }, 10);
  assert.equal((await presence.processes()).length, 1);
  await store.set('claim', 'value', 2000);
  assert.deepEqual(await Promise.all([store.take('claim'), store.take('claim')]), ['value', undefined]);
  assert.equal((await new StorePresence(store, { namespace: 'other' }).processes()).length, 0);
  t.mock.timers.setTime(1010);
  assert.equal((await presence.processes()).length, 0);
});

test('requests abort without replay, time out, report remote errors and clean up records', async () => {
  const store = new MemoryPresenceStore();
  using presence = new StorePresence(store, { requestTimeout: 20, pollInterval: 1 });
  const abort = new AbortController();
  const pending = presence.request('absent', 'room', {}, 100, abort.signal);
  abort.abort(new TypeError('cancelled'));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(presence.request('absent', 'room', {}, 100), { name: 'TimeoutError' });
  assert.deepEqual(await store.keys('margo-netcode/request/'), []);
  assert.deepEqual(await store.keys('margo-netcode/reply/'), []);
  const stop = new AbortController();
  const serving = presence.serve(
    'a',
    () => {
      throw new RangeError('no seat');
    },
    stop.signal,
  );
  await assert.rejects(presence.request('a', 'room', {}, 100), /no seat/);
  stop.abort();
  await serving;
});

test('a failed heartbeat cancels IPC and withdraws only after its in-flight tasks stop', async () => {
  using presence = new MemoryPresence();
  using server = new RoomServer();
  let stopped = false,
    removedAfterStop = false;
  presence.publish = async () => {
    throw new TypeError('store failed');
  };
  presence.serve = async (_id, _handler, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    stopped = true;
  };
  presence.remove = async () => {
    removedAfterStop = stopped;
  };
  const node = new RoomNode(server, { presence, endpoint: 'ws://localhost' });
  await assert.rejects(node.run(), /store failed/);
  assert.equal(removedAfterStop, true);
});

test('SQLite adapter shares leases and atomic claims between independent connections', async () => {
  const folder = resolve('test-results/batch256', `presence-store-${crypto.randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  try {
    using a = await openSqlitePresence(resolve(folder, 'store.sqlite'));
    using b = await openSqlitePresence(resolve(folder, 'store.sqlite'));
    await a.publish({ processId: 'a', endpoint: 'ws://a', rooms: [] }, 10000);
    assert.equal((await b.processes())[0].processId, 'a');
    await b.remove('a');
    assert.deepEqual(await a.processes(), []);
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test('real OS processes discover and reserve remotely, then client joins owning WebSocket', {
  timeout: 20000,
}, async () => {
  const folder = resolve('test-results/batch256', `presence-process-${crypto.randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  const children = [];
  const start = async (label) => {
    const child = fork(new URL('./presence-child.mjs', import.meta.url), [resolve(folder, 'rooms.sqlite'), label], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let errors = '';
    child.stderr.on('data', (data) => {
      errors += data;
    });
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => reject(new TypeError(`child exited ${code}: ${errors}`)));
    });
    assert.equal(ready.ready, true, errors);
    const call = (command, args = {}) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const handler = (message) => {
          if (message.id !== id) return;
          child.off('message', handler);
          if (message.error) reject(new TypeError(message.error));
          else resolve(message.value);
        };
        child.on('message', handler);
        child.send({ id, command, ...args });
      });
    return { ...ready, call };
  };
  try {
    const a = await start('a'),
      b = await start('b');
    const list = await b.call('list');
    assert.equal(list.length, 2);
    assert.equal(list.find((room) => room.roomId === a.roomId).metadata.label, 'a');
    const seat = await b.call('reserve', { roomId: a.roomId });
    assert.equal(seat.processId, a.processId);
    const client = new RoomsClient(() => openWebSocket(seat.endpoint));
    using room = await client.joinById(
      seat.roomId,
      { seatToken: seat.seatToken },
      { schema, stateType: 'State', signal: AbortSignal.timeout(5000) },
    );
    if (!room.state) {
      for await (const state of room.states({ signal: AbortSignal.timeout(5000) })) {
        assert.equal(state.joined, 1);
        break;
      }
    }
    assert.equal(room.state.joined, 1);
    await assert.rejects(b.call('reserve', { roomId: a.roomId }), /reserve/);
    room.leave();
    await a.call('close');
    assert.equal(
      (await b.call('list')).some((room) => room.processId === a.processId),
      false,
    );
    await b.call('close');
  } finally {
    for (const child of children)
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => child.once('exit', resolve));
      }
    rmSync(folder, { recursive: true });
  }
});
