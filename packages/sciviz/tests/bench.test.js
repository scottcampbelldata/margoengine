import assert from 'node:assert/strict';
import test from 'node:test';
import { imageDifference, pairedFrames } from '../dist/bench.js';

const frame = (rgba = [1, 2, 3, 255]) => ({ width: 1, height: 1, rgba: new Uint8Array(rgba) });

test('full RGB error and exact alpha difference use unmodified frame bytes', () => {
  assert.deepEqual(imageDifference(frame([0, 0, 0, 0]), frame([9, 12, 15, 1])), {
    pixels: 1,
    mean: 12,
    maximum: 15,
    far8: 1,
    identical: false,
  });
  assert.equal(imageDifference(frame(), frame()).identical, true);
  assert.equal(imageDifference(frame([1, 2, 3, 0]), frame()).mean, 0);
  assert.equal(imageDifference(frame([1, 2, 3, 0]), frame()).identical, false);
  for (const bad of [
    { ...frame(), width: -1 },
    { ...frame(), height: NaN },
    { ...frame(), rgba: new Uint8Array(3) },
    { ...frame(), rgba: [1, 2, 3, 4] },
  ])
    assert.throws(() => imageDifference(bad, frame()));
  assert.throws(() => imageDifference(frame(), { width: 2, height: 1, rgba: new Uint8Array(8) }));
});

test('paired reads alternate turns, omit clocks by default and return every explicit timing sample', async (t) => {
  const order = [];
  const a = {
    async frame() {
      order.push('a');
      return frame();
    },
  };
  const b = {
    async frame() {
      order.push('b');
      return frame();
    },
  };
  const clock = t.mock.method(performance, 'now', () => {
    throw new Error('smoke clock');
  });
  const smoke = await pairedFrames(a, b, { runs: 3, warmup: 1 });
  assert.equal(smoke.timing, undefined);
  assert.deepEqual(order, ['a', 'b', 'a', 'b', 'b', 'a', 'a', 'b']);
  assert.equal(clock.mock.callCount(), 0);
  let tick = 0;
  clock.mock.mockImplementation(() => ++tick);
  const timed = await pairedFrames(a, b, { runs: 3, timing: true });
  assert.deepEqual(timed.timing, { a: [1, 1, 1], b: [1, 1, 1], minimumA: 1, minimumB: 1 });
});

test('hostile controls, aborts and renderer failures propagate without retries', async () => {
  const a = {
    async frame() {
      return frame();
    },
  };
  for (const options of [{ runs: 0 }, { runs: 101 }, { runs: 1.2 }, { warmup: -1 }, { warmup: 21 }, { timing: 1 }])
    await assert.rejects(pairedFrames(a, a, options));
  await assert.rejects(pairedFrames({}, a));
  const abort = new AbortController();
  abort.abort(new Error('cancel before setup'));
  await assert.rejects(pairedFrames(a, a, { signal: abort.signal }), /cancel before setup/);
  const active = new AbortController();
  await assert.rejects(
    pairedFrames(
      {
        async frame() {
          active.abort(new Error('cancel after read'));
          return frame();
        },
      },
      a,
      { signal: active.signal },
    ),
    /cancel after read/,
  );
  let attempts = 0;
  await assert.rejects(
    pairedFrames(
      {
        async frame() {
          attempts++;
          throw new Error('device lost');
        },
      },
      a,
    ),
    /device lost/,
  );
  assert.equal(attempts, 1);
});

test('abort releases a pending frame wait even when the adapter ignores its signal', async () => {
  const controller = new AbortController();
  const renderer = {
    frame() {
      return new Promise(() => {});
    },
  };
  const waiting = pairedFrames(renderer, renderer, { signal: controller.signal });
  controller.abort(new Error('cancel pending GPU frame'));
  await assert.rejects(waiting, /cancel pending GPU frame/);
});
