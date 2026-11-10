import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveEvents } from '../dist/events.js';
function clock() {
  let now = 0,
    id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    get size() {
      return timers.size;
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].fn();
      }
      now = end;
    },
  };
}
const drain = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test('movement coalesces to the latest pointer and bounds deterministic work', async () => {
  const c = clock(),
    calls = [],
    task = adaptiveEvents(
      (x) => {
        calls.push(x);
        return x * 2;
      },
      { ...c, interval: 100 },
    );
  task.setMoving(true);
  assert.equal(await task.run(1), 2);
  const pending = [];
  for (let x = 2; x <= 100; x++) pending.push(task.run(x));
  assert.deepEqual(calls, [1]);
  c.advance(99);
  assert.deepEqual(calls, [1]);
  c.advance(1);
  assert.deepEqual(calls, [1, 100]);
  assert.deepEqual(await Promise.all(pending), Array(99).fill(200));
  assert.equal(task.pending, false);
  assert.equal(c.size, 0);
  const next = task.run(101);
  c.advance(100);
  assert.equal(await next, 202);
  task.dispose();
});
test('suppression matches disabled raycasting during motion and flushes final input at rest', async () => {
  const c = clock(),
    source = new EventTarget(),
    calls = [],
    task = adaptiveEvents(
      (x) => {
        calls.push(x);
        return x;
      },
      { ...c, sources: [source], interval: Infinity, debounce: 120 },
    );
  source.dispatchEvent(new Event('change'));
  const a = task.run(4),
    b = task.run(9);
  assert.equal(task.moving, true);
  assert.deepEqual(calls, []);
  c.advance(119);
  source.dispatchEvent(new Event('end'));
  c.advance(119);
  assert.deepEqual(calls, []);
  c.advance(1);
  assert.deepEqual(await Promise.all([a, b]), [9, 9]);
  assert.deepEqual(calls, [9]);
  assert.equal(task.moving, false);
  assert.equal(c.size, 0);
});
test('async picks never overlap; queued callers receive latest result and rejection is preserved', async () => {
  let finish;
  const seen = [],
    error = new Error('pick');
  const task = adaptiveEvents((x) => {
    seen.push(x);
    if (x === 1) return new Promise((resolve) => (finish = resolve));
    if (x === 4) throw error;
    return Promise.resolve(x);
  });
  const a = task.run(1),
    b = task.run(2),
    c = task.run(3);
  assert.deepEqual(seen, [1]);
  finish(1);
  assert.deepEqual(await Promise.all([a, b, c]), [1, 3, 3]);
  assert.deepEqual(seen, [1, 3]);
  await assert.rejects(task.run(4), (e) => e === error);
  assert.equal(await task.run(5), 5);
  task.dispose();
});
test('force flush and explicit rest bypass throttling without overlapping in-flight work', async () => {
  const c = clock(),
    seen = [],
    task = adaptiveEvents(
      (x) => {
        seen.push(x);
        return x;
      },
      { ...c, interval: Infinity },
    );
  task.setMoving(true);
  const a = task.run(1);
  task.flush();
  assert.equal(await a, 1);
  const b = task.run(2);
  task.setMoving(false);
  assert.equal(await b, 2);
  assert.deepEqual(seen, [1, 2]);
  task.regress();
  assert.equal(task.moving, true);
  c.advance(120);
  assert.equal(task.moving, false);
  task.dispose();
  assert.equal(c.size, 0);
});
test('abort rejects queued and in-flight callers, ignores late completion and removes timers/listeners', async () => {
  const c = clock(),
    source = new EventTarget(),
    abort = new AbortController();
  let finish;
  const task = adaptiveEvents(() => new Promise((resolve) => (finish = resolve)), {
    ...c,
    sources: [source],
    signal: abort.signal,
  });
  const a = task.run(),
    b = task.run();
  source.dispatchEvent(new Event('change'));
  const error = new Error('abort');
  abort.abort(error);
  await assert.rejects(a, (e) => e === error);
  await assert.rejects(b, (e) => e === error);
  finish(42);
  await drain();
  assert.equal(task.pending, false);
  assert.equal(c.size, 0);
  source.dispatchEvent(new Event('change'));
  assert.equal(c.size, 0);
  await assert.rejects(task.run(), (e) => e === error);
  task[Symbol.dispose]();
  const disposed = adaptiveEvents(() => 1, { ...c });
  disposed.dispose();
  await assert.rejects(disposed.run(), { code: 'disposed' });
});
test('validates clocks policy and pre-aborted signals', async () => {
  for (const options of [{ interval: -1 }, { interval: NaN }, { debounce: Infinity }, { debounce: -1 }])
    assert.throws(() => adaptiveEvents(() => 0, options), RangeError);
  const abort = new AbortController();
  abort.abort('cancelled');
  const task = adaptiveEvents(() => assert.fail(), { signal: abort.signal });
  await assert.rejects(task.run(), (e) => e === 'cancelled');
});
