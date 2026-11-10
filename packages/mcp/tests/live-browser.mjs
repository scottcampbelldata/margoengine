import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { createLiveHost } from '../dist/live-host.js';
import { createLiveTools } from '../dist/live.js';
import { createMcpServer } from '../dist/index.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/mcp/tests/live-browser.html', port: 'free' });
const { page } = context;
page.setDefaultTimeout(30000);
await page.waitForFunction(() => typeof window.liveSetup === 'function');
try {
  for (const backend of ['webgpu', 'webgl2']) {
    const origin = new URL(page.url()).origin;
    const host = await createLiveHost({ origins: [origin] });
    const server = createMcpServer({ tools: createLiveTools(host) });
    try {
      assert.equal(
        await page.evaluate(({ backend, endpoint, token }) => window.liveSetup(backend, endpoint, token), {
          backend,
          endpoint: host.endpoint,
          token: host.token,
        }),
        backend,
      );
      const scene = await host.request('scene', {});
      assert.ok(scene.objects.some((o) => o.id.startsWith('mesh:')));
      const before = await host.request('capture', {});
      const png = await decodePNG(new Uint8Array(Buffer.from(before.data, 'base64')));
      assert.ok(png.width > 0 && png.height > 0);
      const colours = new Set();
      for (let i = 0; i < png.data.length; i += 4) colours.add(png.data.slice(i, i + 3).join(','));
      assert.ok(colours.size > 2, 'canvas contains rendered geometry');
      const mesh = scene.objects.find((o) => o.id.startsWith('mesh:'));
      await host.request('set', { id: mesh.id, key: 'visible', value: false });
      const after = await host.request('capture', {});
      assert.notEqual(before.data, after.data, 'inspector edit changes rendered canvas');
      await page.evaluate(() => window.liveFixture.bridge.reportError('fixture diagnostic'));
      const errors = await host.request('errors', {});
      assert.ok(errors.some((e) => e.message === 'fixture diagnostic'));
      const image = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'live_capture' },
      });
      assert.equal(image.result.content[0].type, 'image');
      console.log(`${backend}: authenticated live scene, inspector edit, PNG and error tools passed`);
    } finally {
      await page.evaluate(async () => {
        window.liveFixture.bridge.dispose();
        await window.liveFixture.bridge.closed;
        window.liveFixture.stage.dispose();
      });
      server.dispose();
      await host.close();
    }
  }
} finally {
  await context.close();
}
