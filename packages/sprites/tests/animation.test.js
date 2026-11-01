// Node checks of @margoengine/sprites/animation: frame at time for each mode, events, speed and determinism.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameGrid, SpriteAnimation } from '../dist/animation.js';
import { clipFromAtlas } from '../dist/atlas.js';

const rects = frameGrid(8, 8, 4);
const make = (clip, extra = {}) => {
  const log = [];
  const animation = new SpriteAnimation({
    clips: { c: { frames: rects, fps: 10, ...clip } },
    onEvent: (name, from) => log.push(`${from}:${name}`),
    ...extra,
  });
  return { animation, log };
};
const frames = (animation, dts) => dts.map((dt) => animation.update(dt).frame);

test('frameGrid lays rectangles out row by row', () => {
  assert.deepEqual(frameGrid(16, 8, 2, 3, 4, 2), [
    [4, 2, 16, 8],
    [20, 2, 16, 8],
    [4, 10, 16, 8],
  ]);
  assert.throws(() => frameGrid(0, 8, 2), RangeError);
});

test('loop wraps after the last frame', () => {
  const { animation } = make({});
  animation.play('c');
  assert.equal(animation.frame, 0);
  assert.deepEqual(frames(animation, [0.05, 0.1, 0.1, 0.1, 0.1, 0.1]), [0, 1, 2, 3, 0, 1]);
  assert.deepEqual(animation.rect, rects[1]);
});

test('once stops on the last frame and reports finished', () => {
  const { animation } = make({ mode: 'once' });
  animation.play('c');
  assert.deepEqual(frames(animation, [0.15, 0.15, 0.15, 5]), [1, 2, 3, 3]);
  assert.equal(animation.finished, true);
  assert.equal(animation.update(1).frame, 3);
  animation.play('c');
  assert.equal(animation.frame, 0);
  assert.equal(animation.finished, false);
});

test('pingpong runs forward then back without repeating the ends', () => {
  const { animation } = make({ mode: 'pingpong' });
  animation.play('c');
  assert.deepEqual(frames(animation, [0.05, ...Array(7).fill(0.1)]), [0, 1, 2, 3, 2, 1, 0, 1]);
  const single = new SpriteAnimation({ clips: { c: { frames: [rects[0]], mode: 'pingpong' } } }).play('c');
  assert.equal(single.update(10).frame, 0);
});

test('per-frame durations are honoured', () => {
  const animation = new SpriteAnimation({
    clips: { c: { frames: [{ rect: rects[0], duration: 0.5 }, { rect: rects[1], duration: 0.25 }, rects[2]], fps: 4 } },
  }).play('c');
  assert.deepEqual(frames(animation, [0.49, 0.02, 0.2, 0.05]), [0, 1, 1, 2]);
});

test('events fire once per frame entered, in order, including skipped frames and each loop', () => {
  const { animation, log } = make({
    events: [
      { frame: 0, name: 'start' },
      { frame: 2, name: 'step' },
      { frame: 2, name: 'dust' },
    ],
  });
  animation.play('c');
  assert.deepEqual(log, ['c:start']);
  animation.update(0.05).update(0.01);
  assert.equal(log.length, 1);
  animation.update(0.5);
  assert.deepEqual(log, ['c:start', 'c:step', 'c:dust', 'c:start']);
  animation.update(0.03);
  assert.equal(log.length, 4, 'staying on a frame does not fire again');
  animation.update(0.05);
  assert.deepEqual(log.slice(4), ['c:step', 'c:dust']);
});

test('a once clip fires its last-frame event one time', () => {
  const { animation, log } = make({ mode: 'once', events: [{ frame: 3, name: 'end' }] });
  animation.play('c');
  frames(animation, [1, 1, 1]);
  assert.deepEqual(log, ['c:end']);
});

test('speed scales time, 0 pauses, and playing the same clip does not restart it', () => {
  const { animation } = make({}, { speed: 2 });
  animation.play('c');
  assert.equal(animation.update(0.1).frame, 2);
  animation.speed = 0;
  assert.equal(animation.update(5).frame, 2);
  animation.speed = 1;
  animation.play('c');
  assert.equal(animation.frame, 2);
  animation.play('c', true);
  assert.equal(animation.frame, 0);
});

test('the same dts always give the same frames and events', () => {
  const run = () => {
    const { animation, log } = make({ mode: 'pingpong', events: [{ frame: 1, name: 'a' }] });
    animation.play('c');
    const seen = frames(animation, [0.03, 0.31, 0.07, 0.5, 0.01, 0.2]);
    return { seen, log, time: animation.time };
  };
  assert.deepEqual(run(), run());
});

test('apply writes the rectangle to a sprite', () => {
  const sprite = {};
  const { animation } = make({});
  animation.apply(sprite);
  assert.equal(sprite.rect, undefined);
  animation.play('c').update(0.2);
  animation.apply(sprite);
  assert.deepEqual(sprite.rect, rects[2]);
});

test('bad clips, speeds and dts throw coded errors', () => {
  assert.throws(() => new SpriteAnimation({ clips: { c: { frames: [] } } }), TypeError);
  assert.throws(() => new SpriteAnimation({ clips: { c: { frames: [[0, 0, 1.5, 1]] } } }), TypeError);
  assert.throws(() => new SpriteAnimation({ clips: { c: { frames: rects, mode: 'bounce' } } }), TypeError);
  assert.throws(() => new SpriteAnimation({ clips: { c: { frames: rects, fps: 0 } } }), TypeError);
  assert.throws(() => new SpriteAnimation({ clips: { c: { frames: [{ rect: rects[0], duration: 0 }] } } }), RangeError);
  assert.throws(
    () => new SpriteAnimation({ clips: { c: { frames: rects, events: [{ frame: 4, name: 'x' }] } } }),
    RangeError,
  );
  assert.throws(() => new SpriteAnimation({ clips: {}, speed: -1 }), RangeError);
  const { animation } = make({});
  assert.throws(
    () => animation.play('nope'),
    (error) => error.code === 'range' || error instanceof RangeError,
  );
  animation.play('c');
  assert.throws(() => animation.update(-1), RangeError);
  assert.throws(() => animation.update(Number.NaN), RangeError);
});

test('clipFromAtlas keeps the order and times, and each frame knows where it sits in the untrimmed image', () => {
  const manifest = {
      frames: {
        a: {
          frame: { x: 1, y: 2, w: 3, h: 4 },
          spriteSourceSize: { x: 5, y: 6, w: 3, h: 4 },
          sourceSize: { w: 16, h: 16 },
          pivot: { x: 0.5, y: 1 },
          page: 1,
        },
        b: { frame: { x: 9, y: 9, w: 8, h: 8 } },
      },
    },
    clip = clipFromAtlas(manifest, ['b', 'a'], { durations: [0.1, 0.3], mode: 'once' });
  assert.equal(clip.mode, 'once');
  assert.deepEqual(clip.frames, [
    { rect: [9, 9, 8, 8], duration: 0.1, offset: [0, 0], sourceSize: [8, 8], pivot: { x: 0.5, y: 0.5 }, page: 0 },
    { rect: [1, 2, 3, 4], duration: 0.3, offset: [5, 6], sourceSize: [16, 16], pivot: { x: 0.5, y: 1 }, page: 1 },
  ]);
  const animation = new SpriteAnimation({ clips: { c: clipFromAtlas(manifest, ['a', 'b'], { fps: 10 }) } });
  animation.play('c');
  assert.deepEqual(animation.update(0.15).rect, [9, 9, 8, 8]);
  assert.throws(() => clipFromAtlas(manifest, []), TypeError);
  assert.throws(() => clipFromAtlas(manifest, ['nope']), /no frame nope/);
  assert.throws(() => clipFromAtlas(manifest, ['toString']), /no frame toString/);
  assert.throws(() => clipFromAtlas(manifest, ['a'], { durations: [] }), /0 durations for 1/);
});
