import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { GpuActivity, monitorGpuLease } from '../scripts/support/gpu-activity.mjs';
import { observeUsage, readUsage } from '../scripts/support/gpu-admission.mjs';

test('the first incomplete usage append is not parsed as a published observation', { timeout: 5000 }, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-usage-partial-'));
  const file = resolve(folder, 'usage.jsonl');
  try {
    writeFileSync(file, '{"freeSlotWaitMs":');
    assert.equal(readUsage(file, 100).freeSlotWaitMs, 0);
    observeUsage(file, { shared: [], waiting: [{}] }, 3, 110);
    assert.equal(readUsage(file, 120).freeSlotWaitMs, 10, 'a new writer can publish after a crashed partial append');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a failed idle confirmation resets the idle window before any later reclaim', { timeout: 5000 }, async () => {
  const snapshot = (timestamp) => ({
    ok: true,
    processes: [{ pid: 100, parent: 1, birth: '1000' }],
    engineCount: 1,
    engines: [{ pid: 100, name: 'pid_100_gpu', running: '0', timestamp: String(timestamp) }],
  });
  const activity = new GpuActivity({ idleMs: 10 });
  activity.observe(snapshot(1), 100, 0);
  let count = 0;
  const states = [];
  const options = {
    activity,
    pid: 100,
    token: 'ours',
    readEntry: () => ({ token: 'ours' }),
    query: async () => (++count === 2 ? { ok: false, error: 'missing confirmation' } : snapshot(count + 1)),
    now: () => count * 10,
    publish: ({ state }) => states.push(state),
    terminate: () => assert.fail('unknown interval cannot justify a kill'),
    report() {},
    release: () => assert.fail('unknown interval cannot release'),
  };
  await monitorGpuLease(options);
  assert.equal(activity.idleSince, null, 'unknown confirmation must reset the clock');
  await monitorGpuLease(options);
  assert.deepEqual(states, ['idle', 'unknown', 'unknown']);
});

test('a withdrawn last waiter stops the free-slot wait clock', { timeout: 15000 }, async () => {
  const folder = mkdtempSync(resolve('test-results/gpu-withdraw-accounting-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('MARGO_GPU_')) delete process.env[key];
  process.env.MARGO_GPU_LOCK = resolve(folder, 'gpu.lock');
  process.env.MARGO_GPU_FRESH_MS = '0';
  let release;
  try {
    const gpu = await import(`../scripts/gpu-lock.mjs?withdraw=${Date.now()}`);
    release = await gpu.acquire({ owner: 'lane-G/held', max: 1, log() {} });
    await assert.rejects(
      gpu.acquire({ owner: 'lane-G/withdraw', waitMax: 0.001, max: 1, poll: 1, log() {} }),
      /gave up/,
    );
    const state = gpu.status();
    assert.equal(state.waiting, undefined);
    assert.equal(state.usage.waiting, 0, 'no free-slot wait can accumulate after the final waiter leaves');
  } finally {
    release?.();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(folder, { recursive: true, force: true });
  }
});
