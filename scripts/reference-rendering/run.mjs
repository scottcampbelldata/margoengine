// Black-box Sample Viewer screenshot. Images remain outside this repository.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { prepareScene } from './scene.mjs';
import { referenceCase } from './cases.mjs';
import { pictureError, assertBudget } from './compare.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { saveReference } from './reference.mjs';
import { viewerBudget } from './proof-contract.mjs';
import { GAMMA_22, SRGB_ENCODE, installViewerTransfer } from './viewer-transfer.mjs';

const root = join(
  process.env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../../engine-bench', import.meta.url)),
  'batch-160',
);
const family = process.argv.find((a) => a.startsWith('--case='))?.slice(7) ?? 'metallic-roughness';
// --like-for-like: the viewer's pow(x, 1/2.2) transfer and one sample per pixel (viewer-transfer.mjs, docs/limits.md),
// gated by the case's own `likeForLike` row. Native WebGPU only: the rewrite acts on WGSL modules.
const likeForLike = process.argv.includes('--like-for-like');
const compat = process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1';
assert.ok(!(likeForLike && compat), '--like-for-like measures native WebGPU only');
assert.ok(!(likeForLike && process.argv.includes('--capture-reference')), '--like-for-like never captures a reference');
const entry = referenceCase(family),
  SETTINGS = {
    ...entry.settings,
    powerPreference: process.env.GPU_POWER,
    ...(likeForLike ? { exactSize: [entry.settings.width, entry.settings.height] } : {}),
  };
const suffix = likeForLike ? '-like-for-like' : compat ? '-compat' : '';
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
  assert.ok(
    likeForLike
      ? !JSON.parse(readFileSync(baselinePath, 'utf8')).likeForLike
      : !existsSync(baselinePath),
    '--measure cannot replace an established budget',
  );
const context = await openBrowser({ startPath: '/scripts/reference-rendering/margo.html', port: 'free' });
const { page } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  if (likeForLike) {
    await page.addInitScript(installViewerTransfer, { source: SRGB_ENCODE, replacement: GAMMA_22 });
    await page.reload();
  }
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
  const rewritten = likeForLike ? await page.evaluate(() => window.__viewerTransfer) : 0;
  if (likeForLike) assert.ok(rewritten > 0, 'The viewer transfer must reach the material shaders');
  const actual = await page.locator('canvas').screenshot();
  writeFileSync(join(out, `margo${suffix}.png`), actual);
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
    domain: likeForLike
      ? 'RGB bytes after Khronos PBR Neutral and pow(x, 1/2.2), one sample per pixel; all pixels, black background'
      : 'RGB bytes after Khronos PBR Neutral and sRGB; all pixels, black background',
    sourceSha256: sha256(source),
    sceneSha256: sha256(scene.bytes),
    referenceSha256: sha256(reference),
    hardware: context.hardware,
    margo,
    nativeWebGL2: native,
    ...(likeForLike ? { transfer: { rewrittenEncodes: rewritten, samples: 1 } } : {}),
    metrics: pictureError(await decodePNG(actual), await decodePNG(reference)),
  };
  // The measurement is written and printed before the budget check, so a run over its budget still reports what it
  // measured (KB3584: the AMD rows could not be re-measured from a failing run).
  writeFileSync(join(out, `comparison${suffix}.json`), JSON.stringify(result, null, 2));
  console.log('RESULT', JSON.stringify(result));
  if (!process.argv.includes('--measure')) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(result.referenceSha256, baseline.referenceSha256);
    assert.equal(result.sceneSha256, baseline.sceneSha256);
    // An AMD run is gated by the case's own `amd` row when it has one, as proof.mjs does (proof-contract.mjs).
    // A like-for-like run is gated by its own row (the viewer transfer and one sample, viewer-transfer.mjs).
    if (likeForLike) assertBudget(result.metrics, baseline.likeForLike.metrics);
    else assertBudget(result.metrics, viewerBudget(baseline, compat, process.env.MARGO_GPU));
  }
} finally {
  await context.close();
}
