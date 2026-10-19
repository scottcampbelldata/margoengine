// Real-GPU play test of the voxel sandbox in headless Edge: spawn on dry ground, pointer lock, fly up and forward,
// land, break the block under the crosshair, place stone, swim in the lake, change the render distance, and find the
// placed block again after a reload (IndexedDB save). Run from the repository root after `npm run build:packages`,
// holding the GPU lock: node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(resolve(import.meta.dirname, '../../..'));
const port = 5245,
  path = '/examples/voxel-sandbox/index.html?rd=4',
  context = await openBrowser({ startPath: path, port }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
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
  console.log('voxel sandbox play test passed');
} finally {
  await context.close();
}
