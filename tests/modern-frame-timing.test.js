import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDue, frameStatus } from '../packages/quality/dist/index.js';

test('120 target uses every callback at 60 Hz and explains the observed limit', () => {
  const clock = new Float64Array(3);
  for (let i = 1; i <= 120; i++) assert(frameDue(clock, 100 + (i * 1000) / 60, 120));
  assert.match(frameStatus(120, 60, 60), /120 FPS target.*browser supplies ~60 Hz/);
  assert.match(frameStatus(120, 144, 120), /browser cadence ~144 Hz/);
  assert.match(frameStatus(120, 144, 75), /rendering ~75 FPS/);
  assert.equal(frameStatus(120, 0, 0), 'Measuring browser cadence…');
});

test('native 60 Hz jitter never skips every other animation callback', () => {
  const clock = new Float64Array(3),
    jitter = [16.4, 16.9, 16.5, 16.8];
  let now = 100;
  for (let i = 0; i < 240; i++) {
    now += jitter[i % jitter.length];
    assert(frameDue(clock, now, 60));
  }
});

test('faster clocks retain phase and reach 60/120 targets without exceeding display refresh', () => {
  for (const [source, target] of [
    [120, 60],
    [144, 60],
    [240, 60],
    [144, 120],
    [240, 120],
  ]) {
    const clock = new Float64Array(3);
    let rendered = 0;
    for (let i = 1; i <= source * 4; i++) rendered += Number(frameDue(clock, 100 + (i * 1000) / source, target));
    assert(Math.abs(rendered - target * 4) <= 1, `${source} Hz to ${target} FPS rendered ${rendered} frames`);
  }
  const clock = new Float64Array(3);
  for (let i = 1; i < 120; i++)
    assert(frameDue(clock, 100 + i * 31.3, 60), 'A clamped browser should render every available callback');
});

test('a stalled clock resumes without replaying missed frames', () => {
  const clock = new Float64Array(3);
  assert(frameDue(clock, 100, 60));
  assert(!frameDue(clock, 104, 60));
  assert(frameDue(clock, 1000, 60));
  assert(!frameDue(clock, 1004, 60));
  assert(frameDue(clock, 1016.5, 60));
});

test('bursty browser clocks do not render only the long interval of each pair', () => {
  const clock = new Float64Array(3);
  let now = 100,
    rendered = 0;
  for (let i = 0; i < 120; i++) {
    now += 17.8;
    rendered += Number(frameDue(clock, now, 120));
    now += 0.2;
    rendered += Number(frameDue(clock, now, 120));
  }
  assert(rendered > 230, `Rendered ${rendered} of 240 available callbacks`);
});

test('changing display refresh does not inherit a future native-clock deadline', () => {
  const clock = new Float64Array(3);
  let now = 100,
    rendered = 0;
  for (let i = 0; i < 6200; i++) {
    now += 1000 / 62;
    assert(frameDue(clock, now, 60));
  }
  for (let i = 0; i < 144; i++) {
    now += 1000 / 144;
    rendered += Number(frameDue(clock, now, 60));
  }
  assert(Math.abs(rendered - 60) <= 1, `Refresh transition rendered ${rendered} frames`);
});
