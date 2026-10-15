import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

process.env.MARGO_GPU_LOCK = join(mkdtempSync(join(tmpdir(), 'gpu-lock-')), 'gpu.lock');
const {acquire, status, lockDir} = await import('../scripts/gpu-lock.mjs');

test('one holder at a time; release only removes our own lock; dead holders are taken over', async () => {
  const release = await acquire({owner: 'a', poll: 10});
  assert.equal(status().owner, 'a');
  let second = false;
  const waiting = acquire({owner: 'b', poll: 10, log() {}}).then(r => {second = true; return r;});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(second, false, 'b waits while a holds the lock');
  release();
  const releaseB = await waiting;
  assert.equal(status().owner, 'b');
  release();
  assert.equal(status().owner, 'b', "a's stale release must not remove b's lock");
  releaseB();
  assert.equal(existsSync(lockDir), false);

  mkdirSync(lockDir); writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({owner: 'ghost', pid: 2 ** 30, token: 'x'}));
  const releaseC = await acquire({owner: 'c', poll: 10, log() {}});
  assert.equal(status().owner, 'c', 'a lock whose process is gone is taken over');
  releaseC();
});

test('run: a wrapped script that takes the lock itself finishes instead of waiting on its parent', () => {
  // The self-locking pattern of scripts/visual-regression.js and the GPU benchmarks.
  const child = `const {mkdirSync, rmSync} = require('node:fs'); const lock = process.env.MARGO_GPU_LOCK_NESTED ?? process.env.MARGO_GPU_LOCK;
    for (let i = 0; ; i++) {try {mkdirSync(lock); break;} catch (e) {if (i > 20) process.exit(3); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);}}
    rmSync(lock, {recursive: true, force: true});`;
  const script = join(mkdtempSync(join(tmpdir(), 'gpu-lock-child-')), 'child.cjs'); writeFileSync(script, child);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/gpu-lock.mjs', import.meta.url)), 'run', '--owner=t', '--', 'node', script],
    {encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(lockDir), false, 'the lock is released afterwards');
});
