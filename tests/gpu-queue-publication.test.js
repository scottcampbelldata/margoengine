import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createGpuQueue } from '../scripts/gpu-queue.mjs';
import { windowsCommandLine } from '../scripts/gpu-lock.mjs';

test('a detached owner that exits before admission reports its exit, never a fictitious 30-second timeout', {
  timeout: 5000,
}, async () => {
  const folder = fs.mkdtempSync(resolve('test-results/gpu-queue-exit-'));
  try {
    const queue = createGpuQueue({
      lockDir: join(folder, 'gpu.lock'),
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
