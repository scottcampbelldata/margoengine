// VoxelServer `tls`: the server serves wss:// itself, a client and a bot join over it, the certificate is checked by
// the client and can be swapped on a running server, and a connection that never finishes its handshake is closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { VoxelBot } from '../dist/bot.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';
import { selfSigned } from './tls-cert.js';

const blocks = testBlocks(),
  FLAT = { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 },
  pause = () => new Promise((done) => setTimeout(done, 16));

async function start(options) {
  const server = new VoxelServer({ blocks, workers: 1, generator: FLAT, spawn: () => [8, 8], ...options }),
    { port } = await server.listen(0);
  return { server, port, url: `wss://127.0.0.1:${port}` };
}
async function drive(client, done, ms = 10_000) {
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end && !done()) {
    await pause();
    const now = performance.now();
    client.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return done();
}

test('a server with tls serves wss://: a client checks the certificate and joins, a bot too', {
  timeout: 60_000,
}, async (t) => {
  const pair = selfSigned(),
    s = await start({ tls: pair });
  t.after(() => s.server.close());
  assert.equal(s.server.secure, true);
  const conn = await connectWebSocket(s.url, { tls: { ca: pair.cert } }),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(world, { send: (d) => conn.send(d), close: () => conn.close() }, { view: 2 });
  conn.onmessage = (d) => client.receive(d);
  assert.ok(await drive(client, () => client.spawned), 'the client joined over wss://');
  const bot = await VoxelBot.connect({ url: s.url, blocks, editInterval: 0, view: 2, tls: { ca: pair.cert } });
  assert.ok(await drive(bot.client, () => bot.client.spawned), 'the bot joined over wss://');
  client.close();
  bot.close();
  // A client that does not trust the certificate is refused by its own TLS check; so is plain ws:// on this port.
  await assert.rejects(() => connectWebSocket(s.url), /self[- ]signed|certificate/i);
  await assert.rejects(() => connectWebSocket(`ws://127.0.0.1:${s.port}`));
});

test('setTls swaps the certificate for new connections; open ones keep theirs', { timeout: 60_000 }, async (t) => {
  const first = selfSigned('first'),
    second = selfSigned('second'),
    s = await start({ tls: first });
  t.after(() => s.server.close());
  const before = await connectWebSocket(s.url, { tls: { ca: first.cert } });
  let closed = false;
  before.onclose = () => (closed = true);
  s.server.setTls(second);
  await assert.rejects(() => connectWebSocket(s.url, { tls: { ca: first.cert } }), /certificate|signature/i);
  const after = await connectWebSocket(s.url, { tls: { ca: second.cert } });
  assert.equal(closed, false, 'the connection made before the swap stays open');
  before.close();
  after.close();
});

test('tls is checked when the server is made, and setTls needs a server made with tls', async () => {
  const pair = selfSigned(),
    other = selfSigned();
  for (const tls of [{}, { key: pair.key }, null, 'cert.pem'])
    assert.throws(() => new VoxelServer({ blocks, tls }), /needs \{ key, cert \}/, JSON.stringify(tls));
  assert.throws(() => new VoxelServer({ blocks, tls: { key: 'nope', cert: pair.cert } }), /not a usable PEM pair/);
  assert.throws(() => new VoxelServer({ blocks, tls: { key: other.key, cert: pair.cert } }), /not a usable PEM pair/);
  const plain = new VoxelServer({ blocks });
  assert.equal(plain.secure, false);
  assert.throws(
    () => plain.setTls(pair),
    (e) => e.code === 'state' && /pass tls/.test(e.message),
  );
  await plain.close();
  const secure = new VoxelServer({ blocks, tls: pair });
  assert.throws(() => secure.setTls({ key: other.key, cert: pair.cert }), /not a usable PEM pair/);
  secure.setTls(other); // before listen too
  await secure.close();
});

test('a connection that never finishes its TLS handshake is closed after helloTimeout', {
  timeout: 30_000,
}, async (t) => {
  const s = await start({ tls: selfSigned(), helloTimeout: 300 });
  t.after(() => s.server.close());
  const opened = performance.now(),
    socket = tcpConnect(s.port, '127.0.0.1'),
    closedAt = await new Promise((done) => socket.on('close', () => done(performance.now())));
  assert.ok(closedAt - opened >= 250, `closed after ${Math.round(closedAt - opened)} ms, not at once`);
  assert.ok(closedAt - opened < 10_000, `closed after ${Math.round(closedAt - opened)} ms`);
});
