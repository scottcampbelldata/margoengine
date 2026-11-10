import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createGpuQueue } from '../scripts/gpu-queue.mjs';
import { windowsCommandLine } from '../scripts/gpu-lock.mjs';

for (const state of ['passed', 'failed', 'running']) {
  test(`an owner exiting after the observer's status read retains ${state} evidence`, {
    timeout: 5000,
  }, async (t) => {
    const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-observe-exit-'));
    const lock = join(folder, 'gpu.lock');
    const ticket = '001794250000000-123-observe';
    const pid = 2147483647;
    const record = { ticket, state: 'running', pid, options: {}, log: join(folder, 'command.log') };
    fs.mkdirSync(`${lock}-jobs`);
    const base = join(`${lock}-jobs`, `${ticket}.json`);
    fs.writeFileSync(base, JSON.stringify(record));
    fs.writeFileSync(record.log, 'failure evidence\n');
    let probes = 0,
      drains = 0,
      output = '';
    const exitCode = process.exitCode;
    t.mock.method(process, 'kill', (owner, signal) => {
      assert.equal(owner, pid);
      assert.equal(signal, 0);
      probes++;
      // The owner publishes its last immutable revision and exits after the read,
      // before the observer probes it. No time-based scheduling is needed.
      if (state !== 'running')
        fs.writeFileSync(
          `${base.slice(0, -5)}.00000001.json`,
          JSON.stringify({
            ...record,
            state,
            revision: 1,
            finishedAt: 42,
            result: { ok: state === 'passed' },
          }),
        );
      throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
    });
    t.mock.method(process.stdout, 'write', (bytes) => {
      output += String(bytes);
      return true;
    });
    t.mock.method(console, 'log', (line) => {
      output += `${line}\n`;
    });
    try {
      const queue = createGpuQueue({
        lockDir: lock,
        settleOwner: async (pids, bound, since) => {
          assert.deepEqual(pids, [pid]);
          assert.equal(bound, 30_000);
          assert.equal(since, 42);
          drains++;
          return [];
        },
      });
      if (state === 'running') {
        await assert.rejects(queue.queueCli('wait', [ticket]), /ERR_GPU_QUEUE_OWNER_GONE/);
        assert.equal(output, '');
        assert.equal(drains, 0);
      } else {
        await queue.queueCli('wait', [ticket]);
        assert.match(output, /failure evidence/);
        assert.ok(output.includes(`"state":"${state}"`), output);
        assert.equal(process.exitCode, state === 'passed' ? 0 : 1);
        assert.equal(drains, 1, 'the terminal record still drains its owner');
      }
      assert.equal(probes, 1, 'one liveness observation, no retries');
    } finally {
      process.exitCode = exitCode;
      t.mock.restoreAll();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
}

test('waiting for a terminal ticket drains its detached owner before returning completion', {
  timeout: 5000,
}, async () => {
  const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-drain-'));
  const lock = join(folder, 'gpu.lock');
  const ticket = '001794250000000-123-drain';
  const record = { state: 'passed', pid: 123, finishedAt: 42, options: {} };
  fs.mkdirSync(`${lock}-jobs`);
  fs.writeFileSync(join(`${lock}-jobs`, `${ticket}.json`), JSON.stringify(record));
  let drained = false;
  try {
    const queue = createGpuQueue({
      lockDir: lock,
      settleOwner: async (pids, bound, since) => {
        assert.deepEqual(pids, [123]);
        assert.equal(bound, 30_000);
        assert.equal(since, 42);
        drained = true;
        return [];
      },
    });
    assert.equal((await queue.waitForTicket(ticket, 0.01)).state, 'passed');
    assert.equal(drained, true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a detached owner that exits before admission reports its exit, never a fictitious 30-second timeout', {
  timeout: 5000,
}, async () => {
  const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-exit-'));
  try {
    const queue = createGpuQueue({
      lockDir: join(folder, 'gpu.lock'),
      validateRequest() {},
      validateGpuCommand() {},
      defaultMaxMinutes: () => 1,
      launch: () => Object.assign(new EventEmitter(), { exitCode: 13, signalCode: null, unref() {} }),
    });
    await assert.rejects(queue.enqueue([process.execPath, '-e', ''], { mode: 'shared' }), (error) => {
      assert.equal(error.code, 'ERR_GPU_QUEUE_OWNER_EXIT');
      assert.match(error.message, /exit 13/);
      return true;
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a detached bootstrap failure retains the original stderr and exit in its ticket', {
  timeout: 30_000,
}, async () => {
  const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-bootstrap-'));
  const evidence = 'ERR_QUEUE_BOOTSTRAP_PROOF: failure before ticket admission';
  try {
    const queue = createGpuQueue({
      lockDir: join(folder, 'gpu.lock'),
      validateRequest() {},
      validateGpuCommand() {},
      defaultMaxMinutes: () => 1,
      launch: (file, _args, options) =>
        spawn(file, ['-e', `console.error(${JSON.stringify(evidence)}); process.exit(19)`], options),
    });
    await assert.rejects(queue.enqueue([process.execPath, '-e', ''], { mode: 'shared' }), (error) => {
      assert.equal(error.code, 'ERR_GPU_QUEUE_OWNER_EXIT');
      assert.match(error.message, /exit 19/);
      assert.ok(error.message.includes(evidence), error.message);
      return true;
    });
    const [base] = fs.readdirSync(`${join(folder, 'gpu.lock')}-jobs`).filter((name) => !name.includes('.000000'));
    const { readGpuQueueRecord } = await import('../scripts/gpu-queue.mjs');
    const record = readGpuQueueRecord(join(`${join(folder, 'gpu.lock')}-jobs`, base));
    assert.equal(record.code, 'ERR_GPU_QUEUE_OWNER_EXIT');
    assert.ok(record.error.includes(evidence));
    assert.ok(fs.readFileSync(record.ownerLog, 'utf8').includes(evidence));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a Windows reader can pin every published ticket name while queue status advances', {
  timeout: 30_000,
}, async (t) => {
  const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-publish-'));
  const lock = join(folder, 'gpu.lock');
  const jobs = `${lock}-jobs`;
  fs.mkdirSync(jobs);
  const ticket = '001794250000000-123-regression';
  const base = join(jobs, `${ticket}.json`);
  const initial = JSON.stringify({
    ticket,
    state: 'starting',
    command: [process.execPath, '-e', 'process.exit(7)'],
    cwd: process.cwd(),
    queuedAt: Date.now(),
    options: { owner: 'publication', max: 0.2 },
    log: join(folder, 'command.log'),
  });
  // An existing, pre-revision ticket must remain readable as well.
  fs.writeFileSync(base, initial);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    // Model Windows refusing replacement of a name held by a reader, on every platform.
    if (fs.existsSync(to)) throw Object.assign(new Error(`pinned Windows reader: ${to}`), { code: 'EPERM' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const queue = createGpuQueue({
      lockDir: lock,
      acquire: async () => Object.assign(() => {}, { mode: 'shared' }),
      defaultMaxMinutes: () => 0.2,
      windowsCommandLine,
    });
    await queue.queueCli('queue-run', [ticket]);
    const result = await queue.waitForTicket(ticket, 0.01);
    assert.equal(result.state, 'failed');
    assert.equal(result.result.ok, false);
    assert.equal(result.result.timedOut, false);
    assert.equal(fs.readFileSync(base, 'utf8'), initial, 'no published name is rewritten');
    assert.equal(result.revision, 2, 'running and failed are separate immutable publications');
    assert.equal(fs.readdirSync(jobs).filter((name) => name.endsWith('.json')).length, 3);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
