// Real-GPU test of virtual shadow page caching (row 21.6 stage 4).
//  1. A still scene renders 0 pages once feedback has settled (stats.pagesRendered, `SETTLE` frames).
//  2. A moved caster re-renders exactly its pages: the resident pages its old or new bounds reach, as predicted on the CPU.
//  3. invalidate() re-renders every resident page.
//  4. The cached frame equals a fresh effect's frame at the same state, so no old depth is left: after the still-path move
//     and after a dynamic caster (unknown bounds, every resident page each frame) has moved away.
// Run from the repository root after `npm run build:packages`. Writes test-results/virtual-cache.json.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const SETTLE = 6,
  // Largest channel difference and how many pixels may differ between the cached and the fresh frame.
  CHANNEL = 2,
  PIXELS = 0;
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-virtual-cache' });
const context = await openBrowser({ startPath: '/packages/shadows/test/virtual-cache.html', port: 5272 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const call = async (method, ...args) => {
  const out = await page.evaluate(([m, a]) => window.check[m](...a), [method, args]);
  assert.deepEqual(out.errors, [], `${method} ${JSON.stringify(args)}`);
  return out;
};
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const difference = (a, b) => {
  let pixels = 0;
  for (let p = 0; p < a.width * a.height; p++)
    for (let k = 0; k < 3; k++)
      if (Math.abs(a.data[p * 4 + k] - b.data[p * 4 + k]) > CHANNEL) {
        pixels++;
        break;
      }
  return pixels;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const started = await call('start'),
    idle = await call('idle', 5);
  // 2. A small move, inside the pages already resident.
  const moved = await call('move', [-1.9, 0.6, 1.05]),
    afterMove = await call('idle', 1);
  const invalidated = await call('invalidate');
  // 4. Far enough that its old pages hold nothing of it now.
  const FAR = [2.5, 0.6, 3];
  await call('move', FAR);
  await call('idle', SETTLE);
  const cachedFrame = await shot(),
    settledAfterMove = await call('idle', 2);
  await call('start', FAR);
  await call('idle', 2);
  const freshFrame = await shot(),
    cachedDiff = difference(cachedFrame, freshFrame);
  await call('start', undefined, true);
  const dynamicIdle = await call('idle', 2);
  await call('move', FAR);
  await call('idle', SETTLE);
  const dynamicDiff = difference(await shot(), freshFrame);
  const result = {
    started: started.frames,
    idle: idle.frames,
    moved: moved.frames,
    predicted: moved.predicted,
    afterMove: afterMove.frames,
    invalidated: invalidated.frames,
    resident: invalidated.resident,
    settledAfterMove: settledAfterMove.frames,
    cachedDiff,
    dynamicIdle: dynamicIdle.frames,
    dynamicResident: dynamicIdle.stats.residentPages,
    dynamicDiff,
    pageErrors,
  };
  console.log(JSON.stringify(result));
  await writeFile('test-results/virtual-cache.json', JSON.stringify(result, null, 2));
  assert.deepEqual(pageErrors, []);
  assert.ok(started.stats.residentPages > 20, 'pages to cache');
  assert.deepEqual(idle.frames, [0, 0, 0, 0, 0], 'a still scene renders no page');
  assert.ok(moved.predicted > 0);
  assert.deepEqual(moved.frames, [moved.predicted], 'a moved caster renders exactly its pages');
  assert.deepEqual(afterMove.frames, [0], 'and nothing the frame after');
  assert.deepEqual(invalidated.frames, [invalidated.resident], 'invalidate renders every resident page');
  assert.deepEqual(settledAfterMove.frames, [0, 0]);
  // A caster of unknown bounds redraws every resident page every frame.
  assert.deepEqual(dynamicIdle.frames, [dynamicIdle.stats.residentPages, dynamicIdle.stats.residentPages]);
  // The moved caster's shadow left no old depth: every path ends in a fresh effect's picture.
  assert.ok(cachedDiff <= PIXELS, `${cachedDiff} pixels differ between the cached and a fresh frame`);
  assert.ok(dynamicDiff <= PIXELS, `${dynamicDiff} pixels differ between the dynamic path and a fresh frame`);
  console.log('shadows virtual cache: ok');
} finally {
  await context.close?.();
  await release?.();
}
