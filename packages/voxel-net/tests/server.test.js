import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld } from '@margoengine/voxel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { decodeServerMessage, encodeClientMessage, Keys, PROTOCOL_VERSION, VoxelNetClient } from '../dist/index.js';
import { VoxelBot } from '../dist/bot.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flaky = new URL('./flaky-generator.js', import.meta.url),
  blocks = testBlocks(),
  STONE = blocks.id('stone'),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

// A server on a free port, closed after the test `t` even when it fails (an open server keeps the file running).
async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 2, spawn: (id) => [id * 4, 8], ...options }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
// A VoxelNetClient over the Node WebSocket; `closed` resolves with the close code.
async function join(url, options = {}) {
  const conn = await connectWebSocket(url),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(
      world,
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, ...options },
    );
  let closed;
  const done = new Promise((resolve) => (closed = resolve));
  conn.onmessage = (d) => client.receive(d);
  conn.onclose = (code) => closed(code);
  return { client, conn, world, closed: done };
}
// Runs update(dt) on the clients at 60 per second until `until()` holds or `ms` pass.
async function drive(clients, ms, controls = () => ({ keys: 0, yaw: 0, pitch: 0 }), until = () => false) {
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end && !until()) {
    await wait(16);
    const now = performance.now();
    for (const c of clients) c.update((now - last) / 1000, controls(c));
    last = now;
  }
}
const spawned = (clients) => () => clients.every((c) => c.spawned && c.world.getChunk(...chunkOf(c)));
const chunkOf = (c) => c.player.position.map((v) => Math.floor(v) >> 5);
// The solid block under the player's feet.
const under = (c) => {
  const [x, y, z] = c.player.position.map(Math.floor);
  return [x, y - 1, z];
};

test('two players join, see each other, and an edit reaches the other one', async (t) => {
  const { server, url } = await start(t),
    a = await join(url, { name: 'a' }),
    b = await join(url, { name: 'b' }),
    clients = [a.client, b.client];
  await drive(clients, 10_000, undefined, () => spawned(clients)() && clients.every((c) => c.players.size === 1));
  assert.ok(a.client.spawned && b.client.spawned, 'both spawned');
  assert.deepEqual([...a.client.players.keys()], [b.client.welcome.id]);
  assert.deepEqual([...b.client.players.keys()], [a.client.welcome.id]);
  // Other players are drawn where the server has them (within the codec's 1/512 block).
  b.client.samplePlayers(performance.now() / 1000 + 1);
  const seen = b.client.players.get(a.client.welcome.id).snapshot.position,
    actual = server.players.find((p) => p.id === a.client.welcome.id).character.position;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(seen[i] - actual[i]) < 0.01, `axis ${i}: ${seen[i]} vs ${actual[i]}`);
  // A breaks the block under its feet; B (whose view holds that chunk) gets it.
  const [x, y, z] = under(a.client),
    got = [];
  b.client.onBlocks = (changes) => got.push(...changes);
  assert.notEqual(a.world.getBlock(x, y, z), 0);
  assert.equal(a.client.edit(x, y, z, 0), true);
  assert.equal(a.world.getBlock(x, y, z), 0, 'shown at once');
  await drive(clients, 2000, undefined, () => got.length > 0);
  assert.deepEqual(got, [x, y, z, 0]);
  assert.equal(b.world.getBlock(x, y, z), 0);
  assert.equal(server.world.getBlock(x, y, z), 0);
  assert.equal(server.metrics.editsAccepted, 1);
  a.client.close();
  b.client.close();
  await server.close();
});

test('edits out of reach, too fast, or into a body are refused and undone', async (t) => {
  const { server, url } = await start(t, { editRate: 1, editBurst: 2 }),
    a = await join(url),
    c = a.client;
  await drive([c], 10_000, undefined, spawned([c]));
  const [x, y, z] = c.player.position.map(Math.floor);
  // Placing stone where the player stands: refused, the client's optimistic stone goes away again.
  assert.equal(c.edit(x, y, z, STONE), true);
  assert.equal(a.world.getBlock(x, y, z), STONE);
  await drive([c], 1000, undefined, () => a.world.getBlock(x, y, z) !== STONE);
  assert.equal(a.world.getBlock(x, y, z), server.world.getBlock(x, y, z));
  assert.notEqual(a.world.getBlock(x, y, z), STONE);
  // Out of reach: ten blocks below the feet (in a loaded chunk).
  const deep = [x, y - 10, z],
    before = server.world.getBlock(...deep);
  if (a.world.getChunk(deep[0] >> 5, deep[1] >> 5, deep[2] >> 5)) {
    c.edit(...deep, before === 0 ? STONE : 0);
    await drive([c], 600);
    assert.equal(a.world.getBlock(...deep), before);
  }
  // Too fast: four breaks at once against a burst of two; the refused ones come back.
  const denied = server.metrics.editsDenied,
    [ux, uy, uz] = under(c),
    targets = [-1, 0, 1, 2].map((dx) => [ux + dx, uy, uz]).filter((t) => a.world.getBlock(...t) !== 0);
  for (const t of targets) c.edit(...t, 0);
  await drive([c], 600);
  assert.ok(server.metrics.editsDenied >= denied + targets.length - 2, 'refused for rate');
  for (const t of targets) assert.equal(a.world.getBlock(...t), server.world.getBlock(...t));
  c.close();
  await server.close();
});

test('a matching prediction is never corrected; a cheat is corrected and replayed', async (t) => {
  const { server, url } = await start(t),
    a = await join(url),
    c = a.client;
  await drive([c], 10_000, undefined, spawned([c]));
  await drive([c], 2500, () => ({ keys: Keys.forward | (Math.random() < 0.05 ? Keys.jump : 0), yaw: 1, pitch: 0 }));
  assert.equal(server.metrics.corrections, 0);
  assert.equal(c.stats.corrections, 0);
  // Teleport five blocks on the client only: the server puts the player back where it really is.
  c.player.position = [c.player.position[0] + 5, c.player.position[1], c.player.position[2]];
  await drive(
    [c],
    1500,
    () => ({ keys: 0, yaw: 0, pitch: 0 }),
    () => c.stats.corrections > 0,
  );
  // Stand still until any jump has landed, then let the server run the last inputs before comparing.
  await drive([c], 1500);
  c.flush();
  await wait(200);
  assert.ok(c.stats.corrections >= 1);
  const truth = server.players[0].character.position;
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(c.player.position[i] - truth[i]) < 0.02,
      `axis ${i}: client ${c.player.position} server ${truth} v ${c.player.velocity} corrections ${c.stats.corrections} liquid ${c.player.inLiquid}`,
    );
  c.close();
  await server.close();
});

test('moving the player away unloads chunks past the view and sends the new ones', async (t) => {
  const { server, url } = await start(t, { view: 2 }),
    a = await join(url),
    c = a.client;
  await drive([c], 10_000, undefined, () => c.loaded);
  assert.ok(c.loaded);
  const before = c.stats.chunks,
    body = server.players[0].character;
  body.position = [body.position[0] + 32 * 5, body.position[1] + 40, body.position[2]];
  body.flying = true;
  await drive([c], 5000, undefined, () => c.stats.received.unload > 0 && c.stats.chunks > before + 20);
  assert.ok(c.stats.received.unload > 0, 'unloads sent');
  assert.ok(c.stats.chunks > before + 20, 'new chunks sent');
  c.close();
  await server.close();
});

test('protocol violations close the connection', async (t) => {
  const { server, url } = await start(t),
    wrong = await connectWebSocket(url),
    early = await connectWebSocket(url),
    codes = [];
  for (const conn of [wrong, early]) conn.onclose = (code) => codes.push(code);
  wrong.send(encodeClientMessage({ type: 'hello', version: 99, view: 6, name: '' }));
  early.send(encodeClientMessage({ type: 'edit', x: 0, y: 0, z: 0, state: 0 }));
  await wait(200);
  assert.deepEqual(codes.sort(), [1008, 1008]);
  await server.close();
});

test('four bots walk and build for two seconds without errors', async (t) => {
  // Each bot spawns on its own corner of a 40-block square. Within two seconds no bot can reach another's edits
  // (6-block reach plus at most about 12 blocks walked each), so every client predicts exactly what the server
  // simulates and a correction would mean a real disagreement. Four bots 4 blocks apart (as before) could walk into a
  // block another bot placed before its client heard of it; the server then corrects it, rightly, and how often that
  // happens depends on machine load. All four stay within the 96-block player distance of bot 0.
  const { server, url } = await start(t, { spawn: (id) => [(id % 2) * 40, ((id >> 1) % 2) * 40] }),
    bots = await Promise.all(
      [0, 1, 2, 3].map((i) => VoxelBot.connect({ url, blocks, editInterval: 0.25, players: i === 0 })),
    ),
    clients = bots.map((b) => b.client);
  const errors = [];
  for (const c of clients) c.onError = (e) => errors.push(e);
  server.onError = (e) => errors.push(e);
  const step = { update: (dt) => bots.forEach((b) => b.update(dt)) };
  await drive([step], 10_000, undefined, () => clients.every((c) => c.spawned));
  await drive([step], 2000);
  assert.deepEqual(errors, []);
  assert.ok(bots.every((b) => b.times.spawn > b.times.connect));
  assert.ok(server.metrics.editsAccepted > 0);
  assert.equal(server.metrics.corrections, 0);
  assert.equal(clients[0].players.size, 3);
  for (const b of bots) b.close();
  await server.close();
});

// Bug 43: bytes that arrive with the upgrade request were parsed before the server set onmessage, so a hello sent in
// the same TCP write as the upgrade was lost and the player was dropped after 10 s with no welcome.
test('a hello sent in the same TCP write as the upgrade is answered with a welcome', { timeout: 10_000 }, async (t) => {
  const { url } = await start(t),
    { connect } = await import('node:net'),
    socket = connect(Number(new URL(url).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((done) => socket.once('connect', done));
  const hello = encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'early' }),
    frame = Buffer.alloc(6 + hello.length);
  frame[0] = 0x82;
  frame[1] = 0x80 | hello.length;
  for (let i = 0; i < hello.length; i++) frame[6 + i] = hello[i]; // mask key 0 0 0 0
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  socket.write(
    Buffer.concat([
      Buffer.from(
        'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      ),
      frame,
    ]),
  );
  const started = Date.now();
  let body;
  while (Date.now() - started < 3000) {
    const end = data.indexOf('\r\n\r\n');
    body = end < 0 ? undefined : data.subarray(end + 4);
    if (body && body.length >= 2 && body.length >= 2 + (body[1] & 127)) break;
    await wait(10);
  }
  assert.ok(body && body.length >= 2, 'the server answered the early hello');
  assert.equal(body[0], 0x82);
  assert.equal(decodeServerMessage(body.subarray(2, 2 + (body[1] & 127))).type, 'welcome');
});

// Bug 43, second part: a chunk of a player's simulation range whose generation failed was dropped from loading and
// never asked for again, so a player who did not move waited forever to spawn.
test('a chunk whose generation fails once is generated again, and the waiting player spawns', {
  timeout: 20_000,
}, async (t) => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'voxel-net-flaky-'));
  process.env.VOXEL_NET_FLAKY = 'once';
  process.env.VOXEL_NET_FLAKY_DIR = dir;
  t.after(() => {
    delete process.env.VOXEL_NET_FLAKY;
    delete process.env.VOXEL_NET_FLAKY_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const errors = [],
    { server, url } = await start(t, { generator: flaky, spawn: () => [16, 16] });
  server.onError = (error) => errors.push(error);
  const a = await join(url);
  await drive([a.client], 8000, undefined, spawned([a.client]));
  assert.ok(a.client.spawned, 'spawned after the retry');
  assert.ok(errors.length > 0 && errors.every((e) => /fails once/.test(e.message)), 'the failures were reported');
});

test('a chunk that keeps failing closes the waiting player with 1011 and a reason, after a few tries', {
  timeout: 20_000,
}, async (t) => {
  process.env.VOXEL_NET_FLAKY = 'always';
  t.after(() => delete process.env.VOXEL_NET_FLAKY);
  const errors = [],
    { server, url } = await start(t, { generator: flaky, spawn: () => [16, 16] });
  server.onError = (error) => errors.push(error);
  const a = await join(url),
    reasons = [];
  const previous = a.conn.onclose;
  a.conn.onclose = (code, reason) => {
    reasons.push(reason);
    previous(code, reason);
  };
  const code = await Promise.race([a.closed, wait(15_000).then(() => 'still open')]);
  assert.equal(code, 1011);
  assert.match(reasons[0], /^chunk 1,-?\d+,0 failed to generate/);
  // Bounded: a few tries per failing chunk, not one per tick.
  const chunks = new Set(errors.map((e) => /chunk (\S+) fails/.exec(e.message)?.[1]));
  assert.ok(errors.length <= chunks.size * 3 * 2, `${errors.length} errors for ${chunks.size} chunks`);
});
