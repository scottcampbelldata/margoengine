import assert from 'node:assert/strict';
import test from 'node:test';
import { gpuIdleWindow, GpuActivity } from '../scripts/support/gpu-activity.mjs';

test('a measured compile idle window is bounded by the existing hard hold limit', { timeout: 5000 }, () => {
  assert.equal(gpuIdleWindow(8), 180_000);
  assert.equal(gpuIdleWindow(8, 4), 240_000);
  assert.equal(gpuIdleWindow(2, 4), 120_000);
  for (const invalid of [0, -1, NaN, Infinity, '4']) {
    assert.throws(() => gpuIdleWindow(8, invalid), /MARGO_GPU_IDLE_MIN/);
    assert.throws(() => gpuIdleWindow(invalid), /hold minutes/);
  }
  const activity = new GpuActivity({ idleMs: gpuIdleWindow(8, 4) });
  const snapshot = (timestamp) => ({
    ok: true,
    processes: [{ pid: 100, parent: 1, birth: '1000' }],
    engineCount: 1,
    engines: [{ pid: 100, name: 'pid_100_gpu', running: '0', timestamp: String(timestamp) }],
  });
  activity.observe(snapshot(1), 100, 0);
  for (const at of [30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 194_050, 210_000])
    assert.equal(activity.observe(snapshot(at), 100, at).reclaim, false, `protected at ${at}`);
  assert.equal(activity.observe(snapshot(240_000), 100, 240_000).reclaim, true);
});
