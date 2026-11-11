// Public bpy API only; CPU reference, no third-party renderer source. Images stay in engine-bench.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceCase } from './cases.mjs';
import { displayImage } from './transport-image.mjs';
import { pictureError, assertBudget } from './compare.mjs';
import { saveReference } from './reference.mjs';
import { encodePNG } from '../support/visual-image.js';
import { decodePNG } from '../../tests/support/png.js';

const family = process.argv.find((x) => x.startsWith('--case='))?.slice(7);
assert.ok(['transmission', 'volume'].includes(family), 'Choose --case=transmission or --case=volume');
const entry = referenceCase(family),
  { width, height } = entry.settings;
const out = join(
  process.env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../../engine-bench', import.meta.url)),
  'batch-160',
  family,
);
const baselinePath = `docs/whitepaper/results/batch-160-${family}-transport.json`;
const measure = process.argv.includes('--measure');
assert.ok(!measure || !existsSync(baselinePath), '--measure cannot replace an established budget');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath)) : undefined;
if (!measure) assert.ok(baseline, 'Collect and freeze a new scene first');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sceneSha256 = sha256(readFileSync(join(out, 'scene.glb')));
const source = JSON.parse(readFileSync(join(out, 'comparison.json')));
assert.equal(source.sceneSha256, sceneSha256, 'Render the current shared scene first');
assert.equal(source.sourceSha256, entry.sourceSha256);
if (baseline) assert.equal(sceneSha256, baseline.sceneSha256);

async function capture(candidate, direct) {
  const args = [
    '--background',
    '--python',
    fileURLToPath(new URL('./cycles-gltf.py', import.meta.url)),
    '--',
    candidate,
  ];
  if (direct) args.push('--direct');
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.MARGO_BLENDER ?? 'C:/blender/blender.exe', args, {
      windowsHide: true,
      cwd: candidate,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      reject(new Error('Cycles reference exceeded its 20-minute process-tree deadline'));
    }, 20 * 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Cycles exited ${code}`));
    });
  });
}

const rows = {};
for (const mode of ['full', 'direct']) {
  const prefix = mode === 'full' ? 'cycles' : 'cycles-direct';
  if (process.argv.includes('--capture')) {
    const candidate = join(out, 'trace-candidate');
    mkdirSync(candidate, { recursive: true });
    for (const file of ['scene.glb', 'viewer-metadata.json']) copyFileSync(join(out, file), join(candidate, file));
    await capture(candidate, mode === 'direct');
    const floats = readFileSync(join(candidate, `${prefix}-rgb.f32`));
    if (baseline)
      assert.equal(
        sha256(floats),
        baseline.rows[mode].linearSha256,
        'Outside linear reference changed; frozen files preserved',
      );
    const picture = encodePNG(displayImage(floats, width, height));
    saveReference(join(out, `${prefix}.png`), picture, baseline?.rows[mode].referenceSha256);
    for (const suffix of ['.exr', '-rgb.f32', '-meta.json'])
      copyFileSync(join(candidate, prefix + suffix), join(out, prefix + suffix));
  }
  const floats = readFileSync(join(out, `${prefix}-rgb.f32`));
  const picture = encodePNG(displayImage(floats, width, height));
  const referenceSha256 = sha256(picture),
    linearSha256 = sha256(floats);
  if (baseline) {
    assert.equal(referenceSha256, baseline.rows[mode].referenceSha256);
    assert.equal(linearSha256, baseline.rows[mode].linearSha256);
  }
  saveReference(join(out, `${prefix}.png`), picture, baseline?.rows[mode].referenceSha256);
  const reference = await decodePNG(picture);
  const metrics = pictureError(await decodePNG(readFileSync(join(out, 'margo.png'))), reference);
  const compat = { metrics: pictureError(await decodePNG(readFileSync(join(out, 'margo-compat.png'))), reference) };
  if (!measure) {
    assertBudget(metrics, baseline.rows[mode].metrics);
    assertBudget(compat.metrics, baseline.rows[mode].compat.metrics);
  }
  rows[mode] = {
    referenceSha256,
    linearSha256,
    meta: JSON.parse(readFileSync(join(out, `${prefix}-meta.json`))),
    metrics,
    compat,
  };
}
const result = {
  family,
  domain:
    'All RGB pixels, neutral/sRGB; black world, fixed radiometric sun 3; full transport and direct-lit refraction control separately',
  sourceSha256: entry.sourceSha256,
  sceneSha256,
  width,
  height,
  rows,
};
writeFileSync(join(out, 'transport-comparison.json'), JSON.stringify(result, null, 2) + '\n');
console.log('RESULT', JSON.stringify(result));
