// Display names on the wire (hostile ones too), and exporting and importing edited chunks, over real sockets.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { EntityCodec } from '@margoengine/voxel/codec';
import {
  connectVoxelNet,
  encodeClientMessage,
  encodeServerMessage,
  PLAYER_SCHEMA,
  PROTOCOL_VERSION,
  VoxelNetClient,
} from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  STONE = blocks.id('stone'),
  FAIL_MARKER = joinPath(tmpdir(), `voxel-net-flat-fail-${process.pid}`),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));
process.env.VOXEL_NET_FLAT_FAIL = FAIL_MARKER;

// Players on flat stone either side of the chunk border at x = 32: both can reach cells of chunks 0 and 1.
async function start(t, options = {}) {
  const server = new VoxelServer({
      blocks,
      workers: 1,
      generator: flat,
      spawn: (id) => [31, 4 + id * 4],
      editBurst: 50,
      ...options,
    }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(url, options = {}) {
  const conn = await connectWebSocket(url),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(
      world,
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, ...options },
    );
  conn.onmessage = (d) => client.receive(d);
  return { client, conn, world };
}
// Updates the clients at 60 per second until `until()` holds or 10 s pass; false when it never held.
async function drive(clients, until) {
  const end = performance.now() + 10_000;
  let last = performance.now();
  while (!until()) {
    if (performance.now() > end) return false;
    await wait(16);
    const now = performance.now();
    for (const c of clients) c.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return true;
}
const hasChunk = (client, x, y, z) => !!client.world.getChunk(x >> 5, y >> 5, z >> 5);
const ready = (clients) => () => clients.every((c) => c.spawned && hasChunk(c, 31, 7, 8) && hasChunk(c, 32, 7, 8));
const rawHello = (name) => {
  const bytes = encoder.encode(name);
  return Uint8Array.from([1, PROTOCOL_VERSION, 2, bytes.length, ...bytes]);
};
const encoder = new TextEncoder();
const closeOf = (conn) => new Promise((done) => (conn.onclose = (code, reason) => done({ code, reason })));

test('a player sees the names of others, before their first state, and again when they come back', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, { name: 'Ada' }),
    b = await join(url, { name: 'Lin' }),
    c = await join(url),
    clients = [a.client, b.client, c.client];
  // Whatever the first frame holds, a RemotePlayer never exists without the name the server gave.
  const seen = new Set(),
    idOf = (x) => x.client.welcome.id,
    receive = b.client.receive.bind(b.client);
  b.client.receive = (d) => {
    receive(d);
    for (const other of b.client.players.values()) seen.add(`${other.id}:${other.name}`);
  };
  assert.ok(await drive(clients, () => ready(clients)() && clients.every((x) => x.players.size === 2)), 'all in range');
  assert.equal(b.client.players.get(idOf(a)).name, 'Ada');
  assert.equal(a.client.players.get(idOf(b)).name, 'Lin');
  assert.equal(a.client.players.get(idOf(c)).name, '', 'no name stays empty');
  assert.deepEqual([...seen].sort(), [`${idOf(a)}:Ada`, `${idOf(c)}:`].sort());
  assert.deepEqual(server.players.map((p) => p.name).sort(), ['', 'Ada', 'Lin']);
  // A leaves everyone's range and comes back: the client forgot the name with the player, and hears it again.
  const body = server.players.find((p) => p.id === idOf(a)).character,
    home = [...body.position],
    before = server.metrics.bytesOut.names;
  body.position = [home[0] + 200, home[1], home[2]];
  assert.ok(await drive(clients, () => !b.client.players.has(idOf(a))), 'A out of range');
  body.position = home;
  assert.ok(await drive(clients, () => b.client.players.has(idOf(a))), 'A back in range');
  assert.equal(b.client.players.get(idOf(a)).name, 'Ada');
  assert.ok(server.metrics.bytesOut.names > before, 'named again');
  assert.ok(b.client.stats.received.names > 0, 'the client counts them');
});

test('a bot without player decoding ignores names; a name before its player is kept for it', () => {
  const codec = new EntityCodec(PLAYER_SCHEMA),
    state = codec.prepare({ position: [1, 2, 3], rotation: [0, 0, 0, 1] }, 9),
    nearby = new Map([[9, state]]),
    data = codec.encode(nearby, new Map()),
    gone = codec.encode(new Map(), nearby),
    names = encodeServerMessage({ type: 'names', names: [{ id: 9, name: 'Ada' }] }),
    players = (tick, bytes) => encodeServerMessage({ type: 'players', tick, data: bytes }),
    make = (options) => new VoxelNetClient(new VoxelWorld({ blocks }), { send() {}, close() {} }, options);
  const client = make({});
  client.onError = (error) => assert.fail(error);
  client.receive(names);
  client.receive(players(1, data));
  assert.equal(client.players.get(9).name, 'Ada');
  client.receive(players(2, gone));
  assert.equal(client.players.size, 0);
  // Forgotten with the player: the server names it again when it returns.
  client.receive(players(3, data));
  assert.equal(client.players.get(9).name, '');
  const bot = make({ players: false });
  bot.receive(names);
  bot.receive(players(1, data));
  assert.equal(bot.players.size, 0);
  assert.ok(bot.stats.received.names > 0);
});

test('hostile names are cleaned before anyone sees them, and unreadable ones are kicked', async (t) => {
  const hooked = [],
    { server, url } = await start(t, {
      authenticate: (_req, hello) => {
        if (hello) hooked.push(hello.name);
        return true;
      },
    }),
    watcher = await join(url, { name: 'w' });
  // Bidi override, NUL, newline, markup, zero width, more combining marks than anyone needs: over the raw wire.
  const evil = await connectWebSocket(url),
    all = [];
  evil.onmessage = () => {};
  evil.send(rawHello('‮A\u0000d​a\n<b>'));
  const blank = await connectWebSocket(url);
  blank.onmessage = () => {};
  blank.send(rawHello('​ㅤ ⠀\u0007'));
  assert.ok(
    await drive([watcher.client], () => {
      all.length = 0;
      for (const p of server.players) all.push(p.name);
      return all.length === 3;
    }),
  );
  assert.deepEqual(all.sort(), ['', 'Ada b', 'w']);
  assert.deepEqual(hooked.sort(), ['', 'Ada b', 'w'], 'authenticate sees the cleaned name');
  // Over 32 bytes, not UTF-8, a length past the end: the hello cannot be read, so the connection is closed.
  for (const bytes of [
    rawHello('x'.repeat(33)),
    Uint8Array.from([1, PROTOCOL_VERSION, 2, 2, 0xc0, 0xaf]),
    Uint8Array.from([1, PROTOCOL_VERSION, 2, 30, 65]),
  ]) {
    const conn = await connectWebSocket(url),
      closed = closeOf(conn);
    conn.send(bytes);
    assert.equal((await closed).code, 1002, 'unreadable hello');
  }
  assert.equal(server.players.length, 3, 'those never joined');
});

test('filterName replaces names; one that throws or returns nonsense closes the client with 1011', async (t) => {
  const errors = [],
    { server, url } = await start(t, {
      filterName: (name, id) => {
        assert.ok(id > 0);
        if (name === 'boom') throw new Error('rule broke');
        if (name === 'nonsense') return 7;
        return name === 'ok' ? 'quiet otter\u0000' : 'nameless';
      },
    });
  server.onError = (error) => errors.push(error);
  const a = await join(url, { name: 'ok' }),
    b = await join(url, { name: 'rude word' }),
    clients = [a.client, b.client];
  assert.ok(await drive(clients, () => clients.every((c) => c.players.size === 1)));
  assert.equal(b.client.players.get(a.client.welcome.id).name, 'quiet otter');
  assert.equal(a.client.players.get(b.client.welcome.id).name, 'nameless');
  for (const [name, message] of [
    ['boom', /rule broke/],
    ['nonsense', /filterName returned number/],
  ]) {
    const conn = await connectWebSocket(url),
      closed = closeOf(conn);
    conn.send(rawHello(name));
    const { code, reason } = await closed;
    assert.equal(code, 1011);
    assert.match(reason, /name-failed/);
    assert.match(errors.at(-1).message, message);
  }
  assert.equal(server.counts.pending, 0, 'the slot is free again');
  assert.throws(() => new VoxelServer({ blocks, filterName: 'no' }), TypeError);
});

test('an older protocol is kicked with a reason, and connectVoxelNet reports a refused connection', async (t) => {
  const { server, url } = await start(t, { authenticate: (_req, hello) => !hello || hello.name !== 'refused' });
  assert.equal(PROTOCOL_VERSION, 6);
  const old = await connectWebSocket(url),
    closed = closeOf(old);
  old.send(encodeClientMessage({ type: 'hello', version: 1, view: 2, name: 'old page' }));
  const { code, reason } = await closed;
  assert.equal(code, 1008);
  assert.equal(reason, 'protocol 1, server speaks 6');
  assert.equal(server.players.length, 0);
  // The browser path: without this, the page never learns why nothing arrives.
  const refused = connectVoxelNet(url, new VoxelWorld({ blocks }), { name: 'refused' }),
    error = await new Promise((done) => (refused.onError = done));
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'failed');
  assert.match(error.message, /closed the connection with 1008 \(not authorized\); check/);
  // A close the page asked for is no error.
  const fine = connectVoxelNet(url, new VoxelWorld({ blocks }), { name: 'fine' });
  fine.onError = (e) => assert.fail(e);
  await drive([fine], () => !!fine.welcome);
  fine.close();
  await wait(50);
});

test('two clients: export, edit, import, and both see the old state', { timeout: 60_000 }, async (t) => {
  const { server, url } = await start(t),
    a = await join(url, { name: 'a' }),
    b = await join(url, { name: 'b' }),
    clients = [a.client, b.client];
  // The server's "loaded", not the two chunks the edits need: until it comes, the rest of the view is still arriving.
  assert.ok(
    await drive(clients, () => ready(clients)() && clients.every((c) => c.loaded)),
    'both hold their whole view',
  );
  const same = (cell, want) => [server.world, a.world, b.world].every((w) => w.getBlock(...cell) === want);
  const breakCell = async (cell) => {
    assert.equal(a.client.edit(...cell, 0), true);
    assert.ok(await drive(clients, () => same(cell, 0)), `break ${cell}`);
  };
  const kept = [31, 7, 7],
    later = [30, 7, 7],
    other = [32, 7, 7];
  await breakCell(kept);
  const snapshot = await server.exportEdits();
  assert.deepEqual([...snapshot.keys()], ['0,0,0']);
  // Importing what the server already holds sends nothing.
  const quiet = b.client.stats.chunks;
  await server.importEdits(await server.exportEdits());
  // After the snapshot: one more edit in the same chunk, and the first edit of another chunk. Each one's blocks message
  // is written by a later tick than the one before, on the same socket, so whatever the import sent has come by now.
  await breakCell(later);
  await breakCell(other);
  assert.equal(b.client.stats.chunks, quiet, 'no chunk changed, none is sent');
  assert.equal(server.counts.editedChunks, 2);
  await server.importEdits(snapshot);
  assert.ok(await drive(clients, () => same(later, STONE) && same(other, STONE)), 'both clients see the old state');
  assert.equal(b.client.stats.chunks, quiet + 2, 'the two changed chunks, once each');
  assert.ok(same(kept, 0), 'the edit inside the snapshot stays');
  assert.equal(server.counts.editedChunks, 1, 'the other chunk is the generator again');
  assert.deepEqual([...(await server.exportEdits()).keys()], ['0,0,0']);
  // The snapshot is a copy: edits after importing it do not reach it.
  await breakCell(later);
  await server.importEdits(snapshot);
  assert.ok(await drive(clients, () => same(later, STONE)), 'a snapshot can be imported twice');
  // Play goes on: an edit after the import reaches the other client.
  await breakCell(other);
  assert.equal(server.metrics.editsDenied, 0);
});

test('importEdits checks everything first, and a failing generator changes nothing', { timeout: 60_000 }, async (t) => {
  const { server, url } = await start(t),
    a = await join(url);
  assert.ok(await drive([a.client], ready([a.client])));
  a.client.edit(31, 7, 7, 0);
  assert.ok(await drive([a.client], () => server.world.getBlock(31, 7, 7) === 0));
  const good = await server.exportEdits(),
    chunk = good.get('0,0,0'),
    bad = (key, value) => new Map([[key, value]]);
  await assert.rejects(server.importEdits([]), TypeError);
  await assert.rejects(server.importEdits(new Map([[7, chunk]])), TypeError);
  for (const key of ['nope', '1,2', '01,0,0', '1,0,0,0', `${2 ** 26},0,0`, '0,99999,0'])
    await assert.rejects(server.importEdits(bad(key, chunk)), RangeError, key);
  await assert.rejects(server.importEdits(bad('1,0,0', {})), TypeError);
  await assert.rejects(server.importEdits(bad('1,0,0', { ...chunk, bits: 3 })), RangeError);
  const unknown = { ...chunk, palette: Uint32Array.from(chunk.palette, (s, i) => (i ? 999 : s)) };
  await assert.rejects(server.importEdits(bad('1,0,0', unknown)), /block state 999.*block types/);
  assert.equal(server.world.getBlock(31, 7, 7), 0, 'none of those changed anything');
  // Going back to the generator needs the generator: when it fails the import rejects as a whole.
  writeFileSync(FAIL_MARKER, '');
  t.after(() => rmSync(FAIL_MARKER, { force: true }));
  const errors = [];
  server.onError = (e) => errors.push(e);
  await assert.rejects(server.importEdits(new Map()), /fails/);
  assert.equal(server.world.getBlock(31, 7, 7), 0);
  assert.equal(server.counts.editedChunks, 1);
  rmSync(FAIL_MARKER);
  await server.importEdits(new Map());
  assert.equal(server.world.getBlock(31, 7, 7), STONE);
  assert.equal(server.counts.editedChunks, 0);
  await server.close();
  await assert.rejects(
    server.importEdits(good),
    (e) => e.name === 'MargoError' && e.code === 'state' && /closed/.test(e.message),
  );
  const small = new VoxelServer({ blocks, generator: flat, maxEditedChunks: 1 });
  t.after(() => small.close());
  await assert.rejects(
    small.importEdits(
      new Map([
        ['0,0,0', chunk],
        ['1,0,0', chunk],
      ]),
    ),
    /maxEditedChunks/,
  );
});

test('a snapshot starts a new server, before it listens', { timeout: 60_000 }, async (t) => {
  const first = await start(t),
    a = await join(first.url);
  assert.ok(await drive([a.client], ready([a.client])));
  a.client.edit(31, 7, 7, 0);
  assert.ok(await drive([a.client], () => first.server.world.getBlock(31, 7, 7) === 0));
  const snapshot = await first.server.exportEdits(),
    second = new VoxelServer({ blocks, workers: 1, generator: flat, spawn: () => [31, 8] });
  t.after(() => second.close());
  await second.importEdits(snapshot);
  const { port } = await second.listen(0),
    b = await join(`ws://127.0.0.1:${port}`);
  assert.ok(await drive([b.client], ready([b.client])));
  assert.equal(b.world.getBlock(31, 7, 7), 0);
  assert.equal(second.counts.editedChunks, 1);
});

test('with a store: evicted chunks are exported, and going back deletes them', { timeout: 60_000 }, async (t) => {
  const saved = new Map(),
    make = (withDelete) => ({
      save: (key, chunk) => void saved.set(key, chunk),
      load: (key) => saved.get(key),
      ...(withDelete ? { delete: (key) => void saved.delete(key) } : {}),
    }),
    store = make(true),
    { server, url } = await start(t, { store, maxEditedChunks: 1 }),
    a = await join(url);
  assert.ok(await drive([a.client], ready([a.client])));
  a.client.edit(31, 7, 7, 0);
  assert.ok(await drive([a.client], () => server.world.getBlock(31, 7, 7) === 0));
  a.client.edit(32, 7, 7, 0);
  assert.ok(await drive([a.client], () => server.world.getBlock(32, 7, 7) === 0));
  assert.ok(await drive([a.client], () => saved.has('0,0,0')), 'the older chunk went to the store');
  assert.equal(server.counts.editedChunks, 1);
  const all = await server.exportEdits();
  assert.deepEqual([...all.keys()].sort(), ['0,0,0', '1,0,0'], 'both, the one in the store too');
  // Back to the snapshot taken with only 1,0,0: the one in the store goes back to the generator and leaves the store.
  const only = new Map([['1,0,0', all.get('1,0,0')]]);
  await server.importEdits(only);
  assert.ok(!saved.has('0,0,0'), 'deleted from the store');
  assert.equal(server.world.getBlock(31, 7, 7), STONE);
  assert.ok(await drive([a.client], () => a.world.getBlock(31, 7, 7) === STONE), 'the client sees it');
  assert.equal(server.world.getBlock(32, 7, 7), 0);
  // A store without delete: refused before anything changes, naming the fix.
  const blocked = await start(t, { store: make(false) }),
    c = await join(blocked.url);
  assert.ok(await drive([c.client], ready([c.client])));
  c.client.edit(31, 7, 7, 0);
  assert.ok(await drive([c.client], () => blocked.server.world.getBlock(31, 7, 7) === 0));
  await assert.rejects(
    blocked.server.importEdits(new Map()),
    (e) => e.name === 'MargoError' && e.code === 'state' && /delete\(key\)/.test(e.message),
  );
  assert.equal(blocked.server.world.getBlock(31, 7, 7), 0);
});

test('with a store: importing an evicted chunk the world still holds, unchanged, sends nothing', {
  timeout: 60_000,
}, async (t) => {
  const saved = new Map(),
    store = { save: (key, chunk) => void saved.set(key, chunk), load: (key) => saved.get(key) },
    { server, url } = await start(t, { store, maxEditedChunks: 1 }),
    a = await join(url);
  assert.ok(await drive([a.client], () => ready([a.client])() && a.client.loaded), 'holds its whole view');
  const breakCell = async (...cell) => {
    a.client.edit(...cell, 0);
    assert.ok(await drive([a.client], () => a.world.getBlock(...cell) === 0), `break ${cell}`);
  };
  await breakCell(31, 7, 7);
  await breakCell(32, 7, 7);
  assert.ok(await drive([a.client], () => saved.has('0,0,0')), 'the older chunk went to the store');
  const held = server.world.getChunk(0, 0, 0),
    quiet = a.client.stats.chunks;
  assert.ok(held);
  await server.importEdits(await server.exportEdits());
  assert.equal(server.world.getChunk(0, 0, 0), held, 'left alone');
  assert.equal(server.counts.editedChunks, 1, 'still in the store only');
  // Each blocks message is written by a later tick than the one before, on the same socket.
  await breakCell(33, 7, 7);
  await breakCell(34, 7, 7);
  assert.equal(a.client.stats.chunks, quiet, 'no chunk changed, none is sent');
  // A difference is still a change: the snapshot with the first cell back in place goes out.
  const whole = new VoxelWorld({ blocks }).addChunk(0, 0, 0),
    before = server.world.getChunk(0, 0, 0);
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) whole.set(x, y, z, x === 31 && y === 7 && z === 7 ? STONE : before.get(x, y, z));
  await server.importEdits(new Map([...(await server.exportEdits()), ['0,0,0', whole.pack()]]));
  assert.ok(await drive([a.client], () => a.world.getBlock(31, 7, 7) === STONE), 'the client sees it');
  assert.equal(a.client.stats.chunks, quiet + 1, 'that chunk, once');
});

test('a chunk just past the view is unloaded, not left stale, when it changes', { timeout: 60_000 }, async (t) => {
  const { server, url } = await start(t, { view: 2, maxView: 2, spawn: () => [8, 8] }),
    a = await join(url);
  assert.ok(await drive([a.client], () => a.client.spawned && a.client.loaded));
  assert.ok(a.world.getChunk(2, 0, 0), 'chunk in view');
  // One chunk away: its column is 3 from the player, one past the view, so it stays sent and in the client's world.
  const body = server.players[0].character,
    [x, y, z] = body.position;
  body.position = [x - 32, y, z];
  assert.ok(await drive([], () => a.world.getChunk(-3, 0, 0)), 'the view moved');
  assert.ok(a.world.getChunk(2, 0, 0), 'one past the view stays');
  await server.importEdits(new Map([['2,0,0', new VoxelWorld({ blocks }).addChunk(0, 0, 0).pack()]]));
  assert.ok(await drive([], () => !a.world.getChunk(2, 0, 0)), 'unloaded, not left showing the old chunk');
});
