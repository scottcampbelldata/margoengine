// scripts/gpu-lock.mjs never lets anything hang while holding or waiting: a hold limit that ends the command's whole
// process tree and frees the lock, a heartbeat lease a waiter can reclaim past, a wait limit that names the holder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const settled = (promise, ms = 200) => Promise.race([promise.then(() => 'got'), sleep(ms).then(() => 'waiting')]);
const quiet = () => {};
const FAST = { MARGO_GPU_BEAT_MS: '50', MARGO_GPU_GRACE_MS: '200' };

let copies = 0;
// A copy of the lock module for the folder `lock`, with `env` set while it loads and while `body` runs.
async function withLock(body, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'gpu.lock'),
    set = { MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', MARGO_GPU_EXCLUSIVE: '', ...FAST, ...env },
    saved = {};
  for (const [key, value] of Object.entries(set)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const gpu = await import(`../scripts/gpu-lock.mjs?limits=${copies++}`);
    await body(gpu, lock);
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await sleep(150); // the heartbeat processes see the release and end
    rmSync(folder, { recursive: true, force: true });
  }
}

test('run: a command past --max is killed with its children, the lock is freed, the error says so', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'gpu.lock'),
    pidFile = join(folder, 'child.pid');
  try {
    // The command starts a grandchild too: the whole tree must end.
    const hang = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[1], process.pid + ',' + g.pid); setTimeout(()=>{},120000)`;
    const started = Date.now();
    const run = spawnSync(
      process.execPath,
      ['scripts/gpu-lock.mjs', 'run', '--max=0.04', '--owner=hang', '--', process.execPath, '-e', hang, pidFile],
      { encoding: 'utf8', env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...FAST } },
    );
    assert.notEqual(run.status, 0);
    assert.equal(run.status, 124, run.stderr);
    assert.match(run.stderr, /TIMEOUT after 0\.04 min: .*setTimeout/);
    assert.ok(Date.now() - started < 30_000, 'it did not wait for the command to finish by itself');
    const [child, grandchild] = readFileSync(pidFile, 'utf8').split(',').map(Number);
    await sleep(500);
    assert.equal(alive(child), false, 'the command is gone');
    assert.equal(alive(grandchild), false, "the command's child is gone");
    // Freed: a new holder gets the lock at once, and nothing is left in the folder.
    const next = spawnSync(process.execPath, ['scripts/gpu-lock.mjs', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, MARGO_GPU_LOCK: lock },
    });
    assert.equal(JSON.parse(next.stdout), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a holder that called acquire() itself and hangs in a synchronous loop is ended by its heartbeat process', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-')),
    lock = join(folder, 'gpu.lock');
  try {
    const hog =
      "const m = await import('./scripts/gpu-lock.mjs'); await m.acquire({ owner: 'hog', max: 0.01, command: 'busy loop' }); for (;;) {}";
    const child = spawn(process.execPath, ['--input-type=module', '-e', hog], {
      stdio: 'ignore',
      env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...FAST },
    });
    const closed = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    const outcome = await Promise.race([closed, sleep(20_000).then(() => 'still running')]);
    assert.notEqual(outcome, 'still running', 'the heartbeat process ended the hung holder');
    assert.ok(outcome.code !== 0, 'it did not exit cleanly');
    await sleep(300);
    const status = spawnSync(process.execPath, ['scripts/gpu-lock.mjs', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, MARGO_GPU_LOCK: lock },
    });
    assert.equal(JSON.parse(status.stdout), null, 'its entry is gone');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a heartbeat keeps a holder alive, and a stale heartbeat is reclaimed even though the process lives', () =>
  withLock(
    async (gpu, lock) => {
      const held = await gpu.acquire({ owner: 'holder', poll: 10, log: quiet });
      // Longer than the lease: only the heartbeat process keeps the entry fresh.
      const waiter = gpu.acquire({ owner: 'bench', mode: 'exclusive', poll: 10, log: quiet });
      assert.equal(await settled(waiter, 4000), 'waiting', 'a live heartbeat is not reclaimed');
      held();
      (await waiter)();
      // A holder whose process is alive (this one) but whose heartbeat stopped long ago.
      mkdirSync(join(lock, 'shared'), { recursive: true });
      const entry = join(lock, 'shared', 'frozen.json');
      writeFileSync(
        entry,
        JSON.stringify({
          owner: 'frozen',
          pid: process.pid,
          token: 'frozen',
          mode: 'shared',
          beats: true,
          command: 'frozen job',
        }),
      );
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(entry, old, old);
      const logs = [];
      const taken = await gpu.acquire({ owner: 'bench', mode: 'exclusive', poll: 10, log: (m) => logs.push(m) });
      assert.match(logs.join('\n'), /stale shared entry of frozen \(no heartbeat/);
      assert.deepEqual(readdirSync(join(lock, 'shared')), []);
      taken();
    },
    { MARGO_GPU_LEASE_MS: '2000' },
  ));

test('a waiter gives up after --wait-max and names the holder and its command', () =>
  withLock(async (gpu) => {
    const held = await gpu.acquire({
      owner: 'slow-job',
      mode: 'exclusive',
      command: 'npm run slow',
      poll: 10,
      log: quiet,
    });
    await assert.rejects(
      gpu.acquire({ owner: 'impatient', waitMax: 0.02, poll: 10, log: quiet }),
      (error) =>
        /gave up after/.test(error.message) && /slow-job/.test(error.message) && /npm run slow/.test(error.message),
    );
    assert.equal(gpu.status().mode, 'exclusive', 'the holder is untouched');
    held();
  }));

test('a request that gave up leaves nothing in the queue', () =>
  withLock(async (gpu, lock) => {
    const reader = await gpu.acquire({ owner: 'reader', poll: 10, log: quiet });
    await assert.rejects(
      gpu.acquire({ owner: 'bench', mode: 'exclusive', waitMax: 0.02, poll: 10, log: quiet }),
      /gave up/,
    );
    assert.equal(gpu.status().waiting, undefined);
    // Shared requests are not stuck behind the withdrawn exclusive one.
    (await gpu.acquire({ owner: 'second', poll: 10, log: quiet }))();
    reader();
  }));
