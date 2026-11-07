// safeStorage against the states a crash can leave. The crash states follow the model of Pillai et al. (OSDI 2014,
// ALICE): a write that lands as a prefix, in pieces, with garbage in it, or out of order. Those are built on a stand-in
// storage; the last test kills a real process while it writes real files. The real browser run is
// tests/browser/safe-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGame, memoryStorage, saveGame } from '../dist/index.js';
import { fileStorage } from '../dist/node.js';
import { safeStorage } from '../dist/safe.js';
import { SaveSlots } from '../dist/slots.js';

const text = (bytes) => new TextDecoder().decode(bytes);
const bytes = (value) => new TextEncoder().encode(value);

/** A store with two good copies, 'old' then 'new', and which copy holds which. */
async function twoCopies(key = 'k') {
  const inner = memoryStorage(),
    safe = safeStorage(inner);
  await safe.write(key, bytes('older save'));
  await safe.write(key, bytes('newer save'));
  return { inner, safe, older: `${key}~a`, newer: `${key}~b` };
}

test('a write alternates the copies, and a read gives the newest', async () => {
  const inner = memoryStorage(),
    safe = safeStorage(inner);
  assert.equal(await safe.read('k'), null);
  for (let i = 0; i < 5; i++) {
    await safe.write('k', bytes(`save ${i}`));
    assert.equal(text(await safe.read('k')), `save ${i}`);
  }
  assert.deepEqual(await inner.keys(), ['k~a', 'k~b']);
  assert.deepEqual(await safe.keys(), ['k']);
  assert.deepEqual(await safe.check('k'), { ok: true, good: 2, bad: 0, generation: 5 });
  assert.deepEqual(await safe.check('none'), { ok: false, good: 0, bad: 0, generation: 0 });
  await safe.write('empty', new Uint8Array(0));
  assert.equal((await safe.read('empty')).length, 0);
});

test('delete removes both copies, and says whether there were any', async () => {
  const { inner, safe } = await twoCopies();
  assert.equal(await safe.delete('k'), true);
  assert.equal(await safe.delete('k'), false);
  assert.deepEqual(await inner.keys(), []);
  assert.equal(await safe.read('k'), null);
});

test('a crash in a delete leaves the newest save, never an older one', async () => {
  const { inner, older } = await twoCopies(),
    deleted = [];
  await assert.rejects(
    safeStorage({
      ...inner,
      delete(key, options) {
        deleted.push(key);
        if (deleted.length === 2) throw new Error('crash');
        return inner.delete(key, options);
      },
    }).delete('k'),
    /crash/,
  );
  assert.equal(deleted[0], older);
  assert.equal(text(await safeStorage(inner).read('k')), 'newer save');
});

test('every prefix of a write leaves the last good save', async () => {
  const { inner, older } = await twoCopies(),
    payload = bytes('the newest save of all'),
    probe = memoryStorage();
  await safeStorage(probe).write('p', payload);
  const whole = await probe.read('p~a'),
    framed = new Uint8Array(whole);
  for (let length = 0; length < framed.length; length++) {
    await inner.write(older, framed.subarray(0, length));
    const seen = [],
      safe = safeStorage(inner, { onRecover: (recovery) => seen.push(recovery) });
    assert.equal(text(await safe.read('k')), 'newer save', `prefix of ${length}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].copy, older);
    assert.deepEqual(await safe.check('k'), { ok: true, good: 1, bad: 1, generation: 2 });
  }
});

test('a write torn in three parts, with holes or garbage, is never taken for a save', async () => {
  const inner = memoryStorage(),
    safe = safeStorage(inner),
    payload = new Uint8Array(300).map((_, i) => (i * 7) & 255);
  await safe.write('k', bytes('good save'));
  await safe.write('k', bytes('next save'));
  await safe.write('k', payload);
  const whole = await inner.read('k~a'),
    before = await inner.read('k~b');
  assert.equal(text(await safe.read('k')).length, 300);
  const cuts = [0, 100, 200, whole.length],
    fills = [() => 0, (i) => (i * 31 + 5) & 255, (i) => before[i] ?? 0];
  for (const fill of fills)
    for (let parts = 0; parts < 7; parts++) {
      const torn = whole.slice();
      for (let part = 0; part < 3; part++)
        if (!(parts & (1 << part))) for (let i = cuts[part]; i < cuts[part + 1]; i++) torn[i] = fill(i);
      await inner.write('k~a', torn);
      assert.equal(text(await safe.read('k')), 'next save', `parts ${parts}`);
    }
});

test('pieces of two writes landing out of order are caught', async () => {
  const inner = memoryStorage(),
    safe = safeStorage(inner),
    a = new Uint8Array(512).fill(1),
    b = new Uint8Array(512).fill(2);
  await safe.write('k', a);
  await safe.write('k', bytes('kept'));
  const first = await inner.read('k~a');
  await safe.write('k', b);
  const second = await inner.read('k~a');
  await safe.write('k', bytes('kept')); // goes to ~b, generation 4
  for (let cut = 1; cut < first.length; cut += 37) {
    const mixed = first.slice();
    mixed.set(second.subarray(cut), cut);
    await inner.write('k~a', mixed);
    assert.equal(text(await safe.read('k')), 'kept');
  }
});

test('every single flipped bit is found, and so are bursts of up to 32 bits', async () => {
  const { inner, safe, newer } = await twoCopies(),
    good = await inner.read(newer);
  for (let bit = 0; bit < good.length * 8; bit++) {
    const flipped = good.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    await inner.write(newer, flipped);
    assert.equal(text(await safe.read('k')), 'older save', `bit ${bit}`);
  }
  let seed = 1;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let round = 0; round < 500; round++) {
    const flipped = good.slice(),
      start = next() % (good.length * 8 - 32),
      span = 2 + (next() % 31);
    for (const at of [start, start + span - 1]) flipped[at >> 3] ^= 1 << (at & 7);
    for (let at = start + 1; at < start + span - 1; at++) if (next() & 1024) flipped[at >> 3] ^= 1 << (at & 7);
    await inner.write(newer, flipped);
    assert.equal(text(await safe.read('k')), 'older save', `round ${round}`);
  }
});

test('the write after damage goes over the bad copy and keeps the good one', async () => {
  const { inner, safe, newer } = await twoCopies();
  await inner.write(newer, new Uint8Array([1, 2, 3]));
  await safe.write('k', bytes('third'));
  assert.equal(text(await safe.read('k')), 'third');
  assert.deepEqual(await safe.check('k'), { ok: true, good: 2, bad: 0, generation: 2 });
  await inner.delete(newer);
  assert.equal(text(await safe.read('k')), 'older save', 'the copy it spared is the older save');
});

test('with both copies bad a read says so and names the way out', async () => {
  const { inner, safe, older, newer } = await twoCopies();
  await inner.write(older, new Uint8Array(4));
  await inner.write(newer, bytes('x'.repeat(80)));
  await assert.rejects(safe.read('k'), (error) => {
    assert.equal(error.code, 'failed');
    assert.match(error.message, /k~a: .*k~b: .*delete this one/);
    return true;
  });
  assert.deepEqual(await safe.check('k'), { ok: false, good: 0, bad: 2, generation: 0 });
  await safe.write('k', bytes('fresh'));
  assert.equal(text(await safe.read('k')), 'fresh');
  assert.equal(await safe.delete('k'), true);
});

test('the first write torn is reported, since there is nothing older', async () => {
  const inner = memoryStorage(),
    safe = safeStorage(inner);
  await inner.write('k~a', new Uint8Array(10));
  await assert.rejects(safe.read('k'), (error) => error.code === 'failed');
});

test('a copy the storage cannot read counts as bad', async () => {
  const { inner, newer } = await twoCopies(),
    seen = [],
    safe = safeStorage(
      {
        ...inner,
        read(key, options) {
          if (key === newer) return Promise.reject(new Error('disk read error'));
          return inner.read(key, options);
        },
      },
      { onRecover: (recovery) => seen.push(recovery.reason) },
    );
  assert.equal(text(await safe.read('k')), 'older save');
  assert.deepEqual(seen, ['disk read error']);
});

test('a stopped call rejects with the signal, and is not taken for damage', async () => {
  const { safe } = await twoCopies(),
    signal = AbortSignal.abort(new Error('stop'));
  await assert.rejects(safe.read('k', { signal }), /stop/);
  await assert.rejects(safe.write('k', bytes('x'), { signal }), /stop/);
  assert.equal(text(await safe.read('k')), 'newer save');
});

test('a write that fails at any step keeps the last good save', async () => {
  for (let nth = 1; nth <= 4; nth++) {
    const { inner } = await twoCopies();
    let calls = 0;
    const count = (fn) => (...args) => {
      if (++calls === nth) return Promise.reject(new Error(`step ${nth} failed`));
      return fn(...args);
    };
    const safe = safeStorage({ ...inner, read: count(inner.read), write: count(inner.write) });
    await safe.write('k', bytes('lost')).catch((error) => assert.match(error.message, /step/));
    const value = text(await safeStorage(inner).read('k'));
    assert.ok(value === 'newer save' || value === 'lost', `step ${nth}: ${value}`);
  }
});

test('a storage that drops or changes a write is caught by the read-back', async () => {
  for (const change of [() => {}, (key, bytes, write) => write(key, bytes.subarray(0, bytes.length - 1))]) {
    const { inner } = await twoCopies(),
      lying = {
        ...inner,
        write: async (key, bytes, options) => change(key, bytes, (k, b) => inner.write(k, b, options)),
      };
    await assert.rejects(safeStorage(lying).write('k', bytes('lost')), (error) => error.code === 'failed' && /save again/.test(error.message));
    assert.equal(text(await safeStorage(inner).read('k')), 'newer save');
  }
  const { inner } = await twoCopies();
  const blind = safeStorage({ ...inner, write: async () => {} }, { verify: false });
  await blind.write('k', bytes('gone'));
  assert.equal(text(await safeStorage(inner).read('k')), 'newer save', 'verify: false does not look');
});

test('a plain save is refused unless legacy is on, and the first write moves it over', async () => {
  const inner = memoryStorage();
  await inner.write('old', bytes('from before'));
  await assert.rejects(safeStorage(inner).read('old'), (error) => error.code === 'failed' && /legacy: true/.test(error.message));
  assert.deepEqual(await safeStorage(inner).keys(), ['old']);
  const safe = safeStorage(inner, { legacy: true });
  assert.equal(text(await safe.read('old')), 'from before');
  await safe.write('old', bytes('checked'));
  assert.deepEqual(await inner.keys(), ['old~a']);
  assert.equal(text(await safeStorage(inner).read('old')), 'checked');
  await inner.write('gone', bytes('x'));
  assert.equal(await safe.delete('gone'), true);
  assert.deepEqual(await inner.keys(), ['old~a']);
});

test('unframed bytes in a copy are damage, with legacy on or off', async () => {
  const inner = memoryStorage();
  await inner.write('k~a', bytes('x'.repeat(40)));
  await assert.rejects(safeStorage(inner).read('k'), /not a checked copy/);
  await assert.rejects(safeStorage(inner, { legacy: true }).read('k'), /not a checked copy/);
});

test('calls on a key run in order, and keys with the suffix survive', async () => {
  const safe = safeStorage(memoryStorage());
  const reads = await Promise.all([safe.write('k', bytes('1')), safe.read('k'), safe.write('k', bytes('2')), safe.read('k')]);
  assert.equal(text(reads[1]), '1');
  assert.equal(text(reads[3]), '2');
  await safe.write('x~a', bytes('odd name'));
  assert.deepEqual(await safe.keys(), ['k', 'x~a']);
  assert.equal(text(await safe.read('x~a')), 'odd name');
});

test('arguments are checked', async () => {
  assert.throws(() => safeStorage(null), /needs a storage/);
  const safe = safeStorage(memoryStorage());
  await assert.rejects(safe.read(''), /non-empty/);
  await assert.rejects(safe.write('k', 'text'), /Uint8Array/);
});

test('saves and slots run over it, and a copy cut short on disk costs one save', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-safe-'));
  try {
    const seen = [],
      storage = safeStorage(fileStorage(folder), { onRecover: (recovery) => seen.push(recovery.key) }),
      document = (title) => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] });
    await saveGame(storage, 'game', document('one'));
    await saveGame(storage, 'game', document('two'));
    const newest = join(folder, 'game~b.save');
    await truncate(newest, 30);
    assert.equal((await loadGame(storage, 'game')).meta.title, 'one');
    assert.deepEqual(seen, ['game']);
    const garbage = await readFile(join(folder, 'game~a.save'));
    garbage[40] ^= 0x10;
    await writeFile(join(folder, 'game~a.save'), garbage);
    await assert.rejects(loadGame(storage, 'game'), (error) => error.code === 'failed');
    const slots = new SaveSlots(storage);
    await slots.save('slot-1', document('slotted'), { thumbnail: new Uint8Array([0xff, 0xd8, 0xff]) });
    assert.equal((await new SaveSlots(storage).list())[0].title, 'slotted');
    assert.equal((await slots.load('slot-1')).meta.title, 'slotted');
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a process killed while it writes real files leaves a whole save, no older than the last it was told of', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'margo-safe-kill-')),
    writer = fileURLToPath(new URL('./safe-writer.mjs', import.meta.url));
  try {
    let wrote = 0;
    for (let round = 0; round < 12; round++) {
      const child = spawn(process.execPath, [writer, folder, String(wrote + 1)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let done = 0,
        output = '';
      await new Promise((resolve, reject) => {
        const limit = setTimeout(() => reject(new Error('the writer did not start')), 20_000);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const lines = output.split('\n');
          output = lines.pop();
          for (const line of lines) done = Number(line);
          if (done > wrote + round % 4) {
            clearTimeout(limit);
            child.kill('SIGKILL');
          }
        });
        child.on('exit', () => {
          clearTimeout(limit);
          resolve();
        });
      });
      const save = await safeStorage(fileStorage(folder)).read('game');
      assert.ok(save, `round ${round}: no save left`);
      const number = new DataView(save.buffer, save.byteOffset).getUint32(0);
      assert.equal(save.length, 1 << 20, `round ${round}`);
      assert.ok(save.every((byte, i) => i < 4 || byte === ((number + i) & 255)), `round ${round}: a mixed save`);
      assert.ok(number >= done, `round ${round}: save ${number} is older than the acknowledged ${done}`);
      wrote = number;
    }
    assert.ok(wrote > 12);
    assert.ok((await readdir(folder)).some((name) => name.startsWith('game')));
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
