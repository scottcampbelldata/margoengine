// The shared-memory layout of the physics framework (docs/physics-framework.md, section 3), proved on two prototype
// modules (tests/modules/source and reader, built by scripts/physics-modules.mjs): both import one memory, each with its
// static data in its own slot's window; the reader reads the source's port in place; a snapshot of both restores and
// steps on bit for bit; and the reader's results are the same bits whether 1, 2 or 4 threads share its work, on a
// shared memory, and on a plain memory with one thread.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import * as layout from '../../../scripts/physics-modules.mjs';
import {
  Arena,
  DYNAMIC_BASE,
  MAX_MEMORY_PAGES,
  MODULE_BASE,
  MODULE_SLOTS,
  MODULE_WINDOW,
  loadSolverModule,
  regionWords,
  restoreSnapshot,
  stateHash,
  takeSnapshot,
  worldMemory,
} from '../dist/world.js';

const built = JSON.parse(readFileSync(new URL('./modules/built.json', import.meta.url), 'utf8'));
const builds = (name) => ({
  shared: Buffer.from(built[name].shared, 'base64'),
  plain: Buffer.from(built[name].plain, 'base64'),
});
const N = 1000,
  STRIDE = 6,
  CHUNK = 64,
  CHUNKS = Math.ceil(N / CHUNK),
  LEVEL = 0.75,
  DT = 1 / 240;

/** A world memory with both modules loaded, the source's state region (its port) and the reader's regions. */
async function world(shared) {
  const arena = new Arena(worldMemory(shared)),
    source = await loadSolverModule(arena, { name: 'proto-source', slot: 0 }, builds('proto-source')),
    reader = await loadSolverModule(arena, { name: 'proto-reader', slot: 1 }, builds('proto-reader')),
    state = arena.allocate('proto-source:particles', N * STRIDE * 4, 'f32', 1),
    out = arena.allocate('proto-reader:depth', N * 4, 'f32', 1),
    sums = arena.allocate('proto-reader:sums', CHUNKS * 4, 'f32', 1),
    words = regionWords(arena.memory, state);
  // A fixed start: particles on a lattice, thrown with a spread of speeds.
  for (let i = 0; i < N; i++)
    words.set(
      [(i % 10) * 0.1, 0.2 + (i % 37) * 0.05, Math.floor(i / 10) * 0.1, (i % 7) - 3, (i % 5) * 0.5, (i % 3) - 1],
      i * STRIDE,
    );
  const solvers = [
    { describe: () => ({ id: 'proto-source' }), stateRegions: () => [state], extraState: () => [] },
    { describe: () => ({ id: 'proto-reader' }), stateRegions: () => [out, sums], extraState: () => [] },
  ];
  const step = (count = 1) => {
    for (let k = 0; k < count; k++) source.exports.source_step(state.byteOffset, N, 0, -9.80665, 0, DT);
  };
  return { arena, source, reader, state, out, sums, solvers, step };
}

/** The reader's work on one thread: depths, chunk sums in chunk order, and the total. */
function readSerial(w) {
  w.reader.exports.reader_depth(w.state.byteOffset, STRIDE, 0, N, LEVEL, w.out.byteOffset);
  w.reader.exports.reader_chunk_sums(w.out.byteOffset, N, CHUNK, 0, CHUNKS, w.sums.byteOffset);
  return w.reader.exports.reader_total(w.sums.byteOffset, CHUNKS);
}

const bytes = (w, region) => Buffer.from(new Uint8Array(w.arena.memory.buffer, region.byteOffset, region.byteLength));
const digest = (data) => createHash('sha256').update(data).digest('hex');

test('the module table and the loader agree on the layout, and the committed builds are current and placed', () => {
  assert.equal(layout.MODULE_BASE, MODULE_BASE);
  assert.equal(layout.MODULE_WINDOW, MODULE_WINDOW);
  assert.equal(layout.MODULE_SLOTS, MODULE_SLOTS);
  assert.equal(layout.DYNAMIC_BASE, DYNAMIC_BASE);
  assert.equal(layout.MAX_MEMORY_PAGES, MAX_MEMORY_PAGES);
  assert.deepEqual(layout.checkRecords(), []);
  // The check finds a build placed for another slot.
  const entry = layout.MODULES[1],
    other = Buffer.from(built['proto-source'].plain, 'base64');
  assert.match(layout.moduleProblems(entry, other, false).join(' '), /not its slot's base 131072/);
});

for (const shared of [false, true])
  test(`two modules on one ${shared ? 'shared' : 'plain'} memory: each in its window, the port read in place, the windows never written`, async () => {
    const w = await world(shared);
    assert.equal(w.arena.memory.buffer instanceof SharedArrayBuffer, shared);
    for (const [module, slot] of [
      [w.source, 0],
      [w.reader, 1],
    ]) {
      const base = MODULE_BASE + slot * MODULE_WINDOW;
      assert.equal(module.exports.__global_base.value, base);
      assert.ok(module.exports.__data_end.value <= base + MODULE_WINDOW);
      // Its stack is a region of its own above the windows, its pointer at the region's top.
      assert.ok(module.stack.byteOffset >= DYNAMIC_BASE);
      assert.equal(module.exports.__stack_pointer.value % 16, 0);
      assert.ok(module.exports.__stack_pointer.value <= module.stack.byteOffset + module.stack.byteLength);
      assert.ok(module.exports.__stack_pointer.value >= module.stack.byteOffset + module.stack.byteLength - 16);
    }
    assert.notEqual(w.source.stack.byteOffset, w.reader.stack.byteOffset);
    const windows = () => digest(new Uint8Array(w.arena.memory.buffer, MODULE_BASE, DYNAMIC_BASE - MODULE_BASE));
    const before = windows();
    w.step(120);
    const total = readSerial(w);
    assert.equal(windows(), before, 'no step writes a module window: modules keep no state in statics');
    // The reader read the source's region where it lies: its depths are the positions now in the region.
    const positions = regionWords(w.arena.memory, w.state),
      depths = regionWords(w.arena.memory, w.out),
      weight = [1, 0.875, 0.75, 0.625, 0.5, 0.625, 0.75, 0.875];
    let wet = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.fround(LEVEL - positions[i * STRIDE + 1]);
      assert.equal(depths[i], d > 0 ? Math.fround(d * weight[i & 7]) : 0, `particle ${i}`);
      if (d > 0) wet++;
    }
    assert.ok(wet > 100 && wet < N, `the fixture has particles on both sides of the level: ${wet}`);
    assert.ok(total > 0);
    // Writing the port in place moves what the reader reads next, with no copy between.
    positions[1] = -5;
    w.reader.exports.reader_depth(w.state.byteOffset, STRIDE, 0, 1, LEVEL, w.out.byteOffset);
    assert.equal(depths[0], Math.fround(Math.fround(LEVEL + 5) * weight[0]));
  });

test('a snapshot of both modules restores bit for bit, and the run goes on as if never stopped', async () => {
  const w = await world(false);
  w.step(60);
  readSerial(w);
  const snapshot = takeSnapshot(w.arena.memory, w.solvers);
  w.step(90);
  const totalA = readSerial(w),
    hashA = stateHash(w.arena.memory, w.solvers);
  // Scramble both modules' state, then restore and run the same steps.
  regionWords(w.arena.memory, w.state).fill(123);
  regionWords(w.arena.memory, w.out).fill(-1);
  restoreSnapshot(w.arena.memory, w.solvers, snapshot.bytes);
  assert.equal(stateHash(w.arena.memory, w.solvers), snapshot.hash);
  w.step(90);
  assert.equal(readSerial(w), totalA);
  assert.equal(stateHash(w.arena.memory, w.solvers), hashA);
  // A second world restored from the same bytes, laid out after another region, steps to the same hash.
  const other = await world(false);
  other.arena.allocate('elsewhere', 4096, 'u8', 1);
  restoreSnapshot(other.arena.memory, other.solvers, snapshot.bytes);
  other.step(90);
  readSerial(other);
  assert.equal(stateHash(other.arena.memory, other.solvers), hashA);
});

/** The reader's work split over `threads` workers by element ranges and chunk ranges, then the total on this thread. */
async function readThreaded(w, threads) {
  const workers = [],
    per = Math.ceil(N / threads),
    perChunk = Math.ceil(CHUNKS / threads);
  for (let t = 0; t < threads; t++) {
    const stack = w.arena.allocate(`stack:proto-reader:worker${t}`, 65536 + 8, 'u8', 1);
    workers.push(
      new Worker(new URL('./modules/worker.mjs', import.meta.url), {
        workerData: {
          memory: w.arena.memory,
          module: w.reader.module,
          stack,
          port: w.state.byteOffset,
          stride: STRIDE,
          out: w.out.byteOffset,
          sums: w.sums.byteOffset,
          n: N,
          chunk: CHUNK,
          level: LEVEL,
          range: [Math.min(N, t * per), Math.min(N, (t + 1) * per)],
          chunks: [Math.min(CHUNKS, t * perChunk), Math.min(CHUNKS, (t + 1) * perChunk)],
        },
      }),
    );
  }
  const next = (worker) => new Promise((done, fail) => worker.once('message', done).once('error', fail));
  // Every depth is written before any chunk is summed: the chunks cross the element ranges.
  await Promise.all(workers.map(next));
  const ends = workers.map(next);
  for (const worker of workers) worker.postMessage('sum');
  const pointers = (await Promise.all(ends)).map((m) => m.stackPointer);
  await Promise.all(workers.map((worker) => worker.terminate()));
  assert.equal(new Set(pointers).size, threads, 'each thread runs on a stack of its own');
  return w.reader.exports.reader_total(w.sums.byteOffset, CHUNKS);
}

test('the reader gives the same bits on 1, 2 and 4 threads, and the shared build the bits of the plain one', async () => {
  const plain = await world(false);
  plain.step(150);
  const total = readSerial(plain),
    expected = [digest(bytes(plain, plain.out)), digest(bytes(plain, plain.sums))];
  for (const threads of [1, 2, 4]) {
    const w = await world(true);
    w.step(150);
    assert.equal(digest(bytes(w, w.state)), digest(bytes(plain, plain.state)), 'the shared build steps the same bits');
    assert.ok(Object.is(await readThreaded(w, threads), total), `${threads} threads: total`);
    assert.deepEqual(
      [digest(bytes(w, w.out)), digest(bytes(w, w.sums))],
      expected,
      `${threads} threads: depths and sums`,
    );
  }
});

test('a build placed for another slot is refused before it writes the world memory', async () => {
  const arena = new Arena(worldMemory(false)),
    before = digest(new Uint8Array(arena.memory.buffer));
  await assert.rejects(
    loadSolverModule(arena, { name: 'proto-reader', slot: 1 }, builds('proto-source')),
    (error) => error.code === 'unsupported' && /not inside slot 1's window/.test(error.message),
  );
  assert.equal(digest(new Uint8Array(arena.memory.buffer)), before);
  await assert.rejects(loadSolverModule(arena, { name: 'x', slot: 16 }, builds('proto-source')), RangeError);
});
