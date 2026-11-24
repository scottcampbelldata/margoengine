import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncTween, AsyncTimeline } from '../dist/async.js';

test('await scalar, array, path, custom and a group without an automatic clock', async () => {
  const tween = new AsyncTween(),
    target = { x: 0 },
    vector = [0, 0],
    point = [0, 0];
  let progress = 0,
    completed = 0;
  const scalar = tween.to(target, 'x', 10, { duration: 1, repeat: 1, yoyo: true, onComplete: () => completed++ });
  const array = tween.array(vector, [2, 4], { duration: 2 });
  const path = tween.path(
    point,
    (t, out) => {
      out[0] = t;
      out[1] = t * t;
      return out;
    },
    { duration: 2 },
  );
  const custom = tween.custom(
    (t) => {
      progress = t;
    },
    { duration: 0, delay: 2 },
  );
  const group = tween.finished;
  tween.update(1);
  assert.equal(target.x, 10);
  assert.equal(completed, 0);
  tween.update(1);
  await Promise.all([scalar, array, path, custom, group, tween]);
  assert.equal(target.x, 0);
  assert.deepEqual(vector, [2, 4]);
  assert.deepEqual(point, [1, 1]);
  assert.equal(progress, 1);
  assert.equal(completed, 1);
  await scalar; // repeated await is stable
});

test('abort before/during delay or repeat, preserves values and signal reason', async () => {
  for (const before of [true, false]) {
    const tween = new AsyncTween(),
      controller = new AbortController(),
      reason = new Error('stop');
    const target = { x: 0 };
    if (before) controller.abort(reason);
    const task = tween.to(target, 'x', 10, { duration: 1, delay: 1, repeat: Infinity, signal: controller.signal });
    const rejected = assert.rejects(task.finished, (error) => error === reason);
    if (!before) {
      tween.update(1.5);
      assert.equal(target.x, 5);
      controller.abort(reason);
    }
    const value = target.x;
    tween.update(100);
    assert.equal(target.x, value);
    await rejected;
  }
});

test('replacement, callable cancellation, clear, dispose and failed input', async () => {
  const tween = new AsyncTween(),
    target = { x: 0 };
  const first = tween.to(target, 'x', 1, { duration: 1 });
  assert.throws(() => tween.to(target, 'x', 2, { duration: -1 }), RangeError);
  tween.update(0.5);
  assert.equal(target.x, 0.5);
  const firstRejected = assert.rejects(first.finished, { name: 'AbortError' });
  const next = tween.to(target, 'x', 2, { duration: 1 });
  const nextRejected = assert.rejects(next.finished, { name: 'AbortError' });
  next();
  await Promise.all([firstRejected, nextRejected]);
  for (const cancel of [() => tween.clear(), () => tween[Symbol.dispose]()]) {
    const task = tween.custom(() => {}, { duration: 1 });
    const rejected = assert.rejects(task.finished, { name: 'AbortError' });
    cancel();
    await rejected;
  }
});

test('completion can replace its own key, and update errors reject without being hidden', async () => {
  const tween = new AsyncTween(),
    target = { x: 0 };
  let next;
  const first = tween.to(target, 'x', 1, {
    duration: 1,
    onComplete: () => {
      next = tween.to(target, 'x', 2, { duration: 1 });
    },
  });
  tween.update(1);
  await first;
  assert.equal(target.x, 1);
  tween.update(1);
  await next;
  const error = new Error('apply failed');
  const task = tween.custom(
    () => {
      throw error;
    },
    { duration: 1 },
  );
  const rejected = assert.rejects(task.finished, (reason) => reason === error);
  assert.throws(
    () => tween.update(0.5),
    (reason) => reason === error,
  );
  await rejected;
});

test('timeline promise waits across pause, repeats, reverse and is renewed on replay', async () => {
  const target = { x: 0 };
  const timeline = new AsyncTimeline({ repeat: 1, yoyo: true }).to(target, 'x', 4, { duration: 1 }).play();
  const finished = timeline.finished;
  let done = false;
  finished.then(() => {
    done = true;
  });
  timeline.update(1);
  timeline.pause().update(1);
  await Promise.resolve();
  assert.equal(done, false);
  timeline.play().update(1);
  await timeline;
  assert.equal(target.x, 0);
  timeline.reverse().play();
  assert.notEqual(timeline.finished, finished);
  timeline.update(1);
  await timeline;
});

test('timeline abort removes playback and empty timeline resolves after update', async () => {
  const controller = new AbortController(),
    target = { x: 0 };
  const timeline = new AsyncTimeline({ signal: controller.signal }).to(target, 'x', 4, { duration: 1 }).play();
  const rejected = assert.rejects(timeline.finished, { name: 'AbortError' });
  timeline.update(0.5);
  controller.abort();
  timeline.update(1);
  assert.equal(timeline.playing, false);
  assert.equal(target.x, 2);
  await rejected;
  const empty = new AsyncTimeline().play();
  empty.update(0);
  await empty;
});

test('abort inside repeat stops the current write and cancellation suppresses completion', async () => {
  const controller = new AbortController(), target = { x: 0 }, tween = new AsyncTween();
  let completed = 0;
  const task = tween.to(target, 'x', 10, { duration: 1, repeat: 1, signal: controller.signal,
    onRepeat: () => controller.abort(), onComplete: () => completed++ });
  const rejected = assert.rejects(task.finished, { name: 'AbortError' });
  tween.update(0.5);
  tween.update(1.25);
  assert.equal(target.x, 5);
  assert.equal(completed, 0);
  await rejected;
  const timeline = new AsyncTimeline({ onComplete: () => completed++ });
  const stopped = assert.rejects(timeline.finished, { name: 'AbortError' });
  let later = 0;
  timeline.call(() => timeline.cancel(), 0).call(() => later++, 0).play().update(0);
  await stopped;
  assert.equal(later, 0);
  assert.equal(completed, 0);
});
