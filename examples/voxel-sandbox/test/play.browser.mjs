// Real-GPU play test of the voxel sandbox in headless Edge: spawn on dry ground, pointer lock, fly up and forward,
// land, break the block under the crosshair, place stone, swim in the lake, change the render distance, and find the
// placed block again after a reload (IndexedDB save). Then Plaza: a second client's figure and name tag on a local shard,
// the banner and solo world on every failure (server killed, no welcome, router full or down, a world's end), the room
// retry, a report, and a phone run on real touch events. Run from the repository root after `npm run build:packages`,
// holding the GPU lock: node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';
import { VoxelBot } from '@margoengine/voxel-net/bot';
import { freePort, openBrowser } from '../../../scripts/browser.js';
import { killTree } from '../../../scripts/support/shutdown.mjs';
import { defineBlocks } from '../src/blocks.ts';

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

  await plaza();
  assert.deepEqual(
    errors.filter((e) => !NETWORK_ERROR.test(e)),
    [],
  );
  console.log('voxel sandbox play test passed');
} finally {
  await context.close();
  for (const close of cleanup.reverse()) await close();
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
  await page.waitForFunction(async () => (await window.voxelSandbox.figures.crowd.readCount()) >= 6, null, {
    timeout: 15_000,
    polling: 200,
  });
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

  // The server is killed: the banner within 5 s, then a playable solo world.
  clearInterval(botLoop);
  const killed = Date.now();
  await killTree(shard.child);
  await banner(/building alone/, 5000);
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
      if (request.url.endsWith('/join')) {
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

  // Tap past the overlay.
  await tab.touchscreen.tap(195, 420);
  await tab.waitForFunction(() => window.voxelSandbox.touch.active);
  assert.equal(await tab.evaluate(() => document.getElementById('overlay').hidden), true);
  await tab.screenshot({ path: 'test-results/plaza-phone.png' });

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

// A shard in its own process, so a kill is a real kill.
async function startShard() {
  const child = spawn(process.execPath, ['examples/voxel-sandbox/test/shard-fixture.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanup.push(() => killTree(child));
  const port = await new Promise((done, fail) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = /"port":(\d+)/.exec(text);
      if (match) done(Number(match[1]));
    });
    child.once('exit', (code) => fail(new Error(`The shard fixture exited with ${code}`)));
  });
  return { child, port };
}
