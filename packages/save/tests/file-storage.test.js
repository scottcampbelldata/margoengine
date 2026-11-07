// fileStorage against what a real file system does around a rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileStorage } from '../dist/node.js';

/**
 * Runs `job` as on Linux, with the directory fsyncs recorded in order with the renames: Windows has no fsync of a
 * directory, so this is the only way to see the order there. `failure` is what a directory's fsync does.
 */
async function posix(job, failure) {
  const log = [],
    { open: realOpen, rename: realRename } = fs,
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
  fs.rename = async (from, to) => {
    log.push('rename');
    return realRename(from, to);
  };
  fs.open = async (path, flags) => {
    if (flags !== 'r') return realOpen(path, flags);
    return {
      async sync() {
        log.push(`sync ${path}`);
        if (failure) throw failure;
      },
      async close() {
        log.push('close');
      },
    };
  };
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    await job();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.assign(fs, { open: realOpen, rename: realRename });
    syncBuiltinESMExports();
  }
  return log;
}

async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), 'margo-file-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

test('a write is not refused because a read of the same save is under way', async (t) => {
  const storage = fileStorage(await folder(t)),
    size = 1 << 22,
    save = (byte) => new Uint8Array(size).fill(byte);
  await storage.write('game', save(1));
  let stop = false,
    reads = 0;
  const reader = (async () => {
    while (!stop) {
      const bytes = await storage.read('game');
      assert.equal(bytes.length, size);
      assert.equal(bytes[size - 1], bytes[0], 'a read sees one whole save');
      reads++;
    }
  })();
  try {
    for (let i = 0; i < 60; i++) await storage.write('game', save(i));
  } finally {
    stop = true;
    await reader;
  }
  assert.ok(reads > 0);
});

test('a save another program has open keeps the old save, and says what to do', async (t) => {
  const path = await folder(t),
    storage = fileStorage(path);
  await storage.write('game', new Uint8Array([1]));
  const held = await open(join(path, 'game.save'), 'r');
  t.after(() => held.close());
  if (process.platform === 'win32') {
    await assert.rejects(storage.write('game', new Uint8Array([2])), (error) => {
      assert.equal(error.code, 'failed');
      assert.match(error.message, /close it and save again/);
      assert.equal(error.cause.code, 'EPERM');
      return true;
    });
    assert.deepEqual(await readFile(join(path, 'game.save')), Buffer.from([1]));
    assert.deepEqual(await readdir(path), ['game.save'], 'no temporary file is left');
  } else {
    await storage.write('game', new Uint8Array([2]));
    assert.deepEqual(await storage.read('game'), new Uint8Array([2]));
  }
});

test('a rename reaches the disk: the folder is fsynced after it, as a crash could otherwise undo it', async (t) => {
  const path = await folder(t),
    storage = fileStorage(path),
    log = await posix(() => storage.write('game', new Uint8Array([1])));
  assert.deepEqual(log, ['rename', `sync ${path}`, 'close']);
  assert.deepEqual(await storage.read('game'), new Uint8Array([1]));
});

test('folders the first write made are fsynced in their parents too', async (t) => {
  const path = await folder(t),
    deep = join(path, 'a', 'b'),
    log = await posix(() => fileStorage(deep).write('game', new Uint8Array([1])));
  assert.deepEqual(log.filter((line) => line.startsWith('sync')), [`sync ${deep}`, `sync ${dirname(deep)}`, `sync ${path}`]);
});

test('a file system with no fsync of a folder is no failure, and any other error is', async (t) => {
  const path = await folder(t),
    storage = fileStorage(path);
  await posix(() => storage.write('a', new Uint8Array([1])), Object.assign(new Error('no'), { code: 'EINVAL' }));
  await assert.rejects(
    posix(() => storage.write('b', new Uint8Array([1])), Object.assign(new Error('disk failed'), { code: 'EIO' })),
    /disk failed/,
  );
});

test('on Windows, which cannot fsync a folder, none is tried', async (t) => {
  if (process.platform !== 'win32') return;
  const path = await folder(t);
  await fileStorage(path).write('game', new Uint8Array([1]));
  assert.deepEqual(await readdir(path), ['game.save']);
});
