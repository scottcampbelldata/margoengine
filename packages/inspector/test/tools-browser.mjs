import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/inspector/test/tools.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => typeof window.setup === 'function');
  for (const backend of ['webgpu', 'webgl2']) {
    assert.equal(await page.evaluate((backend) => window.setup(backend), backend), backend);
    await page.getByRole('combobox', { name: 'Camera', exact: true }).selectOption('side');
    await page.waitForFunction(() => window.engine.camera.fov === 45);
    const image = await page.evaluate(() => window.inspectScreenshot());
    assert.equal(image.type, 'image/png');
    assert.deepEqual(image.bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(image.width > 0 && image.height > 0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Screenshot', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'screenshot.png');
    const exportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export glTF', exact: true }).click();
    assert.equal((await exportDownload).suggestedFilename(), 'scene.glb');
    const gltf = await page.evaluate(async () =>
      JSON.parse(await (await window.panel.exportGLTF({ binary: false })).text()),
    );
    assert.equal(gltf.asset.version, '2.0');
    assert.ok(gltf.meshes.length);
    await page.evaluate(() => window.startVideo());
    await page.evaluate(async () => {
      // fixed-wait: exercise 1.2 seconds of media, matching the video package's recording fixture.
      const end = performance.now() + 1200;
      let frame = 0;
      while (performance.now() < end) {
        window.mesh.setRotation([0, frame++ / 12, 0]);
        window.engine.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    const video = await page.evaluate(() => window.finishVideo());
    assert.ok(video.size > 0);
    assert.ok(video.width > 0 && video.height > 0);
    assert.match(video.type, /^video\/webm/);
    await page.getByRole('combobox', { name: 'Camera', exact: true }).selectOption('default');
    await page.waitForFunction(() => window.engine.camera.fov === 60);
    assert.deepEqual(errors, []);
    console.log(`${backend}: CC0 model camera switch, PNG download, scene GLB/glTF and decodable canvas video passed`);
  }
} finally {
  await page.evaluate(() => window.engine?.dispose());
  await context.close();
}
