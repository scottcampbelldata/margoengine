// Fake lock folders only: exercise active scheduler policy without running speed work.
process.env.MARGO_SPEED_PHASE = 'active';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { endTree } from '../scripts/support/shutdown.mjs';
import { readGpuQueueRecord } from '../scripts/gpu-queue.mjs';

const until = async (condition) => {
  const end = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < end, 'CPU-only queue handshake exceeded 30 seconds');
    await new Promise((done) => setTimeout(done, 10));
  }
};

test('detached shared tickets retain FIFO order through observer timeout and admit while another slot is held', {
  timeout: 120_000,
}, async () => {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/gpu-queue-test-'));
  const lock = join(folder, 'gpu.lock');
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('MARGO_GPU_')) delete process.env[key];
  process.env.MARGO_GPU_LOCK = lock;
  process.env.MARGO_GPU_FRESH_MS = '0';
  const jobs = [],
    held = [];
  let later;
  const cli = (args, cwd = process.cwd()) =>
    spawnSync(process.execPath, [resolve('scripts/gpu-lock.mjs'), ...args], {
      env: process.env,
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
  const readJob = (ticket) => readGpuQueueRecord(join(`${lock}-jobs`, `${ticket}.json`));
  const queue = (label) => {
    const cwd = join(folder, `worktree-${label}`);
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const result = cli(
      [
        'enqueue',
        `--owner=${label}`,
        '--max=2',
        '--',
        process.execPath,
        resolve('tests/fixtures/gpu-queue-command.mjs'),
        folder,
        label,
      ],
      cwd,
    );
    assert.equal(result.status, 0, result.stderr);
    const job = JSON.parse(result.stdout);
    jobs.push(job);
    assert.equal(readJob(job.ticket).options.waitMax, 60, 'gate wait defaults to at least an hour');
    return job;
  };
  try {
    const gpu = await import('../scripts/gpu-lock.mjs?queue-test');
    for (let i = 0; i < 3; i++) {
      const worktree = join(folder, `held-${i}`);
      mkdirSync(join(worktree, '.git'), { recursive: true });
      held.push(await gpu.acquire({ owner: `occupied-${i}`, worktree, max: 2, log() {} }));
    }
    const first = queue('first'),
      second = queue('second');
    assert.equal(first.state, 'waiting');
    assert.equal(second.state, 'waiting');
    assert.equal(existsSync(join(folder, 'first-started')), false, 'enqueue returns while the GPU is unavailable');
    const observed = cli(['wait', first.ticket, '--wait-max=0.001']);
    assert.notEqual(observed.status, 0);
    assert.match(observed.stderr, /ERR_GPU_QUEUE_WAIT_TIMEOUT.*place is retained/);
    assert.equal(readJob(first.ticket).state, 'waiting');
    // A later ordinary acquire must queue behind both detached jobs, not bypass their tickets.
    later = spawn(
      process.execPath,
      [
        'scripts/gpu-lock.mjs',
        'run',
        '--owner=later',
        '--max=2',
        '--wait-max=1',
        '--',
        process.execPath,
        resolve('tests/fixtures/gpu-queue-command.mjs'),
        folder,
        'later',
      ],
      {
        env: process.env,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    await until(() => gpu.status()?.waiting?.length === 3);
    held.pop()();
    await until(() => existsSync(join(folder, 'first-started')));
    assert.equal(readFileSync(join(folder, 'first-started'), 'utf8'), 'shared');
    assert.equal(existsSync(join(folder, 'second-started')), false);
    assert.equal(existsSync(join(folder, 'later-started')), false);
    writeFileSync(join(folder, 'first-finish'), '');
    await until(() => existsSync(join(folder, 'second-started')));
    assert.equal(existsSync(join(folder, 'later-started')), false);
    writeFileSync(join(folder, 'second-finish'), '');
    await until(() => existsSync(join(folder, 'later-started')));
    writeFileSync(join(folder, 'later-finish'), '');
    await until(() => later.exitCode !== null);
    assert.equal(later.exitCode, 0);
    for (const job of jobs) {
      const completed = cli(['wait', job.ticket]);
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stdout, /finished /);
      assert.equal(readJob(job.ticket).state, 'passed');
      assert.equal(readJob(job.ticket).mode, 'shared');
    }
    assert.equal(gpu.status().holders.length, 2, 'jobs use the free slot without disturbing the other holders');
  } finally {
    for (const label of ['first', 'second', 'later']) writeFileSync(join(folder, `${label}-finish`), '');
    if (later && later.exitCode === null) await endTree(later.pid);
    for (const job of jobs) {
      if (!['passed', 'failed'].includes(readJob(job.ticket).state)) await endTree(job.pid);
    }
    for (const release of held) release();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(folder, { recursive: true, force: true });
  }
});

test('invalid queue ticket paths fail before reading outside the job directory', { timeout: 30_000 }, () => {
  const result = spawnSync(process.execPath, ['scripts/gpu-lock.mjs', 'wait', '../other-owner'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_GPU_QUEUE_TICKET/);
});

test('a detached command failure is retained for wait and never reported as a passed gate', { timeout: 60_000 }, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-queue-failure-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MARGO_GPU_')));
  env.MARGO_GPU_LOCK = join(folder, 'gpu.lock');
  const run = (args) =>
    spawnSync(process.execPath, [resolve('scripts/gpu-lock.mjs'), ...args], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
  try {
    const queued = run([
      'enqueue',
      '--owner=fails',
      '--gpu=CPU-only failed-command fixture',
      '--max=0.2',
      '--wait-max=1',
      '--',
      process.execPath,
      '-e',
      'console.log("failure evidence"); process.exit(7)',
    ]);
    assert.equal(queued.status, 0, queued.stderr);
    const { ticket } = JSON.parse(queued.stdout);
    const completed = run(['wait', ticket]);
    assert.equal(completed.status, 1, completed.stderr);
    assert.match(completed.stdout, /failure evidence/);
    const record = readGpuQueueRecord(join(`${env.MARGO_GPU_LOCK}-jobs`, `${ticket}.json`));
    assert.equal(record.state, 'failed');
    assert.equal(record.result.ok, false);
    assert.equal(record.result.timedOut, false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
