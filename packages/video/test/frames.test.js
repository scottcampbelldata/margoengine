import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from '@margoengine/materials';
import { FrameVideo } from '../dist/frames.js';

/** A 2 x 2 frame whose top row holds `value` and bottom row `value + 1`. */
const rows = (value) => new Uint8Array(16).fill(value, 0, 8).fill(value + 1, 8);
const clip = (options = {}) => new FrameVideo({ width: 2, height: 2, fps: 30, frames: 10, read: rows, ...options });
const held = (video) => [video.texture.source.data[0], video.texture.source.data[8]];

test('the frame is a function of the film time: holds the ends, loops, and survives rounding', () => {
  const video = clip({ start: 1 });
  assert.equal(video.duration, 10 / 30);
  assert.equal(video.frameAt(0), 0, 'before the start');
  assert.equal(video.frameAt(1), 0);
  assert.equal(video.frameAt(1 + 7 / 30), 7, '(1 + 7/30 - 1) * 30 is a little under 7 in floating point');
  assert.equal(video.frameAt(1 + 7.999 / 30), 7);
  assert.equal(video.frameAt(100), 9, 'the last frame stays');
  const looping = clip({ loop: true });
  assert.equal(looping.frameAt(10 / 30), 0);
  assert.equal(looping.frameAt(23 / 30), 3);
  const ntsc = clip({ fps: 30000 / 1001, frames: 100000 });
  for (let k = 0; k < 100000; k += 997) assert.equal(ntsc.frameAt((k * 1001) / 30000), k);
  assert.throws(() => video.frameAt(-1), RangeError);
  assert.throws(() => video.frameAt(Number.NaN), RangeError);
});

test('seek reads a frame once, copies its rows bottom up and updates the texture only for a new frame', async () => {
  const buffer = new Uint8Array(16),
    reads = [];
  const video = clip({
    read: (frame) => {
      reads.push(frame);
      buffer.set(rows(frame * 10));
      return buffer;
    },
  });
  let updates = 0;
  const update = video.texture.update.bind(video.texture);
  video.texture.update = () => {
    updates++;
    update();
  };
  assert.ok(video.texture instanceof Texture);
  assert.equal(video.texture.mipmaps, true);
  assert.equal(video.frame, -1);
  assert.deepEqual(held(video), [0, 0], 'transparent black before the first seek');
  await video.seek(3 / 30);
  buffer.fill(200); // The caller's buffer is free again once seek resolves.
  assert.deepEqual(held(video), [31, 30], 'the top row of the frame is the last row of the texture (v = 1)');
  assert.equal(updates, 1);
  await video.seek(3.5 / 30);
  assert.deepEqual(reads, [3], 'the same frame is not read again');
  assert.equal(updates, 1);
  await video.seek(0);
  await video.seek(3 / 30);
  assert.deepEqual(reads, [3, 0, 3]);
  assert.deepEqual(held(video), [31, 30], 'seeking back gives the same bytes');
  assert.equal(updates, 3);
  const unflipped = clip({ flipY: false });
  await unflipped.seek(0);
  assert.deepEqual(held(unflipped), [0, 1]);
  video.dispose();
  video.dispose();
  await assert.rejects(video.seek(0), (e) => e.code === 'disposed');
});

test('a later seek wins, and a failed, short or aborted read leaves the picture', async () => {
  const waiting = new Map();
  const video = clip({
      read: (frame, signal) =>
        new Promise((resolve, reject) => {
          waiting.set(frame, { resolve, reject, signal });
        }),
    }),
    slow = video.seek(1 / 30),
    fast = video.seek(2 / 30);
  waiting.get(2).resolve(rows(2));
  await fast;
  waiting.get(1).resolve(rows(1));
  await slow;
  assert.equal(video.frame, 2);
  const failed = video.seek(3 / 30);
  waiting.get(3).reject(new Error('decoder gone'));
  await assert.rejects(failed, /decoder gone/);
  assert.equal(video.frame, 2);
  const short = video.seek(4 / 30);
  waiting.get(4).resolve(new Uint8Array(12));
  await assert.rejects(short, /16 bytes/);
  assert.equal(video.frame, 2);
  const controller = new AbortController(),
    aborted = video.seek(5 / 30, { signal: controller.signal });
  controller.abort(new Error('stop'));
  assert.equal(waiting.get(5).signal.aborted, true, 'the reader hears the abort');
  waiting.get(5).resolve(rows(5));
  await assert.rejects(aborted, /stop/);
  assert.equal(video.frame, 2);
  await assert.rejects(video.seek(6 / 30, { signal: controller.signal }), /stop/);
  assert.equal(waiting.has(6), false);
  // Asking for the shown frame again drops the older read still running.
  const stale = video.seek(7 / 30);
  await video.seek(2 / 30);
  waiting.get(7).resolve(rows(7));
  await stale;
  assert.equal(video.frame, 2);
  const open = video.seek(8 / 30);
  video.dispose();
  assert.equal(waiting.get(8).signal.aborted, true);
  waiting.get(8).resolve(rows(8));
  await assert.rejects(open, (e) => e.code === 'disposed');
});

test('options are checked', () => {
  for (const bad of [
    { width: 0 },
    { height: 1.5 },
    { width: 20000 },
    { fps: 0 },
    { fps: Infinity },
    { frames: 0 },
    { start: Number.NaN },
  ])
    assert.throws(() => clip(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => clip({ read: 'file' }), TypeError);
  assert.throws(() => clip({ loop: 1 }), TypeError);
  assert.throws(() => clip({ flipY: 'no' }), TypeError);
});

test('video/frames loads only the materials texture entry, not the Material pipeline (size leak)', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../dist/frames.js', import.meta.url), 'utf8');
  const bare = [...text.matchAll(/from\s*["'](@margoengine\/[^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(
    bare.filter((s) => s.startsWith('@margoengine/materials')),
    ['@margoengine/materials/texture'],
  );
  assert.ok(new FrameVideo({ width: 2, height: 2, fps: 30, frames: 1, read: rows }).texture instanceof Texture);
});
