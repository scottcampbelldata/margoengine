import test from 'node:test';
import assert from 'node:assert/strict';
import { opfsStorage } from '../dist/opfs.js';
import { loadGame, saveGame } from '../dist/index.js';

// A filesystem with the standard's temporary-file/close commit semantics, and fault injection at every write boundary.
function filesystem() {
  const files = new Map(),
    namespaces = new Map();
  const fs = {
    files,
    fail: '',
    after: undefined,
    log: [],
    async getDirectoryHandle(name) {
      if (!namespaces.has(name)) namespaces.set(name, new Map());
      return directory(namespaces.get(name));
    },
  };
  function directory(map) {
    return {
      async getFileHandle(name, options) {
        if (!map.has(name)) {
          if (!options?.create) throw new DOMException('missing', 'NotFoundError');
          map.set(name, new Uint8Array());
        }
        const handle = {
          kind: 'file',
          async getFile() {
            return new Blob([map.get(name)]);
          },
          async createWritable(options) {
            assert.equal(options.keepExistingData, false);
            let pending;
            fs.log.push('open');
            fs.after?.('open');
            if (fs.fail === 'open') throw new Error('open failed');
            return {
              async write(bytes) {
                pending = bytes.slice();
                fs.log.push('write');
                fs.after?.('write');
                if (fs.fail === 'write') throw new Error('write failed');
              },
              async close() {
                fs.log.push('close');
                if (fs.fail === 'close') throw new Error('close failed');
                map.set(name, pending);
                files.set(name, pending);
              },
              async abort() {
                fs.log.push('abort');
              },
            };
          },
        };
        return handle;
      },
      async removeEntry(name) {
        if (!map.delete(name)) throw new DOMException('missing', 'NotFoundError');
      },
      async *entries() {
        for (const name of map.keys()) yield [name, await this.getFileHandle(name)];
      },
    };
  }
  return fs;
}

test('OPFS binary, empty, Unicode and path-like keys roundtrip in isolated namespaces', async () => {
  const directory = filesystem(),
    storage = opfsStorage({ directory });
  assert.equal(await storage.read('missing'), null);
  assert.equal(await storage.delete('missing'), false);
  for (const key of ['../save/🦆', '~a', 'empty']) {
    const bytes = key === 'empty' ? new Uint8Array() : new Uint8Array([0, 255, 23]);
    await storage.write(key, bytes);
    assert.deepEqual(await storage.read(key), bytes);
  }
  assert.deepEqual(await storage.keys(), ['../save/🦆', 'empty', '~a']);
  assert.deepEqual(await opfsStorage({ directory, namespace: 'other' }).keys(), []);
  assert.equal(await storage.delete('empty'), true);
  assert.equal(await storage.read('empty'), null);
  const save = { format: 'margo-save', version: 1, entities: [], meta: { title: 'OPFS' } };
  await saveGame(storage, 'game', save);
  assert.deepEqual(await loadGame(opfsStorage({ directory }), 'game'), save);
});

for (const point of ['open', 'write', 'close']) {
  test(`OPFS failure at ${point} preserves the previous committed bytes and hides an uncommitted new key`, async () => {
    const directory = filesystem(),
      storage = opfsStorage({ directory });
    await storage.write('old', new Uint8Array([1, 2, 3]));
    directory.fail = point;
    for (const key of ['old', 'new'])
      await assert.rejects(storage.write(key, new Uint8Array([9])), new RegExp(`${point} failed`));
    assert.deepEqual(await storage.read('old'), new Uint8Array([1, 2, 3]));
    assert.equal(await storage.read('new'), null);
    assert.deepEqual(await storage.keys(), ['old']);
  });
}

test('OPFS abort before open, after stream creation and after write cannot commit', async () => {
  for (const point of ['before', 'open', 'write']) {
    const directory = filesystem(),
      storage = opfsStorage({ directory }),
      controller = new AbortController();
    await storage.write('slot', new Uint8Array([1]));
    directory.log.length = 0;
    if (point === 'before') controller.abort(new Error('cancelled'));
    else
      directory.after = (at) => {
        if (point === at) controller.abort(new Error('cancelled'));
      };
    await assert.rejects(storage.write('slot', new Uint8Array([2]), { signal: controller.signal }), /cancelled/);
    assert.deepEqual(await storage.read('slot'), new Uint8Array([1]));
    assert.ok(!directory.log.includes('close'));
    if (point !== 'before') assert.ok(directory.log.includes('abort'));
  }
});

test('OPFS queues same-key writes, copies input and exposes unsupported and invalid input failures', async () => {
  const directory = filesystem(),
    storage = opfsStorage({ directory }),
    bytes = new Uint8Array([1]);
  const first = storage.write('slot', bytes);
  bytes[0] = 9;
  await first;
  assert.deepEqual(await storage.read('slot'), new Uint8Array([1]));
  await Promise.all([storage.write('slot', new Uint8Array([2])), storage.write('slot', new Uint8Array([3]))]);
  assert.deepEqual(await storage.read('slot'), new Uint8Array([3]));
  await assert.rejects(storage.read(''), /key/);
  await assert.rejects(storage.read('\ud800'), /Unicode/);
  await assert.rejects(storage.write('slot', []), /Uint8Array/);
  await assert.rejects(storage.read('a'.repeat(176)), /shorter/);
  assert.throws(() => opfsStorage({ namespace: '../escape' }), /namespace/);
  await assert.rejects(opfsStorage().read('slot'), { code: 'unsupported' });
});
