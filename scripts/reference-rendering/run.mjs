// Black-box Sample Viewer screenshot. Run through gpu-lock.mjs; images remain outside this repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { prepareScene } from './scene.mjs';
import { referenceCase } from './cases.mjs';
import { pictureError, assertBudget } from './compare.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { saveReference } from './reference.mjs';

const root = join(process.env.MARGO_ENGINE_BENCH ?? 'C:/Development/Projects/engine-bench', 'batch-160');
const family = process.argv.find((a) => a.startsWith('--case='))?.slice(7) ?? 'metallic-roughness';
const entry = referenceCase(family),
  SETTINGS = { ...entry.settings, powerPreference: process.env.GPU_POWER };
const baselinePath = `docs/whitepaper/results/batch-160-${family}.json`;
const out = join(root, family);
mkdirSync(out, { recursive: true });
const source = readFileSync(
  family === 'metallic-roughness' ? join(root, entry.model + '.glb') : join(root, entry.model, entry.model + '.glb'),
);
const scene = prepareScene(source, entry);
writeFileSync(join(out, 'scene.glb'), scene.bytes);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
assert.equal(sha256(source), entry.sourceSha256, 'Standard sample asset changed');
if (process.argv.includes('--measure'))
  assert.ok(!existsSync(baselinePath), '--measure cannot replace an established budget');
const context = await openBrowser({ startPath: '/scripts/reference-rendering/margo.html', port: 'free' });
const { page } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.setViewportSize({ width: SETTINGS.width, height: SETTINGS.height });
  await page.waitForFunction(() => window.referenceMargo, null, { timeout: 30000 });
  const native = await page.evaluate(
    async ({ bytes, settings }) => {
      try {
        await window.referenceMargo.render(bytes, { backend: 'webgl2', settings });
        return null;
      } catch (e) {
        return { code: e.code, message: e.message };
      }
    },
    { bytes: Array.from(scene.bytes), settings: SETTINGS },
  );
  assert.equal(native?.code, 'unsupported', 'Native WebGL2 must explicitly reject PBR');
  const margo = await page.evaluate(({ bytes, settings }) => window.referenceMargo.render(bytes, { settings }), {
    bytes: Array.from(scene.bytes),
    settings: SETTINGS,
  });
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
    family,
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
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
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
