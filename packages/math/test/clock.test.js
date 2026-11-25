// The film clock: frame and offset over a rational frame rate, and whole solver ticks in integer arithmetic, so the same time
// reached by any frame rate, any seek or any sub-frame gives the same ticks (docs/physics-framework.md, section 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FilmClock, SOLVER_RATE_LEVELS, solverRate } from '../dist/clock.js';

test('the same time reached at 24, 30 and 60 fps holds the same ticks at every solver rate', () => {
  for (let level = 0; level < SOLVER_RATE_LEVELS; level++) {
    const rate = solverRate(level);
    for (const seconds of [0, 1, 2, 7, 60]) {
      const counts = [24, 30, 60].map((fps) => new FilmClock({ fps, frame: seconds * fps }));
      for (const clock of counts) {
        assert.equal(clock.ticks(rate), seconds * rate, `${clock.fps.num} fps at ${seconds} s, ${rate} Hz`);
        assert.equal(clock.alpha(rate), 0);
      }
    }
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(solverRate), [60, 120, 240, 480, 960, 1920], 'the dyadic rates');
  assert.equal(solverRate(7), 7680);
  for (const bad of [-1, 8, 1.5, Number.NaN]) assert.throws(() => solverRate(bad), RangeError);
});

test('a frame rate that does not divide the tick rate loses no tick: 25 fps owes 4 or 5 ticks of 1/120 s and 24000/1001 is exact', () => {
  const clock = new FilmClock({ fps: 25 });
  let last = 0,
    owed = [];
  for (let frame = 1; frame <= 250; frame++) {
    clock.frame = frame;
    const now = clock.ticks(120);
    owed.push(now - last);
    last = now;
  }
  assert.ok(
    owed.every((n) => n === 4 || n === 5),
    `${owed}`,
  );
  assert.equal(last, 1200, 'ten seconds is 1,200 ticks: none lost');
  // 23.976 fps: 24,000 frames are exactly 1,001 seconds.
  const ntsc = new FilmClock({ fps: { num: 24000, den: 1001 }, frame: 24000 });
  assert.equal(ntsc.ticks(120), 120120);
  assert.equal(ntsc.alpha(120), 0);
  assert.equal(ntsc.time, 1001);
  // A float sum of the frame time would not be: 1001/24000 added 24,000 times.
  let sum = 0;
  for (let i = 0; i < 24000; i++) sum += 1001 / 24000;
  assert.notEqual(sum, 1001, 'the float sum the clock replaces drifts');
  assert.equal(Math.floor(sum * 120) === 120120, false, 'and loses a tick');
});

test('a sub-frame has an exact time inside its frame, the fraction of a tick is exact, and a seek is an assignment', () => {
  const clock = new FilmClock({ fps: 24 });
  clock.at(10, { num: 1, den: 2 });
  assert.deepEqual(clock.offset, { num: 1, den: 2 });
  assert.equal(clock.ticks(120), 52, '10.5 frames of 1/24 s are 52.5 ticks of 1/120 s');
  assert.equal(clock.alpha(120), 0.5);
  assert.equal(clock.time, 10.5 / 24);
  // An offset is kept in lowest terms; a whole frame drops it.
  clock.at(3, { num: 2, den: 4 });
  assert.deepEqual(clock.offset, { num: 1, den: 2 });
  clock.frame = 3;
  assert.deepEqual(clock.offset, { num: 0, den: 1 });
  // The motion-blur sub-frames of frame 7 at 60 fps, a quarter of a frame apart, against the same times reached at 240 fps.
  const fine = new FilmClock({ fps: 240 });
  for (let k = 0; k < 4; k++) {
    const blur = new FilmClock({ fps: 60 }).at(7, { num: k, den: 4 });
    fine.frame = 28 + k;
    for (const rate of [60, 120, 480, 7680]) {
      assert.equal(blur.ticks(rate), fine.ticks(rate), `sub-frame ${k}, ${rate} Hz`);
      assert.equal(blur.alpha(rate), fine.alpha(rate));
    }
  }
  // A seek is the same whether reached by advancing or by assignment.
  const walked = new FilmClock({ fps: { num: 30000, den: 1001 } });
  for (let i = 0; i < 1234; i++) walked.advance();
  const jumped = new FilmClock({ fps: { num: 30000, den: 1001 } });
  jumped.frame = 1234;
  assert.equal(walked.ticks(7680), jumped.ticks(7680));
  assert.equal(walked.advance(0).frame, 1234);
  assert.equal(new FilmClock().fps.num, 24, 'default 24 fps');
});

test('every input is checked', () => {
  for (const fps of [0, -24, 23.976, { num: 24, den: 0 }, { num: 2 ** 31 + 1, den: 1 }, Number.NaN])
    assert.throws(() => new FilmClock({ fps }), RangeError, JSON.stringify(fps));
  const clock = new FilmClock();
  for (const frame of [-1, 0.5, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => (clock.frame = frame), RangeError);
  for (const offset of [
    { num: 1, den: 1 },
    { num: -1, den: 2 },
    { num: 1, den: 0 },
    { num: 0.5, den: 2 },
  ])
    assert.throws(() => clock.at(0, offset), RangeError, JSON.stringify(offset));
  for (const rate of [0, -60, 60.5, 2 ** 32]) assert.throws(() => clock.ticks(rate), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
  // A tick count past the safe integers is refused, not rounded.
  const far = new FilmClock({ fps: 1, frame: Number.MAX_SAFE_INTEGER });
  assert.throws(() => far.ticks(7680), RangeError);
});
