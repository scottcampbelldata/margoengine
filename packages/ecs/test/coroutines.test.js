import test from 'node:test';
import assert from 'node:assert/strict';
import { Schedule } from '../dist/schedule.js';
import { Coroutines } from '../dist/coroutines.js';

test('a bare yield waits one update and a number waits that many seconds', () => {
  const co = new Coroutines(),
    log = [];
  co.start(
    (function* () {
      log.push('a');
      yield;
      log.push('b');
      yield 0.5;
      log.push('c');
    })(),
  );
  assert.equal(co.update(0.1), 1);
  assert.deepEqual(log, ['a']);
  co.update(0.1);
  assert.deepEqual(log, ['a', 'b']);
  co.update(0.3);
  assert.deepEqual(log, ['a', 'b']);
  assert.equal(co.update(0.2), 0);
  assert.deepEqual(log, ['a', 'b', 'c']);
});
test('yielding a promise waits for it and a rejection is thrown into the generator', async () => {
  const co = new Coroutines(),
    log = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const done = co.run(
    (function* () {
      yield gate;
      log.push('opened');
      try {
        yield Promise.reject(new Error('nope'));
      } catch (e) {
        log.push(e.message);
      }
    })(),
  );
  co.update(0.016);
  co.update(0.016);
  assert.deepEqual(log, []);
  release();
  await Promise.resolve();
  await Promise.resolve();
  co.update(0.016);
  assert.deepEqual(log, ['opened']);
  await Promise.resolve();
  await Promise.resolve();
  co.update(0.016);
  await done;
  assert.deepEqual(log, ['opened', 'nope']);
});
test('yielding a coroutine waits until it ends', () => {
  const co = new Coroutines(),
    log = [];
  const inner = co.start(
    (function* () {
      yield;
      yield;
      log.push('inner');
    })(),
  );
  co.start(
    (function* () {
      yield inner;
      log.push('outer');
    })(),
  );
  for (let i = 0; i < 4; i++) co.update(0.016);
  assert.deepEqual(log, ['inner', 'outer']);
});
test('cancel stops it, runs finally, and rejects done with an AbortError; an abort signal cancels too', async () => {
  const co = new Coroutines(),
    log = [];
  const run = co.start(
    (function* () {
      try {
        while (true) yield;
      } finally {
        log.push('cleanup');
      }
    })(),
  );
  co.update(0.016);
  run.cancel();
  await assert.rejects(run.done, { name: 'AbortError' });
  assert.deepEqual(log, ['cleanup']);
  assert.equal(co.size, 0);
  const ctl = new AbortController();
  const second = co.start((function* () { while (true) yield; })(), { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(second.done, { name: 'AbortError' });
  await assert.rejects(co.run((function* () { yield; })(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('errors reach onError, or are rethrown by update with the first as cause; other coroutines keep running', () => {
  const seen = [];
  const quiet = new Coroutines({ onError: (e) => seen.push(e.message) });
  quiet.start((function* () { yield; throw new Error('boom'); })());
  const other = quiet.start((function* () { yield; yield; })());
  quiet.update(0.016);
  quiet.update(0.016);
  assert.deepEqual(seen, ['boom']);
  assert.equal(other.active, true);
  const loud = new Coroutines();
  loud.start((function* () { throw new Error('first'); })());
  assert.throws(() => loud.update(0.016), (e) => e.code === 'failed' && e.cause.message === 'first');
});
test('install steps from a Schedule, bad input names its fix, dispose cancels', async () => {
  const co = new Coroutines(),
    schedule = new Schedule();
  co.install(schedule);
  let n = 0;
  co.start((function* () { while (true) { n++; yield; } })());
  schedule.update(0.016);
  schedule.update(0.016);
  assert.equal(n, 2);
  assert.throws(() => co.update(-1), (e) => e instanceof RangeError && /pass seconds/.test(e.message));
  const bad = co.start((function* () { try { yield -1; } catch (e) { n = e.message; } })());
  co.update(0.016);
  co.update(0.016);
  assert.match(String(n), /yield a finite number/);
  const last = co.start((function* () { yield; })());
  co.dispose();
  await assert.rejects(last.done, { name: 'AbortError' });
  assert.throws(() => co.start((function* () {})()), { code: 'disposed' });
});
