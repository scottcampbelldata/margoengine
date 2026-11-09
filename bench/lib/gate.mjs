// The quiet-machine gate that runs before every benchmark run (docs/benchmarking.md "Quiet-machine rules"):
// 1. AC power (a laptop on battery throttles; refused unless BENCH_ALLOW_BATTERY=1, which marks the run invalid);
// 2. the GPU lock (scripts/gpu-lock.mjs), taken exclusively for any timed run: no correctness test shares the GPU or
//    the machine with a measurement. Held until the run ends;
// 3. an idle baseline: whole-machine CPU at or under --quiet-max % for --quiet-hold s (scripts/quiet-gate.mjs), and on
//    NVIDIA GPUs utilisation at or under --gpu-max % (nvidia-smi).
// Between cases `settle()` re-checks the CPU and waits again when another job has started.
import { acPower } from '../../examples/package-benchmarks/parts/power.mjs';
import { acquire, lockDir, status } from '../../scripts/gpu-lock.mjs';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { nvidiaSmi } from './env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until NVIDIA GPU utilisation stays at or under `max` % for 3 readings. `{ checked: false, reason }` when
 * nvidia-smi gives no reading (the reason is nvidia-smi's own failure); `smi` is the query (tests pass a stand-in).
 */
export async function gpuIdle(max, timeout, log, smi = nvidiaSmi) {
  const start = Date.now();
  for (;;) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const read = smi(),
        u = read.gpus.find((g) => Number.isFinite(g.utilizationPercent))?.utilizationPercent;
      if (u === undefined) return { checked: false, reason: read.error ?? 'nvidia-smi gave no utilisation reading' };
      samples.push(u);
      await sleep(1000);
    }
    if (Math.max(...samples) <= max) return { checked: true, utilizationPercent: samples };
    if (Date.now() - start > timeout * 1000) return { checked: true, utilizationPercent: samples, busy: true };
    log(`gate: GPU ${Math.max(...samples)}% busy (need <= ${max}%), waiting`);
    await sleep(10_000);
  }
}

/**
 * Runs the gate. Returns {record, invalid: string[], release()}; throws when the run must not start (battery, or the
 * machine never went quiet). `skip` (--no-gate) records the load instead and marks the run invalid.
 */
export async function openGate({ needsGpu, skip, quietMax, quietHold, gpuMax, timeout, owner, log }) {
  const invalid = [],
    ac = acPower();
  if (ac === false) {
    if (process.env.BENCH_ALLOW_BATTERY !== '1')
      throw new Error('On battery: plug in before timing runs (BENCH_ALLOW_BATTERY=1 records an invalid run anyway).');
    invalid.push('on battery');
  }
  const nested = !!process.env.MARGO_GPU_LOCK_NESTED;
  const release = await acquire({ owner, mode: 'exclusive', max: 20, log });
  // Results are committed: the lock's place, not this machine's path.
  const dir = lockDir.replaceAll('\\', '/').replace(/^.*\/(test-results\/gpu\.lock)$/, '<main checkout>/$1');
  const lock = nested ? { held: 'by the wrapping gpu-lock run', dir } : { ...status(), dir };
  let quiet;
  try {
    if (skip) {
      quiet = { skipped: true, cpuLoadPercent: cpuLoad(), checkedAt: new Date().toISOString() };
      invalid.push('quiet gate skipped (--no-gate)');
    } else {
      quiet = await waitForQuiet({ max: quietMax, hold: quietHold, timeout, log });
      if (needsGpu) {
        quiet.gpu = await gpuIdle(gpuMax, Math.min(timeout, 300), log);
        if (quiet.gpu.busy) invalid.push(`GPU busy (${quiet.gpu.utilizationPercent.join(', ')}%)`);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return {
    record: { ac, lock, quiet, rules: { quietMax, quietHold, gpuMax, timeout } },
    invalid,
    release,
  };
}

/** Between cases: the CPU load now; waits for quiet again (shorter hold) if it rose over the limit. */
export async function settle({ skip, quietMax, quietHold, timeout, log }) {
  const load = cpuLoad();
  if (skip || load <= quietMax) return { cpuLoadPercent: load, waitedSeconds: 0 };
  log(`gate: CPU ${load}% before the next case, waiting for quiet`);
  const quiet = await waitForQuiet({ max: quietMax, hold: Math.min(quietHold, 10), timeout, log });
  return { cpuLoadPercent: quiet.cpuLoadPercent, waitedSeconds: quiet.waitedSeconds };
}

export { acPower };
