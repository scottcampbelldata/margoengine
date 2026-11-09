// Independent path-tracer validation of the exact pane oracle; frame timings are not collected here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { oitRivalPlugin } from './rival-oit-alias.mjs';
import { OIT_SCENE, srgbByte, tracePixel } from '../packages/oit/scripts/oit-scene.mjs';
import { decodePNG } from '../tests/support/png.js';

const external = join(process.env.MARGO_ENGINE_BENCH ?? 'C:\\Development\\Projects\\engine-bench', 'batch-168');
const out = join(external, 'data', 'oit-cycles');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'scene.json'), JSON.stringify(OIT_SCENE));
execFileSync(
  process.env.MARGO_BLENDER ?? 'C:\\blender\\blender.exe',
  [
    '--background',
    '--python',
    fileURLToPath(new URL('./rival-oit-cycles.py', import.meta.url)),
    '--',
    join(out, 'scene.json'),
    out,
  ],
  { cwd: external, timeout: 240_000, stdio: 'inherit', windowsHide: true },
);
const meta = JSON.parse(readFileSync(join(out, 'cycles-meta.json'), 'utf8'));
const floats = readFileSync(join(out, 'cycles-rgb.f32'));
assert.equal(floats.length, OIT_SCENE.width * OIT_SCENE.height * 12);
const reference = new Uint8Array(floats.length / 4);
for (let i = 0; i < reference.length; i++) reference[i] = srgbByte(floats.readFloatLE(i * 4));
const analytic = new Uint8Array(reference.length);
for (let y = 0; y < OIT_SCENE.height; y++)
  for (let x = 0; x < OIT_SCENE.width; x++) {
    analytic.set(tracePixel(OIT_SCENE, x, y).rgb, (y * OIT_SCENE.width + x) * 3);
  }
const metrics = (picture) => {
  let abs = 0,
    sq = 0,
    max = 0;
  for (let i = 0; i < reference.length; i++) {
    const d = Math.abs(picture[i] - reference[i]);
    abs += d;
    sq += d * d;
    max = Math.max(max, d);
  }
  return { mae: abs / reference.length, psnr: 10 * Math.log10((255 * 255) / (sq / reference.length)), max };
};
const oracle = metrics(analytic);
// This catches wrong colour units, camera axes and coverage setup before engine comparisons.
assert.ok(oracle.mae < 1, 'Cycles path trace must agree with the exact emission/coverage transport');
const modules = realpathSync.native(join(external, 'node_modules'));
const context = await openBrowser({
  startPath: '/scripts/rival-oit-page.html',
  port: 'free',
  plugins: [oitRivalPlugin(modules, realpathSync.native(process.cwd()))],
});
try {
  await context.page.waitForFunction(() => window.__rival, null, { timeout: 120_000 });
  const report = await context.page.evaluate(() => window.__rival);
  if (report.error) throw new Error(report.stack ?? report.error);
  const shots = await context.page.evaluate(() =>
    Array.from(document.querySelectorAll('canvas'), (c) => c.toDataURL('image/png')),
  );
  assert.equal(shots.length, 2);
  const engines = [];
  for (let i = 0; i < shots.length; i++) {
    const bytes = Buffer.from(shots[i].split(',')[1], 'base64');
    writeFileSync(join(out, `${i === 0 ? 'margo' : 'babylon'}.png`), bytes);
    const png = await decodePNG(bytes),
      rgb = new Uint8Array(reference.length);
    assert.equal(png.width, OIT_SCENE.width);
    assert.equal(png.height, OIT_SCENE.height);
    for (let p = 0; p < rgb.length / 3; p++)
      for (let c = 0; c < 3; c++) rgb[p * 3 + c] = srgbByte(png.data[p * 4 + c] / 255);
    engines.push(metrics(rgb));
  }
  const result = {
    ...meta,
    oracle,
    margo: engines[0],
    babylon: engines[1],
    centerCycles: Array.from(
      reference.subarray((360 * OIT_SCENE.width + 640) * 3, (360 * OIT_SCENE.width + 640) * 3 + 3),
    ),
    centerOracle: tracePixel(OIT_SCENE, 640, 360).rgb,
    note: 'common sRGB after readback; binary source palette; residual Cycles path noise and silhouette sampling differences; no timing row',
  };
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(result, null, 2));
  console.log(`RESULT ${JSON.stringify(result)}`);
} finally {
  await context.close();
}
