// The client's half of a resume: it holds the player in the gap, refuses edits, keeps its world, and tries again on a
// schedule; connectVoxelNet and VoxelBot through a proxy that cuts them, and a fake socket and clock for the schedule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet, Keys, SERVER_SILENT_CODE, VoxelNetClient } from '../dist/index.js';
import { VoxelBot } from '../dist/bot.js';
import { VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';
import { cutProxy, until, wait } from './cut-proxy.js';

const blocks = testBlocks(),
  flat = new URL('./flat-generator.js', import.meta.url),
  controls = { keys: 0, yaw: 0, pitch: 0 };

async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat, spawn: () => [0, 0], view: 2, ...options }),
    { port } = await server.listen(0),
    proxy = await cutProxy(port);
  server.onError = () => {};
  t.after(async () => {
    proxy.close();
    await server.close();
  });
  return { server, port, proxy, url: `ws://127.0.0.1:${proxy.port}` };
}
function page(url, options) {
  const client = connectVoxelNet(url, new VoxelWorld({ blocks }), { name: 'page', view: 2, ...options }),
    log = { closes: [], errors: [], tries: [], back: [], spawns: 0, loads: 0 };
  client.onClose = (e) => log.closes.push(e);
  client.onError = (e) => log.errors.push(e);
  client.onResume = (e) => log.tries.push(e);
  client.onResumed = (e) => log.back.push(e);
  client.onSpawn = () => log.spawns++;
  client.onLoaded = () => log.loads++;
  return { client, log };
}
const ready = async (client) => {
  await until('the view', () => client.loaded && client.spawned);
  for (let i = 0; i < 3; i++) client.update(1 / 60, controls);
  await wait(100); // fixed-wait: server ticks run those steps; its character then knows it stands on the ground
};

test('a cut: the player is held, edits are refused, the world stays, and it comes back in the same place', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url);
  await ready(client);
  const before = [...client.player.position],
    world = client.world.getChunk(0, 0, 0),
    chunks = client.stats.chunks;
  assert.ok(world);
  s.proxy.cut();
  await until('the drop', () => client.detached);
  assert.equal(client.stats.drops, 1);
  assert.equal(log.closes.length, 0, 'not the end');
  assert.equal(log.errors.length, 0, 'not an error');
  // Gap: keys held do nothing, nothing is sent, an edit is refused and changes nothing.
  const sent = client.stats.sent;
  for (let i = 0; i < 20; i++) client.update(1 / 60, { keys: Keys.forward, yaw: 0, pitch: 0 });
  assert.deepEqual([...client.player.position], before, 'no steps');
  assert.equal(client.edit(0, 7, 0, 0), false);
  assert.equal(client.world.getBlock(0, 7, 0), blocks.id('stone'), 'the edit changed nothing');
  assert.equal(client.stats.sent, sent);
  assert.equal(client.world.getChunk(0, 0, 0), world, 'the same chunk, still there');
  await until('the resume', () => log.back.length);
  assert.equal(client.detached, false);
  assert.equal(client.stats.resumes, 1);
  assert.equal(log.tries[0].attempt, 1);
  assert.ok(log.tries[0].delay >= 100 && log.tries[0].delay <= 600);
  assert.equal(log.tries[0].cause, '1006');
  assert.deepEqual([...client.player.position], before, 'the spot it had');
  assert.equal(log.spawns, 1, 'onSpawn is for the first time only');
  assert.equal(log.loads, 1, 'onLoaded too');
  assert.ok(log.back[0].gapMs >= 100);
  assert.equal(log.back[0].chunksResent, 0);
  assert.equal(client.stats.chunks, chunks, 'nothing sent again on a quiet world');
  assert.equal(client.world.getChunk(0, 0, 0), world);
  // Playing goes on: steps reach the server, with no step error or correction.
  const server = s.server.players[0];
  for (let i = 0; i < 40; i++) {
    client.update(1 / 60, { keys: Keys.forward, yaw: 0, pitch: 0 });
    await wait(20); // slower than the clock, or the server's bank corrects it for going too fast
  }
  assert.notDeepEqual([...client.player.position], before, 'it moves again');
  await until('the server to follow', () => server.character.position[2] < before[2]);
  assert.equal(log.closes.length, 0);
  assert.equal(client.stats.corrections, 0);
  assert.equal(client.edit(0, 7, 0, 0), true);
});

test('an edit sent into the dead socket: the client lists its chunk, and the prediction goes back to the truth', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url);
  await ready(client);
  s.proxy.freeze(); // the edit goes nowhere, as into a connection that has just died
  assert.equal(client.edit(0, 7, 0, 0), true);
  assert.equal(client.world.getBlock(0, 7, 0), 0, 'predicted');
  s.proxy.kill();
  await until('the resume', () => log.back.length);
  assert.ok(log.back[0].chunksResent >= 1);
  await until('the truth', () => client.world.getBlock(0, 7, 0) !== 0);
  assert.equal(s.server.metrics.editsAccepted, 0, 'the server never saw it');
});

test('a chunk sent again replaces the old copy without a hole', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url);
  await ready(client);
  const holes = [];
  // Every message: is the chunk under the player in the world?
  const receive = client.receive.bind(client);
  client.receive = (bytes) => {
    receive(bytes);
    if (!client.world.getChunk(0, 0, 0)) holes.push(bytes[0]);
  };
  s.proxy.freeze();
  client.edit(0, 7, 0, 0);
  s.proxy.kill();
  await until('the resume', () => log.back.length);
  await until('the truth', () => client.world.getBlock(0, 7, 0) !== 0);
  assert.deepEqual(holes, []);
  assert.ok(client.world.getChunk(0, 0, 0));
});

test('figures stay in the gap and those who left are gone after it', async (t) => {
  const s = await start(t, { spawn: () => [2, 2] }),
    { client, log } = page(s.url),
    other = await VoxelBot.connect({ url: `ws://127.0.0.1:${s.port}`, blocks, editInterval: 0, players: true });
  t.after(() => other.close());
  await ready(client);
  await until('the other figure', () => {
    other.update(1 / 60);
    return client.players.size === 1;
  });
  s.proxy.cut();
  await until('the drop', () => client.detached);
  assert.equal(client.players.size, 1, 'on screen in the gap');
  other.close();
  await until('the resume', () => log.back.length);
  await until('the figure gone', () => client.players.size === 0);
  assert.equal(log.closes.length, 0);
});

test('a resume after a resume: the new token works, and the counts add up', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url);
  await ready(client);
  for (let n = 1; n <= 3; n++) {
    s.proxy.cut();
    await until(`resume ${n}`, () => log.back.length === n);
  }
  assert.equal(client.stats.drops, 3);
  assert.equal(client.stats.resumes, 3);
  assert.equal(s.server.metrics.resumed, 3);
  assert.equal(s.server.metrics.fullResends, 0);
});

test('half-open: the page notices the silence, comes back, and the server replaces the old socket', async (t) => {
  // Heartbeats well below the page's serverTimeout, as the docs ask. With the default 5,000 the server says nothing
  // while it makes the first chunks; under load that took over 300 ms, and the page gave up before its view (see the
  // heartbeat test 'a world slower than serverTimeout').
  const s = await start(t, { clientTimeout: 60_000, heartbeatInterval: 50 }),
    { client, log } = page(s.url, { serverTimeout: 300 });
  await ready(client);
  s.proxy.freeze();
  await until('the drop', () => client.detached);
  // The proxy still answers: the try goes through a fresh connection, which is not frozen.
  await until('the resume', () => log.back.length);
  assert.equal(log.tries[0].cause, 'server-silent');
  assert.equal(s.server.metrics.replaced, 1);
  assert.equal(s.server.metrics.parked.socket, 0);
  assert.equal(log.closes.length, 0);
  assert.equal(SERVER_SILENT_CODE, 4408);
});

test('nothing resumes after a clean end: a world ending, an idle close, a kick', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url);
  await ready(client);
  s.server.players[0].conn.close(4410, 'idle');
  await until('the close', () => log.closes.length);
  assert.deepEqual(log.closes, [{ code: 4410, reason: 'idle', byClient: false }]);
  assert.equal(log.tries.length, 0);
  const second = page(s.url);
  await ready(second.client);
  await s.server.close();
  await until('the close', () => second.log.closes.length);
  assert.deepEqual(second.log.closes, [{ code: 1001, reason: 'server closing', byClient: false }]);
  assert.equal(second.log.tries.length, 0);
});

test('resume: false: onClose at the first drop, as before', async (t) => {
  const s = await start(t),
    { client, log } = page(s.url, { resume: false });
  await ready(client);
  s.proxy.cut();
  await until('the close', () => log.closes.length);
  assert.equal(log.closes[0].code, 1006);
  assert.equal(log.closes[0].resumeFailed, undefined);
  assert.equal(log.errors.length, 1);
  assert.equal(log.tries.length, 0);
  assert.equal(client.detached, false);
});

test('a player who never spawned does not resume', async (t) => {
  const s = await start(t, { generator: new URL('./slow-generator.js', import.meta.url) }),
    { client, log } = page(s.url);
  await until('its welcome', () => client.welcome);
  s.proxy.cut();
  await until('the close', () => log.closes.length);
  assert.equal(log.closes[0].code, 1006);
  assert.equal(log.tries.length, 0);
});

test('a server with resume off: the client has no token and ends at the first drop', async (t) => {
  const s = await start(t, { resumeTimeout: 0 }),
    { client, log } = page(s.url);
  await ready(client);
  s.proxy.cut();
  await until('the close', () => log.closes.length);
  assert.equal(log.tries.length, 0);
  assert.equal(client.stats.drops, 0);
});

// A fake socket, with a fake clock, for everything about the schedule.
function fakeSockets(t) {
  const real = globalThis.WebSocket,
    sockets = [];
  t.after(() => {
    globalThis.WebSocket = real;
  });
  globalThis.WebSocket = class {
    readyState = 1;
    listeners = {};
    sent = [];
    closed = false;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    close() {
      this.closed = true;
    }
    send(data) {
      this.sent.push(data);
    }
  };
  return sockets;
}
// A fake page already spawned on the fake socket, by its messages.
async function spawned(sockets, options) {
  const { encodeServerMessage } = await import('../dist/index.js'),
    { blockTableHash } = await import('../dist/index.js'),
    p = page('ws://fake', options),
    deliver = (message, socket = sockets.at(-1)) =>
      socket.listeners.message({ data: encodeServerMessage(message).buffer.slice(0) }),
    welcome = (id) => ({
      type: 'welcome',
      version: 4,
      id,
      tickRate: 20,
      view: 2,
      viewHeight: 3,
      simulation: 3,
      simulationHeight: 2,
      playerDistance: 96,
      blocks: blockTableHash(blocks),
      flight: false,
      resume: new Uint8Array(16).fill(id),
      resent: 0,
    }),
    state = { type: 'state', spawn: true, step: 0, position: [0, 0, 0], velocity: [0, 0, 0], flying: false };
  deliver(welcome(1));
  deliver(state);
  assert.equal(p.client.spawned, true);
  return { ...p, deliver, welcome, state };
}
const close = (socket, code = 1006, reason = '') => socket.listeners.close({ code, reason });

test('the schedule: the first try spreads a crowd over half a second, then 1, 2, 4, 8 s each within half', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const [random, delays] of [
    [0, [100, 500, 1000, 2000, 4000]],
    [1, [600, 1500, 3000, 6000, 12_000]],
  ]) {
    const restore = t.mock.method(Math, 'random', () => random),
      sockets = fakeSockets(t),
      p = await spawned(sockets, { serverTimeout: 0 });
    close(sockets[0]);
    for (let n = 1; n <= 5; n++) {
      t.mock.timers.tick(p.log.tries[n - 1].delay + 1);
      await Promise.resolve();
      await Promise.resolve();
      close(sockets[n]);
    }
    assert.deepEqual(
      p.log.tries.map((e) => e.delay),
      delays,
    );
    // The longest wait of five tries is well inside the server's 30 s.
    assert.ok(delays.reduce((a, b) => a + b) < 25_000);
    restore.mock.restore();
  }
});

test('five tries on the schedule, then onError and onClose with the first drop and why it gave up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 });
  close(sockets[0], 1006, 'first');
  assert.equal(p.client.detached, true);
  for (let n = 1; n <= 5; n++) {
    assert.equal(p.log.tries.length, n);
    assert.equal(sockets.length, n, 'not yet');
    t.mock.timers.tick(p.log.tries[n - 1].delay + 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sockets.length, n + 1, `try ${n} opened`);
    assert.equal(p.client.stats.resumeAttempts, n);
    assert.equal(p.log.closes.length, 0);
    close(sockets[n]);
  }
  assert.equal(p.log.tries.length, 5);
  assert.deepEqual(p.log.closes, [
    { code: 1006, reason: 'first', byClient: false, resumeFailed: 'no answer in 5 tries' },
  ]);
  assert.equal(p.log.errors.length, 1);
  assert.equal(p.client.stats.resumeFailed, 1);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 6, 'nothing more');
});

for (const [code, reason] of [
  [1008, 'resume-unknown'],
  [1008, 'protocol 5, server speaks 6'],
  [1008, 'not authorized'],
  [1011, 'auth-failed'],
  [1001, 'server closing'],
  [1013, 'server full'],
]) {
  test(`no second try after ${code} ${reason}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const sockets = fakeSockets(t),
      p = await spawned(sockets, { serverTimeout: 0 });
    close(sockets[0], 1006, 'first');
    t.mock.timers.tick(p.log.tries[0].delay + 1);
    await Promise.resolve();
    await Promise.resolve();
    close(sockets[1], code, reason);
    assert.deepEqual(p.log.closes, [{ code: 1006, reason: 'first', byClient: false, resumeFailed: reason }]);
    t.mock.timers.tick(60_000);
    assert.equal(sockets.length, 2);
    assert.equal(p.log.tries.length, 1);
  });
}

test('a try that hears nothing is given up on, and the next one starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 });
  close(sockets[0]);
  t.mock.timers.tick(p.log.tries[0].delay + 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(5001);
  assert.equal(sockets[1].closed, true);
  assert.equal(p.log.tries.length, 2);
  close(sockets[1]); // its late close means nothing now
  assert.equal(p.log.tries.length, 2);
});

test('no new try once 30 s have gone, however many are left', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const realNow = performance.now,
    sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0, resume: { attempts: 100 } });
  let now = 0;
  performance.now = () => now;
  t.after(() => {
    performance.now = realNow;
  });
  close(sockets[0]);
  for (let n = 0; n < 200 && !p.log.closes.length; n++) {
    const delay = p.log.tries.at(-1).delay + 1;
    t.mock.timers.tick(delay);
    now += delay;
    await Promise.resolve();
    await Promise.resolve();
    close(sockets.at(-1));
  }
  assert.ok(p.log.closes[0].resumeFailed);
  assert.ok(now >= 30_000 && now < 30_000 + 8000 * 1.5 + 2);
  assert.ok(p.log.tries.length < 10);
});

test('abort in a gap ends it with 1000 aborted; abort before a drop means no resume', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    controller = new AbortController(),
    p = await spawned(sockets, { serverTimeout: 0, resume: { signal: controller.signal } });
  close(sockets[0]);
  controller.abort();
  assert.deepEqual(p.log.closes, [{ code: 1000, reason: 'aborted', byClient: true }]);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1, 'no try after the abort');
  controller.abort();
  assert.equal(p.log.closes.length, 1);
  const sockets2 = fakeSockets(t),
    stopped = new AbortController();
  stopped.abort();
  const q = await spawned(sockets2, { serverTimeout: 0, resume: { signal: stopped.signal } });
  close(sockets2[0], 1006, 'cut');
  assert.equal(q.log.tries.length, 0);
  assert.equal(q.log.closes[0].code, 1006);
});

test('client.close() in a gap ends it once, as the client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 });
  close(sockets[0]);
  p.client.close();
  p.client.close();
  assert.deepEqual(p.log.closes, [{ code: 1000, reason: '', byClient: true }]);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1);
});

test('client.close() during a try is the client too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 });
  close(sockets[0]);
  t.mock.timers.tick(p.log.tries[0].delay + 1);
  await Promise.resolve();
  await Promise.resolve();
  p.client.close();
  assert.equal(sockets[1].closed, true);
  close(sockets[1], 1005);
  assert.deepEqual(p.log.closes, [{ code: 1005, reason: '', byClient: true }]);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
});

test('the silence watch sleeps in a gap, and wakes after it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 1500 });
  t.mock.timers.tick(1600);
  assert.equal(p.log.tries.length, 1, 'silence is a drop');
  assert.equal(p.log.tries[0].cause, 'server-silent');
  t.mock.timers.tick(p.log.tries[0].delay + 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  p.deliver(p.welcome(9));
  p.deliver({ ...p.state, step: 77 });
  assert.equal(p.client.detached, false);
  assert.equal(p.client.stats.resumes, 1);
  assert.equal(p.client.welcome.id, 9);
  t.mock.timers.tick(1600);
  assert.equal(p.log.tries.length, 2, 'watched again after it');
});

test('a late answer from an old socket is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 }),
    received = p.client.stats.received.heartbeat;
  close(sockets[0]);
  p.deliver({ type: 'heartbeat' }, sockets[0]);
  assert.equal(p.client.stats.received.heartbeat, received);
});

test('an offline page waits for the network, and a hidden tab tries at once when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = fakeSockets(t),
    p = await spawned(sockets, { serverTimeout: 0 }),
    listeners = {},
    doc = {
      visibilityState: 'hidden',
      addEventListener: (type, fn) => (listeners[type] = fn),
      removeEventListener: (type) => delete listeners[type],
    },
    realAdd = globalThis.addEventListener,
    realRemove = globalThis.removeEventListener,
    nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.document = doc;
  globalThis.addEventListener = (type, fn) => (listeners[type] = fn);
  globalThis.removeEventListener = (type) => delete listeners[type];
  let onLine = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      get onLine() {
        return onLine;
      },
    },
  });
  t.after(() => {
    delete globalThis.document;
    globalThis.addEventListener = realAdd;
    globalThis.removeEventListener = realRemove;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  });
  close(sockets[0]);
  t.mock.timers.tick(p.log.tries[0].delay + 5000);
  await Promise.resolve();
  assert.equal(sockets.length, 1, 'offline: no try');
  onLine = true;
  doc.visibilityState = 'visible';
  listeners.online();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sockets.length, 2, 'the network came back: a try at once');
  close(sockets[1]);
  doc.visibilityState = 'hidden';
  listeners.visibilitychange();
  await Promise.resolve();
  assert.equal(sockets.length, 2, 'still hidden');
  doc.visibilityState = 'visible';
  listeners.visibilitychange();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sockets.length, 3, 'shown: a try at once');
});

test('detach and attach by hand, for a transport of your own', async () => {
  const sent = [],
    transport = { send: (d) => sent.push(d), close() {} },
    client = new VoxelNetClient(new VoxelWorld({ blocks }), transport);
  assert.equal(client.detached, false);
  assert.throws(() => client.attach(transport), /detach/);
  client.detach();
  assert.equal(client.detached, true);
  assert.throws(() => client.attach(transport), /detach/, 'no token yet');
});

test('resume options are checked', () => {
  assert.throws(
    () => connectVoxelNet('ws://127.0.0.1:1', new VoxelWorld({ blocks }), { resume: { attempts: -1 } }),
    RangeError,
  );
  assert.throws(
    () => connectVoxelNet('ws://127.0.0.1:1', new VoxelWorld({ blocks }), { resume: { attempts: 1.5 } }),
    RangeError,
  );
});

test('VoxelBot resumes too, keeps its counters, and reports giving up', async (t) => {
  const s = await start(t),
    bot = await VoxelBot.connect({ url: s.url, blocks, editInterval: 0, resume: { attempts: 2 } });
  t.after(() => bot.close());
  await until('its spawn', () => {
    bot.update(1 / 60);
    return bot.client.spawned && bot.client.loaded;
  });
  const first = bot.connection,
    bytes = bot.bytesIn;
  s.proxy.cut();
  await until('the resume', () => bot.client.stats.resumes === 1);
  assert.notEqual(bot.connection, first);
  assert.ok(bot.bytesIn >= bytes, 'bytes add up over both connections');
  assert.equal(bot.closeCode, undefined);
  for (let i = 0; i < 30; i++) {
    bot.update(1 / 60);
    await wait(5);
  }
  assert.equal(bot.closeCode, undefined);
  // Now the server is gone for good: it gives up with the drop it started from.
  const end = new Promise((done) => (bot.client.onClose = done));
  s.proxy.cut();
  await until('the drop', () => bot.client.detached);
  await s.server.close();
  s.proxy.close();
  const closed = await end;
  assert.equal(closed.code, 1006);
  assert.ok(closed.resumeFailed);
  assert.equal(bot.closeCode, 1006);
  assert.ok(bot.resumeFailed);
  assert.equal(bot.client.stats.resumeFailed, 1);
});
