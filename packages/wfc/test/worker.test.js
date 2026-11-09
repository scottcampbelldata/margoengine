import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { readFileSync, readdirSync } from 'node:fs';
import { WFCWorkerSolve } from '../dist/worker.js';
import { HeapWFC } from '../dist/chunks.js';

const tiles = [0, 1].map(() => ({ neighbors: Array.from({ length: 6 }, () => [0, 1]) }));
class FakeWorker {
  static all = [];
  constructor() {
    FakeWorker.all.push(this);
    this.terminated = 0;
  }
  postMessage(message) {
    this.message = structuredClone(message);
  }
  terminate() {
    this.terminated++;
  }
  reply(data) {
    this.onmessage?.({ data });
  }
}
function globals(t, Worker = FakeWorker) {
  const old = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.Worker = Worker;
  globalThis.location = { href: 'file:///' };
  t.after(() => {
    for (const key of ['Worker', 'location']) {
      if (old[key]) Object.defineProperty(globalThis, key, old[key]);
      else delete globalThis[key];
    }
  });
}

test('worker import is SSR safe; unsupported/pre-aborted/invalid timeout starts no worker', (t) => {
  assert.throws(
    () => new WFCWorkerSolve([1, 1, 1], tiles),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
  globals(t);
  const before = FakeWorker.all.length;
  assert.throws(
    () => new WFCWorkerSolve([1, 1, 1], tiles, { signal: AbortSignal.abort('stop') }),
    (e) => e === 'stop',
  );
  for (const timeout of [0, -1, Infinity, NaN, 1.5, 2147483648])
    assert.throws(() => new WFCWorkerSolve([1, 1, 1], tiles, { timeout }), RangeError);
  assert.equal(FakeWorker.all.length, before);
});
test('one-shot transport copies inputs, coalesces progress, transfers result and releases listeners', async (t) => {
  globals(t);
  const controller = new AbortController(),
    job = new WFCWorkerSolve([4, 1, 1], tiles, { seed: 7, signal: controller.signal });
  const worker = FakeWorker.all.at(-1),
    iterator = job[Symbol.asyncIterator]();
  assert.equal(worker.message.options.seed, 7);
  assert.equal('signal' in worker.message.options, false);
  assert.notEqual(worker.message.tiles, tiles);
  const pending = iterator.next();
  for (let decisions = 1; decisions <= 100; decisions++)
    worker.reply({ progress: { backend: 'typescript', decisions, updates: decisions, intersections: 0, attempts: 1 } });
  assert.equal((await pending).value.decisions, 100);
  const cells = new Uint16Array([0, 1, 0, 1]);
  worker.reply({ result: cells });
  assert.equal(await job.result, cells);
  assert.equal((await iterator.next()).done, true);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  controller.abort('late');
  job.dispose();
  assert.equal(worker.terminated, 1);
  await assert.rejects(job[Symbol.asyncIterator]().next(), (e) => e.code === 'state');
});
test('abort and disposal terminate active CPU work and close a waiting progress reader', async (t) => {
  globals(t);
  for (const mode of ['abort', 'dispose']) {
    const c = new AbortController(),
      job = new WFCWorkerSolve([4, 1, 1], tiles, { signal: c.signal });
    const worker = FakeWorker.all.at(-1),
      pending = job[Symbol.asyncIterator]().next();
    const rejected = assert.rejects(job.result, (e) => (mode === 'abort' ? e === 'cancel' : e.code === 'disposed'));
    if (mode === 'abort') c.abort('cancel');
    else job[Symbol.dispose]();
    await rejected;
    assert.equal((await pending).done, true);
    assert.equal(worker.terminated, 1);
  }
});
test('worker crash, malformed messages, clone failure, solver errors and watchdog all clean up', async (t) => {
  globals(t);
  for (const mode of ['crash', 'messageerror', 'invalid', 'progress', 'range', 'coded', 'timeout']) {
    const job = new WFCWorkerSolve([1, 1, 1], tiles, { timeout: mode === 'timeout' ? 5 : 1000 }),
      worker = FakeWorker.all.at(-1);
    const rejected = assert.rejects(job.result, (e) =>
      mode === 'range'
        ? e instanceof RangeError
        : mode === 'coded'
          ? e.code === 'failed'
          : e.code === (mode === 'timeout' ? 'timeout' : 'failed'),
    );
    if (mode === 'crash') worker.onerror({ message: 'crash' });
    if (mode === 'messageerror') worker.onmessageerror();
    if (mode === 'invalid') worker.reply({ junk: 1 });
    if (mode === 'progress') worker.reply({ progress: { decisions: -1 } });
    if (mode === 'range') worker.reply({ error: { name: 'RangeError', message: 'bad grid' } });
    if (mode === 'coded')
      worker.reply({
        error: { name: 'MargoError', code: 'failed', message: 'failed. Help: https://margoengine.com/docs/wfc' },
      });
    await rejected;
    assert.equal(worker.terminated, 1, mode);
    assert.equal(worker.onmessage, null);
  }
  class BadClone extends FakeWorker {
    postMessage() {
      throw new DOMException('bad', 'DataCloneError');
    }
  }
  globalThis.Worker = BadClone;
  const job = new WFCWorkerSolve([1, 1, 1], tiles);
  await assert.rejects(job.result, (e) => e.code === 'failed' && e.cause.name === 'DataCloneError');
  assert.equal(FakeWorker.all.at(-1).terminated, 1);
  globalThis.Worker = class {
    constructor() {
      throw new Error('CSP');
    }
  };
  assert.throws(
    () => new WFCWorkerSolve([1, 1, 1], tiles),
    (e) => e.code === 'failed' && /https:/.test(e.message),
  );
});

class RealWorker {
  constructor(url) {
    this.thread = new Thread(new URL('./worker-host.mjs', import.meta.url), { workerData: { url: String(url) } });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message }));
  }
  postMessage(data) {
    this.thread.postMessage(data);
  }
  terminate() {
    void this.thread.terminate();
  }
}

test('actual worker forwards coded missing-asset failures and rejects sparse grid inputs', {
  timeout: 60000,
}, async (t) => {
  class MissingAssetWorker extends RealWorker {
    postMessage(data) {
      super.postMessage({ ...data, wasmURL: new URL('./absent-wfc-artifact.wasm', import.meta.url).href });
    }
  }
  globals(t, MissingAssetWorker);
  using missing = new WFCWorkerSolve([1, 1, 1], tiles, { backend: 'wasm' });
  await assert.rejects(
    missing.result,
    (e) => e.code === 'failed' && /https:\/\/margoengine.com\/docs\/wfc/.test(e.message),
  );
  using sparse = new WFCWorkerSolve([1, , 1], tiles, { backend: 'wasm' });
  await assert.rejects(sparse.result, RangeError);
});
test('actual classic worker runs TS and SIMD with live work reports and identical seed streams', {
  timeout: 60000,
}, async (t) => {
  globals(t, RealWorker);
  for (const backend of ['typescript', 'wasm'])
    for (const seed of [0, -7, 4294967296]) {
      using job = new WFCWorkerSolve([40, 32, 1], tiles, { backend, seed });
      const result = job.result;
      const events = [];
      for await (const progress of job) events.push(progress);
      const cells = await result;
      assert.deepEqual(cells, new HeapWFC([40, 32, 1], tiles).solve({ seed }));
      assert.ok(
        events.some((p) => p.decisions > 0 && p.decisions < cells.length),
        backend,
      );
      assert.ok(events.every((p) => p.backend === backend));
      assert.deepEqual(events.at(-1), { backend, ...newStats(seed) });
    }
  function newStats(seed) {
    const m = new HeapWFC([40, 32, 1], tiles);
    m.solve({ seed });
    return m.stats;
  }
  using bad = new WFCWorkerSolve([0, 1, 1], tiles);
  await assert.rejects(bad.result, RangeError);
});
test('classic worker has no nested Wasm copy; own Rust progress import is explicit', () => {
  const worker = readFileSync(new URL('../dist/workers/wfc.js', import.meta.url), 'utf8');
  assert.ok(worker.includes('progress'));
  assert.deepEqual(readdirSync(new URL('../dist/workers/', import.meta.url)), ['wfc.js']);
  assert.deepEqual(
    WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(new URL('../src/wfc.wasm', import.meta.url)))),
    [{ module: 'progress', name: 'report', kind: 'function' }],
  );
});
test('actual worker preserves pins, weighted/wide auto selection and coded solver failures', {
  timeout: 60000,
}, async (t) => {
  globals(t, RealWorker);
  for (const n of [2, 48]) {
    const ids = Array.from({ length: n }, (_, i) => i);
    const rules = ids.map((i) => ({ weight: i + 1, neighbors: Array.from({ length: 6 }, () => ids) }));
    const options = { seed: 19, pins: [{ position: [0, 0, 0], tile: n - 1 }] };
    using job = new WFCWorkerSolve([8, 4, 1], rules, options);
    assert.deepEqual(await job.result, new HeapWFC([8, 4, 1], rules).solve(options));
    using unsupported = new WFCWorkerSolve([8, 4, 1], rules, { backend: 'wasm' });
    await assert.rejects(unsupported.result, (e) => e.code === 'unsupported' && /https:/.test(e.message));
  }
  using failed = new WFCWorkerSolve([2, 1, 1], [{ neighbors: Array.from({ length: 6 }, () => []) }], { attempts: 1 });
  await assert.rejects(failed.result, (e) => e.code === 'failed' && /https:/.test(e.message));
});
