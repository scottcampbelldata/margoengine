import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const bytes = readFileSync(requireExternalAssets('video/flower.webm'));
const browser = await openBrowser({
  startPath: '/packages/video/test/playback-check.html',
  port: 'free',
  args: ['--autoplay-policy=document-user-activation-required'],
  plugins: [
    {
      name: 'real-playback-fixture',
      configureServer(server) {
        server.middlewares.use('/__playback-flower.webm', (_req, res) => {
          res.setHeader('Content-Type', 'video/webm');
          res.end(bytes);
        });
      },
    },
  ],
});
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  assert.deepEqual(result.errors, []);
  assert.ok(result.ready >= 2);
  assert.equal(result.muted, true);
  assert.equal(result.inline, true);
  assert.equal(result.poster, true);
  for (const [index, pixel] of result.pixels.entries())
    pixel.forEach((v, i) => assert.ok(Math.abs(v - result.expected[index][i]) <= 3, JSON.stringify(result)));
  await browser.page.waitForFunction(() => window.blockedHelper.blocked);
  await browser.page.getByRole('button', { name: 'Play video' }).click();
  const fallback = await browser.page.evaluate(() => window.finishBlocked());
  assert.deepEqual(fallback, { blocked: false, paused: false, button: false });
  console.log(JSON.stringify({ hardware: browser.hardware, result, fallback }));
} finally {
  await browser.close();
}
