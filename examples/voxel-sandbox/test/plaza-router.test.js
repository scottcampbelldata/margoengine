// The router over real sockets, forking real shard processes: join, counters, limits, the world's end as a page sees
// it, a crashed shard coming back with its world, and reports through a stand-in for nginx.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet, VoxelNetClient } from '@margoengine/voxel-net';
import { adminRequest, commandFrom, timeOfDay } from '../server/admin.mjs';
import { fromArguments, PlazaRouter, PRODUCTION_ORIGIN, pickShard, ROUTER_DEFAULTS } from '../server/router.mjs';
import { defineBlocks } from '../src/blocks.ts';
import { cutProxy } from '../../../packages/voxel-net/tests/cut-proxy.js';

const { blocks } = defineBlocks(),
  BRICKS = blocks.id('bricks'),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  TIMEOUT = { timeout: 60_000 };

async function until(what, check, ms = 30_000) {
  const end = performance.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(25);
  }
}

async function startRouter(t, options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'plaza-router-')),
    router = new PlazaRouter({
      dataDir,
      origins: '*',
      restartMs: 50,
      log: () => {},
      metricsToken: 'test-metrics-token',
      rateBurst: 100_000,
      load: () => 0,
      cores: () => 16,
      ...options,
      shard: { quiet: true, snapshotMs: 3_600_000, seed: 5, ...options.shard },
    });
  t.after(async () => {
    await router.close();
    if (!options.dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  const { port } = await router.start();
  const base = `http://127.0.0.1:${port}`;
  return { router, base, dataDir, get: (path, init) => fetch(base + path, init) };
}

const joinAnswer = async ({ get }) => {
  const answer = await until('a ready shard', async () => {
    const res = await get('/join');
    return res.status === 200 ? res.json() : undefined;
  });
  return answer;
};

// A page's way of joining: its own WebSocket (the global one, like a browser's), so it sees every close.
function connectPage(url) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const world = new VoxelWorld({ blocks }),
    queue = [],
    client = new VoxelNetClient(
      world,
      {
        send: (d) => (socket.readyState === 1 ? socket.send(d) : queue.push(d)),
        close: () => socket.close(),
      },
      { view: 2, name: 'Amber Lantern' },
    ),
    closed = new Promise((done) => socket.addEventListener('close', ({ code, reason }) => done({ code, reason })));
  socket.addEventListener('open', () => {
    for (const d of queue.splice(0)) socket.send(d);
  });
  socket.addEventListener('message', (event) => client.receive(new Uint8Array(event.data)));
  let last = performance.now();
  const pump = setInterval(() => {
    const now = performance.now();
    client.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }, 16);
  closed.then(() => clearInterval(pump));
  const stop = () => {
    clearInterval(pump);
    socket.close();
  };
  return { socket, client, world, closed, stop };
}

test('pickShard takes the fullest shard with room, counts places just given out, and skips what is not ready', () => {
  const shard = (index, online, state = 'ready', reserved = []) => ({ index, online, state, reserved }),
    now = 100_000;
  assert.equal(pickShard([shard(0, 10), shard(1, 150)], 200, now).index, 1);
  assert.equal(pickShard([shard(0, 200), shard(1, 150)], 200, now).index, 1);
  assert.equal(pickShard([shard(0, 200), shard(1, 200)], 200, now), undefined);
  assert.equal(pickShard([shard(0, 10, 'starting')], 200, now), undefined);
  assert.equal(pickShard([shard(0, 199, 'ready', [now - 1])], 200, now), undefined, 'the last place is promised');
  assert.equal(pickShard([shard(0, 199, 'ready', [now - 6000])], 200, now).index, 0, 'a promise runs out');
});

test('counters have their shape; /join says where; /metrics wants the token', TIMEOUT, async (t) => {
  const plaza = await startRouter(t),
    answer = await joinAnswer(plaza);
  assert.equal(answer.full, false);
  assert.match(answer.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(answer.shard, 0);
  assert.equal(typeof answer.world, 'string');
  assert.ok(answer.worldEndsAt > answer.now);
  assert.equal(answer.found, 0);
  assert.equal(answer.total, 1000);

  const counters = await (await plaza.get('/counters')).json();
  assert.deepEqual(Object.keys(counters).sort(), ['blocksToday', 'online', 'worldEndsAt', 'worldsFinished']);
  assert.equal(counters.online, 0);
  assert.equal(counters.blocksToday, 0);
  assert.equal(counters.worldsFinished, 0);
  assert.equal(counters.worldEndsAt, answer.worldEndsAt);

  assert.equal((await plaza.get('/metrics')).status, 401);
  assert.equal((await plaza.get('/metrics', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await plaza.get('/metrics?token=test-metrics-token')).status, 401, 'not in a URL, where logs keep it');
  const metrics = await plaza.get('/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } });
  assert.equal(metrics.status, 200);
  const numbers = await metrics.json();
  assert.equal(numbers.shards[0].state, 'ready');
  await until('a beat', async () => {
    const res = await plaza.get('/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } });
    return (await res.json()).shards[0].ticks;
  });

  assert.equal((await plaza.get('/nothing')).status, 404);
  assert.deepEqual(await (await plaza.get('/finished/index.json')).json(), []);
  assert.equal(plaza.router.address.address, '127.0.0.1');
});

test('/metrics shows a drop and its resume, for as long as the shard lives', TIMEOUT, async (t) => {
  const plaza = await startRouter(t),
    answer = await joinAnswer(plaza),
    proxy = await cutProxy(Number(new URL(answer.url).port));
  t.after(() => proxy.close());
  const page = connectVoxelNet(`ws://127.0.0.1:${proxy.port}`, new VoxelWorld({ blocks }), {
      view: 2,
      name: 'Amber Lantern',
    }),
    pump = setInterval(() => page.update(1 / 60, { keys: 0, yaw: 0, pitch: 0 }), 16);
  t.after(() => {
    clearInterval(pump);
    page.onClose = () => {};
    page.close();
  });
  await until('the player', () => page.spawned);
  proxy.cut();
  await until('the resume', () => page.stats.resumes === 1);
  const shard = await until('the numbers', async () => {
    const res = await plaza.get('/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } }),
      [first] = (await res.json()).shards;
    return first.resume?.resumed === 1 && first;
  });
  assert.deepEqual(shard.resume.parked, { socket: 1, clientSilent: 0 });
  assert.equal(shard.parkedNow, 0);
});

test('CORS: the production origin by default, allowed origins only, never on /metrics', TIMEOUT, async (t) => {
  assert.deepEqual(ROUTER_DEFAULTS.origins, ['https://margoengine.com']);
  assert.deepEqual(fromArguments(['--data=d']).origins, [PRODUCTION_ORIGIN]);
  const plaza = await startRouter(t, { origins: [PRODUCTION_ORIGIN] }),
    answer = await joinAnswer(plaza),
    allow = (res) => res.headers.get('access-control-allow-origin'),
    other = 'https://elsewhere.test';
  for (const path of ['/join', '/counters', '/finished/index.json']) {
    const ok = await plaza.get(path, { headers: { Origin: PRODUCTION_ORIGIN } });
    assert.equal(allow(ok), PRODUCTION_ORIGIN, path);
    assert.equal(ok.headers.get('vary'), 'Origin', path);
    assert.equal(allow(await plaza.get(path, { headers: { Origin: other } })), null, `${path} from another origin`);
    assert.equal(allow(await plaza.get(path)), null, `${path} with no origin`);
  }
  // The preflight says the same.
  assert.equal(
    allow(await plaza.get('/report', { method: 'OPTIONS', headers: { Origin: PRODUCTION_ORIGIN } })),
    PRODUCTION_ORIGIN,
  );
  assert.equal(allow(await plaza.get('/report', { method: 'OPTIONS', headers: { Origin: other } })), null);

  // POST /report arrives as text/plain from the page (no preflight): the origin is checked and the body limit holds.
  const report = (origin, body) =>
    plaza.get('/report', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: origin }, body });
  const refused = await report(other, JSON.stringify({ shard: answer.shard, x: 0, z: 40 }));
  assert.equal(refused.status, 403);
  assert.equal(allow(refused), null);
  const fromPage = await report(PRODUCTION_ORIGIN, JSON.stringify({ shard: answer.shard, x: 0, z: 40 }));
  assert.equal(allow(fromPage), PRODUCTION_ORIGIN, 'the page can read the answer');
  assert.equal(fromPage.status, 403, 'not in this world, but answered');
  const big = await report(PRODUCTION_ORIGIN, 'x'.repeat(257));
  assert.equal(big.status, 413);
  assert.equal(allow(big), PRODUCTION_ORIGIN);

  // The metrics are for the token alone, whoever asks.
  const bearer = { Authorization: 'Bearer test-metrics-token' };
  for (const headers of [{ ...bearer, Origin: PRODUCTION_ORIGIN }, { Origin: PRODUCTION_ORIGIN }, bearer]) {
    const res = await plaza.get('/metrics', { headers });
    assert.equal(allow(res), null, 'no CORS header on /metrics');
  }
  assert.equal(allow(await plaza.get('/metrics', { method: 'OPTIONS', headers: { Origin: PRODUCTION_ORIGIN } })), null);
  const wild = await startRouter(t, { origins: '*' });
  assert.equal(allow(await wild.get('/metrics', { headers: { ...bearer, Origin: other } })), null, 'not even with *');
});

test('/metrics is off without a token', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { metricsToken: undefined });
  assert.equal((await plaza.get('/metrics', { headers: { Authorization: 'Bearer ' } })).status, 404);
});

test('full is an answer: one place taken, the next player hears full with the count', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { capacity: 1, maxShards: 1 }),
    answer = await joinAnswer(plaza),
    page = connectPage(answer.url);
  t.after(() => page.stop());
  await until('the shard to count the player', () => plaza.router.counters().online === 1);
  const full = await (await plaza.get('/join')).json();
  assert.deepEqual(full, { full: true, online: 1, retryIn: 30 });
});

test('a page that only looks holds no place', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { capacity: 1, maxShards: 1 });
  await until('a ready shard', async () => (await plaza.get('/join?peek=1')).status === 200);
  for (let i = 0; i < 5; i++) assert.equal((await (await plaza.get('/join?peek=1')).json()).full, false);
  assert.equal((await (await plaza.get('/join')).json()).full, false, 'the place is still there for a real join');
  assert.equal((await (await plaza.get('/join')).json()).full, true, 'and a real join did take it');
});

test('the free core check counts the machine, not the CPU quota', async () => {
  // availableParallelism follows a service's CPUQuota down: a 4 core box at 360% read 3, so a third shard never started.
  const os = await import('node:os'),
    { syncBuiltinESMExports } = await import('node:module'),
    real = os.default.availableParallelism;
  os.default.availableParallelism = () => 1;
  syncBuiltinESMExports();
  try {
    const { ROUTER_DEFAULTS: fresh } = await import('../server/router.mjs?quota');
    assert.equal(fresh.cores(), os.default.cpus().length);
  } finally {
    os.default.availableParallelism = real;
    syncBuiltinESMExports();
  }
});

test('a new shard starts only while a core is free', TIMEOUT, async (t) => {
  const busy = await startRouter(t, { capacity: 1, maxShards: 2, load: () => 16, cores: () => 16 });
  await joinAnswer(busy);
  await (await busy.get('/join')).json();
  // fixed-wait: nothing to wait for, this checks that nothing starts.
  await wait(50);
  assert.equal(busy.router.shards.filter(Boolean).length, 1, 'no core free, no second shard');

  const free = await startRouter(t, { capacity: 1, maxShards: 2 });
  const first = await joinAnswer(free);
  assert.equal(first.shard, 0);
  // The first place is promised, so the rest are nearly full: the second shard starts and the next player goes there.
  const second = await until('the second shard', async () => {
    const answer = await (await free.get('/join')).json();
    return answer.shard === 1 ? answer : undefined;
  });
  assert.notEqual(second.world, first.world);
});

test(
  'the end of a world, as a page sees it: its socket closes with 1001, /join names a new world',
  TIMEOUT,
  async (t) => {
    const plaza = await startRouter(t, { shard: { spanMs: 1500, seed: undefined } }),
      answer = await joinAnswer(plaza),
      page = connectPage(answer.url);
    t.after(() => page.stop());
    const closed = await page.closed;
    assert.equal(closed.code, 1001);
    const next = await until('the next world', async () => {
      const res = await plaza.get('/join');
      if (res.status !== 200) return undefined;
      const body = await res.json();
      return body.world !== answer.world ? body : undefined;
    });
    assert.notEqual(next.seed, answer.seed, 'a new seed');
    assert.ok(next.worldEndsAt > answer.worldEndsAt);
    const again = connectPage(next.url);
    t.after(() => again.stop());
    await until('the page to be back in', () => again.client.welcome);
  },
);

test('a killed shard restarts with its world, up to the last snapshot', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { shard: { snapshotMs: 100 } }),
    answer = await joinAnswer(plaza),
    page = connectPage(answer.url);
  await until('spawn', () => page.client.spawned);
  const [px, py, pz] = Array.from(page.client.renderPosition, Math.floor);
  await until('its chunk', () => page.world.getChunk(px >> 5, py >> 5, pz >> 5));
  const cells = [];
  for (let dz = -3; dz <= 3; dz++)
    for (let dx = -3; dx <= 3; dx++) if (Math.abs(dx) >= 2 || Math.abs(dz) >= 2) cells.push([px + dx, py + 1, pz + dz]);
  const cell = await until('a free cell', () =>
    cells.find((c) => page.world.getChunk(c[0] >> 5, c[1] >> 5, c[2] >> 5) && page.world.getBlock(...c) === 0),
  );
  assert.ok(page.client.edit(...cell, BRICKS));
  // A world with no edit writes no snapshot, so the first file there holds the edit, and it appears whole.
  const worldDir = join(plaza.dataDir, 'shard-0', answer.world);
  await until(
    'the edit in a snapshot',
    () => existsSync(worldDir) && readdirSync(worldDir).some((n) => /^snap-\d+\.bin$/.test(n)),
  );
  plaza.router.shards[0].child.kill('SIGKILL');
  assert.equal((await page.closed).code, 1006);
  await until('the router to see it', () => plaza.router.shards[0].crashes === 1);

  const back = await until('the same world back', async () => {
    const res = await plaza.get('/join');
    return res.status === 200 ? res.json() : undefined;
  });
  assert.equal(back.world, answer.world);
  assert.equal(back.seed, answer.seed);
  assert.equal(back.worldEndsAt, answer.worldEndsAt);
  assert.equal(plaza.router.shards[0].crashes, 1);
  assert.equal(plaza.router.shards.filter(Boolean).length, 1, 'no second world started beside the one coming back');

  const metrics = async () =>
    (await plaza.get('/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } })).json();
  await until('the restored world to hold the edit', async () => (await metrics()).shards[0].editedChunks >= 1);
  assert.equal((await metrics()).shards[0].crashes, 1);
});

test('POST /report: limits on size, shape and rate; only someone in that world can report', TIMEOUT, async (t) => {
  const plaza = await startRouter(t),
    answer = await joinAnswer(plaza),
    post = (body, headers = {}) =>
      plaza.get('/report', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  assert.equal((await post('x'.repeat(257))).status, 413);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('null')).status, 400);
  for (const bad of [
    {},
    { shard: 0, x: 1 },
    { shard: 'a', x: 1, z: 1 },
    { shard: 99, x: 1, z: 1 },
    { shard: 0, x: 1e300, z: 1 },
  ])
    assert.equal((await post(JSON.stringify(bad))).status, 400, JSON.stringify(bad));

  // Not joined: refused, and that used this minute's report.
  assert.equal((await post(JSON.stringify({ shard: answer.shard, x: 0, z: 40 }))).status, 403);
  assert.equal((await post(JSON.stringify({ shard: answer.shard, x: 0, z: 40 }))).status, 429);
});

test(
  'POST /report answers a big body whose length is not declared up front, without reading it all',
  TIMEOUT,
  async (t) => {
    const plaza = await startRouter(t),
      status = await new Promise((resolve, reject) => {
        const { port } = plaza.router.address,
          req = httpRequest({ port, host: '127.0.0.1', method: 'POST', path: '/report' }, (res) =>
            resolve(res.statusCode),
          );
        req.on('error', reject);
        req.write('x'.repeat(1000));
      });
    assert.equal(status, 413);
  },
);

test(
  'reports through a stand-in for nginx: forged headers are one person, three real people roll back',
  TIMEOUT,
  async (t) => {
    // What the production proxy does: whatever the client sent as X-Real-IP is overwritten with who it really is. Here
    // "who it really is" comes from a test-only header the client cannot be confused with, standing for its socket.
    const plaza = await startRouter(t, { proxied: true }),
      proxy = createServer((req, res) => {
        const { 'test-socket-address': socketAddress, ...headers } = req.headers;
        const forward = httpRequest(
          {
            host: '127.0.0.1',
            port: plaza.router.address.port,
            method: req.method,
            path: req.url,
            headers: { ...headers, 'x-real-ip': socketAddress },
          },
          (answer) => {
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
          },
        );
        req.pipe(forward);
      });
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    t.after(() => new Promise((done) => proxy.close(done)));
    const through = `http://127.0.0.1:${proxy.address().port}`,
      post = (who, body, forged = {}) =>
        fetch(`${through}/report`, {
          method: 'POST',
          headers: { 'Test-Socket-Address': who, 'Content-Type': 'application/json', ...forged },
          body: JSON.stringify(body),
        });

    const answer = await until('a shard', async () => {
      const res = await fetch(`${through}/join`, { headers: { 'Test-Socket-Address': '203.0.113.1' } });
      return res.status === 200 ? res.json() : undefined;
    });
    // A direct request has no client address, and is refused for what needs one.
    assert.equal((await plaza.get('/join')).status, 400);
    assert.equal((await plaza.get('/join', { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 400);
    assert.equal((await plaza.get('/counters')).status, 200, 'the health check needs none');

    // One person, a fresh forged address on every try: the second is refused like the first was not.
    const first = await post('203.0.113.1', { shard: answer.shard, x: 0, z: 40 }, { 'X-Real-IP': '198.51.100.1' }),
      second = await post(
        '203.0.113.1',
        { shard: answer.shard, x: 0, z: 40 },
        {
          'X-Real-IP': '198.51.100.2',
          'X-Forwarded-For': '198.51.100.3',
          'CF-Connecting-IP': '198.51.100.4',
        },
      );
    assert.equal(first.status, 403, 'not in the world');
    assert.equal(second.status, 429, 'the same person');

    // The rule itself over the real route: three people standing in the world. The shard's answer to "near" is what a
    // joined player gets; `report` takes the identity from the request, so it is called as the route calls it.
    const shard = plaza.router.shards[answer.shard];
    shard.child.send = ((send) =>
      function (message, ...rest) {
        if (message.type === 'request' && message.name === 'near') {
          queueMicrotask(() => shard.child.emit('message', { type: 'reply', id: message.id, result: true }));
          return true;
        }
        return send.call(this, message, ...rest);
      })(shard.child.send);
    const results = [];
    for (const who of ['203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14']) {
      const res = await post(who, { shard: answer.shard, x: 0, z: 40 }, { 'X-Real-IP': '198.51.100.1' });
      assert.equal(res.status, 202, who);
      results.push((await res.json()).result);
    }
    assert.deepEqual(results, ['counted', 'counted', 'rolled-back', 'cooldown']);
  },
);

test('the admin tool reaches the router over its own socket', TIMEOUT, async (t) => {
  const plaza = await startRouter(t),
    answer = await joinAnswer(plaza),
    status = await adminRequest(plaza.dataDir, commandFrom(['status']));
  assert.equal(status.shards[0].world, answer.world);
  assert.deepEqual(await adminRequest(plaza.dataDir, commandFrom(['snapshots', '--shard=0'])), { snapshots: [] });
  const rolled = await adminRequest(
    plaza.dataDir,
    commandFrom(['rollback', '--shard=0', '--to=00:00', '--area=10,20']),
  );
  assert.deepEqual(rolled, { at: null, chunks: 0 });
  const missing = await adminRequest(plaza.dataDir, { name: 'snapshots', shard: 7 });
  assert.match(missing.error, /not running/);
});

test('the command line: data folder required, proxied and limits passed on, bad numbers refused', () => {
  assert.throws(() => fromArguments([]), TypeError);
  assert.throws(() => fromArguments(['--data=d', '--port=abc']), RangeError);
  const options = fromArguments([
    '--data=d',
    '--proxied',
    '--origins=https://a.test,https://b.test',
    '--per-identity=600',
  ]);
  assert.equal(options.proxied, true);
  assert.deepEqual(options.origins, ['https://a.test', 'https://b.test']);
  assert.deepEqual(options.shard, { perIdentity: 600 });
  assert.deepEqual(fromArguments(['--data=d']).shard, {});
  assert.deepEqual(fromArguments(['--data=d', '--idle-minutes=3']).shard, { idleMs: 180_000 });
  assert.equal(fromArguments(['--data=d', '--idle-minutes=0']).shard.idleMs, 0);
  assert.equal(fromArguments(['--data=d']).proxied, false);
  assert.equal(fromArguments(['--data=d', '--origins=*']).origins, '*');
});

test('the admin tool reads its arguments, and --to is the last such time of day in UTC', () => {
  const now = Date.UTC(2026, 9, 31, 14, 30);
  assert.equal(timeOfDay('14:00', now), Date.UTC(2026, 9, 31, 14, 0));
  assert.equal(timeOfDay('14:30', now), now);
  assert.equal(timeOfDay('15:00', now), Date.UTC(2026, 9, 30, 15, 0), 'not in the future');
  for (const bad of ['', '25:00', '1:5', undefined]) assert.throws(() => timeOfDay(bad), RangeError);
  assert.deepEqual(commandFrom(['rollback', '--shard=1', '--to=14:00', '--area=5,-9'], now), {
    name: 'rollback',
    shard: 1,
    at: Date.UTC(2026, 9, 31, 14, 0),
    area: [5, -9],
  });
  assert.throws(() => commandFrom(['rollback', '--to=14:00'], now), RangeError);
  assert.throws(() => commandFrom(['nonsense'], now), TypeError);
});

test(
  'a world finished before this router started counts; finished/index.json lists those with a render',
  TIMEOUT,
  async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plaza-finished-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    mkdirSync(join(dataDir, 'final'));
    mkdirSync(join(dataDir, 'finished'));
    const meta = (id, endedAt) =>
      JSON.stringify({ id, seed: 7, floor: 9, startedAt: 1, endedAt, chunks: 1, edits: 5, found: 12, total: 1000 });
    writeFileSync(join(dataDir, 'final', 's0-aaa.json'), meta('s0-aaa', 100));
    writeFileSync(join(dataDir, 'final', 's0-bbb.json'), meta('s0-bbb', 200));
    writeFileSync(join(dataDir, 'final', 's0-ccc.json'), meta('s0-ccc', 300));
    writeFileSync(join(dataDir, 'finished', 's0-aaa.webp'), 'w');
    writeFileSync(join(dataDir, 'finished', 's0-bbb.webp'), 'w');
    writeFileSync(join(dataDir, 'finished', 's0-bbb.png'), 'p');
    const plaza = await startRouter(t, { dataDir });
    assert.equal(plaza.router.counters().worldsFinished, 3);
    const index = await (await plaza.get('/finished/index.json')).json();
    assert.deepEqual(index, [
      { id: 's0-bbb', seed: 7, endedAt: 200, edits: 5, found: 12, total: 1000, webp: 's0-bbb.webp', png: 's0-bbb.png' },
      { id: 's0-aaa', seed: 7, endedAt: 100, edits: 5, found: 12, total: 1000, webp: 's0-aaa.webp' },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'finished', 'index.json'), 'utf8')), index);
  },
);

test('every child is gone after close, and nothing keeps the process alive', TIMEOUT, async (t) => {
  const plaza = await startRouter(t);
  await joinAnswer(plaza);
  const { child } = plaza.router.shards[0],
    gone = new Promise((done) => child.once('exit', done));
  await plaza.router.close();
  await gone;
  assert.equal(plaza.router.shards[0].child, undefined);
  await plaza.router.close();
});

test('a client that never finishes its headers is cut off', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { headersMs: 200 }),
    closed = await new Promise((resolve, reject) => {
      const socket = connect(plaza.router.address.port, '127.0.0.1', () =>
        socket.write('GET /counters HTTP/1.1\r\nHost: x\r\n'),
      );
      socket.resume();
      socket.on('close', () => resolve(true));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('still connected after 10 s')), 10_000).unref();
    });
  assert.ok(closed);
});

test('one identity is slowed down, others are not', TIMEOUT, async (t) => {
  const plaza = await startRouter(t, { rateBurst: 3, ratePerSecond: 0.001 }),
    statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await plaza.get('/counters')).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('a player in the world can report, near where they stand', TIMEOUT, async (t) => {
  const plaza = await startRouter(t),
    answer = await joinAnswer(plaza),
    page = connectPage(answer.url);
  t.after(() => page.stop());
  await until('the player', () => page.client.spawned);
  const res = await plaza.get('/report', {
    method: 'POST',
    body: JSON.stringify({ shard: answer.shard, x: 0, z: 0 }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { result: 'counted' });
});

// Two boxes, as two routers on this machine. The first is always filled by a real player, so its 5 s hold cannot run out
// under a test; `second` is a router or a stand-in, anything with a base URL.
const PEER_SECRET = 'test-peer-secret',
  ONE_PLACE = { capacity: 1, maxShards: 1 },
  peerMetrics = async (plaza) =>
    (await plaza.get('/metrics', { headers: { Authorization: 'Bearer test-metrics-token' } }).then((r) => r.json()))
      .peer,
  readyShards = (plaza) => until('a ready shard', () => plaza.router.shards[0]?.state === 'ready');

async function startFirstBox(t, secondBase, options = {}) {
  const first = await startRouter(t, {
    ...ONE_PLACE,
    peer: secondBase,
    peerSecret: PEER_SECRET,
    peerPollMs: 100,
    ...options,
  });
  await readyShards(first);
  return first;
}

// The first box with its one place taken.
async function fillFirstBox(t, first) {
  const answer = await first.get('/join').then((r) => r.json());
  assert.equal(answer.router, undefined, 'the first arrival stays on the first box');
  const page = connectPage(answer.url);
  t.after(() => page.stop());
  await until('the first box to count its player', () => first.router.shards[0].online === 1);
  return page;
}

async function startSecondBox(t, options = {}) {
  const second = await startRouter(t, { ...ONE_PLACE, peerSecret: PEER_SECRET, ...options });
  await readyShards(second);
  return second;
}

// A second box that says it has room and answers /peer/join with `onJoin`.
async function startStandIn(t, onJoin, status = () => ({ online: 3, room: 5, canGrow: false })) {
  const server = createServer((req, res) => {
    if (req.url !== '/peer/status') return onJoin(req, res);
    const body = status();
    if (!body) res.writeHead(500);
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}` };
}

const peerUp = (first) => until('the peer to be up', async () => (await peerMetrics(first)).up);

test('two boxes: the first fills, the next goes to the second naming it, then full counts both', TIMEOUT, async (t) => {
  const second = await startSecondBox(t),
    first = await startFirstBox(t, second.base);
  await until('the second box to show room', async () => (await peerMetrics(first)).room === 1);
  await fillFirstBox(t, first);

  const res = await first.get('/join'),
    answer = await res.json();
  assert.equal(res.status, 200);
  assert.equal(answer.full, false);
  assert.equal(answer.router, second.base);
  assert.equal(answer.url.split(':').at(-1), String(second.router.shards[0].port), 'the second box runs this shard');
  const page = connectPage(answer.url);
  t.after(() => page.stop());
  await until('the player to spawn on the second box', () => page.client.spawned);

  const full = await until('the two players counted', async () => {
    const body = await first.get('/join').then((r) => r.json());
    return body.online === 2 && body;
  });
  assert.equal(full.full, true);
  assert.equal(full.retryIn, 30);
  assert.equal((await first.get('/counters').then((r) => r.json())).online, 2);
  const metrics = await peerMetrics(first);
  assert.equal(metrics.up, true);
  assert.equal(metrics.forwards, 1);
  assert.equal(metrics.room, 0);
  assert.equal((await second.get('/counters').then((r) => r.json())).online, 1, 'the second box counts its own');
});

test('a peek with the first box full reads the last poll and holds no place on the second', TIMEOUT, async (t) => {
  const second = await startSecondBox(t),
    first = await startFirstBox(t, second.base);
  await until('the second box to show room', async () => (await peerMetrics(first)).room === 1);
  await fillFirstBox(t, first);
  const answer = await first.get('/join?peek=1').then((r) => r.json());
  assert.equal(answer.full, false);
  assert.match(answer.url, /^ws:\/\//, 'a page reads this as a shard: there is room');
  assert.equal(second.router.shards[0].reserved.length, 0);
  assert.equal((await peerMetrics(first)).forwards, 0);
});

test('the second box closed: the first answers full fast, and marks it down after two misses', TIMEOUT, async (t) => {
  const second = await startSecondBox(t),
    first = await startFirstBox(t, second.base, { peerPollMs: 600_000 });
  await peerUp(first);
  await fillFirstBox(t, first);
  await second.router.close();

  const began = performance.now(),
    res = await first.get('/join'),
    answer = await res.json();
  assert.ok(performance.now() - began < 1500, 'within the forward limit');
  assert.equal(res.status, 200);
  assert.equal(answer.full, true);
  assert.equal((await first.get('/counters')).status, 200);
  assert.equal((await peerMetrics(first)).failures, 1);
});

test('a peer that stops answering polls is down after two misses and up again after one answer', TIMEOUT, async (t) => {
  let answering = true;
  const standIn = await startStandIn(
      t,
      (req, res) => res.end('{}'),
      () => (answering ? { online: 3, room: 5, canGrow: false } : undefined),
    ),
    first = await startFirstBox(t, standIn.base, { peerPollMs: 25 });
  await peerUp(first);
  assert.equal((await first.get('/counters').then((r) => r.json())).online, 3);
  answering = false;
  await until('the peer to be down', async () => !(await peerMetrics(first)).up);
  assert.ok((await peerMetrics(first)).failures >= 2);
  assert.equal((await first.get('/counters').then((r) => r.json())).online, 0, 'a box that is down counts nobody');
  await fillFirstBox(t, first);
  assert.equal((await first.get('/join').then((r) => r.json())).full, true, 'nothing is forwarded while it is down');
  answering = true;
  await peerUp(first);
});

test('a second box that never answers /peer/join: full within the limit, not an error', TIMEOUT, async (t) => {
  const standIn = await startStandIn(t, () => {}),
    first = await startFirstBox(t, standIn.base, { peerTimeoutMs: 300 });
  await peerUp(first);
  await fillFirstBox(t, first);
  const began = performance.now(),
    res = await first.get('/join'),
    answer = await res.json();
  assert.equal(res.status, 200);
  assert.equal(answer.full, true);
  assert.equal(answer.online, 4, 'its own player and the three of the last poll');
  const took = performance.now() - began;
  assert.ok(took >= 250 && took < 1500, `took ${took} ms`);
});

test('every odd answer from the second box gives full, never a 5xx or its body', TIMEOUT, async (t) => {
  const answers = [
    [500, '{"full":false,"url":"ws://127.0.0.1:1"}'],
    [429, '{"error":"slow-down"}'],
    [503, '{"full":false,"starting":true,"retryIn":2}'],
    [200, 'not json'],
    [200, 'null'],
    [200, '{}'],
    [200, '{"full":false}'],
    [200, '{"full":false,"url":"https://not-a-socket.example"}'],
    [200, '{"full":false,"url":3}'],
    [301, ''],
  ];
  let next = 0;
  const standIn = await startStandIn(t, (req, res) => {
      const [status, text] = answers[next++];
      res.writeHead(status, status === 301 ? { Location: 'http://127.0.0.1:1/' } : {});
      res.end(text);
    }),
    first = await startFirstBox(t, standIn.base);
  await peerUp(first);
  await fillFirstBox(t, first);
  for (let i = 0; i < answers.length; i++) {
    const res = await first.get('/join'),
      answer = await res.json();
    assert.equal(res.status, 200, answers[i][1]);
    assert.equal(answer.full, true, answers[i][1]);
    assert.equal(answer.router, undefined, answers[i][1]);
  }
  assert.equal(next, answers.length, 'each one was asked');
  assert.equal((await peerMetrics(first)).forwards, 0);
});

test(
  'with no shard ready here, a join goes to the second box; if that fails it still says starting',
  TIMEOUT,
  async (t) => {
    let place = true;
    const standIn = await startStandIn(t, (req, res) => {
        if (place) res.end('{"full":false,"url":"ws://127.0.0.1:9","shard":0,"world":"w","online":1}');
        else res.writeHead(500).end();
      }),
      first = await startFirstBox(t, standIn.base, { restartMs: 600_000 });
    await peerUp(first);
    first.router.shards[0].child.kill('SIGKILL');
    await until('the shard to be gone', () => first.router.shards[0].state === 'stopped');
    const forwarded = await first.get('/join').then((r) => r.json());
    assert.equal(forwarded.router, standIn.base);
    assert.equal(forwarded.url, 'ws://127.0.0.1:9');
    place = false;
    const res = await first.get('/join');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { full: false, starting: true, retryIn: 2 });
  },
);

test('/peer/* wants the secret, has no CORS headers and no per-identity bucket', TIMEOUT, async (t) => {
  const second = await startSecondBox(t, { rateBurst: 2, ratePerSecond: 0.001 }),
    bearer = (secret) => ({ headers: { Authorization: `Bearer ${secret}`, Origin: 'https://a.test' } });
  for (const path of ['/peer/status', '/peer/join']) {
    const wrong = await second.get(path, bearer('wrong'));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('access-control-allow-origin'), null);
    assert.equal((await second.get(path)).status, 401, 'no header at all');
  }
  for (let i = 0; i < 5; i++) {
    const res = await second.get('/peer/status', bearer(PEER_SECRET));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['canGrow', 'online', 'room']);
  }
  const preflight = await second.get('/peer/join', { method: 'OPTIONS', headers: { Origin: 'https://a.test' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const joined = await second.get('/peer/join', bearer(PEER_SECRET));
  assert.equal(joined.status, 200);
  assert.equal(second.router.shards[0].reserved.length, 1, 'the second box holds the place');
  assert.equal((await joined.json()).router, undefined, 'only the first box knows it is another box');
  assert.equal((await second.get('/counters')).status, 200, 'the bucket is still full for everyone else');
});

test(
  'a router with no secret and no peer: /peer/* is 404, nothing is asked, /metrics has no peer',
  TIMEOUT,
  async (t) => {
    const plaza = await startRouter(t);
    assert.equal(
      (await plaza.get('/peer/status', { headers: { Authorization: `Bearer ${PEER_SECRET}` } })).status,
      404,
    );
    assert.equal((await plaza.get('/peer/join')).status, 404);
    assert.equal(await peerMetrics(plaza), undefined);
  },
);

test('the second box starts its next shard from forwarded joins', TIMEOUT, async (t) => {
  const second = await startSecondBox(t, { maxShards: 2 }),
    first = await startFirstBox(t, second.base);
  await until('the second box to show room', async () => (await peerMetrics(first)).room === 1);
  await fillFirstBox(t, first);
  const answer = await first.get('/join').then((r) => r.json());
  assert.equal(answer.shard, 0);
  const page = connectPage(answer.url);
  t.after(() => page.stop());
  const next = await until('a place on its second shard', async () => {
    const body = await first.get('/join').then((r) => r.json());
    return body.shard === 1 && body;
  });
  assert.equal(next.router, second.base);
  assert.equal(second.router.shards[1].state, 'ready');
});

test('--peer: passed on with the env, refused without the secret or as anything but a base URL', () => {
  const before = process.env.PLAZA_PEER_SECRET,
    dataDir = mkdtempSync(join(tmpdir(), 'plaza-router-'));
  try {
    delete process.env.PLAZA_PEER_SECRET;
    const alone = fromArguments(['--data=d']);
    assert.equal(alone.peer, undefined);
    assert.equal(alone.peerSecret, undefined);
    process.env.PLAZA_PEER_SECRET = 'from-env';
    const peered = fromArguments(['--data=d', '--peer=https://box2.example']);
    assert.equal(peered.peer, 'https://box2.example');
    assert.equal(peered.peerSecret, 'from-env');
    const make = (options) => new PlazaRouter({ dataDir, log: () => {}, ...options });
    assert.throws(() => make({ peer: 'https://box2.example' }), /PLAZA_PEER_SECRET/);
    for (const peer of ['box2', 'ftp://box2.example', 'https://box2.example/path', 'https://box2.example/?a=1'])
      assert.throws(() => make({ peer, peerSecret: 's' }), TypeError, peer);
    make({ peer: 'https://box2.example/', peerSecret: 's' });
  } finally {
    if (before === undefined) delete process.env.PLAZA_PEER_SECRET;
    else process.env.PLAZA_PEER_SECRET = before;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
