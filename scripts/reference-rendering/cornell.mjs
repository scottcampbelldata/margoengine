import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../browser.js';
import { decodePNG } from '../../tests/support/png.js';
import { pictureError, assertBudget } from './compare.mjs';
import { cornellPicture, cornellDecomposition } from './cornell-scene.mjs';
import { benchRoot, sha256, capturePathReference, readPathReference } from './path-reference.mjs';

const point = process.argv.includes('--point'),
  compat = process.argv.includes('--compat'),
  measure = process.argv.includes('--measure'),
  decompose = process.argv.includes('--decompose'),
  measureDecomposition = process.argv.includes('--measure-decomposition');
const family = point ? 'clustered-point' : 'clustered',
  out = join(benchRoot, 'batch-160', family),
  baselinePath = `docs/whitepaper/results/batch-160-${family}.json`,
  decompositionPath = `docs/whitepaper/results/batch-160-${family}-decomposition.json`;
assert.ok(!measure || !existsSync(baselinePath), '--measure cannot replace an established budget');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath)) : undefined;
if (!measure) assert.ok(baseline, 'Freeze the first measurements before checking them');
mkdirSync(out, { recursive: true });
const payload = cornellPicture(point),
  bytes = Buffer.from(JSON.stringify(payload, null, 2)),
  sceneSha256 = sha256(bytes);
if (baseline) assert.equal(sceneSha256, baseline.sceneSha256);
writeFileSync(join(out, 'scene.json'), bytes);
if (process.argv.includes('--capture-reference')) {
  const candidate = join(out, `candidate-${Date.now()}-${process.pid}`);
  mkdirSync(candidate, { recursive: true });
  copyFileSync(join(out, 'scene.json'), join(candidate, 'scene.json'));
  await capturePathReference(fileURLToPath(new URL('./mitsuba-cornell.py', import.meta.url)), candidate);
  readPathReference(candidate, 'mitsuba-direct', 512, 512, baseline?.reference);
  for (const suffix of ['-rgb.f32', '-meta.json', '.exr'])
    copyFileSync(join(candidate, 'mitsuba-direct' + suffix), join(out, 'mitsuba-direct' + suffix));
}
const reference = readPathReference(out, 'mitsuba-direct', 512, 512, baseline?.reference);
const context = await openBrowser({ startPath: '/scripts/reference-rendering/cornell.html', port: 'free' });
try {
  const { page } = context,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 512, height: 512 });
  await page.waitForFunction(() => window.renderCornell, null, { timeout: 30000 });
  const native = await page.evaluate(async (payload) => {
    try {
      await window.renderCornell(payload, true, 'webgl2');
      return null;
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  }, payload);
  assert.equal(native?.code, 'unsupported', 'Native WebGL2 must explicitly refuse clustered lighting');
  const rows = {};
  for (const shadowed of [false, true]) {
    const margo = await page.evaluate(({ payload, shadowed }) => window.renderCornell(payload, shadowed), {
      payload,
      shadowed,
    });
    assert.equal(margo.quads, 15);
    assert.deepEqual(errors, []);
    const png = Buffer.from(margo.png.split(',')[1], 'base64');
    delete margo.png;
    const mode = shadowed ? 'shadowed' : 'unshadowed',
      metrics = pictureError(await decodePNG(png), reference.image);
    writeFileSync(join(out, 'margo-' + mode + (compat ? '-compat' : '') + '.png'), png);
    if (baseline) assertBudget(metrics, compat ? baseline.compat.rows[mode].metrics : baseline.rows[mode].metrics);
    rows[mode] = { margo, metrics };
  }
  // KB3573: how much of the shadowed residual each model difference explains (diagnostic variants, frozen scene).
  let decomposition;
  if (decompose || measureDecomposition) {
    const frozen = existsSync(decompositionPath) ? JSON.parse(readFileSync(decompositionPath)) : undefined;
    assert.ok(!measureDecomposition || !frozen, '--measure-decomposition cannot replace an established decomposition');
    assert.ok(measureDecomposition || frozen, 'Record the decomposition with --measure-decomposition first');
    decomposition = {};
    for (const variant of cornellDecomposition(point)) {
      const { name, ...options } = variant,
        margo = await page.evaluate(({ payload, options }) => window.renderCornell(payload, true, 'webgpu', options), {
          payload,
          options,
        });
      assert.deepEqual(errors, []);
      const png = Buffer.from(margo.png.split(',')[1], 'base64'),
        metrics = pictureError(await decodePNG(png), reference.image);
      writeFileSync(join(out, 'margo-' + name + (compat ? '-compat' : '') + '.png'), png);
      // Every variant removes part of the frozen shadowed residual.
      assert.ok(metrics.absolute < rows.shadowed.metrics.absolute, `${name} does not lower the residual`);
      if (frozen) assertBudget(metrics, (compat ? frozen.compat : frozen.native)[name].metrics);
      decomposition[name] = { options, metrics };
    }
  }
  const { image, ...ref } = reference;
  const result = {
    family,
    domain:
      'All RGB pixels, PBR Neutral/sRGB; diffuse Cornell quads, no ambient/indirect, direct-only hard-visibility reference; unshadowed control and default LocalShadows separately',
    sceneSha256,
    settings: payload.settings,
    reference: ref,
    hardware: context.hardware,
    nativeWebGL2: native,
    rows,
  };
  writeFileSync(
    join(out, compat ? 'comparison-compat.json' : 'comparison.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  if (decomposition) {
    writeFileSync(
      join(out, compat ? 'decomposition-compat.json' : 'decomposition.json'),
      JSON.stringify(decomposition, null, 2) + '\n',
    );
    console.log('DECOMPOSITION', JSON.stringify(decomposition));
  }
  console.log('RESULT', JSON.stringify(result));
} finally {
  await context.close();
}
