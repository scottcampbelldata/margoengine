import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/gltf-pro/tests/native-volume.html', port: 'free' });
await runSuite(
  async () => {
    await context.page.waitForFunction(() => window.volumeSlabs, null, { timeout: 30000 });
    let timer;
    let rows;
    try {
      rows = await Promise.race([
        context.page.evaluate(() => window.volumeSlabs()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native volume slab proof exceeded 120 seconds')), 120000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const encode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
    for (const row of rows) {
      const picture = await decodePNG(Buffer.from(row.png.split(',')[1], 'base64'));
      delete row.png;
      row.actual = Array.from(picture.data);
      row.expected = [0.25, 0.5, 1].map((c) => Math.round(255 * encode(c ** (row.scale * row.thickness)))).concat(255);
      assert.equal(picture.width, 1);
      assert.equal(picture.height, 1);
    }
    writeFileSync(
      'test-results/batch-160-native-volume-slabs.json',
      JSON.stringify({ hardware: context.hardware, rows }, null, 2) + '\n',
    );
    for (const row of rows) assert.deepEqual(row.actual, row.expected, JSON.stringify(row));
    console.log('native volume slabs:', rows.length, 'exact RGBA pixels passed');
  },
  () => context.close(),
);
