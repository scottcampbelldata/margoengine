// Real-GPU play test of the voxel sandbox in headless Edge: spawn on dry ground, pointer lock, fly up and forward,
// land, break the block under the crosshair, place stone, swim in the lake, change the render distance, and find the
// placed block again after a reload (IndexedDB save). Then Plaza: a second client's figure and name tag on a local shard,
// the banner and solo world on every failure (server killed, no welcome, router full or down, a world's end), the room
// retry, a report, and a phone run on real touch events. Run from the repository root after `npm run build:packages`,
// holding the GPU lock: node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VoxelBot } from '@margoengine/voxel-net/bot';
import { freePort, openBrowser } from '../../../scripts/browser.js';
import { killTree, watchExit } from '../../../scripts/support/shutdown.mjs';
import { defineBlocks } from '../src/blocks.ts';
import { NOTICE_EVERY, PROTECTED_MESSAGE, REFUSED_MESSAGE } from '../src/multiplayer.ts';
import { isPlazaProtected, PLAZA_WALL_TOP } from '../src/plaza-area.ts';

process.chdir(resolve(import.meta.dirname, '../../..'));
const cleanup = [];
const port = await freePort(),
  path = '/examples/voxel-sandbox/index.html?rd=4',
  context = await openBrowser({ startPath: path, port }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
// A dead server or router is the point of these pages: the browser's own report of it is expected.
const NETWORK_ERROR = /WebSocket connection|Failed to load resource|ERR_CONNECTION|net::ERR/;
const sandbox = (f, arg) => page.evaluate(f, arg),
  wait = (ms) => page.waitForTimeout(ms),
  hold = async (key, ms) => {
    await page.keyboard.down(key);
    await wait(ms);
    await page.keyboard.up(key);
  },
  position = () => sandbox(() => [...window.voxelSandbox.player.position]);
try {
  await page.setViewportSize({ width: 960, height: 540 });
  // PLAY_ONLY=edits runs only the Plaza edit test below (a quick loop while working on it).
  if (process.env.PLAY_ONLY === 'edits') {
    await plazaEdits();
    console.log('voxel sandbox Plaza edit test passed');
    process.exit(await closeAll());
  }
  // PLAY_ONLY=load runs only the load order test.
  if (process.env.PLAY_ONLY === 'load') {
    await loadOrder();
    console.log('voxel sandbox load order test passed');
    process.exit(await closeAll());
  }
  // PLAY_ONLY=rejoin runs only the test of a dropped connection.
  if (process.env.PLAY_ONLY === 'rejoin') {
    await rejoin();
    console.log('voxel sandbox rejoin test passed');
    process.exit(await closeAll());
  }
  // PLAY_ONLY=phone runs only the phone test.
  if (process.env.PLAY_ONLY === 'phone') {
    await phone();
    console.log('voxel sandbox phone test passed');
    process.exit(await closeAll());
  }
  await page.goto(`http://127.0.0.1:${port}${path}`);
  await page.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 });
  const spawn = await position(),
    ground = await sandbox(
      ([x, y, z]) =>
        window.voxelSandbox.world.blocks.get(window.voxelSandbox.world.getBlock(Math.floor(x), y - 1, Math.floor(z)))
          .name,
      spawn,
    );
  assert.ok(['grass', 'sand'].includes(ground), `spawned on ${ground} at ${spawn}`);
  console.log(`ok spawned at ${spawn.map((v) => v.toFixed(1))} on ${ground}`);
  assert.deepEqual(
    await sandbox(() => ['fps', 'help'].map((id) => getComputedStyle(document.getElementById(id)).display)),
    ['none', 'none'],
    'a desktop page has no frame rate or help button',
  );

  await page.mouse.click(480, 270);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 5000 });
  console.log('ok pointer lock');

  // Fly: F, rise with Space, forward with W.
  await page.keyboard.press('KeyF');
  assert.equal(await sandbox(() => window.voxelSandbox.player.flying), true);
  const before = await position();
  await hold('Space', 600);
  await hold('KeyW', 800);
  const after = await position(),
    rose = after[1] - before[1],
    moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
  assert.ok(rose > 3, `rose ${rose} blocks`);
  assert.ok(moved > 4, `flew ${moved} blocks`);
  console.log(`ok flew: up ${rose.toFixed(1)}, forward ${moved.toFixed(1)} blocks`);

  // Land: fly off, fall to the ground.
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.voxelSandbox.player.onGround, null, { timeout: 10_000 });
  console.log('ok landed');

  // Look down at the ground and break the block under the crosshair.
  await page.mouse.move(480, 270);
  for (let i = 0; i < 10; i++) await page.mouse.move(480, 270 + 40 * (i + 1));
  await wait(200);
  const target = await sandbox(() => window.voxelSandbox.target && [...window.voxelSandbox.target.cell]);
  assert.ok(target, 'a block under the crosshair');
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await wait(100);
  assert.equal(await sandbox((c) => window.voxelSandbox.world.getBlock(...c), target), 0, `broke ${target}`);
  console.log(`ok broke ${target}`);

  // Place stone (slot 1) against the face under the crosshair.
  await page.keyboard.press('Digit1');
  await wait(100);
  const hit = await sandbox(() => {
    const t = window.voxelSandbox.target;
    return t && { cell: [...t.cell], adjacent: [...t.adjacent] };
  });
  assert.ok(hit, 'a face to place against');
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await wait(100);
  const placed = await sandbox((c) => window.voxelSandbox.world.getBlock(...c), hit.adjacent),
    stone = await sandbox(() => window.voxelSandbox.world.blocks.id('stone'));
  assert.equal(placed, stone, `placed stone at ${hit.adjacent}`);
  console.log(`ok placed stone at ${hit.adjacent}`);

  // Render distance: V steps 4 -> 8.
  await page.keyboard.press('KeyV');
  assert.equal(await sandbox(() => window.voxelSandbox.streamer.distance), 8);
  console.log('ok render distance 8');

  // Swim: teleport into the lake west of spawn.
  await sandbox(() => {
    window.voxelSandbox.player.position = [-40.5, 0.2, -20.5];
  });
  await page.waitForFunction(() => window.voxelSandbox.player.inLiquid, null, { timeout: 10_000 });
  console.log('ok swimming');

  // Save (leaving pointer lock saves; headless Escape does not unlock, so unlock directly) and reload.
  await sandbox(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await sandbox(() => window.voxelSandbox.streamer.save());
  await page.reload();
  await page.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 });
  await page.waitForFunction((c) => window.voxelSandbox.world.getChunk(c[0] >> 5, c[1] >> 5, c[2] >> 5), hit.adjacent, {
    timeout: 30_000,
  });
  assert.equal(await sandbox((c) => window.voxelSandbox.world.getBlock(...c), hit.adjacent), stone);
  if (String(target) !== String(hit.adjacent))
    // the stone may have refilled the hole
    assert.equal(await sandbox((c) => window.voxelSandbox.world.getBlock(...c), target), 0);
  console.log('ok the edits survive a reload');
  assert.deepEqual(errors, []);

  await loadOrder();
  await plaza();
  await rejoin();
  await plazaEdits();
  assert.deepEqual(
    errors.filter((e) => !NETWORK_ERROR.test(e)),
    [],
  );
  console.log('voxel sandbox play test passed');
} finally {
  await closeAll();
  watchExit();
}

async function closeAll() {
  await context.close();
  for (const close of cleanup.splice(0).reverse()) await close();
  return 0;
}

async function plaza() {
  const origin = `http://127.0.0.1:${port}/examples/voxel-sandbox/index.html`,
    open = (query) => page.goto(`${origin}?${query}`),
    spawned = (on = page) => on.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 }),
    bannerText = () =>
      page.evaluate(() =>
        document.getElementById('banner').hidden ? '' : document.querySelector('#banner span').textContent,
      ),
    banner = (pattern, timeout = 30_000) =>
      page.waitForFunction(
        (source) => {
          const box = document.getElementById('banner');
          return !box.hidden && new RegExp(source).test(box.textContent);
        },
        pattern.source,
        { timeout },
      ),
    alone = async () => {
      await spawned();
      assert.equal(await sandbox(() => !!window.voxelSandbox.streamer && !window.voxelSandbox.online), true);
    };

  // A real shard and a second client: its figure and tag appear.
  let shard = await startShard();
  await open(`server=ws://127.0.0.1:${shard.port}&rd=4`);
  await spawned();
  const blocks = defineBlocks().blocks,
    bot = await VoxelBot.connect({
      url: `ws://127.0.0.1:${shard.port}`,
      blocks,
      name: 'Quiet Otter',
      view: 2,
      editInterval: 0,
      home: [8, 2],
      leash: 2,
    });
  const botLoop = setInterval(() => bot.update?.(0.05), 50);
  cleanup.push(async () => {
    clearInterval(botLoop);
    await bot.close();
  });
  await page.waitForFunction(() => window.voxelSandbox.figures?.drawn >= 1, null, { timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.name-tag')].some((t) => t.textContent === 'Quiet Otter'),
    null,
    {
      timeout: 30_000,
    },
  );
  console.log('ok the second client has a figure and a name tag');

  // Turn to face it (a locked mouse turns the view): the crowd then draws its six boxes, and the look can be checked.
  await page.mouse.click(480, 270);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 5000 });
  const aim = await sandbox(() => {
    const s = window.voxelSandbox,
      other = s.online.client.players.values().next().value.snapshot.position,
      me = s.player.position;
    return { yaw: s.look.yaw, wanted: Math.atan2(-(other[0] - me[0]), -(other[2] - me[2])) };
  });
  await page.mouse.move(480 + (aim.yaw - aim.wanted) / 0.0024, 270);
  // The count is read back from the GPU, and waitForFunction does not await a predicate, so this polls from here.
  for (const end = Date.now() + 15_000; (await sandbox(() => window.voxelSandbox.figures.crowd.readCount())) < 6; ) {
    assert.ok(Date.now() < end, 'six figures drawn');
    await wait(200); // fixed-wait: a poll of a GPU readback, which nothing announces
  }
  await page.screenshot({ path: 'test-results/plaza-figures.png' });
  console.log('ok the figure draws (test-results/plaza-figures.png)');

  // The figures' frame cost: 200 players moving, 32 of them tagged, on the real instanced crowd.
  const cost = await sandbox(() => {
    const { figures } = window.voxelSandbox,
      players = new Map();
    for (let id = 1000; id < 1200; id++) {
      const a = id * 0.7;
      players.set(id, {
        id,
        name: 'Quiet Otter',
        snapshot: {
          position: new Float64Array([Math.cos(a) * 30, 20, Math.sin(a) * 30]),
          rotation: new Float64Array([0, Math.sin(a), 0, Math.cos(a)]),
          velocity: new Float64Array([2, 0, 1]),
        },
      });
    }
    for (let i = 0; i < 300; i++) figures.update(players, 1 / 60, [0, 20, 0]); // warm up
    const heap = () => performance.memory?.usedJSHeapSize ?? 0,
      times = [],
      before = heap();
    for (let i = 0; i < 2000; i++) {
      const start = performance.now();
      figures.update(players, 1 / 60, [0, 20, 0]);
      times.push(performance.now() - start);
    }
    const grown = heap() - before;
    figures.update(new Map(), 1 / 60, [0, 20, 0]);
    return { mean: times.reduce((sum, t) => sum + t, 0) / times.length, grown };
  });
  console.log(
    `ok figures cost ${cost.mean.toFixed(3)} ms mean for 200 players; heap grew ${cost.grown} B over 2,000 updates`,
  );
  assert.ok(cost.mean < 4, `${cost.mean} ms a frame for 200 figures`);

  // The server is killed: the page says it is trying within 5 s, stops trying within the 30 s a server keeps a player,
  // then a playable solo world.
  clearInterval(botLoop);
  const killed = Date.now();
  await killTree(shard.child);
  await banner(/Reconnecting to Plaza/, 5000);
  await banner(/building alone/, 35_000);
  console.log(`ok the banner shows ${Date.now() - killed} ms after the kill: ${await bannerText()}`);
  await alone();
  await page.keyboard.up('KeyW');
  if (!(await sandbox(() => document.pointerLockElement?.id === 'scene'))) await page.mouse.click(480, 270);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 5000 });
  const standing = await position();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForFunction(
    (from) => Math.hypot(...window.voxelSandbox.player.position.map((v, i) => v - from[i])) > 1,
    standing,
    { timeout: 15_000 },
  );
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Space');
  console.log('ok walking works in the solo world');

  // Connects and never answers: no welcome in time.
  const silentSockets = new Set(),
    silent = createTcpServer((socket) => {
      silentSockets.add(socket);
      socket.on('error', () => {});
    });
  await new Promise((done) => silent.listen(0, '127.0.0.1', done));
  cleanup.push(
    () =>
      new Promise((done) => {
        for (const socket of silentSockets) socket.destroy();
        silent.close(done);
      }),
  );
  await open(`server=ws://127.0.0.1:${silent.address().port}&rd=2`);
  await banner(/The server is offline, building alone/);
  await alone();
  console.log('ok no welcome: solo');

  // A router: what /join answers is up to the test; every /report it gets is kept.
  const router = { answer: { full: true, online: 400 }, joins: 0, reports: [] },
    routerServer = createServer((request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      // A page playing alone asks /join?peek=1.
      if (request.url.split('?')[0].endsWith('/join')) {
        router.joins++;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(typeof router.answer === 'function' ? router.answer() : router.answer));
      } else {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          router.reports.push(JSON.parse(body));
          response.end('{}');
        });
      }
    });
  await new Promise((done) => routerServer.listen(0, '127.0.0.1', done));
  const routerUrl = `http://127.0.0.1:${routerServer.address().port}`;
  cleanup.push(() => new Promise((done) => (routerServer.closeAllConnections(), routerServer.close(done))));

  // Full: the banner names the count, the page plays alone, and the retry notices room; Join reloads into the shard.
  shard = await startShard();
  await open(`plaza=${routerUrl}&rd=2&retry=200`);
  await banner(/Plaza is full, 400 people are in, building alone, retrying/);
  await alone();
  console.log('ok full: solo');
  router.answer = { url: `ws://127.0.0.1:${shard.port}`, shard: 3, world: 'a' };
  await banner(/Plaza has room now/);
  await Promise.all([page.waitForEvent('load'), page.click('#banner button')]);
  await spawned();
  assert.equal(await sandbox(() => !!window.voxelSandbox.online), true);
  console.log('ok the retry saw room and Join rejoined');
  assert.ok(await page.evaluate(() => /^\w+ \w+$/.test(localStorage.getItem('margo-plaza-name'))));

  // A report: the button posts the shard and position.
  await page.waitForSelector('#report:not([hidden])');
  await page.click('#report');
  await page.waitForFunction(() => /Report sent/.test(document.getElementById('toast').textContent));
  assert.equal(router.reports.length, 1);
  assert.deepEqual(Object.keys(router.reports[0]).sort(), ['shard', 'x', 'z']);
  assert.equal(router.reports[0].shard, 3);
  assert.ok(Number.isFinite(router.reports[0].x) && Number.isFinite(router.reports[0].z));
  await page.click('#report');
  await page.waitForFunction(() => /One report a minute/.test(document.getElementById('toast').textContent));
  assert.equal(router.reports.length, 1);
  console.log('ok a report reached the router, and the page holds to one a minute');

  // A shard closes with 1001, whatever its reason: /join names another world, so the page reloads into it.
  const ended = createServer();
  ended.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const reason = Buffer.from('server closing');
    socket.write(Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x03, 0xe9]), reason]));
    socket.on('error', () => {});
    socket.on('data', () => socket.destroy());
  });
  await new Promise((done) => ended.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise((done) => (ended.closeAllConnections(), ended.close(done))));
  router.answer = () => {
    return router.joins === 1
      ? { url: `ws://127.0.0.1:${ended.address().port}`, shard: 1, world: 'a' }
      : { url: `ws://127.0.0.1:${shard.port}`, shard: 2, world: 'b' };
  };
  router.joins = 0;
  await open(`plaza=${routerUrl}&rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  assert.ok(router.joins >= 3, `${router.joins} asks of /join`);
  console.log('ok a world end rejoined through /join');

  // A close with no room left: the same check ends in the solo world.
  router.answer = () =>
    router.joins === 1
      ? { url: `ws://127.0.0.1:${ended.address().port}`, shard: 1, world: 'a' }
      : { full: true, online: 7 };
  router.joins = 0;
  await open(`plaza=${routerUrl}&rd=2`);
  await banner(/Plaza is full, 7 people are in/);
  await alone();
  console.log('ok a close with no room: solo');

  // The server's idle limit closes the player with 4410 'idle'. Rejoining would undo the limit: the page keeps showing the
  // world, sends nothing more, and shows a Join button that reloads. The close comes from a pipe in front of a real shard,
  // so the page has a world to keep.
  const real = await startShard(),
    pipe = await tcpProxy(real.port);
  router.answer = { url: `ws://127.0.0.1:${pipe.port}`, shard: 1, world: 'a' };
  router.joins = 0;
  await open(`plaza=${routerUrl}&rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  const here = () =>
    sandbox(() => {
      const [x, y, z] = window.voxelSandbox.player.position;
      return !!window.voxelSandbox.world.getChunk(Math.floor(x) >> 5, Math.floor(y) >> 5, Math.floor(z) >> 5);
    });
  assert.equal(await here(), true, 'the world is there before the close');
  let loads = 0;
  const counted = () => loads++;
  page.on('load', counted);
  pipe.injectClose(4410, 'idle');
  await banner(/You were idle/, 10_000);
  assert.equal(await page.isVisible('#banner button'), true, 'the Join button shows');
  assert.equal(await page.evaluate(() => document.querySelector('#banner button').textContent), 'Join');
  const sent = () => sandbox(() => window.voxelSandbox.online.client.stats.sent);
  const sentThen = await sent();
  // Frames pass with the key held: the client is closed, so nothing is sent and nothing is edited.
  await page.keyboard.down('KeyW');
  await page.evaluate(
    () =>
      new Promise((done) => {
        let n = 0;
        const step = () => (++n < 30 ? requestAnimationFrame(step) : done());
        requestAnimationFrame(step);
      }),
  );
  await page.keyboard.up('KeyW');
  assert.equal(await sent(), sentThen, 'nothing is sent after the idle close');
  // The rejoin path waits 0 to 3 s before it asks /join. Anything in this window is a rejoin; there is no event to wait
  // for when nothing should happen, so the test waits out the longest delay.
  await wait(3500); // fixed-wait: the longest rejoin delay is 3 s, and the test is that nothing happens in it
  assert.equal(router.joins, 1, 'no second ask of /join');
  assert.equal(loads, 0, 'no reload');
  assert.equal(await here(), true, 'the world is still shown');
  assert.match(await bannerText(), /You were idle/);
  router.answer = { url: `ws://127.0.0.1:${real.port}`, shard: 1, world: 'a' };
  await Promise.all([page.waitForEvent('load'), page.click('#banner button')]);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  assert.equal(router.joins, 2, 'Join asked /join once more');
  page.off('load', counted);
  console.log('ok idle close: world kept, nothing sent, no rejoin; Join reloads into the shard');

  // A server gone silent with its socket open (the pipe drops everything): the client's own 15 s silence limit closes with
  // 4408, which takes the /join path like any other close. /join says full, so the banner proves which path ran.
  const silentPipe = await tcpProxy(real.port);
  router.answer = { url: `ws://127.0.0.1:${silentPipe.port}`, shard: 1, world: 'a' };
  router.joins = 0;
  await open(`plaza=${routerUrl}&rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  assert.equal(router.joins, 1);
  router.answer = { full: true, online: 7 };
  silentPipe.pause();
  const silentSince = Date.now();
  // 15 s of silence, then the tries at resuming, each stuck in the same pipe for 5 s, up to 30 s.
  await banner(/Plaza is full, 7 people are in/, 90_000);
  assert.equal(router.joins, 2, '4408 asked /join');
  console.log(`ok a silent server with the socket open reached the banner after ${Date.now() - silentSince} ms`);

  // A hidden or busy page still answers pings, because the browser does, not the page's scripts. The server here pings
  // after 300 ms of silence and drops a player at 1.5 s. The debugger stops the page's JavaScript, so the page sends no
  // input at all; the player must stay for twice the limit. The same fixture then drops a player whose connection is cut.
  const pinger = await startShard(['--heartbeat=300', '--client-timeout=1500', '--resume-timeout=1000', '--watch']);
  await open(`server=ws://127.0.0.1:${pinger.port}&rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  const until = async (condition, what, ms = 20_000) => {
    for (const end = Date.now() + ms; !condition(); ) {
      assert.ok(Date.now() < end, `timed out waiting for ${what}`);
      await wait(40);
    }
  };
  await until(() => pinger.watch?.players === 1, 'one player');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  const before = pinger.watch.bytesIn;
  let seenAlone = 0;
  const stayUntil = Date.now() + 3600;
  // The window is time itself (more than twice clientTimeout), so it is waited out, checking the server's count on the way.
  while (Date.now() < stayUntil) {
    assert.equal(pinger.watch.players, 1, 'the paused page was dropped');
    seenAlone++;
    await wait(100); // fixed-wait: a window of 3.6 s the test measures against the server's 1.5 s limit
  }
  const pongs = pinger.watch.bytesIn - before;
  await cdp.send('Debugger.resume');
  await cdp.detach();
  assert.ok(pongs >= 6 * 3, `the browser answered pings on its own: ${pongs} bytes in ${seenAlone} looks`);
  assert.equal(await sandbox(() => !!window.voxelSandbox.online?.client.spawned), true, 'still connected after resume');
  assert.equal(await bannerText(), '');
  console.log(
    `ok a headless Edge page with stopped scripts answered pings for 3.6 s (${pongs} bytes of pongs), server limit 1.5 s`,
  );
  // Control: the same limit does drop a player whose network is cut.
  const cut = await tcpProxy(pinger.port);
  await open(`server=ws://127.0.0.1:${cut.port}&rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 60_000 });
  await until(() => pinger.watch.players === 1, 'the proxied player');
  cut.pause();
  await until(() => pinger.watch.players === 0, 'the server dropping a cut player', 10_000);
  console.log('ok control: a cut connection is dropped by the same server limit');
  await killTree(pinger.child);
  await killTree(real.child);

  // The router is down: solo with its banner.
  await page.goto('about:blank');
  await new Promise((done) => (routerServer.closeAllConnections(), routerServer.close(done)));
  cleanup.splice(
    cleanup.findIndex((c) => String(c).includes('routerServer')),
    1,
  );
  await open(`plaza=${routerUrl}&rd=2`);
  await banner(/Plaza is offline, building alone, retrying/);
  await alone();
  console.log('ok router down: solo');
  await killTree(shard.child);

  await phone();
}

// A dropped connection, as Cloudflare drops one every 15 minutes: the page stays, the player stays, and what changed in
// the gap arrives. A real shard behind a pipe the test cuts, and a router whose /join counts every ask.
async function rejoin() {
  const origin = `http://127.0.0.1:${port}/examples/voxel-sandbox/index.html`,
    router = { answer: undefined, joins: 0 },
    routerServer = createServer((request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      router.joins++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(router.answer));
    });
  await new Promise((done) => routerServer.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise((done) => (routerServer.closeAllConnections(), routerServer.close(done))));
  const shard = await startShard(),
    cdn = await tcpProxy(shard.port),
    open = async (url) => {
      router.answer = { url, shard: 1, world: 'a' };
      router.joins = 0;
      await page.goto(`${origin}?plaza=http://127.0.0.1:${routerServer.address().port}&rd=2`);
      await page.waitForFunction(() => window.voxelSandbox?.online?.client.loaded, null, { timeout: 120_000 });
    },
    banner = (source, timeout) =>
      page.waitForFunction(
        (text) => {
          const box = document.getElementById('banner');
          return !box.hidden && new RegExp(text).test(box.textContent);
        },
        source,
        { timeout },
      ),
    resumes = (count, timeout) =>
      page.waitForFunction((n) => window.voxelSandbox.online.client.stats.resumes === n, count, { timeout }),
    near = (a, b, what) => assert.ok(Math.hypot(...a.map((v, i) => v - b[i])) < 0.1, `${what}: ${a} against ${b}`);
  await open(`ws://127.0.0.1:${cdn.port}`);
  // Every text the banner shows from now on, and every load of the page.
  await page.evaluate(() => {
    window.banners = [];
    const box = document.getElementById('banner');
    new MutationObserver(() => box.hidden || window.banners.push(box.textContent)).observe(box, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  let loads = 0;
  const counted = () => loads++;
  page.on('load', counted);

  // A cut, and the first try gets through: nothing to see.
  let spot = await position();
  cdn.cut();
  await resumes(1, 10_000);
  near(await position(), spot, 'after a cut');
  assert.deepEqual(await sandbox(() => window.banners), [], 'no banner on a quick resume');
  console.log('ok a cut resumes in place with no banner');

  // A slow one: the way back stays shut for a while. The page says so, and another player's edit in the gap is there after.
  const { blocks } = defineBlocks(),
    bot = await VoxelBot.connect({
      url: `ws://127.0.0.1:${shard.port}`,
      blocks,
      name: 'Quiet Otter',
      view: 2,
      editInterval: 0,
    }),
    botLoop = setInterval(() => bot.update(0.05), 50);
  cleanup.push(() => {
    clearInterval(botLoop);
    bot.close();
  });
  // fixed-wait: polling a value in this process, which only a turn of the event loop can change
  while (!bot.client.spawned || !bot.client.loaded) await wait(50);
  const [bx, by, bz] = bot.client.player.position.map(Math.floor);
  let cell;
  for (let up = 3; !cell; up++) if (!bot.world.getBlock(bx + 2, by + up, bz)) cell = [bx + 2, by + up, bz];
  const bricks = blocks.id('bricks'),
    blockAt = (at) => sandbox((c) => window.voxelSandbox.world.getBlock(...c), at);
  assert.equal(await blockAt(cell), 0, 'the page has that air');
  spot = await position();
  cdn.refuse = true;
  cdn.cut();
  await banner('Reconnecting to Plaza', 10_000);
  assert.equal(bot.client.edit(...cell, bricks), true);
  await wait(500); // fixed-wait: a few server ticks, so that the edit lands while the player is away
  assert.equal(bot.world.getBlock(...cell), bricks, 'the server kept it');
  assert.equal(await blockAt(cell), 0, 'the page cannot know yet');
  cdn.refuse = false;
  await resumes(2, 30_000);
  await page.waitForFunction((c) => window.voxelSandbox.world.getBlock(c[0], c[1], c[2]) !== 0, cell, {
    timeout: 5000,
  });
  assert.equal(await blockAt(cell), bricks);
  assert.equal(await sandbox(() => document.getElementById('banner').hidden), true, 'the banner went');
  near(await position(), spot, 'after a slow resume');
  console.log('ok a slow resume shows the banner, clears it, and brings the edit made in the gap');

  // Half-open: nothing moves either way and neither end has noticed.
  spot = await position();
  cdn.cutSilent();
  await resumes(3, 40_000);
  near(await position(), spot, 'after a half-open connection');
  console.log('ok a half-open connection resumes at the client silence limit');

  assert.equal(loads, 0, 'the page never reloaded');
  assert.equal(router.joins, 1, 'and never asked /join again');

  // The shard itself dies: the tries run out, and the way back is today's, through /join and a reload.
  page.off('load', counted);
  const doomed = await startShard();
  await open(`ws://127.0.0.1:${doomed.port}`);
  router.answer = { url: `ws://127.0.0.1:${shard.port}`, shard: 1, world: 'a' };
  const reloaded = page.waitForEvent('load', { timeout: 60_000 });
  await killTree(doomed.child);
  await banner('Reconnecting to Plaza', 10_000);
  await banner('The connection dropped. Checking Plaza.|Rejoining Plaza.', 40_000);
  await reloaded;
  await page.waitForFunction(() => window.voxelSandbox?.online?.client.spawned, null, { timeout: 120_000 });
  assert.ok(router.joins >= 3, `${router.joins} asks of /join`);
  console.log('ok a dead shard falls back through /join and a reload');
  clearInterval(botLoop);
  await page.goto('about:blank');
  await killTree(shard.child);
}

// The order of loading. A slow GPU start must hold nothing else up: the code and /join go out while the adapter is still
// being asked for. On a slow connection the player may move before the far chunks arrive (they used to wait for all of
// them, once behind the socket's queue and once for the light to go quiet), with the ground drawn; figures come after that.
// ?timing shows the phases, and without it no panel and no timing code.
async function loadOrder() {
  const shard = await startShard(),
    pipe = await tcpProxy(shard.port, 60_000), // 480 kbit/s down: a view of 8 takes about 10 s
    asked = [],
    routerServer = createServer((request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('content-type', 'application/json');
      asked.push(performance.now());
      response.end(JSON.stringify({ url: `ws://127.0.0.1:${pipe.port}`, shard: 1, world: 'a' }));
    }),
    closeRouter = () => new Promise((done) => (routerServer.closeAllConnections(), routerServer.close(done)));
  await new Promise((done) => routerServer.listen(0, '127.0.0.1', done));
  cleanup.push(closeRouter);
  const browser = page.context().browser(),
    context2 = await browser.newContext({ viewport: { width: 960, height: 540 } }),
    tab = await context2.newPage(),
    requests = [];
  const closeContext = () => context2.close();
  cleanup.push(closeContext);
  tab.on('request', (request) => requests.push([request.url().replace(/\?.*$/, ''), performance.now()]));
  // The adapter answers late, at a moment the test chooses.
  await tab.addInitScript(() => {
    const ask = GPU.prototype.requestAdapter;
    window.__releaseAdapter = undefined;
    const gate = new Promise((done) => (window.__releaseAdapter = done));
    GPU.prototype.requestAdapter = async function (...args) {
      await gate;
      return ask.apply(this, args);
    };
  });
  const url = `http://127.0.0.1:${port}/examples/voxel-sandbox/index.html?plaza=http://127.0.0.1:${routerServer.address().port}&rd=8&timing`;
  await tab.goto(url, { waitUntil: 'domcontentloaded' });
  await tab.waitForResponse((r) => r.url().includes('/src/main.ts'), { timeout: 60_000 }).catch(() => {});
  assert.ok(
    requests.some(([name]) => name.endsWith('/src/main.ts')),
    'the game code is asked for while the WebGPU check waits',
  );
  await tab.evaluate(() => window.__releaseAdapter());
  await tab.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 });
  const atMove = await tab.evaluate(() => {
    const s = window.voxelSandbox,
      c = s.online.client,
      [x, y, z] = c.player.position;
    return {
      loaded: c.loaded,
      chunks: c.stats.chunks,
      meshed: s.voxels.stats.chunks,
      ground: !!s.world.getChunk(Math.floor(x) >> 5, Math.floor(y - 2) >> 5, Math.floor(z) >> 5),
      overlay: document.getElementById('overlay').dataset.state,
      marks: s.timing.read().marks,
    };
  });
  assert.equal(atMove.loaded, false, `the player can move with chunks still to come (${atMove.chunks} here)`);
  assert.ok(atMove.ground, 'the ground under the player is in the world');
  assert.ok(atMove.meshed > 0, 'and something is drawn');
  assert.equal(atMove.overlay, 'paused', 'the prompt to play shows');
  // The figures wait until the spawn: asked for at or after the first chunks, not beside the ground.
  const figuresAt = requests.findIndex(([name]) => /figures/.test(name));
  assert.ok(figuresAt >= 0, 'the figures were asked for');
  await tab.waitForFunction(() => /CAN MOVE +\d/.test(document.getElementById('timing').textContent));
  assert.ok(atMove.marks.join < atMove.marks.engine, 'the /join answer came before the engine was ready');
  assert.ok(atMove.marks.spawn <= atMove.marks.move);
  assert.ok(
    requests.some(([name]) => /mesher/.test(name) && name),
    'the mesher started',
  );
  const before = await tab.evaluate(() => window.voxelSandbox.player.position.slice());
  await tab.mouse.click(480, 270);
  await tab.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 5000 });
  await tab.keyboard.down('KeyW');
  await tab.keyboard.down('Space');
  await tab.waitForFunction(
    (from) => Math.hypot(...window.voxelSandbox.online.client.player.position.map((v, i) => v - from[i])) > 1,
    before,
    { timeout: 15_000 },
  );
  await tab.keyboard.up('KeyW');
  await tab.keyboard.up('Space');
  assert.equal(
    await tab.evaluate(() => window.voxelSandbox.online.client.loaded),
    false,
    'walked before the far chunks',
  );
  console.log(
    `ok moved at ${(atMove.marks.move / 1000).toFixed(2)} s with ${atMove.chunks} chunks, ground drawn, far chunks still coming`,
  );

  // Without the option: no panel, no timing code.
  const plainRequests = [];
  page.on('request', (request) => plainRequests.push(request.url()));
  await page.goto(`http://127.0.0.1:${port}/examples/voxel-sandbox/index.html?rd=2`);
  await page.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 });
  assert.equal(await page.evaluate(() => !!document.getElementById('timing') || !!window.voxelSandbox.timing), false);
  assert.ok(!plainRequests.some((u) => /timing/.test(u)), 'the timing code was not downloaded');
  console.log('ok no panel and no timing code without ?timing');
  await closeContext();
  await closeRouter();
  for (const done of [closeContext, closeRouter]) cleanup.splice(cleanup.indexOf(done), 1);
  await killTree(shard.child);
}

// A phone: its user agent, screen and touch events (Chromium's own emulation, on this PC's GPU).
async function phone() {
  const browser = page.context().browser(),
    device = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    }),
    tab = await device.newPage(),
    requests = [];
  cleanup.push(() => device.close());
  tab.setDefaultTimeout(30_000);
  tab.on('request', (request) => requests.push(request.url()));
  tab.on('pageerror', (e) => errors.push(`phone pageerror: ${e.message}`));
  tab.on('console', (m) => {
    if (m.type() === 'error') errors.push(`phone console: ${m.text()}`);
  });
  const cdp = await device.newCDPSession(tab),
    touch = (type, ...points) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id = 1]) => ({ x, y, id })) });
  await tab.goto(`http://127.0.0.1:${port}/examples/voxel-sandbox/index.html?photo`);
  await tab.waitForFunction(() => window.voxelSandbox?.spawned, null, { timeout: 120_000 });
  await tab.waitForFunction(() => window.voxelSandbox.voxels.stats.draws > 0, null, { timeout: 60_000 });
  const state = await tab.evaluate(() => {
    const s = window.voxelSandbox,
      stats = s.stats();
    return { tier: stats.tier, distance: stats.distance, shadows: !!s.scene.shadows, photo: !!s.photo };
  });
  assert.deepEqual(state, { tier: 'phone', distance: 4, shadows: false, photo: false });
  console.log('ok phone tier draws: view 4, no shadows, the tracer refused');

  // Layout on the phone's screen.
  const layout = await tab.evaluate(() => {
    const box = (e) => e.getBoundingClientRect(),
      shown = (e) => !e.hidden && getComputedStyle(e).display !== 'none',
      targets = [...document.querySelectorAll('#touch-buttons button, #hotbar .slot')].filter(shown);
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      canvasTouch: getComputedStyle(document.getElementById('scene')).touchAction,
      bodyTouch: getComputedStyle(document.body).touchAction,
      small: targets.filter((e) => box(e).width < 44 || box(e).height < 44).map((e) => e.id || e.title),
      offscreen: targets.filter((e) => box(e).left < 0 || box(e).right > innerWidth).map((e) => e.id || e.title),
      slots: document.querySelectorAll('#hotbar .slot:not([hidden])').length,
    };
  });
  assert.equal(layout.overflow, 0, 'no horizontal scroll');
  assert.equal(layout.canvasTouch, 'none');
  assert.equal(layout.bodyTouch, 'auto');
  assert.deepEqual(layout.small, []);
  assert.deepEqual(layout.offscreen, []);
  assert.ok(layout.slots >= 5);
  console.log(`ok the layout fits 390 px: ${layout.slots} slots, every target at least 44 px`);

  // Before play: every control explained, on screen, and "Tap to play".
  const shots = process.env.PLAZA_SHOTS,
    instructions = async () => {
      const seen = await tab.evaluate(() => {
        const list = document.querySelector('.touch-help'),
          box = list.getBoundingClientRect(),
          overlay = document.getElementById('overlay');
        return {
          overlay: !overlay.hidden,
          state: overlay.dataset.state,
          play: overlay.querySelector('.play').textContent,
          playShown: getComputedStyle(overlay.querySelector('.play')).display !== 'none',
          help: list.textContent,
          text: overlay.textContent,
          keysShown: getComputedStyle(overlay.querySelector('dl:not(.touch-help)')).display !== 'none',
          fits: box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
          size: parseFloat(getComputedStyle(list).fontSize),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.ok(seen.overlay && seen.playShown, `the overlay and its prompt show: ${JSON.stringify(seen.state)}`);
      assert.equal(seen.play, 'Tap to play');
      assert.equal(seen.keysShown, false, 'no keyboard list on a phone');
      assert.ok(seen.fits, 'the instructions are on screen');
      assert.ok(seen.size >= 16, `instructions at ${seen.size} px`);
      assert.equal(seen.overflow, 0);
      for (const word of [/walk/, /look/, /Jump/, /Fly/, /place/, /break/, /choose a block/])
        assert.match(seen.help, word);
      assert.doesNotMatch(seen.text, /Click to play|[–—]/);
    };
  if (shots) await tab.screenshot({ path: `${shots}/phone-before-play.png` });
  await instructions();
  console.log('ok a phone sees the instructions and "Tap to play" before play');

  // Tap past the overlay.
  await tab.touchscreen.tap(195, 420);
  await tab.waitForFunction(() => window.voxelSandbox.touch.active);
  assert.equal(await tab.evaluate(() => document.getElementById('overlay').hidden), true);
  await tab.screenshot({ path: 'test-results/plaza-phone.png' });

  // The help button reopens them, and a tap plays on: nothing stuck, the stick still walks.
  const box = (selector) =>
      tab.evaluate((s) => {
        const e = document.querySelector(s);
        if (!e || e.hidden || getComputedStyle(e).display === 'none') return null;
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      }, selector),
    overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
    bigEnough = (b, name) => assert.ok(b && b.width >= 44 && b.height >= 44, `${name}: ${JSON.stringify(b)}`);
  bigEnough(await box('#help'), 'help');
  await tab.touchscreen.tap(...(await centre(tab, '#help')));
  await tab.waitForFunction(() => !document.getElementById('overlay').hidden);
  assert.equal(await tab.evaluate(() => window.voxelSandbox.touch.active), false);
  assert.equal(await box('#help'), null, 'no help button over the help');
  await instructions();
  await tab.touchscreen.tap(195, 420);
  await tab.waitForFunction(() => window.voxelSandbox.touch.active);
  assert.equal(await tab.evaluate(() => document.getElementById('overlay').hidden), true);
  console.log('ok the help button reopens the instructions and a tap plays on');

  // The frame rate shows; a tap opens the full HUD and closes it; neither blocks the hotbar or the buttons.
  await tab.waitForFunction(() => /^\d+ FPS$/.test(document.getElementById('fps').textContent));
  bigEnough(await box('#fps'), 'fps');
  const hudShown = () => tab.evaluate(() => getComputedStyle(document.getElementById('hud')).display !== 'none');
  assert.equal(await hudShown(), false, 'the HUD starts closed');
  await tab.touchscreen.tap(...(await centre(tab, '#fps')));
  await tab.waitForFunction(() => getComputedStyle(document.getElementById('hud')).display !== 'none');
  const hudBox = await box('#hud'),
    hudStyle = await tab.evaluate(() => getComputedStyle(document.getElementById('hud')).pointerEvents);
  assert.equal(hudStyle, 'none', 'the HUD lets touches through');
  assert.ok(hudBox.right <= 390, `the HUD fits the width: ${hudBox.right}`);
  for (const other of ['#hotbar', '#fps', '#help', '#touch-jump', '#touch-fly'])
    assert.equal(overlap(hudBox, await box(other)), false, `the HUD is clear of ${other}`);
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  if (shots) await tab.screenshot({ path: `${shots}/phone-hud.png` });
  await tab.touchscreen.tap(...(await centre(tab, '#fps')));
  await tab.waitForFunction(() => getComputedStyle(document.getElementById('hud')).display === 'none');
  assert.equal(await tab.evaluate(() => window.voxelSandbox.touch.active), true, 'still playing');
  // A banner over the top of the screen moves them out of its way.
  const bannerOver = await tab.evaluate(() => {
    const b = document.getElementById('banner');
    b.hidden = false;
    b.querySelector('span').textContent = 'Plaza is full, 400 people are in, building alone, retrying';
    b.querySelector('button').hidden = false;
    return true;
  });
  assert.ok(bannerOver);
  const bannerBox = await box('#banner');
  for (const other of ['#fps', '#help'])
    assert.equal(overlap(bannerBox, await box(other)), false, `banner over ${other}`);
  await tab.evaluate(() => {
    document.getElementById('banner').hidden = true;
  });
  if (shots) await tab.screenshot({ path: `${shots}/phone-playing.png` });
  console.log('ok a phone has a frame rate; a tap opens and closes the HUD, clear of the controls');

  // P is refused with a toast, not a crash.
  await tab.keyboard.press('KeyP');
  await tab.waitForFunction(() => /desktop GPU/.test(document.getElementById('toast').textContent));
  assert.ok(!requests.some((url) => /photo\.ts|voxel-pathtracer/.test(url)), 'the tracer was not downloaded');

  // The stick walks; a second finger can look at the same time.
  const from = await tab.evaluate(() => [...window.voxelSandbox.player.position]);
  await touch('touchStart', [90, 600]);
  await touch('touchMove', [90, 500]);
  await tab.waitForFunction(() => window.voxelSandbox.touch.stick.y > 0.9);
  await touch('touchStart', [90, 500, 1], [300, 300, 2]);
  await touch('touchMove', [90, 500, 1], [340, 300, 2]);
  await tab.waitForFunction(
    (start) => Math.hypot(...window.voxelSandbox.player.position.map((v, i) => v - start[i])) > 0.8,
    from,
    { timeout: 15_000 },
  );
  await touch('touchEnd');
  await tab.waitForFunction(() => window.voxelSandbox.touch.stick.y === 0);
  console.log('ok the stick walks, with a second finger looking');

  // Look: a drag on the right half turns the view, down at the ground.
  const yaw0 = await tab.evaluate(() => window.voxelSandbox.look.yaw);
  await touch('touchStart', [300, 300]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [300 - i * 5, 300 + i * 40]);
  await touch('touchEnd');
  const look = await tab.evaluate(() => window.voxelSandbox.look);
  assert.ok(look.yaw !== yaw0, 'the drag turned the view');
  assert.ok(look.pitch < -1.5, `looking down, pitch ${look.pitch}`);
  console.log('ok the right half looks');

  // A hold breaks the block under the crosshair.
  await tab.waitForFunction(() => window.voxelSandbox.target);
  const cell = await tab.evaluate(() => [...window.voxelSandbox.target.cell]);
  await touch('touchStart', [300, 400]);
  await tab.waitForFunction((c) => window.voxelSandbox.world.getBlock(...c) === 0, cell, { timeout: 5000 });
  await touch('touchEnd');
  console.log('ok a 400 ms press breaks');
  // Jump and fly: real buttons.
  await tab.touchscreen.tap(...(await centre(tab, '#touch-fly')));
  await tab.waitForFunction(() => window.voxelSandbox.player.flying);
  assert.equal(await tab.evaluate(() => document.getElementById('touch-down').hidden), false);
  const flying = await tab.evaluate(() => window.voxelSandbox.player.position[1]),
    [jx, jy] = await centre(tab, '#touch-jump');
  await touch('touchStart', [jx, jy]);
  await tab.waitForFunction((y) => window.voxelSandbox.player.position[1] > y + 2.5, flying, { timeout: 10_000 });
  await touch('touchEnd');
  console.log('ok fly and jump buttons');

  // The down button, until the ground is in reach: the placed block then cannot touch the player.
  const [dx, dy] = await centre(tab, '#touch-down');
  await touch('touchStart', [dx, dy]);
  await tab.waitForFunction(() => window.voxelSandbox.target, null, { timeout: 15_000, polling: 'raf' });
  await touch('touchEnd');
  const adjacent = await tab.evaluate(() => [...window.voxelSandbox.target.adjacent]);
  await touch('touchStart', [300, 400]);
  await touch('touchEnd');
  await tab.waitForFunction((c) => window.voxelSandbox.world.getBlock(...c) !== 0, adjacent, { timeout: 5000 });
  console.log('ok a tap places');

  // Hotbar: a swipe moves the selection.
  const slot0 = await tab.evaluate(() => document.querySelector('#hotbar .selected').dataset.slot),
    [hx, hy] = await centre(tab, '#hotbar');
  await touch('touchStart', [hx, hy]);
  await touch('touchMove', [hx - 50, hy]);
  await touch('touchMove', [hx - 100, hy]);
  await touch('touchEnd');
  const slot1 = await tab.evaluate(() => document.querySelector('#hotbar .selected').dataset.slot);
  assert.equal(Number(slot1), Number(slot0) + 2);
  console.log('ok a hotbar swipe chooses a block');
  await tab.screenshot({ path: 'test-results/plaza-phone-playing.png' });
  await device.close();
  cleanup.pop();
}

async function centre(on, selector) {
  const box = await on.locator(selector).boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}

// A shard in its own process, so a kill is a real kill. `flags` go to the fixture (--heartbeat, --client-timeout,
// --watch); `watch` holds the newest {players, bytesIn} it printed.
async function startShard(flags = []) {
  const child = spawn(process.execPath, ['examples/voxel-sandbox/test/shard-fixture.mjs', ...flags], {
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
    shard = { child, port: 0, watch: undefined };
  cleanup.push(() => killTree(child));
  shard.port = await new Promise((done, fail) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const lines = text.split('\n');
      text = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.watch) shard.watch = message.watch;
        else if (message.port) done(message.port);
      }
    });
    child.once('exit', (code) => fail(new Error(`The shard fixture exited with ${code}`)));
  });
  return shard;
}

// A TCP pipe in front of a shard that the test can cut. `cut`, `cutSilent` and `refuse` are for one connection's end and
// the way back; `pause` drops everything both ways and keeps the socket open (a
// network that died without a close). `injectClose` sends the browser a WebSocket close frame as if the server had sent
// it, then pauses, so the real server's later bytes do not follow it.
async function tcpProxy(target, bytesPerSecond = 0) {
  const sockets = new Set(),
    pairs = [],
    pipe = { paused: false, refuse: false, port: 0, last: undefined },
    server = createTcpServer((client) => {
      if (pipe.refuse) return client.destroy();
      const upstream = createConnection(target, '127.0.0.1'),
        pair = { client, upstream, silent: false };
      pairs.push(pair);
      sockets.add(client).add(upstream);
      pipe.last = client;
      client.on('data', (data) => pipe.paused || pair.silent || upstream.write(data));
      if (bytesPerSecond) {
        // Down, at a fixed rate: the socket's queue stays here, as it would on the slow link.
        const queue = [];
        const pump = setInterval(() => {
          let room = bytesPerSecond / 50;
          while (queue.length && room > 0) {
            const part = queue[0].subarray(0, room);
            room -= part.length;
            if (!pipe.paused && client.writable) client.write(part);
            queue[0] = queue[0].subarray(part.length);
            if (!queue[0].length) queue.shift();
          }
        }, 20);
        client.on('close', () => clearInterval(pump));
        upstream.on('data', (data) => queue.push(data));
      } else upstream.on('data', (data) => pipe.paused || pair.silent || client.write(data));
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ]) {
        a.on('error', () => b.destroy());
        a.on('close', () => b.destroy());
      }
    });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  pipe.port = server.address().port;
  pipe.pause = () => (pipe.paused = true);
  // A FIN to both ends of what is open now: what Cloudflare does.
  pipe.cut = () => {
    for (const { client, upstream } of pairs.splice(0)) {
      client.end();
      upstream.end();
    }
  };
  // What is open now goes silent and stays open; a new connection works.
  pipe.cutSilent = () => {
    for (const pair of pairs.splice(0)) pair.silent = true;
  };
  pipe.injectClose = (code, reason) => {
    const text = Buffer.from(reason);
    pipe.paused = true;
    pipe.last.end(Buffer.concat([Buffer.from([0x88, text.length + 2, code >> 8, code & 255]), text]));
  };
  cleanup.push(
    () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      }),
  );
  return pipe;
}

// Plaza edits on the real page: a local router and shard, the real mouse. Outside the square an edit stays; on it the page
// sends nothing, changes nothing (not even for a frame) and says why, once in NOTICE_EVERY; an edit the server refuses
// for any other reason is put back and the page says so; the HUD shows the world's seed.
async function plazaEdits() {
  const [routerPort, shardPort] = [await freePort(), await freePort()],
    data = mkdtempSync(join(tmpdir(), 'plaza-edits-')),
    router = spawn(
      process.execPath,
      [
        'examples/voxel-sandbox/server/router.mjs',
        `--data=${data}`,
        `--port=${routerPort}`,
        `--shard-port=${shardPort}`,
        '--origins=*',
      ],
      { stdio: 'ignore' },
    );
  cleanup.push(async () => {
    await killTree(router);
    rmSync(data, { recursive: true, force: true });
  });
  for (let tries = 0; ; tries++) {
    const answer = await fetch(`http://127.0.0.1:${routerPort}/join`).then(
      (r) => r.json(),
      () => ({}),
    );
    if (answer.url) break;
    assert.ok(tries < 120, 'the router never found a shard');
    // fixed-wait: polling the router, which has no event for its first shard being ready
    await new Promise((done) => setTimeout(done, 500));
  }
  const tab = page,
    ev = (f, arg) => tab.evaluate(f, arg),
    pause = (ms) => tab.waitForTimeout(ms);
  await tab.goto(
    `http://127.0.0.1:${port}/examples/voxel-sandbox/index.html?plaza=http://127.0.0.1:${routerPort}&rd=2`,
  );
  await tab.waitForFunction(
    () => window.voxelSandbox?.spawned && window.voxelSandbox.online?.client.welcome && window.voxelSandbox.plazaWorld,
    null,
    { timeout: 120_000 },
  );
  const { seed, floor } = await ev(() => window.voxelSandbox.plazaWorld),
    hud = await ev(() => document.getElementById('hud').textContent);
  assert.ok(hud.includes(`seed ${seed} `), `the HUD shows the world's seed ${seed}: ${hud}`);
  console.log(`ok the HUD shows the world's seed ${seed}`);

  await tab.mouse.click(480, 270);
  await tab.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 5000 });
  // What the page sent, what the toast said, and every write to a watched cell.
  await ev(() => {
    const s = window.voxelSandbox,
      client = s.online.client,
      send = client.edit.bind(client);
    window.__sent = [];
    client.edit = (x, y, z, state) => {
      const ok = send(x, y, z, state);
      window.__sent.push({ x, y, z, state, ok });
      return ok;
    };
    window.__toasts = [];
    const toastBox = document.getElementById('toast');
    new MutationObserver(() => {
      if (toastBox.textContent) window.__toasts.push(toastBox.textContent);
    }).observe(toastBox, { childList: true, characterData: true, subtree: true });
    window.__watches = new Map();
    window.__watch = (name, cell) => {
      const world = s.world,
        set = world.setBlock.bind(world),
        key = cell.join(','),
        seen = new Set([world.getBlock(...cell)]),
        writes = [];
      let running = true;
      world.setBlock = (x, y, z, state) => {
        if (`${x},${y},${z}` === key) writes.push(state);
        return set(x, y, z, state);
      };
      const sample = () => {
        seen.add(world.getBlock(...cell));
        if (running) requestAnimationFrame(sample);
      };
      sample();
      window.__watches.set(name, () => {
        running = false;
        world.setBlock = set;
        return { writes, seen: [...seen] };
      });
    };
    window.__unwatch = (name) => window.__watches.get(name)();
  });
  const state = (cell) => ev((c) => window.voxelSandbox.world.getBlock(...c), cell),
    target = () =>
      ev(() => {
        const t = window.voxelSandbox.target;
        return t && { cell: [...t.cell], adjacent: [...t.adjacent] };
      }),
    pos = () => ev(() => [...window.voxelSandbox.player.position]),
    sentCount = () => ev(() => window.__sent.length),
    toasts = () => ev(() => [...window.__toasts]),
    click = async (button) => {
      await tab.mouse.down({ button });
      await pause(40);
      await tab.mouse.up({ button });
    };
  let mouseX = 480,
    mouseY = 270;
  // A locked mouse turns the view by its movement: 0.0024 rad per pixel (a move left turns left, a move up looks up).
  const turn = async (yaw, pitch) => {
    const look = await ev(() => ({ ...window.voxelSandbox.look }));
    mouseX += (look.yaw - yaw) / 0.0024;
    mouseY += (look.pitch - pitch) / 0.0024;
    await tab.mouse.move(mouseX, mouseY);
    await pause(150);
  };
  // Every edit the page sent, the last for its cell, must stand.
  const fallen = () =>
    ev(() => {
      const last = new Map();
      for (const e of window.__sent) if (e.ok) last.set(`${e.x},${e.y},${e.z}`, e);
      return [...last.values()].filter((e) => window.voxelSandbox.world.getBlock(e.x, e.y, e.z) !== e.state);
    });

  // Outside the square: a break and a place stay, with no word from the page.
  // The first steepness that has a block in reach (a spawn at a shore may have none ahead).
  const aimDown = async () => {
    for (const pitch of [-0.7, -1, -1.3, -1.5]) {
      await turn(await ev(() => window.voxelSandbox.look.yaw), pitch);
      const hit = await target();
      if (hit) return hit;
    }
    return null;
  };
  const ahead = await aimDown();
  assert.ok(ahead, 'ground ahead');
  assert.ok(!isPlazaProtected(...ahead.cell, floor), 'the spawn is outside the square');
  await click('left');
  await pause(1500);
  assert.equal(await state(ahead.cell), 0, `the break of ${ahead.cell} stays`);
  await tab.keyboard.press('Digit1');
  const face = await aimDown();
  assert.ok(face, 'a face to place against');
  await click('right');
  await pause(1500);
  assert.notEqual(await state(face.adjacent), 0, `the block placed at ${face.adjacent} stays`);
  assert.deepEqual(await toasts(), [], 'nothing to say outside the square');
  console.log('ok outside the square a break and a place stay');

  // A held button (REPEAT 0.22 s), then a slow stream of clicks: every edit sent stands.
  for (const button of ['right', 'left']) {
    await tab.mouse.down({ button });
    await pause(1600);
    await tab.mouse.up({ button });
  }
  // Aiming again each time: what the held buttons left in front of the player depends on the seed, and a click at nothing
  // sends nothing.
  // Eight clicks, each at a block in reach, so each sends one edit; the test then waits until the page has sent them
  // all (no repeat until a count is reached).
  const sentBeforeClicks = await sentCount();
  for (let i = 0; i < 8; i++) {
    assert.ok(await aimDown(), 'a block in reach');
    await click(i % 2 ? 'right' : 'left');
    await pause(700);
  }
  await tab.waitForFunction((n) => window.__sent.length >= n, sentBeforeClicks + 8, { timeout: 10_000 });
  await pause(1500);
  const edits = await sentCount();
  assert.ok(edits >= 8, `the held buttons and the clicks sent ${edits} edits`);
  assert.deepEqual(await fallen(), [], 'every edit stands');
  assert.deepEqual(await toasts(), [], 'still nothing to say');
  console.log(`ok a held button and a slow stream: ${edits} edits, all stand, no notice`);

  // An edit the shard refuses for another reason (too fast: 5 in a burst, 10 a second): put back, and the page says so.
  // Cells of air around and over the player: the world's seed and the spawn are new each run, and a tree or an earlier
  // block in a cell is refused for that reason, using up the burst the test counts.
  const [px, py, pz] = (await pos()).map(Math.floor),
    cells = [];
  for (let up = 2; up <= 4; up++)
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        if (cells.length < 25 && (await state([px + dx, py + up, pz + dz])) === 0)
          cells.push([px + dx, py + up, pz + dz]);
  assert.equal(cells.length, 25, 'enough air around the player');
  const brick = await ev(() => window.voxelSandbox.world.blocks.id('bricks')),
    sentBefore = await sentCount();
  assert.ok(isPlazaProtected(...cells[0], floor) === false, 'the cells over the spawn are outside the square');
  const accepted = await ev(
    ([cs, state]) => cs.filter(([x, y, z]) => window.voxelSandbox.edit(x, y, z, state)).length,
    [cells, brick],
  );
  assert.equal(accepted, cells.length, 'the page sends them all');
  await pause(2500);
  const kept = [];
  for (const c of cells) if ((await state(c)) === brick) kept.push(c);
  assert.ok(
    kept.length >= 5 && kept.length < cells.length,
    `the shard keeps the burst and refuses the rest (${kept.length})`,
  );
  assert.ok((await toasts()).includes(REFUSED_MESSAGE), 'the page says the change did not go through');
  console.log(`ok a burst of ${cells.length}: ${kept.length} kept, the rest put back, and the page says so`);
  assert.ok((await sentCount()) > sentBefore);
  await ev(() => window.__toasts.splice(0));
  await pause(NOTICE_EVERY);

  // Over the square: fly up above the hills and the sign wall, over the middle of it, and down to about 4 blocks above its floor.
  await tab.keyboard.press('KeyF');
  await tab.keyboard.down('Space');
  await tab.waitForFunction((y) => window.voxelSandbox.player.position[1] > y, floor + PLAZA_WALL_TOP + 3, {
    timeout: 60_000,
  });
  await tab.keyboard.up('Space');
  const [x0, , z0] = await pos(),
    toOrigin = Math.atan2(x0, z0);
  await turn(toOrigin, 0);
  await tab.keyboard.down('KeyW');
  await tab.waitForFunction(
    () => Math.hypot(window.voxelSandbox.player.position[0], window.voxelSandbox.player.position[2]) < 10,
    null,
    { timeout: 30_000 },
  );
  await tab.keyboard.up('KeyW');
  await tab.keyboard.down('KeyC');
  await tab.waitForFunction((y) => window.voxelSandbox.player.position[1] < y, floor + 4.2, { timeout: 30_000 });
  await tab.keyboard.up('KeyC');
  await pause(800);
  await turn(toOrigin, -1.5);
  const onSquare = await target();
  assert.ok(onSquare, 'the square under the crosshair');
  assert.ok(isPlazaProtected(...onSquare.cell, floor), `${onSquare.cell} is on the square`);
  assert.ok(isPlazaProtected(...onSquare.adjacent, floor), `${onSquare.adjacent} is on the square`);
  await ev(() => window.__toasts.splice(0)); // the 'Flying' and 'Walking' toasts
  const original = await state(onSquare.cell);
  assert.notEqual(original, 0);
  await ev(
    ([a, b]) => {
      window.__watch('cell', a);
      window.__watch('above', b);
    },
    [onSquare.cell, onSquare.adjacent],
  );
  const sentOnSquare = await sentCount();
  await click('left');
  await pause(1500);
  assert.deepEqual(await toasts(), [PROTECTED_MESSAGE], 'the break on the square is explained');
  await tab.keyboard.press('Digit1');
  await click('right');
  await pause(1500);
  const cell = await ev(() => window.__unwatch('cell')),
    above = await ev(() => window.__unwatch('above'));
  assert.deepEqual(cell, { writes: [], seen: [original] }, 'the block never changed, not for a frame');
  assert.deepEqual(above, { writes: [], seen: [0] }, 'nothing appeared above it, not for a frame');
  assert.equal(await sentCount(), sentOnSquare, 'nothing was sent to the shard');
  assert.equal((await toasts()).filter((t) => t === PROTECTED_MESSAGE).length, 1, 'one notice, not one per click');
  console.log('ok on the square nothing changes, nothing is sent, and the page says why once');

  // A held button on the square: one notice, not one per repeat; and the next comes once its interval is over.
  await pause(NOTICE_EVERY);
  await ev(() => window.__toasts.splice(0));
  await tab.mouse.down({ button: 'left' });
  await pause(NOTICE_EVERY - 600);
  await tab.mouse.up({ button: 'left' });
  assert.deepEqual(await toasts(), [PROTECTED_MESSAGE], 'a held button gives one notice inside the interval');
  await pause(1000);
  await click('left');
  assert.deepEqual(await toasts(), [PROTECTED_MESSAGE, PROTECTED_MESSAGE], 'and the next one after it');
  assert.equal(await sentCount(), sentOnSquare, 'still nothing was sent');
  console.log('ok a held button on the square repeats the notice no faster than its interval');
}
