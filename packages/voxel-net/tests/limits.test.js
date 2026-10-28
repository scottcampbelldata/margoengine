// Server limits (bugs 44 and 50): connections that have not joined are capped before any player object exists, their
// counters return to zero on every close path, the default origin check allows only the server's own pages, the
// authenticate hook decides who joins, and edited chunks past maxEditedChunks go to a store and come back from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { VoxelWorld } from '@margoengine/voxel';
import { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, VoxelNetClient } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  LOG = blocks.id('log'),
  FLAT = { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 },
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 2, spawn: (id) => [id * 4, 8], ...options }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, port, url: `ws://127.0.0.1:${port}` };
}
// Polls `ok()` every 10 ms for up to `ms`; returns its last value.
async function until(ok, ms = 5000) {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await wait(10);
  return ok();
}
// A raw upgrade request with the given headers. Resolves with the status and, for a refusal, the body; a 101 keeps
// the socket open (a pending connection) until `socket.destroy()`.
async function upgrade(port, headers = {}) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((done) => socket.once('connect', done));
  const lines = Object.entries({ Host: `127.0.0.1:${port}`, ...headers }).map(([k, v]) => `${k}: ${v}\r\n`);
  socket.write(
    `GET / HTTP/1.1\r\n${lines.join('')}Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  let data = Buffer.alloc(0),
    ended = false;
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  socket.on('end', () => (ended = true));
  socket.on('error', () => (ended = true));
  await until(() => data.includes('\r\n\r\n'));
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(data.toString())?.[1]);
  if (status !== 101) await until(() => ended);
  return { status, body: data.subarray(data.indexOf('\r\n\r\n') + 4).toString(), socket };
}
// Connects (with extra request headers), sends a hello and resolves with 'welcome' or the close code and reason.
async function hello(url, name = 'p', headers = {}) {
  const conn = await connectWebSocket(url, { headers });
  return new Promise((resolve) => {
    conn.onmessage = (data) => {
      if (decodeServerMessage(data).type === 'welcome') resolve({ welcome: true, conn });
    };
    conn.onclose = (code, reason) => resolve({ code, reason, conn });
    conn.send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name }));
  });
}
// A VoxelNetClient over the Node WebSocket.
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
async function drive(clients, ms, done) {
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end && !done()) {
    await wait(16);
    const now = performance.now();
    for (const c of clients) c.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
}

test('a flood from one address gets 429 past maxPerAddress, before any player object exists', async (t) => {
  const { server, port } = await start(t),
    open = [];
  t.after(() => open.forEach((u) => u.socket.destroy()));
  for (let i = 0; i < 8; i++) open.push(await upgrade(port));
  assert.deepEqual(
    open.map((u) => u.status),
    Array(8).fill(101),
  );
  assert.equal(server.counts.pending, 8);
  const ninth = await upgrade(port);
  assert.equal(ninth.status, 429);
  assert.match(ninth.body, /maxPerAddress/);
  assert.equal(server.counts.pending, 8, 'the refused one was never counted');
  assert.equal(server.players.length, 0);
  open.pop().socket.destroy();
  assert.ok(await until(() => server.counts.pending === 7));
  const again = await upgrade(port);
  open.push(again);
  assert.equal(again.status, 101, 'a freed slot is usable again');
});

test('all addresses together get 503 past maxPending', async (t) => {
  const { server, port } = await start(t, { maxPending: 4, maxPerAddress: 100 }),
    open = [];
  t.after(() => open.forEach((u) => u.socket.destroy()));
  for (let i = 0; i < 4; i++) open.push(await upgrade(port));
  const fifth = await upgrade(port);
  assert.equal(fifth.status, 503);
  assert.match(fifth.body, /maxPending/);
  assert.equal(server.counts.pending, 4);
  // A joined player no longer counts: with one slot free a client joins, and the slot is free again after.
  open.pop().socket.destroy();
  assert.ok(await until(() => server.counts.pending === 3));
  const joined = await hello(`ws://127.0.0.1:${port}`);
  assert.equal(joined.welcome, true);
  assert.equal(server.counts.pending, 3);
  const next = await upgrade(port);
  open.push(next);
  assert.equal(next.status, 101);
  for (const u of open.splice(0)) u.socket.destroy();
  assert.ok(await until(() => server.counts.pending === 0));
  joined.conn.close();
});

test('the pending counters return to zero on every close path', { timeout: 60_000 }, async (t) => {
  const { server, port, url } = await start(t, { helloTimeout: 200 }),
    errors = [];
  server.onError = (e) => errors.push(e);
  for (let round = 0; round < 10; round++) {
    const paths = [
      // Dropped without a close frame.
      upgrade(port).then((u) => u.socket.destroy()),
      // Joined, then left.
      hello(url).then((r) => r.conn.close()),
      // Unreadable bytes: kicked with 1002.
      connectWebSocket(url).then(
        (conn) =>
          new Promise((done) => {
            conn.onclose = done;
            conn.send(new Uint8Array([255, 255, 255]));
          }),
      ),
      // Wrong protocol version: kicked with 1008.
      connectWebSocket(url).then(
        (conn) =>
          new Promise((done) => {
            conn.onclose = done;
            conn.send(encodeClientMessage({ type: 'hello', version: 99, view: 2, name: '' }));
          }),
      ),
      // Closed cleanly before the hello.
      connectWebSocket(url).then((conn) => conn.close()),
      // Silent: the hello timeout closes it.
      connectWebSocket(url).then((conn) => new Promise((done) => (conn.onclose = done))),
    ];
    await Promise.all(paths);
    assert.ok(server.counts.pending <= 6);
  }
  assert.ok(
    await until(() => server.counts.pending === 0 && server.counts.pendingAddresses === 0 && !server.players.length),
    `pending ${server.counts.pending}, addresses ${server.counts.pendingAddresses}`,
  );
  // Every slot is free again.
  const open = [];
  for (let i = 0; i < 8; i++) open.push(await upgrade(port));
  open.forEach((u) => u.socket.destroy());
  assert.deepEqual(
    open.map((u) => u.status),
    Array(8).fill(101),
  );
  assert.deepEqual(errors, []);
});

test('a connection that sends no hello is closed after 3 s by default', { timeout: 15_000 }, async (t) => {
  const { server, url } = await start(t),
    conn = await connectWebSocket(url),
    started = performance.now(),
    [code, reason] = await new Promise((done) => (conn.onclose = (...args) => done(args))),
    took = performance.now() - started;
  assert.equal(code, 1008);
  assert.match(reason, /helloTimeout/);
  assert.ok(took > 2500 && took < 5000, `closed after ${took} ms`);
  assert.equal(server.counts.pending, 0);
});

test('by default only pages of the server own host may connect; Node clients without an Origin always may', async (t) => {
  const { port } = await start(t),
    own = `127.0.0.1:${port}`;
  const status = async (headers) => {
    const u = await upgrade(port, headers);
    u.socket.destroy();
    return u;
  };
  assert.equal((await status({})).status, 101, 'no Origin');
  assert.equal((await status({ Origin: `http://${own}` })).status, 101, 'own page');
  assert.equal((await status({ Origin: `https://${own}` })).status, 101, 'own page over https');
  const evil = await status({ Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.match(evil.body, /origin-refused.*origins/);
  assert.equal((await status({ Origin: 'http://127.0.0.1:1' })).status, 403, 'another port is another origin');
  await assert.rejects(
    connectWebSocket(`ws://${own}`, { headers: { Origin: 'https://evil.example' } }),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /403.*origins/.test(error.message),
  );
});

test("origins: '*' allows any page; a list allows exactly its origins", async (t) => {
  const any = await start(t, { origins: '*' }),
    listed = await start(t, { origins: ['https://game.example'] });
  const status = async (port, headers) => {
    const u = await upgrade(port, headers);
    u.socket.destroy();
    return u.status;
  };
  assert.equal(await status(any.port, { Origin: 'https://evil.example' }), 101);
  assert.equal(await status(listed.port, { Origin: 'https://game.example' }), 101);
  assert.equal(await status(listed.port, { Origin: 'https://evil.example' }), 403);
  assert.equal(await status(listed.port, {}), 403);
  assert.throws(() => new VoxelServer({ blocks, origins: 'yes' }), TypeError);
});

test('authenticate runs on the upgrade and on the hello: true, a string identity, or false', async (t) => {
  const calls = [];
  const { server, url } = await start(t, {
    authenticate: async (req, greeting) => {
      const token = req.headers['x-token'];
      calls.push([token, greeting?.name]);
      if (token === 'bad' || greeting?.name === 'mallory') return false;
      return token === 'alice' && greeting ? 'account-17' : true;
    },
  });
  const alice = await hello(url, 'Alice', { 'X-Token': 'alice' });
  assert.equal(alice.welcome, true);
  const guest = await hello(url, 'guest');
  assert.equal(guest.welcome, true);
  const byName = new Map(server.players.map((p) => [p.name, p]));
  assert.equal(byName.get('Alice').identity, 'account-17');
  assert.equal(byName.get('guest').identity, undefined);
  assert.deepEqual(
    calls.filter(([token]) => token === 'alice'),
    [
      ['alice', undefined],
      ['alice', 'Alice'],
    ],
  );
  const refused = await hello(url, 'x', { 'X-Token': 'bad' });
  assert.deepEqual([refused.code, refused.reason], [1008, 'not authorized']);
  const mallory = await hello(url, 'mallory');
  assert.deepEqual([mallory.code, mallory.reason], [1008, 'not authorized']);
  assert.equal(server.players.length, 2);
  alice.conn.close();
  guest.conn.close();
  assert.ok(await until(() => server.counts.pending === 0 && server.players.length === 0));
});

test('an authenticate hook that throws or hangs closes the client with 1011 and a coded reason', async (t) => {
  const errors = [],
    throwing = await start(t, {
      authenticate: () => {
        throw new Error('accounts database is down');
      },
    }),
    hanging = await start(t, {
      authenticate: (_req, greeting) => !greeting || new Promise(() => {}),
      authTimeout: 200,
    });
  throwing.server.onError = (e) => errors.push(e);
  hanging.server.onError = (e) => errors.push(e);
  const a = await hello(throwing.url);
  assert.equal(a.code, 1011);
  assert.match(a.reason, /^auth-failed/);
  const started = performance.now(),
    b = await hello(hanging.url);
  assert.equal(b.code, 1011);
  assert.match(b.reason, /^auth-timeout/);
  assert.ok(performance.now() - started < 2000);
  assert.equal(errors[0].message, 'accounts database is down');
  assert.equal(errors[1].name, 'MargoError');
  assert.equal(errors[1].code, 'failed');
  assert.match(errors[1].message, /authTimeout/);
  assert.ok(await until(() => throwing.server.counts.pending === 0 && hanging.server.counts.pending === 0));
});

test('edited chunks past maxEditedChunks go to the store and come back from it', { timeout: 60_000 }, async (t) => {
  const saved = new Map(),
    saves = [],
    store = {
      save: async (key, chunk) => {
        await wait(5);
        saves.push(key);
        saved.set(key, structuredClone(chunk));
      },
      load: async (key) => saved.get(key),
    };
  // Player 1 spawns at x 8 (chunk 0); player 2 five chunks east, so chunks -1..1 are in its view but not its
  // simulation range; player 3 back at x 8.
  const { server, url } = await start(t, {
      store,
      maxEditedChunks: 1,
      generator: FLAT,
      spawn: (id) => (id === 2 ? [8 + 32 * 5, 8] : [8, 8]),
    }),
    errors = [];
  server.onError = (e) => errors.push(e);
  const a = await join(url);
  await drive([a.client], 10_000, () => a.client.spawned);
  assert.ok(a.client.spawned);
  const cells = [
    [8, 12, 8],
    [40, 12, 8],
    [-24, 12, 8],
  ];
  for (const [x, y, z] of cells) {
    assert.ok(server.world.getChunk(x >> 5, y >> 5, z >> 5), `chunk of ${x} is loaded`);
    server.world.setBlock(x, y, z, LOG);
  }
  assert.equal(server.counts.editedChunks, 1, 'held in memory');
  assert.ok(await until(() => server.counts.savingChunks === 0));
  assert.deepEqual(saves, ['0,0,0', '1,0,0'], 'least recently edited first');
  // Everyone leaves: the world drops its chunks; two edited chunks now live only in the store.
  a.client.close();
  assert.ok(await until(() => server.counts.worldChunks === 0));
  // A view-only client gets the stored chunks' messages.
  const b = await join(url, { view: 6 });
  await drive([b.client], 20_000, () => b.client.loaded);
  assert.ok(b.client.loaded);
  for (const cell of cells) assert.equal(b.world.getBlock(...cell), LOG, `client sees ${cell}`);
  // A simulating client loads them into the server's world again.
  const c = await join(url);
  await drive([b.client, c.client], 10_000, () => c.client.spawned);
  for (const cell of cells) assert.equal(server.world.getBlock(...cell), LOG, `server holds ${cell}`);
  b.client.close();
  c.client.close();
  // close() saves what is still in memory.
  await server.close();
  assert.equal(saved.size, 3);
  assert.deepEqual(errors, []);
});

test('without a store, edits to a chunk past maxEditedChunks are refused with an error naming the option', {
  timeout: 30_000,
}, async (t) => {
  const { server, url } = await start(t, { maxEditedChunks: 1, generator: FLAT, spawn: () => [8, 8] }),
    errors = [];
  server.onError = (e) => errors.push(e);
  const a = await join(url);
  await drive([a.client], 10_000, () => a.client.spawned);
  server.world.setBlock(40, 12, 8, LOG); // chunk 1 is the one edited chunk allowed
  const [x, y, z] = a.client.player.position.map(Math.floor),
    below = [x, y - 1, z],
    before = server.world.getBlock(...below);
  assert.notEqual(before, 0);
  assert.equal(a.client.edit(...below, 0), true);
  await drive([a.client], 3000, () => a.world.getBlock(...below) === before);
  assert.equal(server.world.getBlock(...below), before, 'refused');
  assert.equal(a.world.getBlock(...below), before, 'and undone on the client');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'failed');
  assert.match(errors[0].message, /maxEditedChunks.*store/);
  a.client.close();
});
