// Save slots on memory, file and failing storages. The real browser run is tests/browser/slots-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStorage } from '../dist/index.js';
import { fileStorage } from '../dist/node.js';
import { SaveSlots, captureThumbnail } from '../dist/slots.js';

const save = (title, extra = {}) => ({
  format: 'margo-save',
  version: 2,
  meta: { title, ...extra },
  entities: [{ id: 'player', components: { name: title } }],
});
const clock = (start = 1000) => {
  let now = start;
  return () => now++;
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A storage whose nth write (from 1) fails before it changes anything. */
function failing(inner, nth) {
  let writes = 0;
  return {
    ...inner,
    async write(key, bytes, options) {
      if (++writes === nth) throw new Error(`write ${nth} failed`);
      return inner.write(key, bytes, options);
    },
  };
}

test('a slot holds a save, a record and a thumbnail, and the list reads records alone', async () => {
  const storage = memoryStorage(),
    reads = [],
    counted = {
      ...storage,
      read(key, options) {
        reads.push(key);
        return storage.read(key, options);
      },
    },
    slots = new SaveSlots(counted, { now: clock() });
  const info = await slots.save('slot-1', save('Chapter 1', { playTime: 754 }), {
    meta: { level: 3 },
    thumbnail: png,
  });
  assert.deepEqual({ ...info, bytes: 0 }, {
    id: 'slot-1',
    savedAt: 1000,
    autosave: false,
    version: 2,
    bytes: 0,
    meta: { level: 3 },
    title: 'Chapter 1',
    playTime: 754,
    thumbnail: 'image/png',
  });
  assert.ok(info.bytes > 0);
  await slots.save('slot 2/b', save('Two'), { title: 'Other name', playTime: 5 });
  reads.length = 0;
  const list = await slots.list();
  assert.deepEqual(list.map((s) => [s.id, s.title, s.playTime]), [
    ['slot 2/b', 'Other name', 5],
    ['slot-1', 'Chapter 1', 754],
  ]);
  assert.ok(reads.every((key) => key.endsWith('.info')), 'no save was read to list them');
  assert.equal((await slots.load('slot-1')).entities[0].components.name, 'Chapter 1');
  const picture = await slots.thumbnail('slot-1');
  assert.equal(picture.type, 'image/png');
  assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), png);
  assert.equal(await slots.thumbnail('slot 2/b'), null);
  assert.equal(await slots.load('empty'), null);
  assert.equal(await slots.info('empty'), null);
  assert.equal((await slots.info('slot-1')).title, 'Chapter 1');
});

test('a thumbnail can be a Blob, and bytes name their own type', async () => {
  const slots = new SaveSlots(memoryStorage());
  assert.equal((await slots.save('a', save('a'), { thumbnail: new Blob([png], { type: 'image/avif' }) })).thumbnail, 'image/avif');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]),
    webp = new TextEncoder().encode('RIFF____WEBP');
  assert.equal((await slots.save('b', save('b'), { thumbnail: jpeg })).thumbnail, 'image/jpeg');
  assert.equal((await slots.save('c', save('c'), { thumbnail: webp })).thumbnail, 'image/webp');
});

test('saving over a slot replaces its save and thumbnail and leaves no old files', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage);
  await slots.save('s', save('one'), { thumbnail: png });
  const size = (await storage.keys()).length;
  await slots.save('s', save('two'));
  assert.equal(await slots.thumbnail('s'), null);
  assert.equal((await slots.load('s')).meta.title, 'two');
  assert.equal((await storage.keys()).length, size - 1);
});

test('every write that can fail keeps the old slot, and the next save clears what it left', async () => {
  for (let nth = 1; nth <= 3; nth++) {
    const inner = memoryStorage(),
      first = new SaveSlots(inner);
    await first.save('s', save('old'), { thumbnail: png });
    const before = (await inner.keys()).length,
      slots = new SaveSlots(failing(inner, nth));
    await assert.rejects(slots.save('s', save('new'), { thumbnail: png }), new RegExp(`write ${nth} failed`));
    const again = new SaveSlots(inner);
    assert.equal((await again.load('s')).meta.title, 'old', `write ${nth}`);
    assert.equal((await again.info('s')).title, 'old');
    assert.equal((await (await again.thumbnail('s')).arrayBuffer()).byteLength, png.length);
    await again.save('s', save('newer'), { thumbnail: png });
    assert.equal((await inner.keys()).length, before);
  }
});

test('a save refused by validation writes nothing', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage);
  await assert.rejects(slots.save('s', { format: 'margo-save', version: 1 }), TypeError);
  assert.deepEqual(await storage.keys(), []);
  const checked = new SaveSlots(storage, { validate: { components: { name: () => 'never valid' } } });
  await assert.rejects(checked.save('s', save('x')), /never valid/);
  assert.deepEqual(await storage.keys(), []);
});

test('autosaves take turns over the oldest and leave slots alone', async () => {
  const slots = new SaveSlots(memoryStorage(), { autosaves: 3, now: clock() });
  await slots.save('slot-1', save('mine'));
  for (let i = 0; i < 7; i++) await slots.autosave(save(`auto ${i}`));
  const list = await slots.list();
  assert.deepEqual(list.map((s) => [s.id, s.title]), [
    ['auto-0', 'auto 6'],
    ['auto-2', 'auto 5'],
    ['auto-1', 'auto 4'],
    ['slot-1', 'mine'],
  ]);
  assert.ok(list.slice(0, 3).every((s) => s.autosave));
  assert.equal(list[3].autosave, false);
  assert.equal((await slots.latest()).id, 'auto-0');
  await assert.rejects(slots.save('auto-1', save('x')), /belong to autosave/);
});

test('saves within one millisecond keep their order, and the ring still overwrites the oldest', async () => {
  // A fast machine autosaves twice in one Date.now() millisecond: the list must not fall back to id order, and the
  // ring must not take a newer autosave for the oldest.
  const slots = new SaveSlots(memoryStorage(), { autosaves: 3, now: () => 1000 });
  for (const title of ['a1', 'a2', 'a3', 'a4', 'a5']) await slots.autosave(save(title));
  await slots.save('slot-2', save('mine 2'));
  await slots.save('slot-1', save('mine 1'));
  await slots.copy('slot-2', 'slot-0');
  assert.deepEqual((await slots.list()).map((s) => [s.id, s.title]), [
    ['slot-0', 'mine 2'],
    ['slot-1', 'mine 1'],
    ['slot-2', 'mine 2'],
    ['auto-1', 'a5'],
    ['auto-0', 'a4'],
    ['auto-2', 'a3'],
  ]);
  assert.equal((await slots.latest()).id, 'slot-0');
  assert.equal('sequence' in (await slots.info('auto-1')), false, 'the order of saves stays out of SlotInfo');
});

test('a failed autosave leaves the ring whole', async () => {
  const inner = memoryStorage(),
    slots = new SaveSlots(inner, { autosaves: 2, now: clock() });
  await slots.autosave(save('a'));
  await slots.autosave(save('b'));
  await assert.rejects(new SaveSlots(failing(inner, 1), { autosaves: 2, now: clock(5000) }).autosave(save('c')), /write 1 failed/);
  assert.deepEqual((await slots.list()).map((s) => s.title), ['b', 'a']);
  assert.equal((await slots.load('auto-0')).meta.title, 'a');
});

test('writes run in call order, so two saves at once end with the last', async () => {
  const slots = new SaveSlots(memoryStorage());
  await Promise.all([slots.save('s', save('1')), slots.save('s', save('2')), slots.save('s', save('3'))]);
  assert.equal((await slots.load('s')).meta.title, '3');
  const ring = new SaveSlots(memoryStorage(), { autosaves: 2, now: clock() });
  await Promise.all([ring.autosave(save('a')), ring.autosave(save('b')), ring.autosave(save('c'))]);
  assert.deepEqual((await ring.list()).map((s) => [s.id, s.title]), [
    ['auto-0', 'c'],
    ['auto-1', 'b'],
  ]);
});

test('copy keeps the save, thumbnail and time; delete empties; namespaces stay apart', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage, { now: clock() }),
    other = new SaveSlots(storage, { namespace: 'profile-2', now: clock() });
  await slots.save('a', save('A'), { thumbnail: png });
  await slots.save('b', save('B'));
  await other.save('a', save('theirs'));
  const copied = await slots.copy('a', 'b');
  assert.equal(copied.savedAt, 1000);
  assert.equal((await slots.load('b')).meta.title, 'A');
  assert.ok(await slots.thumbnail('b'));
  await assert.rejects(slots.copy('none', 'c'), (error) => error.code === 'state');
  await assert.rejects(slots.copy('a', 'auto-0'), /belong to autosave/);
  assert.equal(await slots.delete('a'), true);
  assert.equal(await slots.delete('a'), false);
  assert.equal(await slots.load('a'), null);
  assert.equal((await slots.load('b')).meta.title, 'A', 'the copy stands alone');
  assert.equal((await other.load('a')).meta.title, 'theirs');
  assert.deepEqual((await other.list()).map((s) => s.id), ['a']);
  assert.equal((await storage.keys()).filter((key) => key.startsWith('slot:a')).length, 0);
});

test('a damaged record is listed, refuses to load, and can be saved over or deleted', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage, { now: clock() });
  await slots.save('good', save('good'));
  await slots.save('bad', save('bad'));
  await storage.write('slot:bad.info', new Uint8Array([0xff, 1]));
  const list = await slots.list();
  assert.deepEqual(list.map((s) => [s.id, !!s.damaged]), [
    ['good', false],
    ['bad', true],
  ]);
  await assert.rejects(slots.load('bad'), { name: 'TypeError', message: /damaged record/ });
  assert.equal((await slots.latest()).id, 'good');
  await storage.write('slot:bad.info', new TextEncoder().encode('{"format":"other"}'));
  await assert.rejects(slots.load('bad'), /damaged record/);
  await slots.save('bad', save('fixed'));
  assert.equal((await slots.load('bad')).meta.title, 'fixed');
  assert.equal((await storage.keys()).filter((key) => key.endsWith('.data')).length, 2, 'the old file left too');
  await storage.write('slot:bad.info', new Uint8Array([0xff]));
  assert.equal(await slots.delete('bad'), true);
  assert.equal((await storage.keys()).filter((key) => key.startsWith('slot:bad')).length, 0);
});

test('a save whose file went missing says so; arguments are checked', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage);
  await slots.save('s', save('x'));
  await storage.delete((await storage.keys()).find((key) => key.endsWith('.data')));
  await assert.rejects(slots.load('s'), /lost its save/);
  assert.throws(() => new SaveSlots(null), /needs a storage/);
  assert.throws(() => new SaveSlots(storage, { autosaves: 0 }), RangeError);
  assert.throws(() => new SaveSlots(storage, { namespace: 'a:b' }), /namespace/);
  await assert.rejects(slots.load(''), /non-empty/);
  assert.throws(() => slots.autosaveEvery(0, () => null), RangeError);
  assert.throws(() => slots.autosaveEvery(10, null), /capture/);
});

test('a record that cannot be read for now is no reason to overwrite the live files', async () => {
  const inner = memoryStorage(),
    slots = new SaveSlots(inner);
  await slots.save('s', save('old'));
  let down = true;
  const flaky = new SaveSlots({
    ...inner,
    read(key, options) {
      if (down && key.endsWith('.info')) {
        down = false;
        return Promise.reject(new Error('disk busy'));
      }
      return inner.read(key, options);
    },
  });
  await assert.rejects(flaky.save('s', save('new')), /disk busy/);
  assert.equal((await slots.load('s')).meta.title, 'old');
});

test('a key the slots never wrote is left out of the list', async () => {
  const storage = memoryStorage(),
    slots = new SaveSlots(storage);
  await slots.save('s', save('mine'));
  await storage.write('slot:100%.info', new Uint8Array([1]));
  assert.deepEqual((await slots.list()).map((s) => s.id), ['s']);
});

test('captureThumbnail says what to do where there is no OffscreenCanvas', async () => {
  await assert.rejects(captureThumbnail({ width: 4, height: 4 }), (error) => error.code === 'unsupported' && /pass your own/.test(error.message));
  await assert.rejects(captureThumbnail({ width: 4, height: 4 }, { width: 0 }), RangeError);
  await assert.rejects(captureThumbnail({ width: 0, height: 4 }), /with a size/);
});

test('an aborted save keeps the old slot', async () => {
  const slots = new SaveSlots(memoryStorage());
  await slots.save('s', save('old'));
  await assert.rejects(slots.save('s', save('new'), { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  assert.equal((await slots.load('s')).meta.title, 'old');
});

test('autosaveEvery saves on a timer, skips a null, reports failures and stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const slots = new SaveSlots(memoryStorage(), { autosaves: 9, now: clock(), compress: false }),
    problems = [];
  let turn = 0;
  const timer = slots.autosaveEvery(
    1000,
    () => {
      turn++;
      if (turn === 2) return null;
      if (turn === 3) throw new Error('capture failed');
      return save(`turn ${turn}`);
    },
    { onError: (error) => problems.push(error.message) },
  );
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(turn, 4);
  assert.deepEqual(problems, ['capture failed']);
  assert.deepEqual((await slots.list()).map((s) => s.title).sort(), ['turn 1', 'turn 4']);
  timer.stop();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(turn, 4, 'stopped');
  const stop = new AbortController();
  slots.autosaveEvery(1000, () => (turn++, null), { signal: stop.signal });
  stop.abort();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(turn, 4, 'the signal stops it');
});

test('slots work on files, under the names a file system allows', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-slots-'));
  try {
    const slots = new SaveSlots(fileStorage(folder), { now: clock() });
    await slots.save('slot: 1/ü', save('on disk'), { thumbnail: png });
    await slots.autosave(save('auto'));
    const again = new SaveSlots(fileStorage(folder));
    assert.deepEqual((await again.list()).map((s) => s.id), ['auto-0', 'slot: 1/ü']);
    assert.equal((await again.load('slot: 1/ü')).meta.title, 'on disk');
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
