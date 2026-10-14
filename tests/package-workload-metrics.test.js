import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize, missedFrameRows} from '../scripts/benchmark-package-workloads.js';

test('render callback statistics retain long gaps and exclude pause/warmup boundaries', () => {
  const result = summarize([50, 0, 1, 2, 110, 20, 2, 3, 130, 20, 4, 5, 330, 200, 6, 7, 340, 10, 8, 9, 400, 0, 1, 1], 100, 350);
  assert.equal(result.callbacks, 3); assert.equal(result.measuredMilliseconds, 230); assert.equal(result.callbackHz, 3000 / 230);
  assert.deepEqual(result.intervalMilliseconds, {mean: 230 / 3, median: 20, p95: 200, p99: 200, max: 200});
  assert.equal(result.workloadCpuMilliseconds.mean, 6); assert.equal(result.renderCpuMilliseconds.mean, 7);
  assert.equal(result.intervalsAbove60HzBudget, 2);
});

test('empty, malformed and invalid timing data never report invented FPS', () => {
  assert.equal(summarize([], 0, 100).callbackHz, null);
  assert.equal(summarize([10, 0, 1, 1], 0, 100).intervalMilliseconds, null);
  assert.throws(() => summarize([10, 20, 1], 0, 100), /Incomplete/);
  assert.throws(() => summarize([10, -20, 1, 1], 0, 100), /Invalid/);
  assert.throws(() => summarize([10, 20, NaN, 1], 0, 100), /Invalid/);
});

test('missed-frame diagnostics retain the preceding CPU callback and merge overlapping neighbors', () => {
  const samples = [90, 10, 1, 2, 100, 10, 3, 40, 160, 60, 0.1, 0.2, 180, 20, 0.3, 0.4, 190, 10, 1, 2, 230, 40, 1, 2];
  assert.deepEqual(missedFrameRows(samples, 100, 200), [
    {callbackAt: 100, intervalMilliseconds: 10, workloadCpuMilliseconds: 3, renderCpuMilliseconds: 40},
    {callbackAt: 160, intervalMilliseconds: 60, workloadCpuMilliseconds: 0.1, renderCpuMilliseconds: 0.2},
    {callbackAt: 180, intervalMilliseconds: 20, workloadCpuMilliseconds: 0.3, renderCpuMilliseconds: 0.4},
    {callbackAt: 190, intervalMilliseconds: 10, workloadCpuMilliseconds: 1, renderCpuMilliseconds: 2}
  ]);
  assert.deepEqual(missedFrameRows([100, 80, 1, 2, 110, 10, 1, 2], 90, 120), []);
  assert.throws(() => missedFrameRows([100, 20, 1], 0, 200), /Incomplete/);
});
