// Both directions of a silently dead network, over real sockets: a page learns its server is gone, a server frees the
// slot of a client that is gone, and neither mistakes an idle player or a slow event loop for a dead peer.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelBot } from '../dist/bot.js';
import {
  connectVoxelNet,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  PROTOCOL_VERSION,
  SERVER_SILENT_CODE,
} from '../dist/index.js';
import { acceptKey, VoxelServer, WebSocketConnection } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  generator = new URL('./flat-generator.js', import.meta.url),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  // Blocks this thread, as a long frame or a stopped tab does; sockets and timers wait behind it.
  block = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  // How long a condition may take on a loaded machine; a test that passes returns as soon as it holds.
  PATIENCE = 30_000;

const until = async (condition, what) => {
  const end = performance.now() + PATIENCE;
  while (!condition()) {
    assert.ok(performance.now() < end, `${what}: not within ${PATIENCE} ms`);
    await wait(5);
  }
};

async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 1, generator, ...options }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}

// A client recording its onClose and onError calls.
function connect(url, options = {}) {
  const client = connectVoxelNet(url, new VoxelWorld({ blocks }), { name: 'page', view: 2, ...options }),
    closes = [],
    errors = [];
  client.onClose = (event) => closes.push(event);
  client.onError = (error) => errors.push(error);
  return { client, closes, errors };
}

// A server that answers the upgrade and then neither sends nor reads: what a dead route looks like from the page. It
// hands over the socket, so a test can send a message or two first. The closing handshake gets no answer either.
async function silentServer(t) {
  const sockets = [],
    http = createServer();
  http.on('upgrade', (req, socket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    socket.on('error', () => {});
    sockets.push(socket);
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    http.close();
  });
  return { sockets, url: `ws://127.0.0.1:${http.address().port}` };
}

// A client that joins and, on stop(), neither reads nor answers anything more, its socket still open: a phone gone from
// the Wi-Fi as the server sees it.
async function deadClient(t, url) {
  const key = randomBytes(16).toString('base64'),
    target = new URL(url),
    { socket, head } = await new Promise((done, fail) => {
      request({
        host: target.hostname,
        port: target.port,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      })
        .on('upgrade', (_res, socket, head) => done({ socket, head }))
        .on('error', fail)
        .end();
    }),
    connection = new WebSocketConnection(socket, true, { maxMessage: 1 << 24 }, head);
  t.after(() => socket.destroy());
  let spawned = false;
  connection.onmessage = (bytes) => {
    if (decodeServerMessage(bytes).type === 'state') spawned = true;
  };
  connection.send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'dead' }));
  await until(() => spawned, 'the dead client spawned');
  return { stop: () => socket.pause() };
}

// The far end in its own process (heartbeat-peer.js); resolves to its first report.
function peer(t, mode, argument) {
  const child = fork(new URL('./heartbeat-peer.js', import.meta.url), [mode, argument]);
  t.after(() => child.kill());
  return new Promise((done, fail) => {
    child.once('message', done);
    child.once('exit', (code) => fail(new Error(`heartbeat peer ${mode} exited with ${code}`)));
  });
}

test('the heartbeat message survives the wire, and trailing bytes are refused', () => {
  const bytes = encodeServerMessage({ type: 'heartbeat' });
  assert.equal(bytes.length, 1, 'one byte: this goes to every quiet player');
  assert.deepEqual(decodeServerMessage(bytes), { type: 'heartbeat' });
  assert.throws(() => decodeServerMessage(new Uint8Array([bytes[0], 0])), RangeError);
});

test('a server that goes silent with its socket open reaches onClose within serverTimeout', async (t) => {
  const { url } = await silentServer(t),
    serverTimeout = 400,
    began = performance.now(),
    page = connect(url, { serverTimeout });
  await until(() => page.closes.length, 'onClose');
  const took = performance.now() - began;
  assert.deepEqual(page.closes, [{ code: SERVER_SILENT_CODE, reason: 'server-silent', byClient: false }]);
  assert.ok(took >= serverTimeout * 0.9, `closed after ${took} ms, too early for ${serverTimeout}`);
  assert.equal(page.errors.length, 1, 'onError first, as for any lost connection');
  assert.equal(page.errors[0].code, 'failed');
  assert.match(page.errors[0].message, /serverTimeout/);
  // The socket's own close comes later or never (nobody answers the handshake) and must not report again.
  await wait(100);
  assert.equal(page.closes.length, 1);
  assert.equal(page.errors.length, 1);
  assert.equal(page.client.update(0.1, { keys: 0, yaw: 0, pitch: 0 }), undefined);
});

test('every message restarts the wait', async (t) => {
  const { sockets, url } = await silentServer(t),
    serverTimeout = 400,
    page = connect(url, { serverTimeout }),
    frame = Buffer.from([0x82, 1, encodeServerMessage({ type: 'heartbeat' })[0]]);
  await until(() => sockets.length, 'the socket opened');
  // Twice the timeout of steady messages, each answered by the client's own timers running free.
  const end = performance.now() + serverTimeout * 2;
  let last = 0;
  while (performance.now() < end) {
    await new Promise((done) => sockets[0].write(frame, done));
    const before = page.client.stats.received.heartbeat;
    await until(() => page.client.stats.received.heartbeat > before || page.closes.length, 'the message arrived');
    last = performance.now();
    assert.equal(page.closes.length, 0, 'closed while messages were arriving');
    await wait(serverTimeout / 8);
  }
  await until(() => page.closes.length, 'onClose after the messages stopped');
  const after = performance.now() - last;
  assert.ok(after >= serverTimeout * 0.9, `closed ${after} ms after the last message`);
});

// Regression (2026-11-07): resume-client's half-open test paired serverTimeout 300 with the default heartbeatInterval
// of 5,000, so only the generator's speed kept the page on before its view; under the 8-way verify load the first
// chunks took longer and the page closed with SERVER_SILENT_CODE. The world is held here, so the slow world is
// certain and nothing depends on the machine: a server far above the page's timeout loses it, one well below keeps it.
test('a world slower than serverTimeout: heartbeats below it keep the page on until its view comes', async (t) => {
  const serverTimeout = 300,
    world = { generator: new URL('./held-generator.js', import.meta.url), spawn: () => [0, 0] },
    quiet = await start(t, { ...world, heartbeatInterval: 60_000, clientTimeout: 120_000 }),
    beating = await start(t, { ...world, heartbeatInterval: 50, clientTimeout: 60_000 }),
    dir = mkdtempSync(join(tmpdir(), 'voxel-net-held-'));
  process.env.VOXEL_NET_HELD_DIR = dir; // read by the generator threads, which start with the first job
  t.after(() => {
    delete process.env.VOXEL_NET_HELD_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const lost = connect(quiet.url, { serverTimeout });
  await until(() => lost.closes.length, 'the page left a server that says nothing');
  assert.equal(lost.closes[0].code, SERVER_SILENT_CODE);
  assert.equal(lost.client.loaded, false, 'before its view');
  const kept = connect(beating.url, { serverTimeout });
  // Five timeouts' worth of heartbeats, counted, with the world still held.
  await until(() => kept.client.stats.received.heartbeat >= 30 || kept.closes.length, '30 heartbeats');
  assert.deepEqual(kept.closes, []);
  assert.equal(kept.client.loaded, false, 'the world was still held');
  writeFileSync(join(dir, 'release'), '');
  await until(() => (kept.client.loaded && kept.client.spawned) || kept.closes.length, 'the view');
  assert.deepEqual(kept.closes, []);
  assert.deepEqual(kept.errors, []);
  kept.client.close();
});

test('a client that stops responding is dropped and its slot, counts and chunks freed', async (t) => {
  const clientTimeout = 500,
    { server, url } = await start(t, {
      heartbeatInterval: 100,
      clientTimeout,
      maxPlayers: 1,
      spawn: () => [0, 0],
      resumeTimeout: 0,
    }),
    dead = await deadClient(t, url);
  assert.equal(server.counts.players, 1);
  assert.ok(server.counts.worldChunks > 0);
  // While it holds the only slot, nobody else gets on.
  const refused = connect(url);
  await until(() => refused.closes.length, 'the full server refused a second client');
  assert.equal(refused.closes[0].code, 1013);
  const began = performance.now();
  dead.stop();
  await until(() => server.counts.players === 0, 'the dead client was dropped');
  const took = performance.now() - began;
  assert.ok(took >= clientTimeout * 0.5, `dropped after ${took} ms, too early for ${clientTimeout}`);
  assert.equal(server.counts.pending, 0);
  await until(() => server.counts.worldChunks === 0, 'its chunks were let go');
  // The slot is free: someone else plays.
  const next = connect(url);
  await until(() => next.client.spawned, 'the next client spawned in the freed slot');
  next.client.close();
});

test('server.close() does not wait for a client that stopped reading', async (t) => {
  const { server, url } = await start(t),
    dead = await deadClient(t, url);
  dead.stop();
  let closed = false;
  server.close().then(() => (closed = true));
  await until(() => closed, 'server.close() resolved');
});

test('an idle lone player sending nothing is told the server lives and is not dropped', async (t) => {
  const clientTimeout = 500,
    serverTimeout = 500,
    { server, url } = await start(t, { heartbeatInterval: 100, clientTimeout, spawn: () => [0, 0] }),
    // Never calls update(), as a tab whose frames stopped: only its WebSocket answers.
    page = connect(url, { serverTimeout });
  await until(() => page.client.loaded, 'the view arrived');
  const before = page.client.stats.received.heartbeat;
  server.resetMetrics();
  // Three times either timeout of nothing but heartbeats.
  await until(() => page.client.stats.received.heartbeat - before >= 15, '15 heartbeats');
  assert.deepEqual(page.closes, []);
  assert.deepEqual(page.errors, []);
  assert.equal(server.counts.players, 1);
  for (const [type, bytes] of Object.entries(server.metrics.bytesOut))
    assert.equal(bytes > 0, type === 'heartbeat', `${type}: ${bytes} bytes to an idle lone player`);
  page.client.close();
});

// Pongs reach no message handler, so the count must not wait for the next message to include them.
test('metrics count the pongs of a player sending no messages', async (t) => {
  const { server, url } = await start(t, { heartbeatInterval: 100, clientTimeout: 500, spawn: () => [0, 0] }),
    page = connect(url); // never calls update(): only its WebSocket answers
  await until(() => page.client.loaded, 'the view arrived');
  server.resetMetrics();
  await until(() => server.metrics.bytesIn >= 3 * 6, 'three pongs counted');
  assert.equal(server.counts.players, 1);
  page.client.close();
});

test('a background tab whose timers are throttled does not count the wait it slept through', async (t) => {
  const { url } = await silentServer(t),
    serverTimeout = 150,
    real = globalThis.setInterval;
  // A stub only for connectVoxelNet's call: the socket is real, the timer fires when this test says, as a throttled
  // tab's does (once a minute after five hidden minutes in Chrome).
  let check;
  globalThis.setInterval = (callback) => {
    check = callback;
    return real(() => {}, 1 << 30);
  };
  let page;
  try {
    page = connect(url, { serverTimeout });
  } finally {
    globalThis.setInterval = real;
  }
  t.after(() => page.client.close());
  // Far past the timeout on the clock. One wake-up, however late, is only one check.
  await wait(serverTimeout * 3);
  check();
  await wait(20);
  assert.deepEqual(page.closes, [], 'one late timer must not end the connection');
  // A server really gone is still found, later: 15 checks.
  for (let i = 1; i < 14; i++) check();
  await wait(20);
  assert.deepEqual(page.closes, [], '14 checks are not yet the timeout');
  check();
  await until(() => page.closes.length, 'onClose at the 15th check');
  assert.equal(page.closes[0].code, SERVER_SILENT_CODE);
});

test('a slow event loop on the client does not read as a dead server', async (t) => {
  const serverTimeout = 300,
    { port } = await peer(t, 'server', JSON.stringify({ heartbeatInterval: 100, clientTimeout: 60_000 })),
    page = connect(`ws://127.0.0.1:${port}`, { serverTimeout });
  await until(() => page.client.stats.received.heartbeat >= 2, 'heartbeats');
  // Five timeouts with the thread stuck. From setImmediate, so the loop goes to its timers next: the watch fires while
  // the server's heartbeats still wait in the socket, the order that catches a wait measured on a clock.
  await new Promise((done) =>
    setImmediate(() => {
      block(serverTimeout * 5);
      done();
    }),
  );
  const before = page.client.stats.received.heartbeat;
  await until(() => page.client.stats.received.heartbeat >= before + 5 || page.closes.length, 'heartbeats after');
  assert.deepEqual(page.closes, []);
  assert.deepEqual(page.errors, []);
  page.client.close();
});

test('a slow event loop on the server does not read as dead clients', async (t) => {
  const clientTimeout = 500,
    { server, url } = await start(t, { heartbeatInterval: 100, clientTimeout, spawn: () => [0, 0] });
  await peer(t, 'client', url);
  assert.equal(server.counts.players, 1);
  // Three timeouts with the tick stuck: the client's answers wait in the socket.
  block(clientTimeout * 3);
  // Then more than a timeout's worth of ticks, in which the client stays.
  const tick = server.tick;
  await until(() => server.tick >= tick + 20 || server.counts.players === 0, 'ticks ran');
  assert.equal(server.counts.players, 1, 'dropped for the server having stalled');
});

test('players who get messages anyway get no heartbeats, and VoxelBot keeps working', async (t) => {
  const { server, url } = await start(t, { heartbeatInterval: 2000, spawn: () => [0, 0] }),
    bots = await Promise.all([1, 2].map(() => VoxelBot.connect({ url, blocks, editInterval: 0, view: 2 })));
  t.after(() => bots.forEach((bot) => bot.close()));
  const driving = setInterval(() => bots.forEach((bot) => bot.update(0.016)), 16);
  t.after(() => clearInterval(driving));
  await until(() => bots.every((bot) => bot.client.spawned), 'the bots spawned');
  server.resetMetrics();
  const tick = server.tick;
  await until(() => server.tick >= tick + 50, '2.5 s of ticks');
  assert.ok(server.metrics.bytesOut.players > 0);
  assert.equal(server.metrics.bytesOut.heartbeat, 0, 'not one byte while other messages flow');
  for (const bot of bots) assert.equal(bot.closeCode, undefined);
  assert.equal(server.counts.players, 2);
});

test('the timeouts are checked, and each option has a way off or a floor', async (t) => {
  assert.throws(() => connect('ws://127.0.0.1:1', { serverTimeout: -1 }), RangeError);
  assert.throws(() => connect('ws://127.0.0.1:1', { serverTimeout: Number.NaN }), RangeError);
  assert.throws(() => new VoxelServer({ blocks, heartbeatInterval: 0 }), RangeError);
  assert.throws(() => new VoxelServer({ blocks, heartbeatInterval: 1000, clientTimeout: 1000 }), /clientTimeout/);
  // serverTimeout 0: no timer at all.
  const { url } = await silentServer(t),
    real = globalThis.setInterval;
  let timers = 0;
  globalThis.setInterval = (...args) => {
    timers++;
    return real(...args);
  };
  let page;
  try {
    page = connect(url, { serverTimeout: 0 });
  } finally {
    globalThis.setInterval = real;
  }
  t.after(() => page.client.close());
  assert.equal(timers, 0);
});
