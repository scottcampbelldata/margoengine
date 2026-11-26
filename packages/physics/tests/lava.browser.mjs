import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolated = {
  name: 'lava-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/lava.html',
  port: 5432,
  plugins: [isolated],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('lava-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runLava === 'function', null, { timeout: 20000 });
  assert.deepEqual([...assets], []);
  const { plain, shared } = await page.evaluate(() => window.runLava());
  assert.equal(plain.isShared, false);
  assert.equal(shared.isShared, true);
  assert.ok(plain.displacement > 0);
  assert.ok(plain.coastDepth > 0);
  assert.equal(plain.hash, shared.hash);
  assert.equal(plain.displacement, shared.displacement);
  assert.equal(plain.coastDepth, shared.coastDepth);
  assert.deepEqual([...assets].sort(), ['lava-kernel-shared.wasm', 'lava-kernel.wasm']);
  assert.deepEqual(errors, []);
  console.log(`Browser native EARTH-10 parity, world ${plain.hash}`);
} finally {
  await close();
}
