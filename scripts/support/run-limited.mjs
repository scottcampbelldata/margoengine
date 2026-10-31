// Runs one GPU test command with a hard time limit (used by scripts/gpu-package-tests.mjs). A test that hangs would
// otherwise hold the GPU lock and block a whole check:merge until the overall limit; here its whole process tree
// (shell, node, browser, servers) is ended at the limit and the result names the test and the fix.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { killTree } from '../gpu-lock.mjs';

/** Default limit for one GPU test, in minutes. The slowest real test takes under 5. */
export const DEFAULT_TEST_MINUTES = 10;

/**
 * The minutes a package sets for one of its scripts: `"margo": { "gpuTestTimeoutMinutes": n }` applies to every script,
 * and `{ "<script>": n, "default": m }` sets it per script (a script not listed gets `default`, or the global default).
 */
export function packageMinutes(setting, script) {
  if (setting !== null && typeof setting === 'object') return setting[script] ?? setting.default;
  return setting;
}

/**
 * The limit in milliseconds for one test: `MARGO_GPU_TEST_TIMEOUT_MIN` (all tests) wins over the package's own
 * `"margo": { "gpuTestTimeoutMinutes": n }` in its package.json (a number, or an object per script, see
 * `packageMinutes`), which wins over the default.
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
 * Runs `command` in `cwd`, output passed through. Resolves `{ ok, timedOut, aborted, seconds, message? }`; past
 * `limitMs` the whole process tree is killed and `message` names `label` and how to raise the limit. When `signal`
 * aborts (the heat watch, scripts/support/heat.mjs; a stopped side-by-side run) the tree is killed too and `aborted` is
 * true: the caller states why. With `logFile` the output is appended there instead of passed through, so suites running
 * side by side keep their logs apart.
 */
export function runLimited(command, { cwd, env = process.env, limitMs, label = command, signal, logFile }) {
  return new Promise((done) => {
    const t0 = performance.now();
    const windows = process.platform === 'win32';
    const log = logFile ? openSync(logFile, 'a') : null;
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: log === null ? 'inherit' : ['ignore', log, log],
      detached: !windows,
    });
    if (log !== null) closeSync(log);
    let timedOut = false,
      aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, limitMs);
    const abort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const seconds = Math.round((performance.now() - t0) / 100) / 10;
      done({
        ok: !timedOut && !aborted && code === 0,
        timedOut,
        aborted,
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
