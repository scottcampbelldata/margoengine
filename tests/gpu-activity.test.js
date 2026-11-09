import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GpuActivity, monitorGpuLease, queryGpuActivity, terminateGpuTree } from '../scripts/support/gpu-activity.mjs';
import { endTree } from '../scripts/support/shutdown.mjs';

const root = { pid: 100, parent: 10, birth: '1000' };
const child = { pid: 200, parent: 100, birth: '2000' };
const other = { pid: 999, parent: 1, birth: '1500' };
const counter = (pid, running, timestamp, name = `pid_${pid}_gpu_0`) => ({
  pid,
  name,
  running: String(running),
  timestamp: String(timestamp),
});
const sample = (running, timestamp, processes = [root, child, other]) => ({
  ok: true,
  processes,
  engineCount: 2,
  engines: [counter(200, running, timestamp), counter(999, '999999999999999999', timestamp)],
});

test('raw uint64 GPU work in descendants is busy; stable known samples reclaim only after three idle minutes', {
  timeout: 5000,
}, () => {
  const activity = new GpuActivity();
  assert.equal(activity.observe(sample('9007199254740993', 1), 100, 0).state, 'unknown');
  assert.equal(activity.observe(sample('9007199254740994', 2), 100, 30_000).state, 'busy');
  for (let at = 60_000; at <= 180_000; at += 30_000) {
    const result = activity.observe(sample('9007199254740994', at), 100, at);
    assert.equal(result.state, 'idle');
    assert.equal(result.reclaim, false);
  }
  const result = activity.observe(sample('9007199254740994', 210_000), 100, 210_000);
  assert.equal(result.reclaim, true);
  assert.equal(result.idleMs, 180_000);
  assert.deepEqual(
    result.tracked,
    [root, child].map(({ pid, birth }) => ({ pid, birth })),
  );
});

test('counter loss, resets, provider errors and sample gaps reset the idle window instead of proving idle', {
  timeout: 5000,
}, () => {
  const bad = [
    { ok: false, error: 'provider missing' },
    { ok: true, processes: [root], engines: [], engineCount: 0 },
    { ...sample(3, 5), engineCount: 3 },
    { ...sample(3, 5), engines: [counter(200, 'N/A', 5), counter(999, 0, 5)] },
    sample(0, 5),
    sample(3, 1),
    { ...sample(3, 5), engines: [counter(200, 3, 5, 'replacement'), counter(999, 0, 5)] },
    sample(3, 5, [root, { ...child, birth: '2100' }, other]),
  ];
  for (const failure of bad) {
    const activity = new GpuActivity({ idleMs: 50, maxGapMs: 100 });
    activity.observe(sample(3, 1), 100, 0);
    assert.equal(activity.observe(sample(3, 2), 100, 40).state, 'idle');
    assert.equal(activity.observe(failure, 100, 60).reclaim, false);
    assert.equal(activity.observe(sample(3, 10), 100, 70).reclaim, false);
  }
  const activity = new GpuActivity({ idleMs: 50, maxGapMs: 100 });
  activity.observe(sample(3, 1), 100, 0);
  assert.equal(activity.observe(sample(3, 2), 100, 500).state, 'unknown');
  assert.equal(activity.observe(sample(3, 3), 100, 510).reclaim, false);
});

test('tracked descendants survive exited intermediaries; reused root and child identities never inherit their work', {
  timeout: 5000,
}, () => {
  const activity = new GpuActivity();
  const leaf = { pid: 300, parent: 200, birth: '3000' };
  const first = { ...sample(1, 1, [root, child, leaf, other]), engines: [counter(300, 1, 1), counter(999, 1, 1)] };
  activity.observe(first, 100, 0);
  const orphan = { ...first, processes: [root, leaf, other], engines: [counter(300, 2, 2), counter(999, 1, 2)] };
  assert.equal(activity.observe(orphan, 100, 30_000).state, 'unknown');
  assert.equal(
    activity.observe({ ...orphan, engines: [counter(300, 3, 3), counter(999, 1, 3)] }, 100, 60_000).state,
    'busy',
  );
  const replacement = activity.observe(
    { ...orphan, processes: [{ ...root, birth: '5000' }, leaf, other] },
    100,
    90_000,
  );
  assert.equal(replacement.rootChanged, true);
  assert.equal(replacement.reclaim, false);
  assert.equal(activity.observe({ ...orphan, processes: [leaf, other] }, 100, 120_000).state, 'unknown');
});

test('idle monitor confirms identities and work, kills its tree, reports the reclaim, then releases only its token', {
  timeout: 5000,
}, async () => {
  const activity = new GpuActivity({ idleMs: 10 });
  let stamp = 0,
    token = 'ours';
  const calls = [];
  const options = {
    activity,
    pid: 100,
    token: 'ours',
    readEntry: () => ({ token }),
    query: async () => sample(0, ++stamp),
    now: () => stamp * 10,
    publish: (result) => calls.push(result.state),
    terminate: async (tracked) => {
      assert.deepEqual(
        tracked.map((p) => p.pid),
        [100, 200],
      );
      calls.push('kill-tree');
    },
    report: () => calls.push('reported'),
    release: () => {
      assert.equal(token, 'ours');
      calls.push('released');
    },
  };
  await monitorGpuLease(options);
  await monitorGpuLease(options);
  assert.deepEqual(calls, ['unknown', 'idle', 'idle', 'kill-tree', 'reported', 'released']);
  token = 'another-owner';
  await monitorGpuLease(options);
  assert.equal(calls.length, 6, 'a released or replaced token has no telemetry or kill side effects');
});

test('idle confirmation that sees GPU work, a reused PID or unknown telemetry never kills or releases', {
  timeout: 5000,
}, async () => {
  for (const confirmation of [
    sample(1, 3),
    sample(0, 3, [{ ...root, birth: '9000' }, child, other]),
    { ok: false, error: 'unavailable' },
  ]) {
    const activity = new GpuActivity({ idleMs: 10 });
    activity.observe(sample(0, 1), 100, 0);
    let count = 0;
    await monitorGpuLease({
      activity,
      pid: 100,
      token: 'ours',
      readEntry: () => ({ token: 'ours' }),
      query: async () => (++count === 1 ? sample(0, 2) : confirmation),
      now: () => count * 10,
      publish() {},
      terminate: () => assert.fail('must not kill'),
      release: () => assert.fail('must not release'),
      report: () => assert.fail('must not report reclaim'),
    });
  }
});

test('counter provider preserves raw strings, reports failures and has bounded tree termination even if taskkill hangs', {
  timeout: 5000,
}, async () => {
  const childProcess = () =>
    Object.assign(new EventEmitter(), {
      pid: 12,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.killed = true;
      },
    });
  const ready = childProcess();
  const success = queryGpuActivity({ platform: 'win32', launch: () => ready, timeoutMs: 1000 });
  ready.stdout.emit('data', JSON.stringify(sample('9007199254740993', '9007199254740995')));
  ready.emit('close', 0);
  assert.equal((await success).engines[0].running, '9007199254740993');
  assert.equal((await queryGpuActivity({ platform: 'linux' })).ok, false);
  const hang = childProcess(),
    killer = childProcess();
  const launches = [];
  const result = await queryGpuActivity({
    platform: 'win32',
    timeoutMs: 10,
    killTimeoutMs: 10,
    launch: (file, args) => {
      launches.push([file, args]);
      return launches.length === 1 ? hang : killer;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /hard time limit/);
  assert.deepEqual(launches[1], ['taskkill', ['/pid', '12', '/T', '/F']]);
  assert.equal(hang.killed, true);
  assert.equal(killer.killed, true);
  const malformed = childProcess();
  const parse = queryGpuActivity({ platform: 'win32', launch: () => malformed });
  malformed.stdout.emit('data', 'not JSON');
  malformed.emit('close', 0);
  assert.equal((await parse).ok, false);
});

test('Windows idle terminator leaves a replacement identity alive and ends an owned CPU process tree', {
  timeout: 60_000,
}, async () => {
  if (process.platform !== 'win32') {
    await assert.rejects(terminateGpuTree([]), /requires Windows WDDM/);
    return;
  }
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    const [data] = await once(parent.stdout, 'data');
    const leafPid = Number(String(data).trim());
    const identities = [parent.pid, leafPid].map((pid) => {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()`,
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout.trim(), /^\d+$/);
      return { pid, birth: result.stdout.trim() };
    });
    await terminateGpuTree([{ pid: parent.pid, birth: '1' }], { timeoutMs: 10_000 });
    process.kill(parent.pid, 0);
    process.kill(leafPid, 0);
    const closed = once(parent, 'close');
    await terminateGpuTree(identities, { timeoutMs: 15_000 });
    await closed;
    assert.throws(() => process.kill(leafPid, 0));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) await endTree(parent.pid);
  }
});
