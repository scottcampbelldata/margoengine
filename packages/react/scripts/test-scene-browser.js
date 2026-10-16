import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 5197, startPath: '/packages/react/tests/scene-browser.html' }),
  { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const result = { hardware, checks: [] };
try {
  await page.waitForFunction(() => window.reactScene);
  for (const mode of ['kit', 'environment', 'physics', 'bloom', 'ssao', 'dof', 'xr', 'xr-simulated']) {
    const mounted = await page.evaluate((mode) => window.reactScene.mount(mode), mode);
    assert.equal(mounted.backend, 'webgpu');
    if (mode !== 'xr' && mode !== 'xr-simulated') {
      const frame = await page.evaluate(() => window.reactScene.singleFrame());
      assert.ok(frame.stats.visible > 0, mode + ' did not render geometry');
      await page.evaluate(() => window.reactScene.draw(3));
      if (mode === 'kit') {
        assert.equal(mounted.gltf, true);
        assert.equal(mounted.fbx, true);
        assert.equal(await page.locator('[data-overlay="ready"]').count(), 1);
        await page.evaluate(() => window.reactScene.shadow(false));
        const without = await decodePNG(await page.locator('canvas').screenshot());
        await page.evaluate(() => window.reactScene.shadow(true));
        const withShadow = await decodePNG(
          await page.locator('canvas').screenshot({ path: 'test-results/react-scene-kit.png' }),
        );
        let changed = 0,
          darkened = 0;
        for (let index = 0; index < without.data.length; index += 4) {
          const a = without.data[index] + without.data[index + 1] + without.data[index + 2],
            b = withShadow.data[index] + withShadow.data[index + 1] + withShadow.data[index + 2];
          if (Math.abs(a - b) > 8) changed++;
          if (a - b > 8) darkened++;
        }
        assert.ok(darkened > 50, `ContactShadows must darken visible ground pixels (${darkened})`);
        result.checks.push({
          name: 'kit: real native loaders, shapes, text/HTML, sky, gizmo, pointer controls and shadow-only ground',
          changed,
          darkened,
        });
        const target = await page.evaluate(() => window.reactScene.clickPoint());
        await page.mouse.click(target.x, target.y);
        await page.waitForFunction(() => window.reactScene.snapshot().clicks === 1);
        await page.mouse.move(target.x, target.y);
        await page.mouse.down();
        await page.mouse.move(target.x + 20, target.y + 10, { steps: 3 });
        await page.mouse.up();
        await page.evaluate(() => window.reactScene.draw());
        assert.equal(await page.evaluate(() => window.reactScene.snapshot().clicks), 1);
        result.checks.push({ name: 'native GPU picking: StrictMode click fires once and pointer drag does not click' });
      } else if (mode === 'physics') {
        const physics = await page.evaluate(() => window.reactScene.physics());
        assert.ok(physics.after < physics.before);
        assert.equal(physics.colliders, 1);
        assert.equal(physics.bodyCount, 5);
        assert.equal(physics.fbxCoreGeometries, 0);
        assert.equal(physics.fbxAutoColliders, 1);
        assert.equal(physics.fbxExplicitColliders, 1);
        assert.equal(physics.ballColliders, 1);
        result.checks.push({
          name: 'physics: real Rapier, geometry/bounds-derived FBX cuboid and explicit cuboid/ball collider children',
          ...physics,
        });
      } else {
        const image = await decodePNG(
          await page.locator('canvas').screenshot({ path: `test-results/react-scene-${mode}.png` }),
        );
        let colored = 0;
        for (let at = 0; at < image.data.length; at += 4) {
          const channels = [image.data[at], image.data[at + 1], image.data[at + 2]];
          if (Math.max(...channels) > 60 && Math.max(...channels) - Math.min(...channels) > 30) colored++;
        }
        assert.ok(colored > 100, `${mode} did not present colored geometry (${colored})`);
        result.checks.push({
          name:
            mode === 'environment'
              ? 'environment: HDR Suspense, IBL material bindings and background'
              : `post: ${mode} supported native stack, real WebGPU validation`,
          colored,
          ...frame,
        });
      }
      const removed = await page.evaluate(() => window.reactScene.removeFeatures());
      assert.deepEqual(removed.errors, []);
      assert.deepEqual(removed.gpuErrors, []);
      result.checks.push({ name: mode + ': demand rendering and plugin removal', frames: removed.frames });
    } else if (mode === 'xr-simulated') {
      assert.equal(mounted.xrRequests, 0, 'mount must not request a session');
      assert.equal(mounted.xrReady, true);
      await page.locator('[data-enter-xr]').click();
      const xr = await page.evaluate(() => window.reactScene.verifyXR());
      assert.equal(xr.xrRequests, 1);
      assert.equal(xr.ends, 1);
      assert.ok(xr.controllerFrames >= 4);
      assert.ok(xr.frames >= 4);
      assert.ok(xr.eyes.every((count) => count > 100));
      assert.ok(Math.abs(xr.centers[0] - xr.centers[1]) > 1);
      assert.deepEqual(xr.gpuErrors, []);
      result.checks.push({
        name: 'XR: explicit user gesture, real stereo WebGPU pixels, controllers, frame hooks and demand restoration',
        ...xr,
      });
    } else {
      assert.ok(mounted.xrReady || mounted.xrError?.includes('WebXR is unavailable'));
      result.checks.push({
        name: 'XR: explicit preparation without session permission',
        ready: mounted.xrReady,
        unavailable: mounted.xrError,
      });
    }
    await page.evaluate(() => window.reactScene.unmount());
  }
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.evaluate(() => window.reactScene.mount('kit'));
    await page.evaluate(() => window.reactScene.singleFrame());
    await page.evaluate(() => window.reactScene.unmount());
  }
  result.checks.push({
    name: 'repeated StrictMode mount/render/unmount releases every engine and HTML overlay',
    cycles: 3,
  });
  assert.deepEqual(await page.evaluate(() => window.reactScene.errors), []);
  assert.deepEqual(await page.evaluate(() => window.reactScene.gpuErrors), []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-scene-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.error = String(error);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-scene-browser.json', JSON.stringify(result, null, 2));
  throw error;
} finally {
  await browser.close();
}
