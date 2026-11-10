// Real proof of @margoengine/save/safe in a browser: real IndexedDB and real localStorage, the newest copy damaged in the
// real store, a page reload between. Also that the browser really gets strict durability on a write.
// `npm run test:gpu --workspace @margoengine/save`.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const opfsNamespace = `save-opfs-check-${process.pid}`;
  await page.evaluate(async (namespace) => {
    const { opfsStorage } = await import('/packages/save/dist/opfs.js');
    const storage = opfsStorage({ namespace });
    await storage.write('../slot/🦆', new Uint8Array([0, 255, 17]));
    await storage.write('empty', new Uint8Array());
  }, opfsNamespace);
  await page.reload();
  const opfs = await page.evaluate(async (namespace) => {
    const { opfsStorage } = await import('/packages/save/dist/opfs.js');
    const root = await navigator.storage.getDirectory();
    const storage = opfsStorage({ namespace });
    try {
      const before = [...(await storage.read('../slot/🦆'))];
      const directory = await root.getDirectoryHandle(namespace);
      // A real writable's temporary contents must remain invisible when aborting instead of closing.
      for await (const [name, handle] of directory.entries()) {
        if ((await handle.getFile()).size <= 5) continue;
        const stream = await handle.createWritable({ keepExistingData: false });
        await stream.write(new Uint8Array([99]));
        await stream.abort();
      }
      const after = [...(await storage.read('../slot/🦆'))];
      const keys = await storage.keys();
      const empty = [...(await storage.read('empty'))];
      const deleted = await storage.delete('../slot/🦆');
      return { before, after, keys, empty, deleted, absent: await storage.read('../slot/🦆') };
    } finally {
      await root.removeEntry(namespace, { recursive: true });
    }
  }, opfsNamespace);
  assert.deepEqual(opfs, {
    before: [0, 255, 17],
    after: [0, 255, 17],
    keys: ['../slot/🦆', 'empty'],
    empty: [],
    deleted: true,
    absent: null,
  });
  await page.evaluate(async () => {
    const { indexedDBStorage, saveGame } = await import('/packages/save/dist/index.js');
    const { signedStorage } = await import('/packages/save/dist/signed.js');
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const signed = signedStorage(indexedDBStorage({ database: 'save-signed-check' }), key);
    for (const title of ['trusted older', 'trusted newer'])
      await saveGame(signed, 'game', { format: 'margo-save', version: 1, entities: [], meta: { title } });
  });
  await page.reload();
  const signedResult = await page.evaluate(async () => {
    const { indexedDBStorage, loadGame } = await import('/packages/save/dist/index.js');
    const { signedStorage } = await import('/packages/save/dist/signed.js');
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const disk = indexedDBStorage({ database: 'save-signed-check' });
    const recovered = [],
      signed = signedStorage(disk, key, { onRecover: (r) => recovered.push(r.copy) });
    const before = (await loadGame(signed, 'game')).meta.title;
    const edited = await disk.read('game~b');
    edited[edited.length - 5] ^= 1;
    await disk.write('game~b', edited);
    const after = (await loadGame(signed, 'game')).meta.title;
    const check = await signed.check('game');
    await disk.write('other~a', await disk.read('game~a'));
    const copied = await signed.read('other').then(
      () => 'accepted',
      (error) => error.code,
    );
    return { before, after, check, recovered, copied };
  });
  assert.deepEqual(signedResult, {
    before: 'trusted newer',
    after: 'trusted older',
    check: { ok: true, good: 1, bad: 1, generation: 1 },
    recovered: ['game~b'],
    copied: 'failed',
  });
  const durability = await page.evaluate(async () => {
    const { indexedDBStorage, saveGame, webStorage } = await import('/packages/save/dist/index.js'),
      { safeStorage } = await import('/packages/save/dist/safe.js');
    const seen = [],
      real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function transaction(...args) {
      const tx = real.apply(this, args);
      if (tx.mode === 'readwrite') seen.push(tx.durability);
      return tx;
    };
    const game = (title) => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] });
    for (const storage of [indexedDBStorage({ database: 'save-safe-check' }), webStorage()]) {
      const safe = safeStorage(storage);
      await saveGame(safe, 'game', game('older'));
      await saveGame(safe, 'game', game('newer'));
    }
    IDBDatabase.prototype.transaction = real;
    return seen;
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const { indexedDBStorage, loadGame, webStorage } = await import('/packages/save/dist/index.js'),
      { safeStorage } = await import('/packages/save/dist/safe.js');
    const out = [];
    for (const storage of [indexedDBStorage({ database: 'save-safe-check' }), webStorage()]) {
      const recovered = [],
        safe = safeStorage(storage, { onRecover: (recovery) => recovered.push(recovery.copy) }),
        whole = (await loadGame(safe, 'game')).meta.title,
        newest = await storage.read('game~b');
      await storage.write('game~b', newest.subarray(0, newest.length - 5));
      const after = (await loadGame(safe, 'game')).meta.title,
        check = await safe.check('game');
      await storage.write('game~a', new Uint8Array(3));
      const lost = await loadGame(safe, 'game').then(
        () => 'loaded',
        (error) => error.code,
      );
      out.push({ whole, after, check, recovered, lost, keys: await safe.keys() });
    }
    return out;
  });
  console.log(JSON.stringify({ durability, result }));
  assert.deepEqual(errors, []);
  assert.deepEqual(durability, ['strict', 'strict']);
  for (const store of result)
    assert.deepEqual(store, {
      whole: 'newer',
      after: 'older',
      check: { ok: true, good: 1, bad: 1, generation: 1 },
      recovered: ['game~b'],
      lost: 'failed',
      keys: ['game'],
    });
} finally {
  await browser.close();
}
