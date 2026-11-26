import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolated = {
  name: 'seismic-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/seismic.html',
  port: 5419,
  plugins: [isolated],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('seismic-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runSeismic === 'function', null, { timeout: 20000 });
  assert.deepEqual([...assets], []);
  const { plain, shared } = await page.evaluate(() => window.runSeismic());
  assert.ok(plain.motion.peakHorizontalAcceleration > 0);
  assert.ok(plain.building.displacement !== 0);
  assert.deepEqual(shared, plain, 'isolated Chromium runs both native memory variants');
  assert.deepEqual([...assets].sort(), ['seismic-kernel-shared.wasm', 'seismic-kernel.wasm']);
  assert.deepEqual(errors, []);
  console.log(`Browser native EARTH-08 parity, world ${plain.hash}`);
} finally {
  await close();
}
