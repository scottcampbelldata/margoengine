// Black-box Sample Viewer screenshot. Run through gpu-lock.mjs; images remain outside this repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { prepareScene, SETTINGS } from './scene.mjs';
import { pictureError, assertBudget } from './compare.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { saveReference } from './reference.mjs';

const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
const out = join(root, 'metallic-roughness');
mkdirSync(out, { recursive: true });
const source = readFileSync(join(root, 'MetalRoughSpheresNoTextures.glb'));
const scene = prepareScene(source);
writeFileSync(join(out, 'scene.glb'), scene.bytes);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const context = await openBrowser({ startPath: '/scripts/reference-rendering/margo.html', port: 'free' });
const { page } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.setViewportSize({ width: SETTINGS.width, height: SETTINGS.height });
  await page.waitForFunction(() => window.referenceMargo, null, { timeout: 30000 });
  const native = await page.evaluate(async (bytes) => {
    try {
      await window.referenceMargo.render(bytes, { backend: 'webgl2' });
      return null;
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  }, Array.from(scene.bytes));
  assert.equal(native?.code, 'unsupported', 'Native WebGL2 must explicitly reject PBR');
  const margo = await page.evaluate((bytes) => window.referenceMargo.render(bytes), Array.from(scene.bytes));
  assert.deepEqual(errors, []);
  const actual = await page.locator('canvas').screenshot();
  writeFileSync(join(out, process.argv.includes('--compat') ? 'margo-compat.png' : 'margo.png'), actual);
  const referencePath = join(out, 'sample-viewer.png');
  if (process.argv.includes('--capture-reference')) {
    // The deployed viewer's public UI only. No JS modules, shader text or renderer source are inspected.
    const viewer = await page
      .context()
      .browser()
      .newPage({ viewport: { width: SETTINGS.width, height: SETTINGS.height }, deviceScaleFactor: 1 });
    await viewer.route('https://margo-reference.invalid/scene.glb', (route) =>
      route.fulfill({
        body: Buffer.from(scene.bytes),
        contentType: 'model/gltf-binary',
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    await viewer.goto(
      'https://github.khronos.org/glTF-Sample-Viewer-Release/?model=https://margo-reference.invalid/scene.glb',
      { waitUntil: 'domcontentloaded', timeout: 60000 },
    );
    await viewer.waitForFunction(
      () => [...document.querySelectorAll('option')].some((e) => e.textContent.includes('Batch 160 camera')),
      null,
      { timeout: 60000 },
    );
    if (await viewer.getByRole('button', { name: 'Show the controls' }).isVisible())
      await viewer.getByRole('button', { name: 'Show the controls' }).click();
    await viewer.getByTestId('camera-select').selectOption({ label: 'Batch 160 camera: Batch 160 camera' });
    await viewer.getByRole('tab', { name: 'Display', exact: true }).click();
    await viewer.getByTestId('switch-ibl').locator('input').uncheck({ force: true });
    await viewer
      .locator('label')
      .filter({ hasText: /^Environment Map$/ })
      .locator('input')
      .uncheck({ force: true });
    await viewer.locator('input[type=color]').fill('#000000');
    await viewer.locator('select').first().selectOption({ label: 'Khronos PBR Neutral' });
    const downloadPromise = viewer.waitForEvent('download', { timeout: 30000 });
    await viewer.getByRole('button', { name: 'Download as PNG' }).click();
    const candidatePath = join(out, 'sample-viewer-candidate.png');
    await (await downloadPromise).saveAs(candidatePath);
    const picture = readFileSync(candidatePath);
    const png = await decodePNG(picture);
    assert.ok(
      png.data.some((v, i) => i % 4 !== 3 && v > 0),
      'Sample Viewer is black',
    );
    const baselinePath = 'docs/whitepaper/results/batch-160-metallic-roughness.json';
    const frozenHash = existsSync(baselinePath)
      ? JSON.parse(readFileSync(baselinePath, 'utf8')).referenceSha256
      : undefined;
    saveReference(referencePath, picture, frozenHash);
    writeFileSync(
      join(out, 'viewer-metadata.json'),
      JSON.stringify(
        {
          url: viewer.url(),
          resources: await viewer.evaluate(() =>
            performance
              .getEntriesByType('resource')
              .map((e) => e.name)
              .filter((n) => n.includes('.js')),
          ),
          gl: await viewer.locator('canvas').evaluate((c) => {
            const gl = c.getContext('webgl2');
            return { attributes: gl.getContextAttributes(), samples: gl.getParameter(gl.SAMPLES) };
          }),
          settings: SETTINGS,
          referenceSha256: sha256(picture),
        },
        null,
        2,
      ),
    );
    await viewer.close();
  }
  const reference = readFileSync(referencePath);
  const result = {
    family: 'metallic-roughness',
    domain: 'RGB bytes after Khronos PBR Neutral and sRGB; all pixels, black background',
    sourceSha256: sha256(source),
    sceneSha256: sha256(scene.bytes),
    referenceSha256: sha256(reference),
    hardware: context.hardware,
    margo,
    nativeWebGL2: native,
    metrics: pictureError(await decodePNG(actual), await decodePNG(reference)),
  };
  if (!process.argv.includes('--measure')) {
    const baseline = JSON.parse(readFileSync('docs/whitepaper/results/batch-160-metallic-roughness.json', 'utf8'));
    assert.equal(result.referenceSha256, baseline.referenceSha256);
    assert.equal(result.sceneSha256, baseline.sceneSha256);
    assertBudget(result.metrics, process.argv.includes('--compat') ? baseline.compat.metrics : baseline.metrics);
  }
  writeFileSync(
    join(out, process.argv.includes('--compat') ? 'comparison-compat.json' : 'comparison.json'),
    JSON.stringify(result, null, 2),
  );
  console.log('RESULT', JSON.stringify(result));
} finally {
  await context.close();
}
