// Exact-value regression for a clipped refractor after restoring its clip plane.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'environment-capture-stability' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/env-mirror.html', port: 'free' });
  const { page } = browser;
  await page.waitForFunction(() => window.mirrorFixture);
  const render = (state) => page.evaluate((s) => window.mirrorFixture.render(s), state);
  const capture = (state) => page.evaluate((s) => window.mirrorFixture.capture('glass', s), state);
  // Keep the original mirror gate's glass setup and its negative clipping control.
  await render({ scene: 'glass' });
  await render({ scene: 'glass', tint: [0, 0, 0] });
  await render({ scene: 'glass-reference' });
  const front = await capture({ scene: 'glass', yellow: true });
  const absent = await capture({ scene: 'glass', yellow: false });
  const leaking = await capture({ scene: 'glass', yellow: true, clipBias: -2 });
  const free = await capture({ scene: 'glass', yellow: false, clipBias: -2 });
  const maximum = (a, b) => a.data.reduce((max, value, i) => Math.max(max, Math.abs(value - b.data[i])), 0);
  const initialDifference = maximum(front, absent);
  const controlDifference = maximum(leaking, free);
  // A fixed sample count measures failures; every pair runs even when an earlier one differs.
  const repeat = await page.evaluate(async () => {
    const rows = [],
      mismatches = [];
    for (let pair = 0; pair < 12; pair++) {
      const a = await window.mirrorFixture.capture('glass', { scene: 'glass', yellow: true });
      const b = await window.mirrorFixture.capture('glass', { scene: 'glass', yellow: false });
      const differences = [];
      for (let i = 0; i < a.data.length; i++)
        if (a.data[i] !== b.data[i])
          differences.push({
            index: i,
            x: (i >> 2) % a.width,
            y: Math.floor((i >> 2) / a.width),
            channel: i % 4,
            front: a.data[i],
            absent: b.data[i],
          });
      rows.push({ pair, differences: differences.length });
      if (differences.length) mismatches.push({ pair, differences });
    }
    return { rows, mismatches, errors: window.mirrorFixture.errors };
  });
  const out = `test-results/env-capture-stability/${process.argv.includes('--compat') ? 'compat' : 'webgpu'}`;
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/result.json`,
    JSON.stringify({ hardware: browser.hardware, initialDifference, controlDifference, repeat }, null, 2),
  );
  console.log(
    JSON.stringify({ initialDifference, controlDifference, rows: repeat.rows, report: `${out}/result.json` }),
  );
  assert.equal(initialDifference, 0, 'The front box is absent from the original capture pair');
  assert(controlDifference > 0.05, 'The negative clip bias admits the front box');
  assert.deepEqual(repeat.errors, [], 'No GPU validation or engine errors');
  assert.equal(repeat.rows.length, 12, 'Every bounded comparison completed');
  assert(
    repeat.rows.every((row) => row.differences === 0),
    'Restoring the clip plane preserves exact capture values',
  );
} finally {
  try {
    try {
      await browser?.page.evaluate(() => window.mirrorFixture?.dispose());
    } finally {
      await browser?.close();
    }
  } finally {
    release();
  }
}
