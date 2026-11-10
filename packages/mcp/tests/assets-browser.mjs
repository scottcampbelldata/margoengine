import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { createLiveHost } from '../dist/live-host.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/index.json', import.meta.url), 'utf8'));
for (const backend of ['webgpu', 'webgl2']) {
  const context = await openBrowser({
    startPath: '/packages/mcp/tests/assets-browser.html',
    port: 'free',
    compat: backend === 'webgl2',
  });
  const { page } = context;
  page.setDefaultTimeout(60000);
  await page.waitForFunction(() => typeof window.assetSetup === 'function');
  try {
    const origin = new URL(page.url()).origin;
    const host = await createLiveHost({ origins: [origin], timeoutMs: 90000 });
    try {
      for (const fixture of fixtures) {
        assert.equal(
          await page.evaluate(({ backend, endpoint, token }) => window.assetSetup(backend, endpoint, token), {
            backend: 'webgpu',
            endpoint: host.endpoint,
            token: host.token,
          }),
          'webgpu',
        );
        await page.evaluate(() => window.assetSettle());
        if (fixture.asset.kind === 'model') {
          await page.evaluate(() => {
            window.assetFixture.surface.root.visible = false;
          });
        }
        const path = relative(process.cwd(), resolve(import.meta.dirname, 'fixtures', fixture.directory)).replaceAll(
          '\\',
          '/',
        );
        const url = `${origin}/${path}/${fixture.entry}`;
        const before = await host.request('capture', {});
        const result = await host.request('asset', { kind: fixture.asset.kind, url, target: 'surface' });
        assert.equal(result.kind, fixture.asset.kind);
        await page.evaluate(() => {
          window.assetFixture.stage.fit();
          window.assetFixture.stage.engine.render();
        });
        await page.evaluate(() => window.assetSettle());
        const after = await host.request('capture', {});
        if (fixture.asset.kind !== 'hdri')
          assert.ok(after.data !== before.data, `${fixture.asset.id}: real asset changes rendered pixels`);
        if (fixture.asset.kind === 'texture') {
          assert.equal(await page.evaluate(() => window.assetFixture.material.map.colorSpace), 'srgb');
        }
        assert.ok((await host.request('scene', {})).objects.length > 0);
        console.log(`${backend}: ${fixture.asset.provider}/${fixture.asset.id} loaded from recorded CC0 download`);
      }
      assert.deepEqual(await host.request('errors', {}), []);
    } finally {
      await page.evaluate(() => window.assetDispose());
      await host.close();
    }
  } finally {
    await context.close();
  }
}
