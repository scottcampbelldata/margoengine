import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGIF } from '../dist/gif.js';
import { encodeGIFFrames, encodeGIF as exporterGIF } from '@margoengine/exporters/capture';
import { quantizePalette } from '@margoengine/exporters/palette';
import { decodeGIF } from '../../exporters/tests/support/gif.mjs';

const frame = (r = 255, duration) => ({
  width: 2,
  height: 1,
  data: Uint8Array.of(r, 30, 60, 255, 0, 200, 100, 0),
  duration,
});

test('headless GIF streams one frame at a time through the shared writer and palette', async () => {
  let open = 0,
    closed = false;
  async function* frames() {
    try {
      for (let i = 0; i < 3; i++) {
        open++;
        yield frame(i * 60);
      }
    } finally {
      closed = true;
    }
  }
  const bytes = await encodeGIF(frames(), { fps: 30 }),
    parsed = decodeGIF(bytes);
  assert.equal(open, 3);
  assert.equal(closed, true);
  assert.deepEqual([parsed.width, parsed.height, parsed.loop], [2, 1, 0]);
  assert.deepEqual(
    parsed.frames.map((f) => f.delay),
    [3, 4, 3],
  );
  for (let i = 0; i < 3; i++) assert.deepEqual([...parsed.frames[i].rgba], [i * 60, 30, 60, 255, 0, 0, 0, 0]);
  assert.deepEqual(bytes, await exporterGIF(3, (i) => frame(i * 60), { fps: 30 }));
  const quantized = quantizePalette(frame());
  assert.equal(quantized.transparent, true);
  assert.deepEqual([...quantized.indices], [1, 0]);
});

test('GIF repeat policy, variable durations and unknown frame count decode independently', async () => {
  const frames = [frame(200, 0.025), frame(100, 0.075), frame(0, 0.02)];
  for (const loop of [-1, 0, 7, 65535]) {
    const parsed = decodeGIF(await encodeGIF(frames, { loop }));
    assert.equal(parsed.loop, loop < 0 ? null : loop);
    assert.deepEqual(
      parsed.frames.map((f) => f.delay),
      [3, 7, 2],
    );
  }
});

test('constant-rate centisecond rounding stays exact across long fractional-delay runs', async () => {
  const count = 120,
    fps = 40;
  const decoded = decodeGIF(
    await encodeGIF(
      Array.from({ length: count }, () => frame()),
      { fps },
    ),
  );
  assert.deepEqual(
    decoded.frames.map((f) => f.delay),
    Array.from({ length: count }, (_, i) => Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)),
  );
});

test('cancellation interrupts a pending producer and closes it; failures close the source', async () => {
  const controller = new AbortController(),
    reason = new Error('stop');
  let returned = 0,
    entered;
  const ready = new Promise((resolve) => (entered = resolve)),
    source = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        entered();
        return new Promise(() => {});
      },
      async return() {
        returned++;
        return { done: true };
      },
    };
  const pending = encodeGIF(source, { signal: controller.signal });
  await ready;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(returned, 1);
  let closed = false;
  async function* invalid() {
    try {
      yield frame();
      yield { ...frame(), width: 1 };
    } finally {
      closed = true;
    }
  }
  await assert.rejects(encodeGIF(invalid()), RangeError);
  assert.equal(closed, true);
});

test('rejects invalid options, empty streams, invalid duration and pre-aborted input', async () => {
  for (const options of [{ loop: -2 }, { loop: 1.5 }, { loop: 65536 }, { dither: 'yes' }, { fps: 0 }, { fps: 51 }])
    await assert.rejects(encodeGIF([frame()], options));
  await assert.rejects(encodeGIF([]), RangeError);
  for (const duration of [0, NaN, Infinity, 655.36]) await assert.rejects(encodeGIF([frame(10, duration)]), RangeError);
  const reason = new Error('preabort');
  await assert.rejects(encodeGIFFrames([frame()], { signal: AbortSignal.abort(reason) }), (error) => error === reason);
});
