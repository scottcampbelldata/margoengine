import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
