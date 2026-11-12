// KB-L6b-mb: the gpu-lock mutex heartbeat worker touched its owner directory while the main thread removed it. On
// Windows that touch fails with EPERM (delete pending), the worker rethrew it, and its error ended the gpu-lock process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  OWNER_ABSENT,
  OWNER_PRESENT,
  OWNER_TOUCHING,
  ownerPresent,
  ownerState,
  quiesceOwner,
  touchOwner,
} from '../scripts/support/gpu-mutex-beat.mjs';

test('the heartbeat touches the owner directory only while it exists, and its removal waits out a touch', () => {
  const state = ownerState();
  let touches = 0;
  assert.equal(touchOwner(state, 'owner', () => touches++), false, 'no directory before the critical section');
  ownerPresent(state);
  const waits = [];
  const stop = new Error('stop waiting');
  assert.equal(
    touchOwner(state, 'owner', () => {
      touches++;
      assert.equal(Atomics.load(state, 0), OWNER_TOUCHING);
      // A removal that starts now must wait for this touch to finish.
      assert.throws(
        () =>
          quiesceOwner(state, (expected) => {
            waits.push(expected);
            throw stop;
          }),
        (error) => error === stop,
      );
      assert.equal(Atomics.load(state, 0), OWNER_TOUCHING, 'the removal did not take the directory mid touch');
    }),
    true,
  );
  assert.deepEqual(waits, [OWNER_TOUCHING]);
  assert.equal(Atomics.load(state, 0), OWNER_PRESENT);
  quiesceOwner(state, () => assert.fail('nothing to wait for'));
  assert.equal(Atomics.load(state, 0), OWNER_ABSENT);
  assert.equal(touchOwner(state, 'owner', () => touches++), false, 'no touch once the removal has begun');
  assert.equal(touches, 1);
});

test('a touch that fails for a real reason still surfaces and leaves the directory removable', () => {
  const state = ownerState();
  ownerPresent(state);
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  assert.throws(
    () =>
      touchOwner(state, 'owner', () => {
        throw denied;
      }),
    (error) => error === denied,
  );
  assert.equal(Atomics.load(state, 0), OWNER_PRESENT);
  quiesceOwner(state, () => assert.fail('the failed touch is over'));
});

test('the real heartbeat worker survives thousands of owner directory create and remove cycles', { timeout: 60_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-mutex-beat-')),
    path = join(folder, 'owner'),
    state = ownerState();
  const worker = new Worker(new URL('../scripts/support/gpu-mutex-beat.mjs', import.meta.url), {
    workerData: { path, state, intervalMs: 0 },
    execArgv: [],
  });
  const errors = [];
  worker.on('error', (error) => errors.push(error));
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    for (let cycle = 0; cycle < 3_000 && !errors.length; cycle++) {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), '{}');
      ownerPresent(state);
      // Give the worker's 1 ms timer a chance to land inside the window, as a busy critical section would.
      if (cycle % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      quiesceOwner(state);
      rmSync(path, { recursive: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(errors.map((error) => error.code ?? error.message), []);
  } finally {
    await worker.terminate();
    rmSync(folder, { recursive: true, force: true });
  }
});
