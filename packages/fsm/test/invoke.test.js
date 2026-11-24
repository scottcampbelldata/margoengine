import test from 'node:test';
import assert from 'node:assert/strict';
import { InvokeMachine } from '../dist/invoke.js';
import { EventTrace } from '../dist/events.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('initial task resolves into a done event with output, guard and hook payloads', async () => {
  const data = { answer: 42 }, seen = [];
  using m = new InvokeMachine({ load: { invoke: { id: 'fetch', run: async (_c, signal) => { assert.equal(signal.aborted, false); return data; } } },
    ready: { enter: (_c, d) => seen.push(d.output) } }, 'load', {},
    [{ from: 'load', to: 'ready', event: 'done.invoke.fetch', guard: (_c, d) => d.output === data }]);
  using trace = new EventTrace(m);
  await m.invocations.get('fetch').settled;
  assert.equal(m.state, 'ready'); assert.deepEqual(seen, [data]);
  assert.equal(trace.records[0].data.output, data);
  assert.equal(m.invocations.get('fetch').signal.aborted, true);
});

test('rejection and synchronous throw raise error events without converting their value', async () => {
  for (const sync of [false, true]) {
    const error = new TypeError('service failed');
    using m = new InvokeMachine({ load: { invoke: { id: 'task', run: () => { if (sync) throw error; return Promise.reject(error); } } }, fail: {} }, 'load', {},
      [{ from: 'load', to: 'fail', event: 'error.invoke.task', guard: (_c, d) => d.error === error }]);
    await m.invocations.get('task').settled;
    assert.equal(m.state, 'fail'); assert.equal(m.invocations.get('task').error, error);
  }
});

test('exit aborts immediately, stale result cannot finish a new invocation, and cancelled waits settle', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  using m = new InvokeMachine({ load: { invoke: { id: 'task', run: () => (++count === 1 ? first.promise : second.promise) } }, idle: {}, done: {} }, 'load', {}, [
    { from: 'load', to: 'idle', event: 'cancel' }, { from: 'idle', to: 'load', event: 'retry' }, { from: 'load', to: 'done', event: 'done.invoke.task' },
  ]);
  const old = m.invocations.get('task'); m.send('cancel');
  assert.equal(old.signal.aborted, true); await old.settled;
  m.send('retry'); const current = m.invocations.get('task');
  assert.notEqual(current, old); first.resolve('stale'); await Promise.resolve(); await Promise.resolve();
  assert.equal(m.state, 'load'); second.resolve('fresh'); await current.settled; assert.equal(m.state, 'done');
});

test('exit and re-entry within one macrostep restart a service; transient states do not invoke; input reaches tasks', async () => {
  const work = deferred(), inputs = []; let calls = 0;
  using m = new InvokeMachine({ root: { invoke: { id: 'root', run: () => { calls++; return work.promise; } } },
    a: { parent: 'root' }, transient: { invoke: { id: 'no', run: () => assert.fail('transient task') } },
    b: { parent: 'root', invoke: { id: 'child', run: (_c, _s, d) => { inputs.push(d); return 1; } } } }, 'a', {}, [
    { from: 'a', to: 'transient', event: 'go' }, { from: 'transient', to: 'b', always: true },
  ]);
  const original = m.invocations.get('root'); m.send('go', 7);
  assert.equal(original.signal.aborted, true); assert.equal(calls, 2); assert.deepEqual(inputs, [7]);
  await m.invocations.get('child').settled;
});

test('common ancestor task stays running, multiple tasks abort on parent exit and external abort', async () => {
  const controller = new AbortController(); let calls = 0;
  const spec = id => ({ id, run: () => { calls++; return new Promise(() => {}); } });
  const m = new InvokeMachine({ p: { invoke: [spec('one'), spec('two')] }, a: { parent: 'p' }, b: { parent: 'p' } }, 'a', {},
    [{ from: 'a', to: 'b', event: 'go' }], { signal: controller.signal });
  m.send('go'); assert.equal(calls, 2); assert.equal(m.invocations.get('one').signal.aborted, false);
  controller.abort(); await Promise.all([...m.invocations.values()].map(r => r.settled));
  assert.equal(m.invocations.get('two').signal.aborted, true); assert.equal(m.send('go'), false); m.dispose();
});

test('tasks entered and exited within a long delayed update are started and cancelled at their macrosteps', async () => {
  let signal;
  using m = new InvokeMachine({ a: {}, b: { invoke: { id: 'task', run: (_c, s) => { signal = s; return new Promise(() => {}); } } }, c: {} }, 'a', {},
    [{ from: 'a', to: 'b', after: 1 }, { from: 'b', to: 'c', after: 1 }]);
  m.update(3); assert.equal(m.state, 'c'); assert.equal(signal.aborted, true);
  await m.invocations.get('task').settled;
});

test('preaborted runtimes start nothing and handler failures remain observable on settled', async () => {
  using stopped = new InvokeMachine({ a: { invoke: { id: 'no', run: () => assert.fail('aborted start') } } }, 'a', {}, [],
    { signal: AbortSignal.abort() });
  assert.equal(stopped.invocations.size, 0);
  const failure = new TypeError('entry failed');
  using m = new InvokeMachine({ a: { invoke: { id: 'work', run: () => 1 } }, b: { enter: () => { throw failure; } } }, 'a', {},
    [{ from: 'a', to: 'b', event: 'done.invoke.work' }]);
  await assert.rejects(m.invocations.get('work').settled, e => e === failure);
});
