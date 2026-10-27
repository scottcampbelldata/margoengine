// Runs one GPU test command with a hard time limit (used by scripts/gpu-package-tests.mjs). A test that hangs would
// otherwise hold the GPU lock and block a whole check:merge until the overall limit; here its whole process tree
// (shell, node, browser, servers) is ended at the limit and the result names the test and the fix.
import { spawn } from 'node:child_process';
import { killTree } from '../gpu-lock.mjs';

/** Default limit for one GPU test, in minutes. The slowest real test takes under 5. */
export const DEFAULT_TEST_MINUTES = 10;

/**
 * The limit in milliseconds for one test: `MARGO_GPU_TEST_TIMEOUT_MIN` (all tests) wins over the package's own
 * `"margo": { "gpuTestTimeoutMinutes": n }` in its package.json, which wins over the default.
 */
export function testLimitMs(packageMinutes, env = process.env) {
  const value = env.MARGO_GPU_TEST_TIMEOUT_MIN ?? packageMinutes ?? DEFAULT_TEST_MINUTES;
  const minutes = Number(value);
  if (!(minutes > 0))
    throw new RangeError(
      `GPU test time limit must be a positive number of minutes, got ${JSON.stringify(value)}; set MARGO_GPU_TEST_TIMEOUT_MIN or "margo.gpuTestTimeoutMinutes" to a number such as 10`,
    );
  return Math.round(minutes * 60_000);
}

/**
 * Runs `command` in `cwd`, output passed through. Resolves `{ ok, timedOut, seconds, message? }`; past `limitMs` the
 * whole process tree is killed and `message` names `label` and how to raise the limit.
 */
export function runLimited(command, { cwd, env = process.env, limitMs, label = command }) {
  return new Promise((done) => {
    const t0 = performance.now();
    const windows = process.platform === 'win32';
    const child = spawn(command, { cwd, env, shell: true, stdio: 'inherit', detached: !windows });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, limitMs);
    const finish = (code) => {
      clearTimeout(timer);
      const seconds = Math.round((performance.now() - t0) / 100) / 10;
      done({
        ok: !timedOut && code === 0,
        timedOut,
        seconds,
        ...(timedOut && {
          message: `${label} hung: no result after ${Math.round(limitMs / 1000)} s, process tree killed; find the stuck step (page, server or await) and fix it, or raise the limit with MARGO_GPU_TEST_TIMEOUT_MIN or "margo.gpuTestTimeoutMinutes" in the package's package.json if the test is genuinely slower`,
        }),
      });
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
}
