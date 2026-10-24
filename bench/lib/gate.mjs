// The quiet-machine gate that runs before every benchmark run (docs/benchmarking.md "Quiet-machine rules"):
// 1. AC power (a laptop on battery throttles; refused unless BENCH_ALLOW_BATTERY=1, which marks the run invalid);
// 2. the GPU lock (scripts/gpu-lock.mjs) for any suite that uses the GPU, held until the run ends;
// 3. an idle baseline: whole-machine CPU at or under --quiet-max % for --quiet-hold s (scripts/quiet-gate.mjs), and on
//    NVIDIA GPUs utilisation at or under --gpu-max % (nvidia-smi).
// Between cases `settle()` re-checks the CPU and waits again when another job has started.
import { acPower } from '../../examples/package-benchmarks/cad/power.mjs';
import { acquire, lockDir, status } from '../../scripts/gpu-lock.mjs';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { gpus } from './env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gpuIdle(max, timeout, log) {
  const start = Date.now();
  for (;;) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const u = gpus().find((g) => Number.isFinite(g.utilizationPercent))?.utilizationPercent;
      if (u === undefined) return { checked: false };
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
  let release = () => {},
    lock = null;
  if (needsGpu) {
    const nested = !!process.env.MARGO_GPU_LOCK_NESTED;
    release = await acquire({ owner, log });
    lock = nested ? { held: 'by the wrapping gpu-lock run', dir: lockDir } : { ...status(), dir: lockDir };
  }
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
