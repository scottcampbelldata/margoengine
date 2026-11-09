// Fake lock folders only: exercise active scheduler policy without running speed work.
process.env.MARGO_SPEED_PHASE = 'active';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { endTree } from '../scripts/support/shutdown.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (predicate) => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'mutex process handshake exceeded 30 seconds');
    await sleep(10);
  }
};

test('a paused live mutex owner is published atomically and cannot be reclaimed because of age', {
  timeout: 45_000,
}, async () => {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/gpu-mutex-owner-'));
  const children = [];
  const start = (role) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MARGO_GPU_')));
    Object.assign(env, { MARGO_GPU_LOCK: join(folder, 'gpu.lock'), MARGO_GPU_FRESH_MS: '0' });
    const child = spawn(process.execPath, ['tests/fixtures/gpu-mutex-owner.mjs', role, folder], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  };
  try {
    const holder = start('holder');
    await until(() => existsSync(join(folder, 'paused.json')));
    const contender = start('contender');
    await until(() => contender.exitCode !== null);
    const result = JSON.parse(readFileSync(join(folder, 'contender.json'), 'utf8'));
    assert.equal(result.acquired, false, 'another requester must not enter the paused critical section');
    const paused = JSON.parse(readFileSync(join(folder, 'paused.json'), 'utf8'));
    assert.equal(paused.owner?.pid, holder.pid, 'the mutex is never visible without its owner identity');
    assert.equal(result.code, 'ERR_GPU_MUTEX_WAIT_TIMEOUT');
    const heartbeat = start('heartbeat');
    await until(() => heartbeat.exitCode !== null);
    assert.equal(heartbeat.exitCode, 0, 'mtime is renewed even while the owning thread is paused');
    assert.equal(holder.exitCode, null);
    writeFileSync(join(folder, 'resume'), '');
    await until(() => holder.exitCode !== null);
    assert.equal(holder.exitCode, 0, 'the original owner resumes and releases its own mutex');
    assert.equal(JSON.parse(readFileSync(join(folder, 'holder.json'), 'utf8')).acquired, true);
  } finally {
    writeFileSync(join(folder, 'resume'), '');
    for (const child of children) if (child.exitCode === null) await endTree(child.pid);
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an aged anonymous legacy mutex waits for its owner instead of being stolen', { timeout: 15_000 }, async () => {
  const folder = mkdtempSync(resolve('test-results/gpu-mutex-legacy-'));
  const lock = join(folder, 'gpu.lock');
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('MARGO_GPU_')) delete process.env[key];
  Object.assign(process.env, { MARGO_GPU_LOCK: lock, MARGO_GPU_FRESH_MS: '0' });
  try {
    mkdirSync(join(lock, 'mutex'), { recursive: true });
    const old = new Date(Date.now() - 20_000);
    utimesSync(join(lock, 'mutex'), old, old);
    const gpu = await import('../scripts/gpu-lock.mjs?anonymous-mutex');
    await assert.rejects(gpu.acquire({ owner: 'legacy-neighbor', waitMax: 0.001, poll: 1 }), {
      code: 'ERR_GPU_MUTEX_WAIT_TIMEOUT',
    });
    assert.ok(existsSync(join(lock, 'mutex')), 'the anonymous owner alone can release its mutex');
    rmSync(join(lock, 'mutex'), { recursive: true }); // fixture owner releases its own entry
    (await gpu.acquire({ owner: 'after-legacy-release', waitMax: 0.1 }))();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(folder, { recursive: true, force: true });
  }
});
