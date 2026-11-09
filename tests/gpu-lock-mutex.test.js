import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { retireMutex } from '../scripts/gpu-lock.mjs';

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
      await close();
      mkdirSync(mutex);
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
