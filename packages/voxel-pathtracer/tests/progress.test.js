// The browser check's GPU stall watch (tests/progress.mjs) on a stand-in page, CPU only. A pipeline compile in flight
// is a wait on the shader compiler, not a GPU wait that never resolves: on the WebGL2 layer over ANGLE Direct3D 11 the
// first tracer's cold fxc compiles held the page for over 10 s and test:gpu:stall's 10 s limit fired before its first
// render (MARGO_COMPAT=1, 2026-11-16). Such a wait is held to the compile limit instead, and is still bounded by it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileLimitMs, watched } from './progress.mjs';

// A page whose progress never moves: what the page answered last, as the watch reads it.
const page = (compiling) => ({
  evaluate: async () => ({
    events: 0,
    submits: 0,
    renders: 0,
    rendered: 0,
    stage: '',
    lost: '',
    error: '',
    compiling,
    count: 0,
  }),
});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const never = new Promise(() => {});

test('a case waiting on a pipeline compile is not a GPU stall within the compile limit', async () => {
  const value = await watched(page(2), 'compiling', after(3200, 'done'), { stallMs: 1500, compileMs: 60_000 });
  assert.equal(value, 'done');
});

test('a case with no compile in flight and no GPU work finishing fails at the stall limit', async () => {
  await assert.rejects(
    watched(page(0), 'stalled', never, { stallMs: 1500, compileMs: 60_000 }),
    /stalled: GPU stall, no GPU work finished for \d+ s \(limit 1\.5 s, .*0 pipelines compiling/,
  );
});

test('a compile that does not finish still fails, at the compile limit', async () => {
  await assert.rejects(
    watched(page(1), 'compile', never, { stallMs: 1000, compileMs: 2500 }),
    /compile: GPU stall, no GPU work finished for \d+ s \(limit 2\.5 s, .*1 pipelines compiling/,
  );
});

test('the compile limit is MARGO_GPU_COMPILE_MIN minutes, 3 by default', () => {
  assert.equal(compileLimitMs(undefined), 180_000);
  assert.equal(compileLimitMs('20'), 1_200_000);
  assert.throws(() => compileLimitMs('0'), RangeError);
});
