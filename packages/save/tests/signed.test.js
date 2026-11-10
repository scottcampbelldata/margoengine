import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signedStorage } from '../dist/signed.js';
import { safeStorage } from '../dist/safe.js';
import { memoryStorage, loadGame, saveGame } from '../dist/index.js';

const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const bytes = (...values) => new Uint8Array(values);

test('signed safe storage authenticates the canonical frame with an independent HMAC and protects every byte', async () => {
  const disk = memoryStorage(),
    storage = signedStorage(disk, key);
  await storage.write('slot', bytes(0, 255, 23));
  const raw = await disk.read('slot~a');
  const prefix = Buffer.alloc(9 + 'slot~a'.length * 2);
  prefix.set([77, 83, 73, 71, 1]);
  prefix.writeUInt32BE('slot~a'.length * 2, 5);
  for (let i = 0; i < 'slot~a'.length; i++) prefix.writeUInt16BE('slot~a'.charCodeAt(i), 9 + i * 2);
  const expected = createHmac('sha256', key).update(prefix).update(raw.subarray(37)).digest();
  assert.deepEqual(raw.slice(5, 37), new Uint8Array(expected));
  assert.deepEqual(await storage.read('slot'), bytes(0, 255, 23));
  for (let i = 0; i < raw.length; i++) {
    const edited = raw.slice();
    edited[i] ^= 1;
    await disk.write('slot~a', edited);
    await assert.rejects(storage.read('slot'), { code: 'failed' });
  }
  await disk.write('slot~a', raw);
  assert.deepEqual(await storage.read('slot'), bytes(0, 255, 23));
});

test('signed storage recovers a trusted older copy, reports tampering, rejects copied slots and copy-role swaps', async () => {
  const disk = memoryStorage(),
    recovered = [],
    storage = signedStorage(disk, key, { onRecover: (r) => recovered.push(r) });
  await storage.write('slot', bytes(1));
  await storage.write('slot', bytes(2));
  const newest = await disk.read('slot~b');
  newest[newest.length - 5] ^= 1;
  await disk.write('slot~b', newest);
  assert.deepEqual(await storage.read('slot'), bytes(1));
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].reason, /HMAC authentication/);
  assert.deepEqual(await storage.check('slot'), { ok: true, good: 1, bad: 1, generation: 1 });
  await disk.write('other~a', await disk.read('slot~a'));
  await assert.rejects(storage.read('other'), { code: 'failed' });
  await disk.write('slot~b', await disk.read('slot~a'));
  assert.deepEqual(await storage.read('slot'), bytes(1));
  await disk.delete('slot~a');
  await assert.rejects(storage.read('slot'), { code: 'failed' });
});

test('recomputing the safe CRC does not authenticate edits, while the unsigned adapter accepts the same edited frame', async () => {
  const plain = memoryStorage(),
    unsigned = safeStorage(plain);
  await unsigned.write('slot', bytes(1));
  const old = await plain.read('slot~a');
  // Obtain a correctly framed/CRC-checked edited generation through the public unsigned API.
  const changed = memoryStorage();
  await safeStorage(changed).write('slot', bytes(9));
  const replacement = await changed.read('slot~a');
  assert.notDeepEqual(old, replacement);
  const disk = memoryStorage(),
    signed = signedStorage(disk, key);
  await signed.write('slot', bytes(1));
  const framed = await disk.read('slot~a');
  framed.set(replacement, 37);
  await disk.write('slot~a', framed);
  await assert.rejects(signed.read('slot'), { code: 'failed' });
  await plain.write('slot~a', replacement);
  assert.deepEqual(await unsigned.read('slot'), bytes(9));
});

test('keys are bound without UTF-8 replacement collisions, and wrong keys and unsigned legacy data fail closed', async () => {
  const disk = memoryStorage(),
    storage = signedStorage(disk, key);
  await storage.write('\ud800', bytes(1));
  await disk.write('\ufffd~a', await disk.read('\ud800~a'));
  await assert.rejects(storage.read('\ufffd'), { code: 'failed' });
  await assert.rejects(signedStorage(disk, new Uint8Array(32).fill(9)).read('\ud800'), { code: 'failed' });
  await disk.write('legacy', bytes(1));
  await assert.rejects(signedStorage(disk, key, { legacy: true }).read('legacy'), /HMAC authentication/);
});

test('CryptoKeys, empty saves, saveGame, check, keys and delete compose with safeStorage', async () => {
  const secret = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  const disk = memoryStorage(),
    storage = signedStorage(disk, secret);
  assert.equal(await storage.read('empty'), null);
  await storage.write('empty', bytes());
  assert.deepEqual(await storage.read('empty'), bytes());
  const game = { format: 'margo-save', version: 1, entities: [], meta: { title: 'signed' } };
  await saveGame(storage, 'game', game);
  assert.deepEqual(await loadGame(signedStorage(disk, key), 'game'), game);
  assert.deepEqual(await storage.keys(), ['empty', 'game']);
  assert.equal(await storage.delete('empty'), true);
  assert.equal(await storage.delete('empty'), false);
});

test('keys are copied, import is lazy and cancellation during crypto cannot write an unauthenticated copy', async () => {
  const disk = memoryStorage(),
    raw = key.slice(),
    controller = new AbortController();
  let imports = 0;
  const subtle = {
    importKey(...args) {
      imports++;
      return crypto.subtle.importKey(...args);
    },
    async sign(...args) {
      const result = await crypto.subtle.sign(...args);
      controller.abort(new Error('cancelled'));
      return result;
    },
    verify: (...args) => crypto.subtle.verify(...args),
  };
  const storage = signedStorage(disk, raw, { subtle });
  assert.equal(imports, 0);
  raw.fill(99);
  await assert.rejects(storage.write('slot', bytes(1), { signal: controller.signal }), /cancelled/);
  assert.deepEqual(await disk.keys(), []);
  await storage.write('slot', bytes(2));
  assert.equal(imports, 1);
  assert.deepEqual(await signedStorage(disk, key).read('slot'), bytes(2));
});

test('signedStorage validates keys and storage with actionable errors', async () => {
  for (const candidate of [null, {}, new Uint8Array(31)])
    assert.throws(() => signedStorage(memoryStorage(), candidate), /key/);
  assert.throws(() => signedStorage({}, key), /SaveStorage/);
  const wrongHash = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-384' }, false, ['sign', 'verify']);
  assert.throws(() => signedStorage(memoryStorage(), wrongHash), /SHA-256/);
  const signOnly = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  assert.throws(() => signedStorage(memoryStorage(), signOnly), /verify/);
});
