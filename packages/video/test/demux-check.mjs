import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({
  startPath: '/packages/video/test/demux-check.html',
  port: 'free',
  plugins: [
    {
      name: 'real-demux-fixtures',
      configureServer(server) {
        for (const format of ['mp4', 'webm']) {
          const bytes = readFileSync(requireExternalAssets('video/flower.' + format));
          server.middlewares.use('/__demux-' + format, (_req, res) => {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(bytes);
          });
        }
      },
    },
  ],
});
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, result }));
  assert.equal(result.length, 4);
} finally {
  await browser.close();
}
