import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { makeLockDirectory, retireMutex } from '../scripts/gpu-lock.mjs';

test('Windows pending directory deletion is bounded contention; permission failures still surface', {
  timeout: 5000,
}, async () => {
  const failure = Object.assign(new Error('delete pending or denied'), { code: 'EPERM' });
  let time = 0,
    calls = 0;
  assert.equal(
    await makeLockDirectory('owned.lock', {
      windows: true,
      now: () => time,
      create() {
        if (++calls < 3) throw failure;
      },
      wait: async (ms) => {
        time += ms;
      },
    }),
    true,
  );
  assert.equal(calls, 3);
  assert.equal(
    await makeLockDirectory('owned.lock', {
      create() {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
      wait() {
        assert.fail('a live directory is not pending deletion');
      },
    }),
    false,
  );
  await assert.rejects(
    makeLockDirectory('owned.lock', {
      windows: false,
      create() {
        throw failure;
      },
      wait() {
        assert.fail('POSIX permission failures are not contention');
      },
    }),
    (e) => e === failure,
  );
  time = 0;
  await assert.rejects(
    makeLockDirectory('owned.lock', {
      windows: true,
      now: () => time,
      create() {
        throw failure;
      },
      wait: async (ms) => {
        time += ms;
      },
    }),
    (e) => e === failure,
  );
  assert.equal(time, 10000, 'a persistent access failure cannot wait indefinitely');
});

test('mutex retirement makes its reusable name available before Windows deletion completes', () => {
  const mutex = join('test-results', 'owned.lock', 'mutex'),
    entries = new Set([mutex]),
    pendingDelete = new Set();
  let retired;
  const mkdir = (path) => {
    if (pendingDelete.has(path)) throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
    assert.equal(entries.has(path), false);
    entries.add(path);
  };
  retireMutex(mutex, {
    rename(from, to) {
      assert.equal(from, mutex);
      assert.equal(dirname(to), dirname(mutex));
      assert.match(basename(to), /^mutex-released-/);
      assert.ok(entries.delete(from));
      entries.add(to);
      retired = to;
    },
    remove(path) {
      assert.equal(path, retired);
      entries.delete(path);
      pendingDelete.add(path);
      mkdir(mutex); // a contender arrives while a scanner still holds the removed directory
    },
  });
  assert.ok(entries.has(mutex), 'the new owner holds the original name');
  assert.ok(!pendingDelete.has(mutex), 'no creator sees EPERM on the name it must acquire');
});

test('mutex retirement surfaces permission and cleanup failures without deleting a live mutex', () => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  assert.throws(
    () =>
      retireMutex('test-results/owned.lock/mutex', {
        rename() {
          throw failure;
        },
        remove() {
          assert.fail('cannot delete a mutex that was not retired');
        },
      }),
    (error) => error === failure,
  );
  assert.throws(
    () =>
      retireMutex('test-results/owned.lock/mutex', {
        rename() {},
        remove() {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
});

test('retired mutex names stay reusable with a real pending Windows directory deletion', {
  timeout: 30000,
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gpu-mutex-delete-')),
    mutex = join(folder, 'mutex');
  let child;
  const hold = async () => {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'tests/fixtures/hold-deleted-directory.ps1',
        mutex,
      ],
      { windowsHide: true },
    );
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let errors = '';
    child.stderr.on('data', (part) => {
      errors += part;
    });
    assert.equal((await lines.next()).value, 'ready', errors);
    return async () => {
      child.stdin.write('delete\n');
      assert.equal((await lines.next()).value, 'pending', errors);
    };
  };
  const close = async () => {
    if (!child) return;
    const exited = once(child, 'exit');
    child.stdin.end('close\n');
    const [code] = await exited;
    assert.equal(code, 0);
    child = undefined;
  };
  try {
    mkdirSync(mutex);
    if (process.platform === 'win32') {
      // The old remove/recreate lifecycle reproduces the gate's exact EPERM.
      const markDeleted = await hold();
      await markDeleted();
      assert.throws(() => mkdirSync(mutex), { code: 'EPERM' });
      const creating = makeLockDirectory(mutex);
      await close();
      assert.equal(await creating, true, 'creation waits for the native pending deletion to finish');
    }
    const markDeleted = process.platform === 'win32' ? await hold() : undefined;
    let retired;
    retireMutex(mutex, {
      remove(path) {
        retired = path;
      },
    });
    if (markDeleted) await markDeleted();
    mkdirSync(mutex); // succeeds while the old directory is still held delete-pending
    rmdirSync(mutex);
    if (markDeleted) await close();
    else rmdirSync(retired);
  } finally {
    if (child) {
      child.kill();
      await once(child, 'close');
    }
    rmSync(folder, { recursive: true, force: true });
  }
});
