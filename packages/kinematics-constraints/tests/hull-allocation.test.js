// The measurement runs in a fresh process (support/hull-allocation-probe.mjs, started by support/allocation-probe.js):
// an override installed by another test (hull.test.js has several) makes the solver's calls megamorphic, which is not
// how a game runs. It does mix array types, as callers do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllocationProbe } from './support/allocation-probe.js';

// Regression (2026-11-07): the segment shape failed under a full verify run at about 66 KB per window against 64 KB,
// the same driver garbage as tests/capsule-allocation.test.js: each window started its driver in the interpreter. The
// probe now runs each driver until it has Turbofan code before measuring, with --no-concurrent-recompilation.
test('hull queries and hull solves allocate nothing per call', { timeout: 300_000 }, (t) => {
  for (const { name, clean, windows, status } of runAllocationProbe('hull')) {
    // Bit 64 of %GetOptimizationStatus: the driver runs Turbofan code, so the windows measured the kernel's steady state.
    assert.ok(status & 64, `${name}: the driver never reached Turbofan (status ${status})`);
    assert.ok(clean, `${name}: every window of 20,000 allocated: ${JSON.stringify(windows)}`);
    t.diagnostic(`${name}: ${windows.at(-1).grown} B over 20,000`);
  }
});
