// GPU cost of gltf-pro's native glass tint draw (AC power, after npm run build:packages, GPU alone):
//   node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/tint-pass-gpu.mjs
// The same page and scene run three ways, by patching the served gltf-pro build. The repository's code is not changed.
//   surface   what ships: the tint draw reads the material's maps (surfaceTintPBR).
//   constant  the tint draw reads factors only (margoTintShare), as it did before a1f778bdc. Wrong for mapped glass; it
//             is here to price that fix.
//   off       no tint draw at all. Wrong for all glass; it is here to price the draw.
// Arms take turns inside each round so clock and heat drift falls on all of them alike. Each row is the median of the
// rounds. Rendered frames must differ the expected way, or the patch did nothing and the run fails.
// TINT_ROUNDS=1 gives a quick trial. Writes results/tint-pass-gpu.json.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { acPower } from './parts/power.mjs';
import { median as nearestMedian } from '../../scripts/lib/percentile.mjs';
import { assertPatchedOnce, patchChunk } from './parts/bundle-patch.mjs';

const ROUNDS = Number(process.env.TINT_ROUNDS ?? 5),
  FRAMES = 240,
  ARMS = ['surface', 'constant', 'off'],
  SIZES = [
    [1280, 720],
    [1920, 1080],
  ],
  SCENES = ['factors', 'four', 'eight'].flatMap((material) => [1, 4, 16].map((layers) => ({ material, layers })));
// Each pattern must match the built gltf-pro exactly once per page load, in whichever dist chunk holds it.
const patches = {
  surface: [],
  constant: [[/=([\w$]+)=>!!\1\.attenuation&&!\1\.shading/g, '=$1=>!1']],
  off: [[/if\([\w$]+\.tint\)\{let /g, 'if(0){let ']],
};
assert.notEqual(acPower(), false, 'run on AC power only');

const median = (values) => nearestMedian(values),
  round3 = (value) => +value.toFixed(3),
  meanLevel = (image) => {
    let sum = 0;
    for (let i = 0; i < image.data.length; i += 4) sum += image.data[i] + image.data[i + 1] + image.data[i + 2];
    return sum / (image.data.length * 0.75);
  };

const report = { benchmark: 'tint-pass-gpu', recordedAt: new Date().toISOString(), rounds: ROUNDS, frames: FRAMES };
try {
  report.quietGate = await waitForQuiet({ timeout: 180 });
} catch (error) {
  report.quietGate = { passed: false, timingsAreDiagnostic: true, reason: error.message };
}
report.cpuLoadAtStart = cpuLoad();

const context = await openBrowser({ startPath: '/LICENSE', port: 5273 }),
  { page, hardware } = context,
  pageErrors = [],
  samples = new Map(),
  levels = new Map();
report.hardware = hardware.webgpu;
report.browser = hardware.browserName + ' ' + hardware.browserVersion;
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
let arm = 'surface';
const matched = new Map();
await page.route('**/packages/gltf-pro/dist/*.js*', async (route) => {
  const response = await route.fetch();
  await route.fulfill({ response, body: patchChunk(await response.text(), patches[arm], matched) });
});
const key = (width, scene, name) => `${width}/${scene.material}/${scene.layers}/${name}`;
try {
  for (const [width, height] of SIZES)
    for (let round = 0; round < ROUNDS; round++)
      for (let turn = 0; turn < ARMS.length; turn++) {
        arm = ARMS[(turn + round) % ARMS.length];
        await page.setViewportSize({ width, height });
        matched.clear();
        await page.goto(
          `http://127.0.0.1:5273/examples/package-benchmarks/tint-pass.html?width=${width}&height=${height}`,
          {
            timeout: 120000,
          },
        );
        await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
        assertPatchedOnce(arm, patches[arm], matched);
        for (const scene of SCENES) {
          assert.deepEqual(await page.evaluate((s) => window.check.show(s), scene), [], key(width, scene, arm));
          const result = await page.evaluate((n) => window.check.measure(n), FRAMES);
          assert.deepEqual(result.errors, [], key(width, scene, arm));
          assert.ok(result.gpuSamples >= 10, `${key(width, scene, arm)}: no GPU timestamps`);
          const k = key(width, scene, arm);
          samples.set(k, [...(samples.get(k) ?? []), result]);
          if (round === 0)
            levels.set(
              k,
              meanLevel(await decodePNG(await page.getByRole('img', { name: 'Interactive 3D scene' }).screenshot())),
            );
        }
      }
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}

report.rows = [];
const problems = [];
for (const [width, height] of SIZES)
  for (const scene of SCENES) {
    const arms = Object.fromEntries(
        ARMS.map((name) => {
          const runs = samples.get(key(width, scene, name)),
            gpu = runs.map((r) => r.gpuMs);
          return [
            name,
            {
              gpuMs: round3(median(gpu)),
              gpuMsRange: [Math.min(...gpu), Math.max(...gpu)],
              frameMs: round3(median(runs.map((r) => r.frameMs))),
              meanLevel: +levels.get(key(width, scene, name)).toFixed(2),
            },
          ];
        }),
      ),
      { surface, constant, off } = arms,
      megapixelLayers = (width * height * scene.layers) / 1e6,
      row = {
        width,
        height,
        ...scene,
        ...arms,
        tintDrawMs: round3(surface.gpuMs - off.gpuMs),
        tintDrawMsPerMegapixelLayer: round3((surface.gpuMs - off.gpuMs) / megapixelLayers),
        tintDrawShareOfFrame: +((surface.gpuMs - off.gpuMs) / surface.gpuMs).toFixed(3),
        mapsOverConstantMs: round3(surface.gpuMs - constant.gpuMs),
      };
    report.rows.push(row);
    console.log(JSON.stringify(row));
    // The multiply darkens what is behind, so leaving it out must brighten the frame.
    if (off.meanLevel <= surface.meanLevel) problems.push(`${key(width, scene, 'off')}: no brighter than surface`);
    // Mapped glass passes less light than its factors say, so the two tints must disagree.
    if (scene.material !== 'factors' && Math.abs(constant.meanLevel - surface.meanLevel) < 1)
      problems.push(`${key(width, scene, 'constant')}: same frame as surface`);
  }
report.powerOnlineAfter = acPower();
assert.deepEqual(problems, [], 'an arm did not change the frame the expected way');
await writeFile(resolve(import.meta.dirname, 'results/tint-pass-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('tint pass benchmark done');
