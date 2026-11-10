import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { World, ChangeTracker } from '../dist/index.js';
import { SharedWorld, ParallelSchedule, sharedIndex } from '../dist/parallel.js';
const module = new URL('./fixtures/parallel-systems.mjs', import.meta.url);
function workers(barrier) {
  const created = [];
  const factory = () => {
    const native = new Worker(new URL('./fixtures/parallel-worker.mjs', import.meta.url), { workerData: { barrier } });
    created.push(native);
    const listeners = new Map();
    return {
      postMessage: (m) => native.postMessage(m),
      addEventListener(type, listener) {
        const wrapped = type === 'message' ? (data) => listener({ data }) : (error) => listener({ error });
        const exit = (code) => {
          if (code !== 0) listener({ error: new TypeError('worker exited ' + code) });
        };
        if (!listeners.has(type)) listeners.set(type, new Map());
        listeners.get(type).set(listener, { type, wrapped, exit });
        native.on(type, wrapped);
        if (type === 'error') native.on('exit', exit);
      },
      removeEventListener(type, listener) {
        const item = listeners.get(type)?.get(listener);
        if (item) {
          native.off(type, item.wrapped);
          if (type === 'error') native.off('exit', item.exit);
          listeners.get(type).delete(listener);
        }
      },
      terminate: () => native.terminate(),
    };
  };
  return { factory, created };
}
function view(component) {
  return {
    entities: component.entities,
    rows: component.rows,
    stride: component.world.stride,
    count: component.size,
    fields: component.fields,
  };
}
test('shared stores preserve packed row lookup, generations and ordinary query behavior', () => {
  const w = new SharedWorld(4),
    p = w.component({ x: Float32Array }),
    tag = w.tag();
  const a = w.create(),
    b = w.create(),
    c = w.create();
  p.add(a, { x: 1 });
  p.add(b, { x: 2 });
  p.add(c, { x: 3 });
  tag.add(c);
  for (const array of [p.fields.x, p.entities, p.rows]) assert.ok(array.buffer instanceof SharedArrayBuffer);
  p.remove(b);
  assert.equal(sharedIndex(view(p), c), 1);
  assert.equal(sharedIndex(view(p), b), -1);
  w.destroy(a);
  assert.equal(sharedIndex(view(p), a), -1);
  const reused = w.create();
  p.add(reused);
  assert.notEqual(reused, a);
  assert.equal(sharedIndex(view(p), a), -1);
  assert.equal(sharedIndex(view(p), reused), p.index(reused));
  assert.equal(sharedIndex(view(p), NaN), -1);
  assert.equal(w.query([p, tag], new Uint32Array(4)), 1);
});
test('read/write hazards and explicit dependencies form deterministic concurrent groups', async () => {
  const w = new SharedWorld(2),
    a = w.tag(),
    b = w.tag(),
    pool = workers();
  const s = new ParallelSchedule(w, { a, b }, { workerFactory: pool.factory });
  s.add({ name: 'read-a', module, reads: ['a'], exportName: 'noop' });
  s.add({ name: 'write-b', module, writes: ['b'], exportName: 'noop' });
  s.add({ name: 'write-a', module, writes: ['a'], exportName: 'noop' });
  assert.deepEqual(s.order(), [['read-a', 'write-b'], ['write-a']]);
  await s.update(0);
  assert.equal(pool.created.length, 2);
  await s.stop();
  assert.ok(pool.created.every((w) => w.threadId === -1));
  const reverse = new ParallelSchedule(w, { a });
  reverse.add({ name: 'first', module, writes: ['a'], after: ['second'] });
  reverse.add({ name: 'second', module, writes: ['a'] });
  assert.deepEqual(reverse.order(), [['second'], ['first']]);
  await reverse.stop();
  const cycle = new ParallelSchedule(w, { a });
  cycle.add({ name: 'one', module, before: ['two'] });
  assert.throws(() => cycle.order(), /missing/);
  cycle.add({ name: 'two', module, before: ['one'] });
  assert.throws(() => cycle.order(), /cycle/);
  await cycle.stop();
  assert.throws(() => new ParallelSchedule(new World(1), {}), /SharedWorld/);
  assert.throws(() => new ParallelSchedule(w, { a: new World(1).tag() }), /SharedWorld/);
  assert.throws(() => new ParallelSchedule(w, {}, { workers: 0 }), /options/);
});
test('independent systems overlap on distinct real workers with shared fields, without a timing bar', async () => {
  const w = new SharedWorld(2),
    a = w.component({ x: Int32Array }),
    b = w.component({ x: Int32Array });
  const e = w.create();
  a.add(e);
  b.add(e);
  const barrier = new SharedArrayBuffer(4),
    pool = workers(barrier);
  const s = new ParallelSchedule(w, { a, b }, { workerFactory: pool.factory, workers: 2 });
  s.add({ name: 'a', module, exportName: 'rendezvous', writes: ['a'] });
  s.add({ name: 'b', module, exportName: 'rendezvous', writes: ['b'] });
  try {
    await s.update(0);
    assert.equal(new Int32Array(barrier)[0], 2);
    assert.ok(a.fields.x[0] > 0);
    assert.ok(b.fields.x[0] > 0);
    assert.notEqual(a.fields.x[0], b.fields.x[0]);
  } finally {
    await s.stop();
  }
  assert.ok(pool.created.every((w) => w.threadId === -1));
});
test('systems resolve rows across different dense layouts and publish change tracking after success', async () => {
  const w = new SharedWorld(4),
    position = w.component({ x: Float64Array }),
    velocity = w.component({ x: Float64Array }),
    output = w.component({ x: Float64Array });
  const a = w.create(),
    b = w.create();
  position.add(a, { x: 3 });
  position.add(b, { x: 7 });
  velocity.add(b, { x: 10 });
  velocity.add(a, { x: 4 });
  output.add(b);
  output.add(a);
  const tracker = new ChangeTracker(position);
  tracker.clear();
  const pool = workers();
  const s = new ParallelSchedule(w, { position, velocity, output }, { workerFactory: pool.factory });
  s.add({ name: 'move', module, exportName: 'move', reads: ['velocity'], writes: ['position'] });
  s.add({ name: 'report', module, exportName: 'report', reads: ['position'], writes: ['output'] });
  try {
    await s.update(0.5);
    assert.equal(position.fields.x[position.index(a)], 5);
    assert.equal(position.fields.x[position.index(b)], 12);
    assert.equal(output.fields.x[output.index(a)], 5);
    assert.equal(output.fields.x[output.index(b)], 12);
    assert.equal(tracker.changed(new Uint32Array(4)), 2);
  } finally {
    tracker.stop();
    await s[Symbol.asyncDispose]();
  }
});
test('abort guards every structural path and joins workers before unlocking', async () => {
  const w = new SharedWorld(5),
    p = w.component({ x: Float32Array }),
    e = w.create();
  p.add(e);
  const pool = workers(),
    controller = new AbortController();
  const s = new ParallelSchedule(w, { p }, { workerFactory: pool.factory });
  s.add({ name: 'wait', module, exportName: 'never', reads: ['p'] });
  const pending = s.update(0, { signal: controller.signal });
  for (const action of [
    () => w.create(),
    () => w.destroy(e),
    () => w.component({ x: Float32Array }),
    () => w.tag(),
    () => p.add(e),
    () => p.remove(e),
    () => p.touch(e),
    () => w.reserve(0),
    () => w.attach({ remove() {} }),
    () => w.detach(p),
  ])
    assert.throws(action, /running/);
  await assert.rejects(s.update(0), /already/);
  assert.throws(() => s.add({ name: 'late', module }), /running/);
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.ok(pool.created.every((w) => w.threadId === -1));
  p.add(w.create());
  assert.equal(p.size, 2);
  await s.stop();
  await assert.rejects(s.update(0), /stopped/);
});
test('module failures, endpoint exit, missing exports and hard deadlines close without replay', async () => {
  for (const exportName of ['fail', 'exit', 'missing', 'never']) {
    const w = new SharedWorld(3),
      p = w.component({ x: Int32Array }),
      e = w.create();
    p.add(e);
    const pool = workers();
    const s = new ParallelSchedule(
      w,
      { p },
      { workerFactory: pool.factory, timeout: exportName === 'never' ? 100 : 30000 },
    );
    s.add({ name: 'bad', module, exportName, writes: ['p'] });
    try {
      await assert.rejects(s.update(0), (err) =>
        exportName === 'never' ? err.code === 'timeout' : err.code === 'state',
      );
      await assert.rejects(s.update(0), /stopped/);
      assert.ok(pool.created.every((w) => w.threadId === -1));
      if (exportName === 'fail') assert.equal(p.fields.x[0], 5);
      w.create();
    } finally {
      await s.stop();
    }
  }
});
test('aliased registrations serialize by shared memory and notify each physical component once', async () => {
  const w = new SharedWorld(2),
    a = w.component({ x: Int32Array }),
    e = w.create();
  a.add(e);
  const pool = workers(),
    s = new ParallelSchedule(w, { a, alias: a }, { workerFactory: pool.factory });
  s.add({ name: 'write', module, exportName: 'noop', writes: ['a'] });
  s.add({ name: 'read', module, exportName: 'noop', reads: ['alias'] });
  s.add({ name: 'write-alias', module, exportName: 'noop', writes: ['alias'] });
  assert.deepEqual(s.order(), [['write'], ['read'], ['write-alias']]);
  let changes = 0;
  a.observers.push({
    onAdd() {},
    onRemove() {},
    onChange() {
      changes++;
    },
  });
  try {
    await s.update(0);
    assert.equal(changes, 1);
  } finally {
    await s.stop();
  }
});
test('failed host termination keeps structural mutation locked rather than releasing shared rows', async () => {
  const w = new SharedWorld(2),
    p = w.component({ x: Int32Array }),
    e = w.create();
  p.add(e);
  const s = new ParallelSchedule(
    w,
    { p },
    {
      timeout: 10,
      workerFactory: () => ({
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        terminate() {
          return Promise.reject(new TypeError('host termination failure'));
        },
      }),
    },
  );
  s.add({ name: 'host-failure', module, exportName: 'noop', writes: ['p'] });
  await assert.rejects(s.update(0), /termination failed/);
  assert.throws(() => w.create(), /running/);
  assert.throws(() => p.remove(e), /running/);
  await assert.rejects(s.stop(), /termination failed/);
});

test('stop is idempotent during host termination callbacks', async () => {
  const w = new SharedWorld(1),
    p = w.tag(),
    listeners = new Map();
  let calls = 0,
    nested;
  const s = new ParallelSchedule(
    w,
    { p },
    {
      workerFactory: () => ({
        postMessage(m) {
          queueMicrotask(() => listeners.get('message')({ data: { ...m, ok: true } }));
        },
        addEventListener(type, fn) {
          listeners.set(type, fn);
        },
        removeEventListener(type) {
          listeners.delete(type);
        },
        terminate() {
          calls++;
          if (calls === 1) nested = s.stop();
        },
      }),
    },
  );
  s.add({ name: 'noop', module: new URL('file:///unused.js'), reads: ['p'] });
  await s.update(0);
  const first = s.stop();
  await first;
  await nested;
  assert.equal(calls, 1);
  assert.equal(nested, first);
});
