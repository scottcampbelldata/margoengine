import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = animatedTriangle(),
  { doc, buffers } = fixture;
doc.animations[0].name = 'Walk';
buffers[doc.animations[0].samplers[0].output].set([0, 0, 0, 2, 0, 0]);
const runBuffer = buffers.length,
  runOutput = new Float32Array([0, 0, 0, -2, 0, 0]);
buffers.push(runOutput);
doc.buffers.push({ byteLength: runOutput.byteLength });
doc.bufferViews.push({ buffer: runBuffer, byteLength: runOutput.byteLength });
doc.accessors.push({ bufferView: runBuffer, componentType: 5126, count: 2, type: 'VEC3' });
doc.animations.push({
  name: 'Run',
  channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
  samplers: [{ input: doc.animations[0].samplers[0].input, output: runBuffer }],
});
doc.buffers.forEach((buffer, index) => {
  buffer.uri =
    'data:application/octet-stream;base64,' +
    Buffer.from(buffers[index].buffer, buffers[index].byteOffset, buffers[index].byteLength).toString('base64');
});
// The native loader intentionally requires an HTTP(S) document URL; its binary
// accessors stay self-contained data URIs in this generated fixture.
const src = 'http://127.0.0.1:5198/fixtures/react-after-scene.gltf';
const browser = await openBrowser({ port: 5198, startPath: '/packages/react/tests/after-scene-browser.html' }),
  { page, hardware } = browser,
  result = { hardware, checks: [] },
  errors = [];
await page.route('**/fixtures/react-after-scene.gltf', (route) =>
  route.fulfill({ contentType: 'model/gltf+json', body: JSON.stringify(doc) }),
);
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 2e-5, `${label}: ${actual} differs from ${expected}`);
const delta = (a, b) => {
  assert.equal(a.data.length, b.data.length);
  let changed = 0,
    max = 0,
    colored = 0;
  for (let at = 0; at < a.data.length; at += 4) {
    let different = false;
    for (let lane = 0; lane < 3; lane++) {
      const difference = Math.abs(a.data[at + lane] - b.data[at + lane]);
      max = Math.max(max, difference);
      different ||= difference !== 0;
    }
    if (different) changed++;
    const r = b.data[at],
      g = b.data[at + 1],
      blue = b.data[at + 2];
    if (Math.max(r, g, blue) > 60 && Math.max(r, g, blue) - Math.min(r, g, blue) > 30) colored++;
  }
  return { changed, max, colored };
};
try {
  await page.waitForFunction(() => window.afterScene);
  await page.evaluate(() => window.afterScene.mount('lit'));
  await page.evaluate(() => window.afterScene.draw());
  const lit = await decodePNG(
    await page.locator('canvas').screenshot({ path: 'test-results/react-after-scene-lit.png' }),
  );
  assert.ok(
    delta(lit, lit).colored > 1000,
    'Root-import <Box color> must show lit colored geometry without a material child',
  );
  result.checks.push({
    name: 'single root import: Canvas and Box color render a lit scene',
    colored: delta(lit, lit).colored,
  });
  await page.evaluate(() => window.afterScene.material('pbr'));
  const plain = await decodePNG(await page.locator('canvas').screenshot());
  const zero = await page.evaluate(() => window.afterScene.material('transmission-zero'));
  assert.equal(zero.opaqueCapture, false);
  assert.equal(zero.materialInstallations, 0);
  const disabled = await decodePNG(await page.locator('canvas').screenshot()),
    zeroDelta = delta(plain, disabled);
  assert.equal(zeroDelta.max, 0, 'factor zero must match PbrMaterial pixels exactly');
  result.checks.push({
    name: 'MeshTransmissionMaterial factor0 equals PbrMaterial pixels and allocates no capture',
    ...zeroDelta,
  });
  const transmitted = await page.evaluate(() => window.afterScene.material('transmission-on'));
  await page.evaluate(() => window.afterScene.draw());
  assert.equal(transmitted.opaqueCapture, true);
  assert.equal(transmitted.materialInstallations, 1);
  const enabled = await decodePNG(
      await page.locator('canvas').screenshot({ path: 'test-results/react-after-scene-transmission.png' }),
    ),
    transmissionDelta = delta(disabled, enabled);
  assert.ok(transmissionDelta.changed > 100, 'Positive transmission must change visible pixels');
  result.checks.push({
    name: 'positive transmission uses native material installation and opaque capture',
    ...transmissionDelta,
  });
  await page.evaluate(() => window.afterScene.remove());
  const materialCleanup = await page.evaluate(() => window.afterScene.unmount());
  result.checks.push({
    name: 'material feature removal and StrictMode unmount release plugins and GPU resources',
    ...materialCleanup,
  });

  const waiting = await page.evaluate((src) => window.afterScene.mount('skinned', src, true), src);
  assert.ok(waiting.fallbackMounts > 0);
  assert.equal(waiting.animations, 0);
  assert.equal(waiting.assetRequests, 1);
  const loaded = await page.evaluate(() => window.afterScene.release());
  assert.equal(loaded.assetRequests, 1);
  assert.equal(loaded.animations, 1);
  assert.equal(loaded.animators, 1);
  const frame = await page.evaluate(() => window.afterScene.draw(0.5));
  near(frame.jointX, 1, 'Walk one-frame translation');
  const positions = await page.evaluate(() => window.afterScene.positions());
  for (let vertex = 0; vertex < 3; vertex++)
    near(positions[vertex][0], [-0.6, 0.6, 0][vertex] + 1, 'Deformed vertex ' + vertex);
  const target = await page.evaluate(() => window.afterScene.point());
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => window.afterScene.snapshot().clicks === 1);
  const clicked = await page.evaluate(() => window.afterScene.drain());
  assert.equal(clicked.lastObject, clicked.primitiveId);
  assert.equal(clicked.lastNativeHit, clicked.primitiveId);
  assert.equal(clicked.picking, true);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + 10, { steps: 4 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.afterScene.drain());
  assert.equal(dragged.clicks, 1);
  result.checks.push({
    name: 'Suspense skinned Gltf: one animation frame deforms beyond bind bounds; StrictMode click fires once and drag does not click',
    positions,
    ...dragged,
  });
  await page.evaluate(() => window.afterScene.playback('Run'));
  const blended = await page.evaluate(() => window.afterScene.draw(0.25));
  near(blended.jointX, 0.25, 'Half crossfade');
  const run = await page.evaluate(() => window.afterScene.draw(0.25));
  near(run.jointX, -1, 'Completed crossfade');
  await page.evaluate(() => window.afterScene.playback('Run', false));
  const paused = await page.evaluate(() => window.afterScene.draw(0.25));
  near(paused.jointX, -1, 'Paused clip');
  await page.evaluate(() => window.afterScene.playback('Run'));
  const ended = await page.evaluate(() => window.afterScene.draw(0.5));
  near(ended.jointX, -2, 'Nonloop terminal Run pose');
  assert.equal(ended.animations, 1);
  assert.equal(ended.animators, 1);
  result.checks.push({
    name: 'Animation clip/playing/loop/blend delegate playback and crossfade to native plugins',
    blended: blended.jointX,
    run: run.jointX,
    paused: paused.jointX,
    ended: ended.jointX,
  });
  await page.evaluate(() => window.afterScene.remove());
  const skinCleanup = await page.evaluate(() => window.afterScene.unmount());
  result.checks.push({
    name: 'animation/Suspense removal releases all owned plugins and GPU resources',
    ...skinCleanup,
  });
  await page.evaluate((src) => window.afterScene.mount('skinned', src, true), src);
  const aborted = await page.evaluate(() => window.afterScene.unmount());
  assert.equal(aborted.assetAborts, 1);
  result.checks.push({ name: 'unmount during Suspense aborts the asset without starting animation', ...aborted });
  assert.deepEqual(await page.evaluate(() => window.afterScene.errors), []);
  assert.deepEqual(await page.evaluate(() => window.afterScene.gpuErrors), []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-after-scene-browser.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.error = String(error);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-after-scene-browser.json', JSON.stringify(result, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
}
