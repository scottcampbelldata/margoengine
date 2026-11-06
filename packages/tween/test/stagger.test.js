import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, Tween, easeInQuad, linear } from '../dist/index.js';
import { stagger, staggerDelays, staggerTimeline } from '../dist/stagger.js';

// Sums and products of a few doubles near 1: a few units in the last place.
const EPS = 1e-12;
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => assert.ok(Math.abs(actual[i] - e) <= EPS, `${i}: ${actual[i]} vs ${e}`));
};
const lamps = (n) => Array.from({ length: n }, () => ({ intensity: 0 }));
const levels = (list) => list.map((l) => l.intensity);

test('even offsets: each is the gap between neighbours, amount the whole spread', () => {
  close(staggerDelays(4, 0.25), [0, 0.25, 0.5, 0.75]);
  close(staggerDelays(4, { each: 0.25, from: 'end' }), [0.75, 0.5, 0.25, 0]);
  close(staggerDelays(5, { amount: 1 }), [0, 0.25, 0.5, 0.75, 1]);
  close(staggerDelays(3), [0, 0.1, 0.2]);
});

test('from the centre, the edges or an index, the earliest start is 0', () => {
  close(staggerDelays(5, { each: 1, from: 'center' }), [2, 1, 0, 1, 2]);
  // Four targets: the middle is between two of them, and those two both start first.
  close(staggerDelays(4, { each: 1, from: 'center' }), [1, 0, 0, 1]);
  close(staggerDelays(5, { each: 1, from: 'edges' }), [0, 1, 2, 1, 0]);
  close(staggerDelays(4, { each: 1, from: 1 }), [1, 0, 1, 2]);
});

test('eased offsets follow the curve over the order, and the last start stays at the total', () => {
  close(staggerDelays(3, { amount: 1, easing: easeInQuad }), [0, 0.25, 1]);
  // With each, the total is each * (count - 1) and the curve bends inside it.
  close(staggerDelays(3, { each: 1, easing: easeInQuad }), [0, 0.5, 2]);
  // A curve that dips below 0 must not give a negative delay, which Tween refuses.
  close(staggerDelays(3, { amount: 1, easing: (t) => (t === 0.5 ? -0.2 : t) }), [0, 0, 1]);
});

test('a grid spreads by distance from a cell', () => {
  const r = Math.SQRT2;
  close(staggerDelays(9, { each: 1, grid: [3, 3], from: 'center' }), [r, 1, r, 1, 0, 1, r, 1, r]);
  close(staggerDelays(4, { each: 1, grid: [2, 2], from: 'start' }), [0, 1, 1, r]);
  close(staggerDelays(4, { each: 1, grid: [2, 2], from: 3 }), [r, 1, 1, 0]);
  close(staggerDelays(9, { each: 1, grid: [3, 3], from: 'edges' }), [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  // A short last row: 'end' is the last target, at column 1 of row 1, not the corner of the grid.
  close(staggerDelays(5, { each: 1, grid: [3, 2], from: 'end' }), [r, 1, r, 1, 0]);
});

test('random is a shuffle: every slot once, the same for a seed, another for another seed', () => {
  const sorted = (d) => [...d].sort((a, b) => a - b);
  const a = staggerDelays(32, { each: 1, from: 'random', seed: 7 }),
    b = staggerDelays(32, { each: 1, from: 'random', seed: 7 }),
    c = staggerDelays(32, { each: 1, from: 'random', seed: 8 });
  close(sorted(a), Array.from({ length: 32 }, (_, i) => i));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual([...a], sorted(a));
});

test('no target, one target and identical distances give no spread', () => {
  assert.equal(staggerDelays(0).length, 0);
  close(staggerDelays(1, { amount: 5 }), [0]);
  close(staggerDelays(2, { amount: 5, from: 'edges' }), [0, 0]);
});

test('bad options throw', () => {
  const bad = [
    [-1, {}],
    [1.5, {}],
    [2, { each: 1, amount: 1 }],
    [2, { each: -1 }],
    [2, { amount: Infinity }],
    [2, { from: 'middle' }],
    [2, { from: 2 }],
    [2, { from: 0.5 }],
    [2, { easing: 1 }],
    [2, { easing: () => NaN }],
    [5, { grid: [2, 2] }],
    [2, { grid: [0, 2] }],
    [2, { seed: NaN }],
  ];
  for (const [count, options] of bad) assert.throws(() => staggerDelays(count, options), RangeError);
});

test('one call starts every target at its offset, from its own value', () => {
  const tween = new Tween(),
    list = lamps(3);
  list[2].intensity = 2;
  stagger(tween, list, 'intensity', 4, { duration: 1, easing: linear, stagger: 0.5, delay: 0.25 });
  tween.update(0.25);
  assert.deepEqual(levels(list), [0, 0, 2]);
  tween.update(0.5);
  // Target 0 is half way, target 1 has just started, target 2 starts at 1.25 s.
  assert.deepEqual(levels(list), [2, 0, 2]);
  tween.update(0.5);
  assert.deepEqual(levels(list), [4, 2, 2]);
  tween.update(0.5);
  assert.deepEqual(levels(list), [4, 4, 3]);
});

test('end values can differ per target, and any iterable works', () => {
  const tween = new Tween(),
    list = lamps(3);
  stagger(tween, new Set(list), 'intensity', (_, i) => i * 10, { duration: 1, stagger: 0 });
  tween.update(1);
  assert.deepEqual(levels(list), [0, 10, 20]);
});

test('onComplete runs once, after the last to finish, even when that is first in the list', () => {
  const tween = new Tween(),
    list = lamps(3);
  let done = 0;
  stagger(tween, list, 'intensity', 1, {
    duration: 1,
    stagger: { each: 1, from: 'end' },
    onComplete: () => done++,
  });
  tween.update(2.5);
  assert.equal(done, 0);
  tween.update(0.5);
  assert.equal(done, 1);
  tween.update(5);
  assert.equal(done, 1);
  let empty = 0;
  stagger(tween, [], 'intensity', 1, { duration: 1, stagger: 1, onComplete: () => empty++ });
  assert.equal(empty, 1);
});

test('cancel stops every target and onComplete never runs', () => {
  const tween = new Tween(),
    list = lamps(2);
  let done = 0;
  const cancel = stagger(tween, list, 'intensity', 1, { duration: 1, stagger: 1, onComplete: () => done++ });
  tween.update(0.5);
  cancel();
  tween.update(5);
  assert.deepEqual(levels(list), [0.5, 0]);
  assert.equal(done, 0);
});

test('a target Tween refuses leaves nothing running', () => {
  const tween = new Tween(),
    list = [{ intensity: 0 }, { intensity: NaN }];
  assert.throws(() => stagger(tween, list, 'intensity', 1, { duration: 1, stagger: 0 }), RangeError);
  tween.update(1);
  assert.equal(list[0].intensity, 0);
});

test('repeat and yoyo reach every target', () => {
  const tween = new Tween(),
    list = lamps(2);
  stagger(tween, list, 'intensity', 1, { duration: 1, repeat: 1, yoyo: true, stagger: 1 });
  tween.update(1.5);
  assert.deepEqual(levels(list), [0.5, 0.5]);
  tween.update(1);
  assert.deepEqual(levels(list), [0, 0.5]);
});

test('on a timeline the offsets count from at, a time or a label, and seeking works', () => {
  const list = lamps(3),
    timeline = new Timeline().to({ x: 0 }, 'x', 1, { duration: 1 }).label('in');
  staggerTimeline(timeline, list, 'intensity', 1, { duration: 1, stagger: 0.5, at: 'in' });
  assert.ok(Math.abs(timeline.duration - 3) <= EPS);
  timeline.seek(2);
  close(levels(list), [1, 0.5, 0]);
  timeline.seek(0);
  close(levels(list), [0, 0, 0]);
  const second = new Timeline();
  staggerTimeline(second, lamps(2), 'intensity', 1, { duration: 1, stagger: 1, at: 2 });
  assert.equal(second.duration, 4);
  // With no at, they follow what is already there.
  const third = new Timeline().to({ x: 0 }, 'x', 1, { duration: 2 });
  staggerTimeline(third, lamps(2), 'intensity', 1, { duration: 1, stagger: 1 });
  assert.equal(third.duration, 4);
  // An offset small enough for exponent notation still reads as an offset from the label.
  const tiny = new Timeline().label('a');
  staggerTimeline(tiny, lamps(2), 'intensity', 1, { duration: 1, stagger: 1e-7, at: 'a' });
  assert.ok(Math.abs(tiny.duration - 1.0000001) <= EPS);
});
