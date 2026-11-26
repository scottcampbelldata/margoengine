import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'lightning-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/sky/test/lightning-bolt-check.html?samples=1',
  port: 'free',
  plugins: [isolation],
});
const assets = new Set();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('lightning-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20_000 });
  assert.deepEqual([...assets], []);
  const result = await page.evaluate(() => window.check.runPhysical());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.deepEqual(result.shared, result.plain);
  assert.deepEqual([...assets].sort(), ['lightning-kernel-shared.wasm', 'lightning-kernel.wasm']);
  assert.equal(result.plain.channel.end[1], 0);
  assert.ok(result.plain.channel.trunk > 0 && result.plain.channel.count > result.plain.channel.trunk);
  assert.ok(result.dark.bright === 0 && result.lit.bright > 0 && result.lit.rows > 20, JSON.stringify(result.lit));
  console.log(
    `ATMO-07 native parity ${result.plain.hash}, ${result.lit.bright} bright pixels over ${result.lit.rows} rows.`,
  );
} finally {
  await close();
}
