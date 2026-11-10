// When a GPU lock entry counts as stale. A waiter removes stale entries, so a live, beating holder must never count as
// stale: that let more holders than the slot limit onto the GPU.
// Regression: waiters logged "removing stale shared entry of <owner> (no heartbeat for 1794337171 s)", the whole epoch
// in seconds. The holder had released its entry between the waiter's read and its stat; the failed stat left the beat
// time at 0. Any other stat failure (EPERM or EBUSY on Windows while the file is held) took the same path and removed a
// live, beating holder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASED, deadReason } from '../scripts/gpu-lock.mjs';

const MIN = 60_000;
const coded = (code) => () => {
  throw Object.assign(new Error(`${code}: fake stat failure`), { code });
};

function withEntry(body) {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-lock-stale-'));
  try {
    const file = join(folder, 'holder.json');
    return body(file, (entry) => writeFileSync(file, JSON.stringify(entry)));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const holder = (extra = {}) => ({
  owner: 'live-holder',
  pid: process.pid,
  beats: true,
  deadline: Date.now() + 20 * MIN,
  ...extra,
});

// A pid that is certainly gone: a child that has already exited.
const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', timeout: 10_000 });
  return Number(child.stdout.trim());
};

test('a holder whose heartbeat has not ticked yet is alive (its write time is its first beat)', () =>
  withEntry((file, write) => {
    const entry = holder();
    write(entry);
    assert.equal(deadReason(entry, file), null);
  }));

test('a holder whose heartbeat is current is alive', () =>
  withEntry((file, write) => {
    const entry = holder();
    write(entry);
    const now = Date.now();
    utimesSync(file, new Date(now - 15_000), new Date(now - 15_000));
    assert.equal(deadReason(entry, file, { now }), null);
  }));

test('a holder whose heartbeat stopped past the lease is stale, and the age it reports is the real one', () =>
  withEntry((file, write) => {
    const entry = holder();
    write(entry);
    const now = Date.now();
    utimesSync(file, new Date(now - 3 * MIN), new Date(now - 3 * MIN));
    assert.match(deadReason(entry, file, { now }), /^no heartbeat for 1[78]\d s$/);
  }));

test('a holder whose process is gone is stale, beating or not', () =>
  withEntry((file, write) => {
    const pid = deadPid();
    assert.ok(pid > 0);
    for (const beats of [true, false]) {
      const entry = holder({ pid, beats });
      write(entry);
      assert.equal(deadReason(entry, file), `pid ${pid} gone`);
    }
  }));

test('a beats:false entry is judged by its pid alone, however old its file', () =>
  withEntry((file, write) => {
    const entry = holder({ beats: false });
    write(entry);
    utimesSync(file, new Date(0), new Date(0));
    assert.equal(deadReason(entry, file), null);
    assert.equal(deadReason(entry, file, { stat: coded('ENOENT') }), null);
  }));

test('an entry released between the read and the stat is reported as released, never as no heartbeat since 1970', () =>
  withEntry((file, write) => {
    const entry = holder();
    write(entry);
    rmSync(file);
    assert.equal(deadReason(entry, file), RELEASED);
    assert.equal(deadReason(entry, file, { stat: coded('ENOENT') }), RELEASED);
  }));

test('a stat that fails for any other reason never makes a live holder stale', () =>
  withEntry((file, write) => {
    const entry = holder();
    write(entry);
    for (const code of ['EPERM', 'EBUSY', 'EACCES', undefined])
      assert.equal(deadReason(entry, file, { stat: coded(code) }), null, `stat failing with ${code}`);
    assert.equal(deadReason(entry, file, { stat: () => ({ mtimeMs: Number.NaN }) }), null, 'an unreadable mtime');
  }));

test('a dead holder is still stale when its stat fails', () =>
  withEntry((file, write) => {
    const pid = deadPid();
    const entry = holder({ pid });
    write(entry);
    assert.equal(deadReason(entry, file, { stat: coded('EPERM') }), `pid ${pid} gone`);
  }));
