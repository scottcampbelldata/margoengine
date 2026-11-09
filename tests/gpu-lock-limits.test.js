// Fake lock folders only: exercise active scheduler policy without running speed work.
process.env.MARGO_SPEED_PHASE = 'active';
// scripts/gpu-lock.mjs never lets anything hang while holding or waiting: a hold limit that ends the command's whole
// process tree and frees the lock, a heartbeat lease a waiter can reclaim past, a wait limit that names the holder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree } from '../scripts/gpu-lock.mjs';

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
// `promise`, or a failure saying `message` past `ms`. The timer is cleared, so it keeps nothing running.
const bounded = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const waitUntil = async (condition, message, ms = 20_000) => {
  for (const end = Date.now() + ms; !condition(); await sleep(10)) assert.ok(Date.now() < end, message);
};
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
      // This test is about the wrapper's own limit. With FAST's 200 ms grace the detached heartbeat process reached
      // the same deadline while the wrapper was still ending the tree (taskkill can take longer than that on Windows),
      // killed it too and appended gpu-lock-timeouts.log to this folder during the rmSync below (ENOTEMPTY). A long
      // grace leaves the kill to the wrapper; the heartbeat's own kill is the next test's subject.
      {
        encoding: 'utf8',
        env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...FAST, MARGO_GPU_GRACE_MS: '60000' },
      },
    );
    assert.notEqual(run.status, 0);
    assert.equal(run.status, 124, run.stderr);
    assert.match(run.stderr, /TIMEOUT after 0\.04 min: .*setTimeout/);
    // wall-clock: the command runs 120 s unless the 2.4 s limit ends it.
    assert.ok(Date.now() - started < 30_000, 'it did not wait for the command to finish by itself');
    const [child, grandchild] = readFileSync(pidFile, 'utf8').split(',').map(Number);
    await waitUntil(() => !alive(child), 'the command is gone');
    await waitUntil(() => !alive(grandchild), "the command's child is gone");
    assert.ok(!readdirSync(folder).includes('gpu-lock-timeouts.log'), 'the wrapper ended it, not a racing heartbeat');
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
  let child;
  try {
    const hog =
      "const m = await import('./scripts/gpu-lock.mjs'); await m.acquire({ owner: 'hog', max: 0.01, command: 'busy loop' }); for (;;) {}";
    child = spawn(process.execPath, ['--input-type=module', '-e', hog], {
      stdio: 'ignore',
      env: { ...process.env, MARGO_GPU_LOCK: lock, MARGO_GPU_LOCK_NESTED: '', ...FAST },
    });
    const closed = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    const outcome = await bounded(closed, 20_000, 'the hung holder is still running');
    assert.ok(outcome.code !== 0, 'it did not exit cleanly');
    // The last thing the heartbeat does. Regression (2026-10-31): on Windows `taskkill /T` took the heartbeat down with
    // the holder, every time, so this line was never written; about 2 runs in 100 under load the taskkill died with
    // the heartbeat before it reached the holder, which spun on past its limit and this test timed out.
    const log = join(folder, 'gpu-lock-timeouts.log');
    await waitUntil(() => existsSync(log), 'the heartbeat outlives the holder and logs the timeout');
    await waitUntil(
      () => /TIMEOUT after 0\.01 min: hog: busy loop/.test(readFileSync(log, 'utf8')),
      'the line is whole',
    );
    assert.deepEqual(readdirSync(join(lock, 'shared')), [], 'its entry is gone');
  } finally {
    // Whatever failed above, a spinning holder must not outlive the test (it kept the test file from ending at all).
    if (child && child.exitCode === null && child.signalCode === null) killTree(child.pid);
    rmSync(folder, { recursive: true, force: true });
  }
});

// The heartbeat is a process of its own, so its first beat comes after a Node start-up: about 0.2 s here, but seconds
// on a machine busy with a package build, past this test's 2 s lease (production leases are 2 min). The test waits
// for the first beat, then checks that a beating holder outlives two leases.
async function firstBeat(lock, ready = () => true) {
  const dir = join(lock, 'shared'),
    entry = join(
      dir,
      readdirSync(dir).find((name) => name.endsWith('.json')),
    ),
    until = Date.now() + 30_000;
  // A metadata change alone cannot prove that a deliberately delayed heartbeat has started.
  while (!ready()) {
    assert.ok(Date.now() < until, 'the heartbeat process never started');
    await sleep(10);
  }
  const written = statSync(entry).mtimeMs;
  while (statSync(entry).mtimeMs === written) {
    assert.ok(Date.now() < until, 'the heartbeat process never refreshed the entry');
    await sleep(10);
  }
}

const heartbeatKeepsHolder = (env, ready) =>
  withLock(
    async (gpu, lock) => {
      const held = await gpu.acquire({ owner: 'holder', poll: 10, log: quiet });
      await firstBeat(lock, ready);
      // Longer than the lease: only the heartbeat process keeps the entry fresh.
      const waited = [],
        waiter = gpu.acquire({
          owner: 'bench',
          mode: 'exclusive',
          timing: 'CPU-only scheduler regression',
          poll: 10,
          log: (m) => waited.push(m),
        });
      // fixed-wait: two leases must pass with the holder still in
      assert.equal(await settled(waiter, 4000), 'waiting', 'a live heartbeat is not reclaimed');
      // A reclaimed holder's slot is not handed over at once, so 'waiting' alone does not prove it was kept.
      assert.doesNotMatch(waited.join(' | '), /removing stale/, 'a live heartbeat is not reclaimed');
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
      const taken = await gpu.acquire({
        owner: 'bench',
        mode: 'exclusive',
        timing: 'CPU-only scheduler regression',
        poll: 10,
        log: (m) => logs.push(m),
      });
      assert.match(logs.join('\n'), /stale shared entry of frozen \(no heartbeat/);
      assert.deepEqual(readdirSync(join(lock, 'shared')), []);
      taken();
    },
    { MARGO_GPU_LEASE_MS: '2000', ...env },
  );

test('a heartbeat keeps a holder alive, and a stale heartbeat is reclaimed even though the process lives', () =>
  heartbeatKeepsHolder());

// Regression (2026-10-30): this test failed only while a package build ran beside it: the waiter started counting
// at once, and the heartbeat process, slow to start on the busy machine, beat for the first time after the 2 s lease.
// A start-up delay in the heartbeat process (NODE_OPTIONS reaches it, as the environment does) stands in for the load.
test('a heartbeat process that starts slowly still keeps its holder alive', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-slow-')),
    slow = join(folder, 'slow-start.mjs'),
    ready = join(folder, 'heartbeat-started');
  try {
    writeFileSync(
      slow,
      `import {existsSync, writeFileSync} from 'node:fs';
const end = Date.now() + 2500; while (Date.now() < end);
if (process.argv[2] === 'beat' && existsSync(${JSON.stringify(folder)})) writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
    );
    await heartbeatKeepsHolder({ NODE_OPTIONS: `--import=${pathToFileURL(slow).href}` }, () => existsSync(ready));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('heartbeat readiness ignores metadata changes before its worker has started', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-ready-')),
    lock = join(folder, 'gpu.lock'),
    dir = join(lock, 'shared'),
    entry = join(dir, 'holder.json');
  let ready = false,
    observed = false,
    polls = 0,
    nextPoll;
  const polled = new Promise((resolve) => {
    nextPoll = resolve;
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(entry, '{}');
  const pending = firstBeat(lock, () => {
    if (++polls === 2) nextPoll();
    observed = ready;
    return ready;
  });
  try {
    const changed = new Date(Date.now() + 1000);
    utimesSync(entry, changed, changed);
    assert.equal(
      await Promise.race([pending.then(() => 'beat'), polled.then(() => 'poll')]),
      'poll',
      'metadata does not acknowledge startup',
    );
    ready = true;
    await waitUntil(() => observed, 'the startup acknowledgement is observed');
    const beat = new Date(Date.now() + 2000);
    utimesSync(entry, beat, beat);
    await pending;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a waiter gives up after --wait-max and names the holder and its command', () =>
  withLock(async (gpu) => {
    const held = await gpu.acquire({
      owner: 'slow-job',
      mode: 'exclusive',
      timing: 'CPU-only scheduler regression',
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
      gpu.acquire({
        owner: 'bench',
        mode: 'exclusive',
        timing: 'CPU-only scheduler regression',
        waitMax: 0.02,
        poll: 10,
        log: quiet,
      }),
      /gave up/,
    );
    assert.equal(gpu.status().waiting, undefined);
    // Shared requests are not stuck behind the withdrawn exclusive one.
    (await gpu.acquire({ owner: 'second', poll: 10, log: quiet }))();
    reader();
  }));
