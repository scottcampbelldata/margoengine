import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../browser.js';
import { decodePNG } from '../../tests/support/png.js';
import { referenceCase } from './cases.mjs';
import { pictureError, assertBudget, edgeSplit } from './compare.mjs';
import { environmentScene } from './environment-scene.mjs';
import { benchRoot, sha256, capturePathReference, readPathReference } from './path-reference.mjs';

const out = join(benchRoot, 'batch-160/environment'),
  baselinePath = 'docs/whitepaper/results/batch-160-environment.json',
  decompositionPath = 'docs/whitepaper/results/batch-160-environment-decomposition.json',
  // KB3563: each reference removes one difference from the frozen direct comparison (mitsuba-environment-decompose.py).
  decompositionNames = [
    'principled-direct-1024',
    'principled-unoccluded-1024',
    'gltf-unoccluded-1024',
    'split-model-unoccluded-1024',
  ];
const measure = process.argv.includes('--measure'),
  compat = process.argv.includes('--compat'),
  measureDecomposition = process.argv.includes('--measure-decomposition'),
  decompose = measureDecomposition || process.argv.includes('--decompose');
assert.ok(!measure || !existsSync(baselinePath), '--measure cannot replace an established budget');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath)) : undefined;
if (!measure) assert.ok(baseline, 'Freeze the first measurements before checking them');
mkdirSync(out, { recursive: true });
const source = readFileSync(join(benchRoot, 'batch-160/MetalRoughSpheresNoTextures.glb'));
assert.equal(sha256(source), referenceCase('metallic-roughness').sourceSha256);
const scene = environmentScene(source),
  settings = scene.settings,
  sceneSha256 = sha256(scene.bytes);
if (baseline) assert.equal(sceneSha256, baseline.sceneSha256);
writeFileSync(join(out, 'scene.glb'), scene.bytes);
writeFileSync(join(out, 'settings.json'), JSON.stringify(settings));
if (process.argv.includes('--capture-reference')) {
  const candidate = join(out, `candidate-${Date.now()}-${process.pid}`);
  mkdirSync(candidate, { recursive: true });
  for (const file of ['scene.glb', 'settings.json']) copyFileSync(join(out, file), join(candidate, file));
  await capturePathReference(fileURLToPath(new URL('./mitsuba-environment.py', import.meta.url)), candidate);
  // Validate every candidate before changing any frozen artifact.
  for (const mode of ['direct', 'full'])
    readPathReference(candidate, 'mitsuba-' + mode, settings.width, settings.height, baseline?.rows[mode]);
  for (const mode of ['direct', 'full'])
    for (const suffix of ['-rgb.f32', '-meta.json', '.exr'])
      copyFileSync(join(candidate, 'mitsuba-' + mode + suffix), join(out, 'mitsuba-' + mode + suffix));
}
const decomposition = existsSync(decompositionPath) ? JSON.parse(readFileSync(decompositionPath)) : undefined;
assert.ok(!measureDecomposition || !decomposition, '--measure-decomposition cannot replace an established decomposition');
if (decompose && !measureDecomposition) assert.ok(decomposition, 'Record the decomposition with --measure-decomposition');
if (process.argv.includes('--capture-decomposition')) {
  // CUDA Mitsuba (the caller holds the GPU lock); validated against the frozen hashes before any file is replaced.
  const candidate = join(out, `decomposition-${Date.now()}-${process.pid}`);
  mkdirSync(candidate, { recursive: true });
  for (const file of ['scene.glb', 'settings.json']) copyFileSync(join(out, file), join(candidate, file));
  await capturePathReference(fileURLToPath(new URL('./mitsuba-environment-decompose.py', import.meta.url)), candidate);
  for (const name of decompositionNames)
    readPathReference(candidate, 'mitsuba-' + name, settings.width, settings.height, decomposition?.references[name]);
  for (const name of decompositionNames)
    for (const suffix of ['-rgb.f32', '-meta.json', '.exr'])
      copyFileSync(join(candidate, 'mitsuba-' + name + suffix), join(out, 'mitsuba-' + name + suffix));
}
const context = await openBrowser({ startPath: '/scripts/reference-rendering/environment.html', port: 'free' });
try {
  const { page } = context,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: settings.width, height: settings.height });
  await page.waitForFunction(() => window.renderEnvironment, null, { timeout: 30000 });
  const args = { bytes: Array.from(scene.bytes), settings };
  const native = await page.evaluate(async ({ bytes, settings }) => {
    try {
      await window.renderEnvironment(bytes, settings, 'webgl2');
      return null;
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  }, args);
  assert.equal(native?.code, 'unsupported', 'Native WebGL2 must explicitly refuse this PBR/IBL path');
  const margo = await page.evaluate(({ bytes, settings }) => window.renderEnvironment(bytes, settings), args);
  const png = Buffer.from(margo.png.split(',')[1], 'base64');
  delete margo.png;
  assert.deepEqual(errors, []);
  assert.equal(margo.primitives, 123);
  writeFileSync(join(out, compat ? 'margo-compat.png' : 'margo.png'), png);
  const actual = await decodePNG(png),
    rows = {};
  for (const mode of ['direct', 'full']) {
    const reference = readPathReference(out, 'mitsuba-' + mode, settings.width, settings.height, baseline?.rows[mode]);
    const metrics = pictureError(actual, reference.image);
    if (baseline) assertBudget(metrics, compat ? baseline.compat.rows[mode].metrics : baseline.rows[mode].metrics);
    const { image, ...metadata } = reference;
    rows[mode] = { ...metadata, metrics };
  }
  let split;
  if (decompose) {
    const frozen = readPathReference(out, 'mitsuba-direct', settings.width, settings.height, baseline?.rows.direct).image;
    split = { frozen: { ...rows.direct.metrics, ...edgeSplit(actual, frozen, frozen) } };
    for (const name of decompositionNames) {
      const reference = readPathReference(
        out,
        'mitsuba-' + name,
        settings.width,
        settings.height,
        decomposition?.references[name],
      );
      const metrics = { ...pictureError(actual, reference.image), ...edgeSplit(actual, reference.image, frozen) };
      if (decomposition) {
        const budget = (compat ? decomposition.compat : decomposition.native)[name];
        assertBudget(metrics, budget);
        for (const key of ['edge', 'flat']) assert.ok(metrics[key] <= budget[key], `${name} ${key} over its budget`);
      }
      const { image, ...metadata } = reference;
      split[name] = { reference: metadata, ...metrics };
    }
    writeFileSync(
      join(out, compat ? 'decomposition-compat.json' : 'decomposition.json'),
      JSON.stringify(split, null, 2) + '\n',
    );
    console.log('DECOMPOSITION', JSON.stringify(split));
  }
  const result = {
    family: 'environment',
    domain:
      'All RGB pixels, PBR Neutral/sRGB, constant radiance [0.3,0.5,0.7], black background, no direct sun; principled direct/full transport separately',
    sourceSha256: sha256(source),
    sceneSha256,
    settings,
    hardware: context.hardware,
    margo,
    nativeWebGL2: native,
    rows,
  };
  writeFileSync(
    join(out, compat ? 'comparison-compat.json' : 'comparison.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('RESULT', JSON.stringify(result));
} finally {
  await context.close();
}
