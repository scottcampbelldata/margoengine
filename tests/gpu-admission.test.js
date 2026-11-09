import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  firstEligible,
  observeUsage,
  ownerLane,
  readUsage,
  sameLane,
  worktreeIdentity,
} from '../scripts/support/gpu-admission.mjs';
import { gpuCommand } from '../scripts/support/gpu-command.mjs';

test('GPU leaf classification rejects CPU aggregators independently of their arguments', { timeout: 5000 }, () => {
  for (const words of [
    ['npm', 'run', 'verify', '--', 'test:gpu'],
    ['npm', 'run', 'lint'],
    ['npm', 'test'],
    ['npm', 'run', 'build:packages'],
    ['node', '--test', 'gpu.test.js'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/verify.mjs', 'browser-check.mjs'],
    ['node', '--import', 'browser.mjs', 'scripts/hygiene.js'],
    ['node', 'packages/sky/tests/gpu.test.js'],
    ['cmd.exe', '/c', 'npm run verify'],
  ])
    assert.equal(gpuCommand(words), 'cpu', words.join(' '));
  for (const words of [
    ['npm', 'run', 'test:gpu'],
    ['npm', 'run', 'test:browser'],
    ['npm', 'run', 'test:xr'],
    ['npm', 'run', 'check:readme-run'],
    ['node', 'packages/sky/tests/browser-check.mjs'],
    ['node', '--import', 'preload.mjs', 'scripts/capture.mjs'],
    [process.execPath, resolve('tests/fixtures/gpu-queue-command.mjs')],
  ])
    assert.equal(gpuCommand(words), 'gpu', words.join(' '));
  assert.equal(gpuCommand(['node', '-e', 'console.log("browser-check.mjs")']), 'unknown');
  assert.equal(gpuCommand(['node', '--eval=console.log("capture")']), 'unknown');
});

test('run and enqueue refuse CPU commands before creating tickets, holders or children even with a reason', {
  timeout: 60_000,
}, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-admission-cli-'));
  const lock = join(folder, 'gpu.lock');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MARGO_GPU_')));
  env.MARGO_GPU_LOCK = lock;
  try {
    for (const verb of ['run', 'enqueue']) {
      for (const words of [
        ['npm', 'run', 'verify'],
        ['node', '--test', 'tests/gpu-lock.test.js'],
        ['tsc', '--noEmit'],
      ]) {
        const result = spawnSync(
          process.execPath,
          ['scripts/gpu-lock.mjs', verb, '--owner=lane-proof', '--gpu=must not override CPU', '--', ...words],
          {
            env,
            encoding: 'utf8',
            timeout: 10_000,
            windowsHide: true,
          },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ERR_GPU_COMMAND_NOT_GPU.*GPU-only rule/);
        for (const name of [lock, `${lock}-jobs`, `${lock}-waiting`]) assert.equal(existsSync(name), false, name);
      }
    }
    const refusals = readFileSync(join(folder, 'gpu-lock-refusals.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(refusals.length, 6);
    assert.ok(refusals.every((record) => record.code === 'ERR_GPU_COMMAND_NOT_GPU'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('worktree and lane identities agree across task names and subdirectories; eligible FIFO bypasses held lanes', {
  timeout: 5000,
}, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-lane-identity-'));
  try {
    mkdirSync(join(folder, '.git'));
    mkdirSync(join(folder, 'packages', 'sky'), { recursive: true });
    assert.equal(worktreeIdentity(join(folder, 'packages', 'sky')), worktreeIdentity(folder));
    assert.equal(ownerLane('lane-G/readme'), 'lane-g');
    assert.equal(ownerLane('codex-lane-G-capture'), 'lane-g');
    assert.equal(sameLane({ owner: 'a', worktree: folder }, { owner: 'b', worktree: join(folder, 'packages') }), true);
    const holder = { owner: 'lane-G/readme', worktree: '/one' };
    const waiting = [
      { owner: 'lane-G/test', token: 'g1' },
      { owner: 'lane-H/capture', token: 'h' },
      { owner: 'lane-G/later', token: 'g2' },
    ];
    assert.equal(firstEligible(waiting, [holder]).token, 'h');
    assert.equal(firstEligible(waiting, []).token, 'g1');
    assert.equal(sameLane(holder, { owner: 'lane-G/legacy' }), true, 'legacy entries retain owner-prefix exclusion');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('one slot per worktree or lane leaves the other two slots usable and retains FIFO within the lane', {
  timeout: 60_000,
}, async () => {
  const folder = mkdtempSync(resolve('test-results/gpu-lane-scheduler-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('MARGO_GPU_')) delete process.env[key];
  process.env.MARGO_GPU_LOCK = join(folder, 'gpu.lock');
  process.env.MARGO_GPU_FRESH_MS = '0';
  for (const root of [folder, ...['different-tree', 'h', 'i'].map((name) => join(folder, name))])
    mkdirSync(join(root, '.git'), { recursive: true });
  const releases = [];
  let second, third;
  try {
    const gpu = await import(`../scripts/gpu-lock.mjs?admission=${Date.now()}`);
    const options = { max: 0.5, waitMax: 0.2, poll: 5, log() {} };
    const g = await gpu.acquire({ ...options, owner: 'lane-G/first', worktree: folder });
    releases.push(g);
    let queued;
    const waiting = new Promise((done) => {
      queued = done;
    });
    second = gpu.acquire({ ...options, owner: 'same-tree-alias', worktree: folder, onQueued: queued });
    await waiting;
    third = gpu.acquire({ ...options, owner: 'lane-G/third', worktree: join(folder, 'different-tree') });
    const h = await gpu.acquire({ ...options, owner: 'lane-H/capture', worktree: join(folder, 'h') });
    const i = await gpu.acquire({ ...options, owner: 'lane-I/readme', worktree: join(folder, 'i') });
    releases.push(h, i);
    const status = gpu.status();
    assert.equal(status.slotsUsed, 3);
    assert.equal(status.slots, 3);
    assert.deepEqual(
      status.waiting.map((entry) => entry.owner),
      ['same-tree-alias', 'lane-G/third'],
    );
    assert.ok(
      status.holders.every((entry) => Number.isFinite(entry.heldMinutes) && entry.command && entry.gpu === 'unknown'),
    );
    const sidecar = `${gpu.lockDir}-activity`;
    mkdirSync(sidecar);
    const entry = status.holders.find((holder) => holder.owner === 'lane-G/first');
    const activityFile = join(sidecar, `${entry.token}.jsonl`);
    for (const state of ['busy', 'idle']) {
      appendFileSync(activityFile, JSON.stringify({ state, observedAt: Date.now(), idleMs: 0 }) + '\n');
      assert.equal(gpu.status().holders.find((holder) => holder.token === entry.token).gpu, state);
    }
    g();
    const next = await second;
    releases.push(next);
    assert.equal(gpu.status().waiting[0].owner, 'lane-G/third');
    // The alias was admitted in FIFO order; the remaining request can use that slot next.
    next();
    releases.push(await third);
  } finally {
    for (const release of releases) release();
    // If an assertion failed, settle bounded outstanding own requests before deleting their fake folder.
    for (const pending of [second, third])
      if (pending) {
        try {
          (await pending)();
        } catch {}
      }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(folder, { recursive: true, force: true });
  }
});

test('free-slot wait accounting integrates scheduler observations and ignores an incomplete append', {
  timeout: 5000,
}, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-slot-usage-'));
  const file = join(folder, 'usage.jsonl');
  try {
    observeUsage(file, { shared: [{}], waiting: [{}] }, 3, 100);
    assert.equal(readUsage(file, 110).freeSlotWaitMs, 10);
    assert.equal(readUsage(file, 110).freeSlotWaitSlotMs, 20);
    observeUsage(file, { shared: [{}, {}, {}], waiting: [{}] }, 3, 120);
    assert.equal(readUsage(file, 140).freeSlotWaitMs, 20);
    assert.equal(readUsage(file, 140).freeSlotWaitSlotMs, 40);
    appendFileSync(file, '{"partial":');
    assert.equal(readUsage(file, 150).freeSlotWaitMs, 20);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
