// `npm run modern:test:extensions`: the glTF extension, material and parity suites, one process each, in order. Every
// step has a hard time limit (runLimited: its whole process tree, browser and servers included, is ended at the limit
// and the step is named). The suites ran in one process with no limit before, so a wait that never ended (a
// getCompilationInfo() Chromium left pending, in material-extension-tests.js) held the run silently until the GPU
// lock's 30 minute limit. Limit per step: MARGO_GPU_TEST_TIMEOUT_MIN, default 10 minutes (scripts/support/run-limited.mjs).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLimited, testLimitMs } from './support/run-limited.mjs';

/**
 * The suites, in run order: each runs alone with `node <file>`. Written as `new URL` so check:merge's footprint follows
 * them into the packages they draw (scripts/support/affected-gpu.mjs scan); a plain path string reaches only the file.
 */
export const STEPS = [
  new URL('./modern-extension-tests.js', import.meta.url),
  new URL('./material-extension-tests.js', import.meta.url),
  new URL('./gltf-parity-tests.js', import.meta.url),
  new URL('./local-shadow-tests.js', import.meta.url),
  new URL('./deformed-picking-tests.js', import.meta.url),
  new URL('./silent-geometry-tests.js', import.meta.url),
  new URL('./pbr-box-tests.js', import.meta.url),
  new URL('./scene-helper-tests.js', import.meta.url),
  new URL('./core-parity-hooks-gpu-check.js', import.meta.url),
].map((url) => `scripts/${url.pathname.split('/').pop()}`);

/** Runs the steps in order and exits 1 at the first that fails or runs out of time, naming it. */
async function main() {
  const root = resolve(import.meta.dirname, '..'),
    limitMs = testLimitMs(undefined);
  for (const step of STEPS) {
    console.log(`modern:test:extensions: ${step}`);
    const result = await runLimited(`node ${step}`, { cwd: root, limitMs, label: `modern:test:extensions ${step}` });
    if (!result.ok) {
      console.error(result.message ?? `modern:test:extensions: ${step} failed after ${result.seconds} s`);
      process.exit(1);
    }
    console.log(`modern:test:extensions: ${step} passed in ${result.seconds} s`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
