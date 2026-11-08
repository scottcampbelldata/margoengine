// scripts/support/cpu-budget.mjs: the clock behind every time budget in a unit test counts this thread's work and
// nothing else. A wall clock read 816.8 ms where this one read 39 ms, one biomes tile pinned to a CPU beside 7 busy
// processes, and a limit on it stopped an otherwise valid build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { cpuTimer } from '../scripts/support/cpu-budget.mjs';

/** Work until this thread has burned `ms` of CPU. */
function burn(ms) {
  const read = () => {
      const { user, system } = process.threadCpuUsage();
      return (user + system) / 1000;
    },
    end = read() + ms;
  while (read() < end);
}

test('a thread that is not running costs nothing', () => {
  const cpu = cpuTimer(),
    wall = performance.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const ms = cpu();
  assert.ok(performance.now() - wall >= 290);
  // Less than a third of the sleep: only the few ticks it takes to fall asleep and wake can land on this thread.
  assert.ok(ms < 100, `a 300 ms sleep read ${ms} ms of CPU`);
});

test('work on this thread counts, and another thread does not', async () => {
  const cpu = cpuTimer();
  burn(120);
  const ms = cpu();
  assert.ok(ms >= 100, `120 ms of work read ${ms} ms of CPU`);

  // A worker that spins until told to stop, while this thread sleeps.
  const stop = new Int32Array(new SharedArrayBuffer(4)),
    worker = new Worker(
      'const { workerData } = require("node:worker_threads"); while (!Atomics.load(workerData, 0));',
      { eval: true, workerData: stop },
    );
  await new Promise((resolve) => worker.once('online', resolve));
  const other = cpuTimer();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const read = other();
  Atomics.store(stop, 0, 1);
  await worker.terminate();
  assert.ok(read < 100, `a spinning worker added ${read} ms to this thread`);
});

test('MARGO_CPU_BUDGET_SLOWDOWN burns and reports that many times the work, so every budget can be shown to fire', () => {
  const url = new URL('../scripts/support/cpu-budget.mjs', import.meta.url).href,
    script = `import { cpuTimer } from ${JSON.stringify(url)};
      const read = () => { const { user, system } = process.threadCpuUsage(); return (user + system) / 1000; };
      const cpu = cpuTimer();
      for (const end = read() + 100; read() < end; );
      console.log(String(cpu()));`,
    run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, MARGO_CPU_BUDGET_SLOWDOWN: '5' },
    });
  assert.equal(run.status, 0, run.stderr);
  const ms = Number(run.stdout);
  assert.ok(ms >= 450, `100 ms of work at 5 times read ${ms} ms of CPU`);
});
