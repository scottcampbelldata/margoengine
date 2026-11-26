// Emitter: ordering, once, signal, unsubscribe mid-emit, error hook, async iteration with backpressure and overflow, dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../dist/emitter.js';

test('listeners run in subscription order and emit counts them', () => {
  const e = new Emitter();
  const log = [];
  e.on('a', (v) => log.push(['one', v]));
  e.on('a', (v) => log.push(['two', v]));
  e.on('b', () => log.push('b'));
  assert.equal(e.emit('a', 1), 2);
  assert.equal(e.emit('c', 1), 0);
  assert.deepEqual(log, [['one', 1], ['two', 1]]);
  assert.equal(e.listenerCount('a'), 2);
  assert.equal(e.listenerCount(), 3);
});

test('once fires one time; the unsubscribe function and off are idempotent', () => {
  const e = new Emitter();
  let n = 0;
  e.once('a', () => n++);
  const off = e.on('a', () => (n += 10));
  e.emit('a', 0);
  e.emit('a', 0);
  assert.equal(n, 21);
  off();
  off();
  e.emit('a', 0);
  assert.equal(n, 21);
  const fn = () => n++;
  e.on('a', fn);
  assert.equal(e.off('a', fn), true);
  assert.equal(e.off('a', fn), false);
  assert.equal(e.listenerCount(), 0);
});

test('an AbortSignal removes the listener; an aborted one subscribes nothing', () => {
  const e = new Emitter();
  const c = new AbortController();
  let n = 0;
  e.on('a', () => n++, { signal: c.signal });
  e.emit('a', 0);
  c.abort();
  e.emit('a', 0);
  assert.equal(n, 1);
  assert.equal(e.listenerCount(), 0);
  e.on('a', () => n++, { signal: AbortSignal.abort() });
  assert.equal(e.listenerCount(), 0);
});

test('unsubscribing mid-emit stops that listener now; subscribing mid-emit waits for the next event', () => {
  const e = new Emitter();
  const log = [];
  let offB;
  e.on('a', () => {
    log.push('A');
    offB();
    e.on('a', () => log.push('late'));
  });
  offB = e.on('a', () => log.push('B'));
  e.emit('a', 0);
  assert.deepEqual(log, ['A']);
  e.emit('a', 0);
  assert.deepEqual(log, ['A', 'A', 'late']);
});

test('a throwing listener reaches onError and the others still run', () => {
  const errors = [];
  const e = new Emitter({ onError: (error, type) => errors.push([error.message, type]) });
  const log = [];
  e.on('a', () => {
    throw new Error('boom');
  });
  e.on('a', () => log.push('after'));
  e.emit('a', 0);
  assert.deepEqual(log, ['after']);
  assert.deepEqual(errors, [['boom', 'a']]);
});

test('events: values arrive across await points, in order, with backpressure buffering', async () => {
  const e = new Emitter();
  const it = e.events('n');
  const first = it.next(); // waiting before any emit
  e.emit('n', 1);
  assert.deepEqual(await first, { value: 1, done: false });
  e.emit('n', 2);
  e.emit('n', 3);
  assert.deepEqual(await it.next(), { value: 2, done: false });
  await Promise.resolve();
  assert.deepEqual(await it.next(), { value: 3, done: false });
  assert.equal(it.dropped, 0);
});

test('events: a full buffer drops the oldest and counts them', async () => {
  const e = new Emitter();
  const it = e.events('n', { capacity: 2 });
  for (let i = 1; i <= 5; i++) e.emit('n', i);
  assert.equal(it.dropped, 3);
  assert.equal((await it.next()).value, 4);
  assert.equal((await it.next()).value, 5);
  assert.throws(() => e.events('n', { capacity: 0 }), RangeError);
});

test('events: return(), the signal and for-await break end the iterator and unsubscribe', async () => {
  const e = new Emitter();
  const a = e.events('n');
  const pending = a.next();
  await a.return();
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(a.closed, true);
  assert.equal(e.listenerCount(), 0);

  const c = new AbortController();
  const b = e.events('n', { signal: c.signal });
  const waiting = b.next();
  c.abort();
  assert.equal((await waiting).done, true);
  assert.equal(e.listenerCount(), 0);

  const seen = [];
  const loop = (async () => {
    for await (const v of e.events('n')) {
      seen.push(v);
      if (v === 2) break;
    }
  })();
  for (const v of [1, 2, 3]) {
    e.emit('n', v);
    await Promise.resolve();
  }
  await loop;
  assert.deepEqual(seen, [1, 2]);
  assert.equal(e.listenerCount(), 0);
  assert.equal(e.events('n', { signal: AbortSignal.abort() }).closed, true);
});

test('dispose clears listeners and ends iterators; the emitter stays usable', async () => {
  const e = new Emitter();
  let n = 0;
  e.on('a', () => n++);
  const it = e.events('a');
  const waiting = it.next();
  e[Symbol.dispose]();
  assert.equal((await waiting).done, true);
  assert.equal(e.emit('a', 0), 0);
  assert.equal(n, 0);
  e.on('a', () => n++);
  e.emit('a', 0);
  assert.equal(n, 1);
});
