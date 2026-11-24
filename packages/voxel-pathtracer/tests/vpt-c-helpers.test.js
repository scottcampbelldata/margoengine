// Audit vpt-c (2026-11-24): waitForFeature cancels only the caller's wait and never leaves its abort listener on a
// long-lived signal; PreviewBudget's idle boundary counts frames since the last change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForFeature } from '../src/feature-wait.ts';
import { PreviewBudget } from '../src/preview.ts';

function countingSignal() {
  const controller = new AbortController(),
    signal = controller.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, options) => {
    if (type === 'abort') live++;
    add(type, fn, options);
  };
  signal.removeEventListener = (type, fn, options) => {
    if (type === 'abort') live--;
    remove(type, fn, options);
  };
  return { controller, signal, live: () => live };
}

test('waitForFeature removes its listener when the feature settles and leaves the shared promise alone', async () => {
  const { controller, signal, live } = countingSignal();
  for (let i = 0; i < 100; i++) assert.equal(await waitForFeature(Promise.resolve(i), signal), i);
  const failure = new Error('feature failed');
  for (let i = 0; i < 100; i++)
    await assert.rejects(waitForFeature(Promise.reject(failure), signal), (e) => e === failure);
  assert.equal(live(), 0, 'no abort listener survives a settled wait');

  let finish;
  const shared = new Promise((resolve) => (finish = resolve));
  const waiting = waitForFeature(shared, signal);
  const reason = new Error('caller left');
  controller.abort(reason);
  await assert.rejects(waiting, (e) => e === reason);
  finish('done');
  assert.equal(await shared, 'done', 'the shared operation still completes for other owners');
  await assert.rejects(waitForFeature(Promise.resolve(1), signal), (e) => e === reason);
  assert.equal(await waitForFeature(Promise.resolve(2)), 2);
});

test('PreviewBudget switches to idle samples after exactly idleFrames unchanged frames', () => {
  const zero = new PreviewBudget({ idleFrames: 0 });
  assert.equal(zero.isIdle, false);
  assert.equal(zero.tick(), 256, 'idleFrames 0: the first frame after a change is already idle');
  const b = new PreviewBudget();
  for (let i = 0; i < 8; i++) assert.equal(b.tick(), 4);
  assert.equal(b.tick(), 256);
  b.markDirty();
  assert.equal(b.tick(), 4);
  for (const bad of [{ dirtySamples: NaN }, { idleSamples: Infinity }, { idleFrames: 0.5 }, { dirtySamples: '4' }])
    assert.throws(() => new PreviewBudget(bad), RangeError);
});
