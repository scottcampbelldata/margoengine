// fileStorage makes its temporary file exclusively, so two writers can never fill one temporary file, and reads check
// the size before reading, so a huge or hostile file is refused without reading it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStorage } from '../dist/node.js';

const bytes = (value) => new TextEncoder().encode(value);

async function folder(job) {
  const directory = await mkdtemp(join(tmpdir(), 'margo-save-limits-'));
  try {
    await job(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a write whose temporary name is taken fails and leaves that file alone', () =>
  folder(async (directory) => {
    const storage = fileStorage(directory),
      now = Date.now,
      fixed = 1_700_000_000_000;
    await storage.write('first', bytes('made the folder'));
    // The next write's temporary file: the save file, this process, the time and the write count.
    Date.now = () => fixed;
    try {
      const taken = join(directory, `slot.save.${process.pid}-${fixed.toString(36)}-2.tmp`);
      assert.deepEqual(await readdir(directory), ['first.save']);
      await writeFile(taken, 'another writer');
      await assert.rejects(
        storage.write('slot', bytes('mine')),
        (error) => error.name === 'MargoError' && error.code === 'failed' && /another writer/.test(error.message),
      );
      assert.equal(await readFile(taken, 'utf8'), 'another writer');
      assert.equal(await storage.read('slot'), null);
    } finally {
      Date.now = now;
    }
  }));

test('a save bigger than maxBytes is refused before it is read, and one at the limit reads', () =>
  folder(async (directory) => {
    const storage = fileStorage(directory, { maxBytes: 16 });
    await storage.write('fits', new Uint8Array(16).fill(7));
    assert.deepEqual(await storage.read('fits'), new Uint8Array(16).fill(7));
    await writeFile(join(directory, 'big.save'), new Uint8Array(17));
    await assert.rejects(
      storage.read('big'),
      (error) => error.name === 'MargoError' && error.code === 'failed' && /maxBytes/.test(error.message),
    );
  }));

test('the default limit of 256 MiB refuses a 300 MiB file without reading it', () =>
  folder(async (directory) => {
    const path = join(directory, 'huge.save'),
      handle = await open(path, 'w');
    await handle.truncate(300 * 1024 * 1024);
    await handle.close();
    await assert.rejects(fileStorage(directory).read('huge'), (error) => error.code === 'failed');
  }));

test('maxBytes must be a whole number of bytes', () => {
  for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '16'])
    assert.throws(() => fileStorage('./saves', { maxBytes }), RangeError);
});
