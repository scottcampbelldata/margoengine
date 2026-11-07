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
