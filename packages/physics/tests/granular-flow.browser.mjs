import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolated = {
  name: 'granular-flow-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/granular-flow.html',
  port: 5512,
  plugins: [isolated],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('granular-flow-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runGranularFlow === 'function', null, { timeout: 20000 });
  assert.deepEqual([...assets], []);
  const { plain, shared, roughPlain, roughShared, depositPlain, depositShared } = await page.evaluate(() =>
    window.runGranularFlow(),
  );
  assert.equal(plain.isShared, false);
  assert.equal(shared.isShared, true);
  assert.deepEqual(plain, { ...shared, isShared: false });
  assert.deepEqual(roughPlain, roughShared);
  assert.deepEqual(depositPlain, depositShared);
  assert.equal(depositPlain.mass, 1800);
  assert.equal(depositPlain.volume, 4.5);
  assert.equal(depositPlain.elevation, 0.375);
  assert.ok(roughPlain.velocity > 0.02 * Math.cos((23.3 * Math.PI) / 180));
  assert.ok(plain.advance > 0.1);
  assert.equal(plain.barrier.depth, 0);
  assert.equal(plain.barrier.bedElevation, 3);
  assert.ok(Math.abs(plain.mass - plain.initial) <= 120 * 8 * Number.EPSILON * plain.initial);
  assert.deepEqual([...assets].sort(), ['granular-flow-kernel-shared.wasm', 'granular-flow-kernel.wasm']);
  assert.deepEqual(errors, []);
  console.log(
    `Browser EARTH-02 plain/shared parity for terrain ridge ${plain.hash} and rough-bed chute ${roughPlain.hash}, TerrainBed consolidation ${depositPlain.hash}`,
  );
} finally {
  await close();
}
