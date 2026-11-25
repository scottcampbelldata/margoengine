// Real-GPU check of renderAccumulated + Accumulate (FG-17 piece 1), on WebGPU and on the WebGL2 compatibility layer:
// a 64-sample box-filtered edge at x = 20.3 px reads its 0.3 coverage in linear light (one sample reads 0 or 1); at
// radiance 16 the edge pixel is the tone curve of the linear mean (a still lit to its share), far from the mean of
// display values; two runs are bit-identical; an 8 px strip moving 32 px a frame under a 180 degree shutter spreads
// over 24 px with its energy kept and its centre at the mid-shutter position; an abort stops the sequence.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const check = (label, r) => {
  console.log(label, JSON.stringify(r));
  assert.deepEqual(r.errors, [], `${label}: no GPU errors`);
  assert.ok(r.level > 0.05, `${label}: the lit box is visible (${r.level})`);
  assert.ok(
    Math.abs(r.manyEdge / r.level - 0.3) < 0.03,
    `${label}: 64 samples read 0.3 coverage: ${r.manyEdge / r.level}`,
  );
  assert.ok(Math.abs(r.before / r.level - 1) < 0.01 && r.after / r.level < 0.01, `${label}: neighbours stay whole`);
  assert.ok(
    r.oneLevels.every((v) => v === 0 || v === 1),
    `${label}: one sample has two levels: ${r.oneLevels}`,
  );
  assert.ok(r.identical, `${label}: two runs are bit-identical`);
  assert.ok(r.framesEqual, `${label}: renderFrames with samples is renderAccumulated`);
  assert.ok(
    Math.abs(r.display.edge - r.display.still) <= 2,
    `${label}: tone curve of the linear mean: ${r.display.edge} vs ${r.display.still}`,
  );
  const naive = 0.3 * r.display.inside + 0.7 * r.display.outside;
  assert.ok(Math.abs(r.display.edge - naive) > 20, `${label}: not the mean of display values (${naive})`);
  assert.ok(r.smear.support >= 23 && r.smear.support <= 26, `${label}: smear support 8 + 16 px: ${r.smear.support}`);
  assert.ok(Math.abs(r.smear.energy - 1) < 0.02, `${label}: smear keeps the strip's energy: ${r.smear.energy}`);
  assert.ok(
    Math.abs(r.smear.centroid - 44) < 0.35,
    `${label}: smear centred at mid-shutter (44 px): ${r.smear.centroid}`,
  );
  assert.equal(r.aborted, 'stop', `${label}: abort rejects with the reason`);
};

const context = await openBrowser({ startPath: '/packages/headless/tests/accumulate-gpu.html', port: 5283 });
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  check('webgpu', await context.page.evaluate(() => window.run()));
  check('compat', await context.page.evaluate(() => window.compatRun()));
  console.log('ok accumulate: linear coverage, tone curve once, determinism, shutter smear, abort; WebGPU and compat');
} finally {
  await context.close();
}
