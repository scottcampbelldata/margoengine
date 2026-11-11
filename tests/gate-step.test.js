// scripts/gate-step.mjs: a gate step's own time limit does not count time spent queued for the GPU, and a hard overall
// limit remains. Regression (sweep L6b, 2026-11-11): `timeout 1500 npm run check:readme-run` ran out while the step only
// waited for a gpu-lock slot (all 5 busy) and never ran a README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStep } from '../scripts/gate-step.mjs';

const node = (code) => [process.execPath, '-e', code];
// Leaves a marker for itself (as a waiting gpu-lock request does) for `wait` ms, removes it, then works `work` ms.
const queueThenWork = (wait, work) =>
  node(
    `const fs=require('fs'),p=require('path').join(process.env.MARGO_GPU_WAIT_MARKERS,'req');` +
      `fs.writeFileSync(p,String(process.pid));setTimeout(()=>{fs.rmSync(p);setTimeout(()=>{},${work})},${wait})`,
  );

test('time queued for the GPU does not count against the step limit', async () => {
  const started = Date.now();
  const result = await runStep(queueThenWork(2500, 300), { limitMs: 1500, waitMaxMs: 60_000 });
  assert.equal(result.code, 0, result.reason);
  assert.ok(Date.now() - started >= 2500, 'it waited the whole queue time');
  assert.ok(result.queued >= 2000, `queued ${result.queued} ms`);
  assert.ok(result.ran < 1500, `ran ${result.ran} ms`);
});

test('the step limit still ends a step that runs too long, with its children', async () => {
  const started = Date.now();
  const result = await runStep(node('setTimeout(()=>{},60000)'), { limitMs: 800, waitMaxMs: 60_000 });
  assert.equal(result.code, 124);
  assert.match(result.reason, /past its own limit of 0\.8 s/);
  assert.ok(Date.now() - started < 20_000, 'ended long before the command would have');
});

test('a step that waits forever ends at the hard overall limit', async () => {
  const result = await runStep(queueThenWork(60_000, 0), { limitMs: 500, waitMaxMs: 500, graceMs: 500 });
  assert.equal(result.code, 124);
  assert.match(result.reason, /past the wait limit|past the overall limit/);
});

test('a marker left by a dead waiter does not stop the clock', async () => {
  // The marker names a process that has already ended, as a killed gpu-lock request would leave it.
  const result = await runStep(
    node(
      `const fs=require('fs'),cp=require('child_process');const d=cp.spawnSync(process.execPath,['-e','0']);` +
        `fs.writeFileSync(require('path').join(process.env.MARGO_GPU_WAIT_MARKERS,'dead'),String(d.pid));setTimeout(()=>{},60000)`,
    ),
    { limitMs: 800, waitMaxMs: 60_000 },
  );
  assert.equal(result.code, 124);
  assert.match(result.reason, /past its own limit/);
});

test('gpu-lock leaves a marker while a request waits and removes it when the slot is taken', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gate-step-lock-')),
    markers = join(folder, 'markers'),
    saved = {
      lock: process.env.MARGO_GPU_LOCK,
      nested: process.env.MARGO_GPU_LOCK_NESTED,
      mk: process.env.MARGO_GPU_WAIT_MARKERS,
      slots: process.env.MARGO_GPU_SLOTS,
    };
  process.env.MARGO_GPU_LOCK = join(folder, 'gpu.lock');
  process.env.MARGO_GPU_LOCK_NESTED = '';
  // One slot: the second shared request queues behind the first.
  process.env.MARGO_GPU_SLOTS = '1';
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(markers);
    const gpu = await import('../scripts/gpu-lock.mjs?gate-step');
    const first = await gpu.acquire({ owner: 'holder', mode: 'shared', max: 1, command: 'hold', log: () => {} });
    process.env.MARGO_GPU_WAIT_MARKERS = markers;
    const second = gpu.acquire({ owner: 'waiter', mode: 'shared', max: 1, command: 'wait', poll: 20, log: () => {} });
    for (const end = Date.now() + 10_000; !readdirSync(markers).length; await new Promise((r) => setTimeout(r, 20)))
      assert.ok(Date.now() < end, 'the waiting request left a marker');
    first();
    const release = await second;
    assert.deepEqual(readdirSync(markers), [], 'the marker is gone once the slot is taken');
    release();
  } finally {
    for (const [key, value] of [
      ['MARGO_GPU_LOCK', saved.lock],
      ['MARGO_GPU_LOCK_NESTED', saved.nested],
      ['MARGO_GPU_WAIT_MARKERS', saved.mk],
      ['MARGO_GPU_SLOTS', saved.slots],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(folder, { recursive: true, force: true });
  }
});
