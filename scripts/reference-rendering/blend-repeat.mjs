// Exact repeat regression, including separate browser processes. Run with the GPU lock held.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { compatRun } from '../support/compat-shim.js';
import { runSuite } from '../support/shutdown.mjs';
import { blendRepeatRoot, blendRepeatScene, sourceSha256 } from './blend-repeat-scene.mjs';

const value = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const api = value('api', 'webgpu'),
  frames = Number(value('frames', '200')),
  processes = Number(value('processes', '2')),
  samples = Number(value('samples', '4'));
assert.ok(['webgpu', 'webgl2'].includes(api), 'Choose --api=webgpu or --api=webgl2');
assert.ok(Number.isInteger(frames) && frames >= 2 && frames <= 4096, '--frames must be 2..4096');
assert.ok(Number.isInteger(processes) && processes >= 1 && processes <= 16, '--processes must be 1..16');
assert.ok([1, 4].includes(samples), '--samples must be 1 or 4');
assert.ok(!compatRun(), 'This diagnostic uses raw APIs; use --api=webgl2 rather than --compat');
const root = blendRepeatRoot(),
  data = await blendRepeatScene(root),
  out = join(root, 'determinism', `${api}-${samples}-${Date.now()}-${process.pid}`);
mkdirSync(out, { recursive: true });
const runs = [];
let first;
for (let processIndex = 0; processIndex < processes; processIndex++) {
  const context = await openBrowser({ startPath: '/scripts/reference-rendering/blend-repeat.html', port: 'free' });
  await runSuite(
    async () => {
      await context.page.waitForFunction(() => window.repeatBlend, null, { timeout: 30000 });
      let timer;
      try {
        const result = await Promise.race([
          context.page.evaluate(({ data, options }) => window.repeatBlend(data, options), {
            data,
            options: { api, frames, samples, first },
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Blend repeat exceeded its 120-second browser deadline')),
              120000,
            );
          }),
        ]);
        first ??= result.first;
        delete result.first;
        runs.push({ processIndex, hardware: context.hardware, ...result });
      } finally {
        clearTimeout(timer);
      }
    },
    () => context.close(),
  );
}
const hashes = new Set(runs.flatMap((run) => run.hashes)),
  report = { api, frames, processes, samples, sourceSha256, inputSha256: data.inputSha256, runs };
writeFileSync(join(out, 'repeat.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  'RESULT',
  JSON.stringify({
    api,
    samples,
    frames: frames * processes,
    variants: hashes.size,
    out,
    runs: runs.map(({ renderer, hashes, differences, errors }) => ({
      renderer,
      variants: new Set(hashes).size,
      differences: differences.map(({ frame, diff }) => ({ frame, count: diff.length, first: diff[0] })),
      errors,
    })),
  }),
);
assert.equal(hashes.size, 1, 'Identical blend draws must produce identical bytes in every frame and process');
