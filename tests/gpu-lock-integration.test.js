import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

let imports = 0;

async function pendingMutex(t, body) {
  const folder = fs.mkdtempSync(join(tmpdir(), 'gpu-mutex-integration-')),
    lock = join(folder, 'gpu.lock'),
    saved = { ...process.env },
    pending = new Set(),
    mkdir = fs.mkdirSync,
    remove = fs.rmSync;
  Object.assign(process.env, {
    MARGO_GPU_LOCK: lock,
    MARGO_GPU_LOCK_NESTED: '',
    MARGO_GPU_EXCLUSIVE: '',
    MARGO_GPU_FRESH_MS: '0',
  });
  // The real Win32 pending-deletion contract is proved by gpu-lock-mutex.test.js.
  // Model only mutex names here, then exercise acquisition, release and reclamation together.
  t.mock.method(fs, 'mkdirSync', (path, options) => {
    if (pending.has(resolve(path))) throw Object.assign(new Error('pending mutex deletion'), { code: 'EPERM' });
    return mkdir(path, options);
  });
  t.mock.method(fs, 'rmSync', (path, options) => {
    remove(path, options);
    if (basename(path).startsWith('mutex')) pending.add(resolve(path));
  });
  syncBuiltinESMExports();
  try {
    const gpu = await import(`../scripts/gpu-lock.mjs?integration=${imports++}`);
    const take = (owner) => gpu.acquire({ owner, mode: 'shared', poll: 1, waitMax: 0.1, max: 1, log() {} });
    await body(gpu, take);
    assert.equal(gpu.status(), null);
    assert.deepEqual(fs.readdirSync(folder), [], 'release removes all retired names and the empty lock');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    remove(folder, { recursive: true, force: true });
  }
}

test('mutex retirement preserves live shared holders through another acquire and release', { timeout: 15000 }, (t) =>
  pendingMutex(t, async (gpu, take) => {
    const first = await take('first'),
      second = await take('second');
    first();
    const third = await take('third');
    assert.deepEqual(
      gpu
        .status()
        .holders.map((holder) => holder.owner)
        .sort(),
      ['second', 'third'],
    );
    first();
    second();
    third();
  }),
);

for (const claimed of [false, true])
  test(`dead-owner mutex recovery retires its name (dead reclaimer: ${claimed})`, { timeout: 15000 }, (t) =>
    pendingMutex(t, async (gpu, take) => {
      const mutex = join(gpu.lockDir, 'mutex');
      fs.mkdirSync(gpu.lockDir, { recursive: true });
      const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
      assert.equal(dead.status, 0);
      const token = `${dead.pid}-dead`;
      const target = `${gpu.lockDir}-mutex-${token}`;
      fs.mkdirSync(target);
      fs.writeFileSync(
        join(target, claimed ? `reclaimed-${dead.pid}-dead.json` : 'owner.json'),
        JSON.stringify({ pid: dead.pid, token }),
      );
      fs.symlinkSync(target, mutex, process.platform === 'win32' ? 'junction' : 'dir');
      const old = new Date(Date.now() - 20000);
      fs.utimesSync(mutex, old, old);
      (await take('after-crash'))();
    }),
  );

test('a delayed dead-owner reclaimer cannot claim a replacement live owners metadata', { timeout: 15000 }, (t) =>
  pendingMutex(t, async (gpu) => {
    const mutex = join(gpu.lockDir, 'mutex');
    fs.mkdirSync(gpu.lockDir);
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
    assert.equal(dead.status, 0);
    const oldToken = `${dead.pid}-dead`;
    const oldTarget = `${gpu.lockDir}-mutex-${oldToken}`;
    const liveToken = `${process.pid}-replacement`;
    const liveTarget = `${gpu.lockDir}-mutex-${liveToken}`;
    for (const [target, pid, token] of [
      [oldTarget, dead.pid, oldToken],
      [liveTarget, process.pid, liveToken],
    ]) {
      fs.mkdirSync(target);
      fs.writeFileSync(join(target, 'owner.json'), JSON.stringify({ pid, token }));
    }
    const link = () => fs.symlinkSync(liveTarget, mutex, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(oldTarget, mutex, process.platform === 'win32' ? 'junction' : 'dir');
    const rename = fs.renameSync;
    let replaced = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (!replaced && basename(from) === 'owner.json') {
        replaced = true;
        rename(mutex, join(gpu.lockDir, 'mutex-other-reclaimer'));
        fs.rmSync(join(gpu.lockDir, 'mutex-other-reclaimer'), { recursive: true });
        fs.rmSync(oldTarget, { recursive: true });
        link();
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    await assert.rejects(gpu.acquire({ owner: 'delayed-reclaimer', waitMax: 0.001, poll: 1, log() {} }), {
      code: 'ERR_GPU_MUTEX_WAIT_TIMEOUT',
    });
    assert.equal(replaced, true);
    assert.equal(JSON.parse(fs.readFileSync(join(mutex, 'owner.json'))).token, liveToken);
    fs.rmSync(mutex, { recursive: true }); // fixture owner releases its own mutex
    fs.rmSync(liveTarget, { recursive: true });
    fs.rmdirSync(gpu.lockDir);
  }),
);
