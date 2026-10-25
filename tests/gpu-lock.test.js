// scripts/gpu-lock.mjs `run`: the command gets its arguments exactly as given (spaces and quotes survive, on Windows
// too, where cmd.exe starts it), and the nested marker covers only the lock being held, so a GPU test inside the
// landing lock still takes the GPU lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (lock, args, env = {}) =>
  spawnSync(process.execPath, ['scripts/gpu-lock.mjs', 'run', '--owner=test', '--', ...args], {
    encoding: 'utf8',
    env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...env },
  });

test('a quoted multi-word argument reaches the command intact', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'test.lock');
  try {
    const printer = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const out = run(lock, [process.execPath, '-e', printer, 'two words', 'a"quote', 'back\\slash\\', '50%']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), ['two words', 'a"quote', 'back\\slash\\', '50%']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Acquires the lock at `lock` in a child process whose nested marker is `nested`, and prints the lock's status.
const acquireUnder = (lock, nested) =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m = await import('./scripts/gpu-lock.mjs'); await m.acquire({ owner: 'child', poll: 10 }); console.log(JSON.stringify(m.status()));",
    ],
    { encoding: 'utf8', env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: nested } },
  );

test('the nested marker excuses only the held lock: a different lock is still taken', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    landing = join(folder, 'land.lock'),
    gpu = join(folder, 'gpu.lock');
  try {
    // A GPU test inside the landing lock's run: the GPU lock is really taken.
    const inside = acquireUnder(gpu, join(landing, 'nested'));
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(JSON.parse(inside.stdout.trim()).owner, 'child');
    rmSync(gpu, { recursive: true, force: true });
    // A child of the GPU lock's own run: already held, not taken again.
    const same = acquireUnder(gpu, join(gpu, 'nested'));
    assert.equal(same.status, 0, same.stderr);
    assert.equal(JSON.parse(same.stdout.trim()), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
