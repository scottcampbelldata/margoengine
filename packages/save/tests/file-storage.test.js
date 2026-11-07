// fileStorage against what a real file system does around a rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStorage } from '../dist/node.js';

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
