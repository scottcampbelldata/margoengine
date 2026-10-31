// The generic app message: bytes the game on the server sends to one player or all, over real sockets, and hostile input.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  MAX_APP_BYTES,
  PROTOCOL_VERSION,
  VoxelNetClient,
} from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function start(t) {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat, spawn: (id) => [31, 4 + id * 4] }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(url, name) {
  const conn = await connectWebSocket(url),
    client = new VoxelNetClient(
      new VoxelWorld({ blocks }),
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name },
    ),
    apps = [];
  client.onApp = (data) => apps.push(data);
  client.onError = (error) => assert.fail(error);
  conn.onmessage = (d) => client.receive(d);
  return { client, conn, apps };
}
async function until(what, done) {
  const end = performance.now() + 10_000;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(10);
  }
}
const closeOf = (conn) => new Promise((done) => (conn.onclose = (code, reason) => done({ code, reason })));
const listed = (server, n) => () => server.players.length === n;

test('an app message round-trips through the codec, at every size up to the limit', () => {
  assert.equal(PROTOCOL_VERSION, 4);
  assert.equal(MAX_APP_BYTES, 16384);
  for (const data of [
    new Uint8Array(0),
    Uint8Array.of(0),
    Uint8Array.of(255, 0, 7),
    Uint8Array.from({ length: MAX_APP_BYTES }, (_, i) => i * 7),
  ]) {
    const bytes = encodeServerMessage({ type: 'app', data });
    assert.equal(bytes[0], 25);
    assert.equal(bytes.length, data.length + 1);
    const message = decodeServerMessage(bytes);
    assert.equal(message.type, 'app');
    assert.deepEqual(message.data, data);
    assert.notEqual(message.data.buffer, bytes.buffer, 'the payload is a copy, not a view of the frame');
  }
});

test('hostile app messages throw instead of reading or sending past their end', () => {
  // Oversized, on the way out and on the way in.
  assert.throws(() => encodeServerMessage({ type: 'app', data: new Uint8Array(MAX_APP_BYTES + 1) }), RangeError);
  assert.throws(() => decodeServerMessage(Uint8Array.of(25, ...new Uint8Array(MAX_APP_BYTES + 1))), RangeError);
  // Not bytes at all.
  for (const data of [undefined, null, 'hi', [1, 2], new ArrayBuffer(3)])
    assert.throws(() => encodeServerMessage({ type: 'app', data }), TypeError);
  // Truncated to the kind byte alone is an empty payload; truncated to nothing is not a message; the next kind is unknown.
  assert.deepEqual(decodeServerMessage(Uint8Array.of(25)).data, new Uint8Array(0));
  assert.throws(() => decodeServerMessage(new Uint8Array(0)), RangeError);
  assert.throws(() => decodeServerMessage(Uint8Array.of(26, 1)), RangeError);
  // A client may not send one: kind 25 is not a ClientMessage.
  assert.throws(() => decodeClientMessage(Uint8Array.of(25, 1, 2)), RangeError);
  assert.throws(() => encodeClientMessage({ type: 'app', data: new Uint8Array(1) }), TypeError);
});

test('send reaches one player and broadcast all, in the order sent', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, 'Ada'),
    b = await join(url, 'Lin');
  await until('two players', listed(server, 2));
  const pa = server.players.find((p) => p.name === 'Ada'),
    pb = server.players.find((p) => p.name === 'Lin'),
    big = Uint8Array.from({ length: MAX_APP_BYTES }, (_, i) => i & 255);
  assert.equal(server.send(pa, Uint8Array.of(1, 2, 3)), true);
  assert.equal(server.send(pa, big), true);
  assert.equal(server.broadcast(Uint8Array.of(9)), 2);
  await until('app messages', () => a.apps.length === 3 && b.apps.length === 1);
  assert.deepEqual(a.apps, [Uint8Array.of(1, 2, 3), big, Uint8Array.of(9)]);
  assert.deepEqual(b.apps, [Uint8Array.of(9)]);
  assert.ok(a.client.stats.received.app > b.client.stats.received.app, 'the client counts them');
  assert.ok(server.metrics.bytesOut.app >= 3 + MAX_APP_BYTES + 2, 'the server counts them');
  // The sender's array is copied: changing it after send changes nothing in flight.
  const mine = Uint8Array.of(5, 5);
  server.send(pb, mine);
  mine[0] = 0;
  await until('the copy', () => b.apps.length === 2);
  assert.deepEqual(b.apps[1], Uint8Array.of(5, 5));
});

test('send and broadcast refuse hostile arguments with the right error and queue nothing', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, 'Ada');
  await until('one player', listed(server, 1));
  const player = server.players[0];
  assert.throws(() => server.send(player, new Uint8Array(MAX_APP_BYTES + 1)), RangeError);
  assert.throws(() => server.broadcast(new Uint8Array(MAX_APP_BYTES + 1)), RangeError);
  assert.throws(() => server.send(player, 'text'), TypeError);
  assert.throws(() => server.send(player, [1, 2]), TypeError);
  assert.throws(() => server.broadcast(undefined), TypeError);
  for (const bad of [undefined, null, 7, 'Ada', {}])
    assert.throws(() => server.send(bad, new Uint8Array(1)), TypeError);
  await wait(150);
  assert.deepEqual(a.apps, []);
  assert.equal(server.players.length, 1, 'and nobody was dropped');
});

test('an app message before the player has spawned arrives, after its welcome', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, 'Early'),
    seen = [];
  a.client.onApp = (data) => seen.push([a.client.welcome !== undefined, a.client.spawned, [...data]]);
  // Listed means welcomed: send at once, before the spawn.
  await until('listed', listed(server, 1));
  const player = server.players[0];
  assert.equal(player.spawned, false);
  assert.equal(server.send(player, Uint8Array.of(42)), true);
  await until('the app message', () => seen.length === 1);
  assert.deepEqual(seen[0][2], [42]);
  assert.equal(seen[0][0], true, 'the welcome was handled first');
});

test('a connection that has not said hello is not a player: broadcast skips it', async (t) => {
  const { server, url } = await start(t),
    quiet = await connectWebSocket(url);
  quiet.onclose = () => {};
  await until('a pending connection', () => server.counts.pending === 1);
  assert.equal(server.broadcast(Uint8Array.of(1)), 0);
  assert.deepEqual(server.players, [], 'so a game never holds it to send to');
  quiet.close();
});

test('sending to a player who has left returns false and breaks nothing', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, 'Ada'),
    b = await join(url, 'Lin');
  await until('two players', listed(server, 2));
  const gone = server.players.find((p) => p.name === 'Ada');
  a.conn.close();
  await until('Ada gone', listed(server, 1));
  assert.equal(server.send(gone, Uint8Array.of(1)), false, 'a closed player');
  assert.equal(server.send(gone, Uint8Array.of(1)), false, 'and again');
  assert.equal(server.broadcast(Uint8Array.of(2)), 1, 'only the one still here');
  await until('the broadcast', () => b.apps.length === 1);
  assert.deepEqual(b.apps, [Uint8Array.of(2)]);
  // A player of another server was never this one's.
  const other = new VoxelServer({ blocks, workers: 1, generator: flat });
  t.after(() => other.close());
  assert.equal(other.send(server.players[0], Uint8Array.of(3)), false);
});

test('a client that sends an app message to the server is closed, and the others are not', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, 'Ada'),
    rude = await connectWebSocket(url),
    closed = closeOf(rude);
  rude.send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'rude' }));
  await until('both joined', listed(server, 2));
  rude.send(Uint8Array.of(25, 1, 2, 3));
  const { code, reason } = await closed;
  assert.equal(code, 1002);
  assert.equal(reason, 'unreadable message');
  await until('rude gone', listed(server, 1));
  assert.equal(server.send(server.players[0], Uint8Array.of(1)), true);
  await until('delivered', () => a.apps.length === 1);
});

test('a client on protocol 2 is refused with a reason naming both versions', async (t) => {
  const { server, url } = await start(t),
    old = await connectWebSocket(url),
    closed = closeOf(old);
  old.send(encodeClientMessage({ type: 'hello', version: 2, view: 2, name: 'old page' }));
  const { code, reason } = await closed;
  assert.equal(code, 1008);
  assert.equal(reason, 'protocol 2, server speaks 4');
  assert.equal(server.players.length, 0);
});

test('a throwing onApp goes to onError and closes the connection, and no handler drops the message', () => {
  let closed = 0;
  const errors = [],
    client = new VoxelNetClient(new VoxelWorld({ blocks }), {
      send() {},
      close: () => closed++,
    });
  client.onError = (e) => errors.push(e);
  client.onApp = () => {
    throw new Error('the game broke');
  };
  client.receive(encodeServerMessage({ type: 'app', data: Uint8Array.of(1) }));
  assert.equal(errors.length, 1);
  assert.equal(closed, 1);
  const quiet = new VoxelNetClient(new VoxelWorld({ blocks }), { send() {}, close() {} });
  quiet.onError = (e) => assert.fail(e);
  quiet.receive(encodeServerMessage({ type: 'app', data: Uint8Array.of(1, 2) }));
  assert.equal(quiet.stats.received.app, 3);
});

test('a payload read from a Node Buffer is a plain copy that later frames cannot overwrite', () => {
  const frame = Buffer.from([25, 1, 2, 3]),
    message = decodeServerMessage(frame);
  frame.fill(0);
  assert.equal(message.data.constructor, Uint8Array);
  assert.deepEqual([...message.data], [1, 2, 3]);
});
