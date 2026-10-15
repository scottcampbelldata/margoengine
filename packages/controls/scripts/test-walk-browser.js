// Real-browser WalkControls check (GPU, not in verify): node scripts/gpu-lock.mjs run --owner=<id> -- npm run test:browser:walk --workspace packages/controls
// Desktop: the generated two-storey house walked with the real W key along its scripted path (deck, door, rug, doorway,
// 16 stairs, upper floor), a screenshot at every waypoint, the capsule's clearance from every box and the glass pane
// checked each frame, then the dollhouse view and back. Phone (390 x 844, touch): thumbstick walk and drag-look.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url)), results = resolve(root, 'test-results/walk');
await mkdir(results, {recursive: true});
const server = await createServer({configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: {port: 0}});
await server.listen();
const url = `${server.resolvedUrls.local[0]}tests/walk.html`, report = {checks: []};
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge', args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});
  const errors = [];
  const open = async options => {
    const page = await browser.newPage(options);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto(url); await page.waitForFunction(() => window.walkReady === true, null, {timeout: 60_000});
    return page;
  };

  const page = await open({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  assert.equal(await page.evaluate(() => window.walkState.backend), 'webgpu');
  await page.keyboard.down('KeyW');
  const shots = [];
  for (let waypoint = 1; waypoint < 9; waypoint++) {
    await page.waitForFunction(() => window.walkState.paused, null, {timeout: 60_000});
    const view = await page.evaluate(() => window.inspect());
    await page.screenshot({path: resolve(results, `waypoint-${waypoint}.png`)});
    shots.push(view);
    assert.ok(view.dominant < 0.97, `waypoint ${waypoint}: the view is not one flat colour (${view.dominant})`);
    if (waypoint < 8) await page.evaluate(() => window.resume());
  }
  await page.keyboard.up('KeyW');
  const walk = await page.evaluate(() => window.summary());
  assert.equal(walk.reached.length, 8, 'every waypoint reached');
  assert.ok(Math.abs(walk.reached.at(-1).eye[1] - (3 + 1.65)) < 0.01, `eye height upstairs: ${walk.reached.at(-1).eye[1]}`);
  assert.ok(walk.worstClearance >= 0.24, `capsule clearance from walls, stairs and glass: ${walk.worstClearance}`);
  assert.ok(walk.maxEyeStepPerFrame < 0.06, `no teleporting: ${walk.maxEyeStepPerFrame}`);
  report.walk = {...walk, shots};
  report.checks.push(`Walked deck -> door -> rug -> doorway -> 16 stairs -> upper floor with the real W key in ${walk.frames} frames; worst capsule clearance ${walk.worstClearance.toFixed(4)} m (radius 0.25), largest eye change per frame ${walk.maxEyeStepPerFrame.toFixed(4)} m`);
  const out = await page.evaluate(() => window.mode('dollhouse'));
  assert.equal(out.mode, 'dollhouse'); assert.ok(out.orbit);
  await page.screenshot({path: resolve(results, 'dollhouse.png')});
  const dollhouse = await page.evaluate(() => window.inspect());
  const back = await page.evaluate(() => window.mode('walk'));
  assert.equal(back.mode, 'walk'); assert.ok(!back.orbit);
  assert.ok(Math.hypot(...back.eye.map((v, i) => v - walk.reached.at(-1).eye[i])) < 0.05, 'back at the walk pose');
  await page.screenshot({path: resolve(results, 'back-to-walk.png')});
  report.checks.push(`Dollhouse view and back to the walk pose (dollhouse dominant colour share ${dollhouse.dominant.toFixed(3)})`);

  const phone = await open({viewport: {width: 390, height: 844}, deviceScaleFactor: 3, isMobile: true, hasTouch: true});
  const touch = await phone.evaluate(() => window.touch());
  await phone.screenshot({path: resolve(results, 'phone.png')});
  assert.ok(touch.stickShown, 'the floating thumbstick is drawn'); assert.ok(touch.walked > 1, `thumbstick walks: ${touch.walked} m`);
  assert.ok(Math.abs(touch.turned - 40 * 0.005) < 1e-6, `drag-look turns 0.005 rad per px: ${touch.turned}`);
  report.phone = touch;
  report.checks.push(`Phone: left-half thumbstick walked ${touch.walked.toFixed(2)} m in 1.5 s, right-half drag turned ${touch.turned.toFixed(3)} rad`);

  report.errors = [...errors, ...walk.errors, ...touch.errors];
  assert.deepEqual(report.errors, [], 'no page or WebGPU errors');
  report.browser = browser.version();
  await writeFile(resolve(results, 'walk-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} walk browser checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
