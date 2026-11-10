// Remote inspection in a real browser through the real relay: the page holds a WebGPU target and a viewer, each
// on its own streamed-fetch relay connection, as a phone page and a desktop page would; the viewer lists the scene
// and takes a PNG of the WebGPU canvas. One machine: a phone or headset browser is not driven here.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { createRemoteRelay } from '../dist/remote-relay.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const relay = await createRemoteRelay();
const context = await openBrowser({ startPath: '/packages/inspector/test/remote.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  assert.equal(await page.evaluate(([url, token]) => window.setup(url, token), [relay.url, relay.token]), 'webgpu');
  const result = await page.evaluate(() => window.run());
  assert.equal(result.hello.backend, 'webgpu');
  assert.deepEqual([result.hello.width, result.hello.height], [320, 240]);
  assert.ok(
    result.objects.some((id) => id.startsWith('mesh:')),
    JSON.stringify(result.objects),
  );
  assert.deepEqual(result.png, [320, 240]);
  assert.equal(relay.streams('target'), 1);
  assert.equal(relay.streams('viewer'), 1);
  await page
    .getByRole('status')
    .filter({ hasText: /webgpu 320x240, \d+ fps/ })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(`webgpu: relay hello, scene of ${result.objects.length} objects, 320x240 PNG capture and stats passed`);
} finally {
  await page.evaluate(() => window.engine?.dispose());
  await context.close();
  await relay.close();
}
