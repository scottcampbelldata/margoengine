// The comparison logic of scripts/web-demos/controls.mjs, the dead-control finder for the web demos, on synthetic
// frames and readouts: a still picture, an animated one, a change outside the animation, play and pause, readouts
// that tick on their own and a control's own label.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PIXELS,
  compareRegion,
  diffFrames,
  growMask,
  identicalStops,
  judgeControl,
  judgeStep,
  motionChanged,
  noiseFloor,
  noisyKeys,
  periodOf,
  stalled,
  textChanges,
  VISIBLE_DELTA,
  visiblePixels,
  visiblyApart,
} from '../scripts/web-demos/controls-compare.mjs';

const W = 64,
  H = 48;
/** A frame filled with one grey, with optional rectangles [x, y, w, h, value]. */
function frame(base = 40, boxes = []) {
  const data = new Uint8Array(W * H * 3).fill(base);
  for (const [x0, y0, w, h, v] of boxes)
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) data.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
  return { width: W, height: H, data };
}

test('diffFrames counts pixels past the delta and the mean change', () => {
  const d = diffFrames(frame(40), frame(40, [[0, 0, 10, 10, 200]]));
  assert.equal(d.count, 100);
  assert.ok(Math.abs(d.mean - (100 * 160) / (W * H)) < 1e-9);
  assert.equal(diffFrames(frame(40), frame(45)).count, 0, 'a change below the delta is not a changed pixel');
  assert.throws(() => diffFrames(frame(), { width: 1, height: 1, data: new Uint8Array(3) }), /sizes differ/);
});

test('growMask grows a single pixel into a square', () => {
  const m = new Uint8Array(W * H);
  m[10 * W + 10] = 1;
  const g = growMask(m, W, H, 2);
  assert.equal(
    g.reduce((s, v) => s + v, 0),
    25,
  );
  assert.equal(g[8 * W + 8], 1);
  assert.equal(g[7 * W + 10], 0);
});

test('a still picture: no change is a conclusive dead, any visible change is live', () => {
  const a = frame(40),
    noise = noiseFloor(a, frame(40));
  const same = compareRegion(a, frame(40), noise);
  assert.equal(same.changed, false);
  assert.equal(same.conclusive, true);
  const moved = compareRegion(a, frame(40, [[20, 20, 4, 4, 90]]), noise);
  assert.equal(moved.changed, true, 'a 16 px change on a still picture counts');
  const tiny = compareRegion(a, frame(40, [[20, 20, 2, 2, 90]]), noise);
  assert.equal(tiny.changed, false, `fewer than ${MIN_PIXELS} px is not a change`);
});

test('a subtle change over the whole picture counts through the mean (a light dimming)', () => {
  const a = frame(100),
    r = compareRegion(a, frame(110), noiseFloor(a, frame(100)));
  assert.equal(r.count, 0);
  assert.equal(r.changed, true);
});

test('an animated area is noise; a change outside it is live, more of the same motion is not', () => {
  // A spinning part fills the left quarter: it changes between the two frames taken with no input.
  const p0 = frame(40, [[0, 0, 16, 48, 200]]),
    p1 = frame(40, [[0, 0, 16, 48, 120]]);
  const noise = noiseFloor(p0, p1);
  assert.ok(noise.maskFraction > 0.25 && noise.maskFraction < 0.5);
  const stillMoving = compareRegion(p1, frame(40, [[0, 0, 16, 48, 60]]), noise);
  assert.equal(stillMoving.changed, false, 'the animation alone is not the control working');
  assert.equal(stillMoving.conclusive, true);
  const elsewhere = compareRegion(
    p1,
    frame(40, [
      [0, 0, 16, 48, 60],
      [40, 10, 8, 8, 230],
    ]),
    noise,
  );
  assert.equal(elsewhere.changed, true);
  assert.ok(elsewhere.outside >= 64);
});

test('a picture that moves almost everywhere is inconclusive', () => {
  const noise = noiseFloor(frame(40, [[0, 0, 60, 48, 200]]), frame(40, [[0, 0, 60, 48, 120]]));
  const r = compareRegion(frame(40, [[0, 0, 60, 48, 120]]), frame(40, [[0, 0, 60, 48, 60]]), noise);
  assert.equal(r.conclusive, false);
  assert.equal(
    judgeStep({ regions: [r], motion: false, text: { changed: [], own: [] }, events: [], layoutChanged: false })
      .verdict,
    'unsure',
  );
});

test('motionChanged sees play and pause but not steady motion', () => {
  const still = { count: 0 },
    moving = { count: 900 },
    alsoMoving = { count: 800 };
  assert.equal(motionChanged(still, moving), true, 'play');
  assert.equal(motionChanged(moving, still), true, 'pause');
  assert.equal(motionChanged(moving, alsoMoving), false);
  assert.equal(motionChanged(still, { count: 20 }), false, 'a few pixels of shimmer is not play');
});

test("textChanges leaves out readouts that tick on their own and splits the control's own label", () => {
  const before = { fps: '60', label: 'Mass 1 kg', readout: 'Period 2.0 s', status: 'Ready' },
    after = { fps: '59', label: 'Mass 3 kg', readout: 'Period 2.0 s', status: 'Ready' };
  const noisy = noisyKeys({ fps: '60' }, { fps: '58' });
  assert.deepEqual([...noisy], ['fps']);
  const t = textChanges(before, after, noisy, new Set(['label']));
  assert.deepEqual(t.changed, []);
  assert.deepEqual(t.own, ['label']);
  const live = textChanges(before, { ...after, readout: 'Period 3.5 s' }, noisy, new Set(['label']));
  assert.deepEqual(live.changed, ['readout']);
  assert.deepEqual(textChanges({ a: 'x' }, { a: 'x', b: 'new panel' }).changed, ['b'], 'new text that appears counts');
});

test('judgeStep and judgeControl: dead, label only, live by event, live by any input', () => {
  const quiet = { changed: false, reasons: [], conclusive: true };
  const none = { changed: [], own: [] };
  const dead = judgeStep({ regions: [quiet], motion: false, text: none, events: [], layoutChanged: false });
  assert.equal(dead.verdict, 'dead');
  assert.equal(dead.labelOnly, false);
  const labelOnly = judgeStep({
    regions: [quiet],
    motion: false,
    text: { changed: [], own: ['out'] },
    events: [],
    layoutChanged: false,
  });
  assert.equal(labelOnly.verdict, 'dead');
  assert.equal(labelOnly.labelOnly, true);
  const sound = judgeStep({
    regions: [quiet],
    motion: false,
    text: none,
    events: ['played a sound'],
    layoutChanged: false,
  });
  assert.equal(sound.verdict, 'live');
  const picture = judgeStep({
    regions: [{ changed: true, reasons: ['40 px changed'], conclusive: true }],
    motion: false,
    text: none,
    events: [],
    layoutChanged: false,
  });
  assert.equal(picture.verdict, 'live');
  assert.equal(
    judgeStep({ regions: [], motion: false, text: none, events: [], layoutChanged: false }).verdict,
    'dead',
    'no picture and no readout change is dead',
  );
  assert.equal(judgeControl([dead, picture]).verdict, 'live', 'a slider that works at one end works');
  assert.deepEqual(judgeControl([dead, labelOnly]), { verdict: 'dead', labelOnly: true });
  assert.equal(judgeControl([dead, { verdict: 'unsure', labelOnly: false }]).verdict, 'unsure');
  assert.equal(
    judgeControl([dead, { verdict: 'unreachable', labelOnly: false }]).verdict,
    'unreachable',
    'a covered control is not called dead',
  );
  assert.equal(judgeControl([]).verdict, 'skipped');
});

test('identicalStops finds two stops of one control that give the same picture (partly dead)', () => {
  const stop = (name, value, f) => ({ name, value, frames: [f], noise: [noiseFloor(f, f)] });
  const fringesA = frame(40, [[10, 10, 8, 30, 200]]),
    fringesB = frame(40, [[30, 10, 8, 30, 200]]),
    fringesC = frame(40, [[50, 10, 8, 30, 200]]);
  // Mirror travel: the middle and the far end both land on whole fringes and draw the same picture.
  const stops = [
    stop('start', '0', fringesA),
    stop('max', '10', fringesB),
    stop('min', '-10', fringesC),
    stop('middle', '5', fringesB),
  ];
  assert.deepEqual(identicalStops(stops), [['max', 'middle']]);
  assert.deepEqual(
    identicalStops([stop('start', '5', fringesB), stop('middle', '5', fringesB)]),
    [],
    'the same value twice is not a dead stop',
  );
  const moving = { ...stop('max', '10', fringesB), noise: [noiseFloor(fringesA, fringesB)] };
  assert.deepEqual(
    identicalStops([stop('start', '0', fringesB), moving]),
    [],
    'a stop whose picture moves on its own is not judged',
  );
  assert.deepEqual(identicalStops([stop('start', '0', fringesA), stop('max', '10', fringesB)]), []);
  // A turn slider: -180 and 180 degrees are the same angle and draw the same picture by design.
  const turn = [stop('max', '180', fringesA), stop('min', '-180', fringesA), stop('middle', '0', fringesB)];
  assert.deepEqual(identicalStops(turn), [['max', 'min']], 'without a period the two ends look partly dead');
  assert.deepEqual(identicalStops(turn, { period: 360 }), [], 'whole turns apart are the same angle, not a dead stop');
  assert.deepEqual(
    identicalStops([stop('a', '0', fringesA), stop('b', '180', fringesA)], { period: 360 }),
    [['a', 'b']],
    'half a turn apart still counts',
  );
  // the-chain-fountain: the middle of 1 to 2.4 in steps of 0.1 is 1.7000000000000002, which the input holds as 1.7.
  assert.deepEqual(
    identicalStops([stop('start', '1.7', fringesA), stop('max', '2.4', fringesB), stop('middle', '1.7000000000000002', fringesA)]),
    [],
    'one value written two ways is not a dead stop',
  );
  // the-road-builder: the start (8) and the middle (9) of a 0 to 17 slider are one step apart.
  const bank = [stop('start', '8', fringesA), stop('max', '17', fringesB), stop('middle', '9', fringesA)];
  assert.deepEqual(identicalStops(bank), [['start', 'middle']], 'without a step the neighbours look partly dead');
  assert.deepEqual(identicalStops(bank, { step: 1 }), [], 'neighbouring settings may draw the same picture');
  assert.deepEqual(
    identicalStops([stop('start', '6', fringesA), stop('middle', '9', fringesA)], { step: 1 }),
    [['start', 'middle']],
    'three steps apart still counts',
  );
  // the-sky-clock: 0 and 1439 minutes are one minute apart across midnight.
  const day = [stop('max', '1439', fringesA), stop('min', '0', fringesA), stop('middle', '720', fringesB)];
  assert.deepEqual(identicalStops(day, { step: 1 }), [['max', 'min']], 'without the period the ends are 1439 apart');
  assert.deepEqual(identicalStops(day, { period: 1440, step: 1 }), [], 'around a day they are neighbours');
});

test('periodOf: whole turns and a day of minutes or hours', () => {
  assert.equal(periodOf({ label: 'Heading', min: '-180', max: '180' }), 360);
  // the-sky-clock: 0 to 1439 minutes in steps of 1 is one day.
  assert.equal(periodOf({ label: 'Time of day (UTC)', min: '0', max: '1439', step: '1' }), 1440);
  assert.equal(periodOf({ label: 'Hour (UTC)', min: '0', max: '23', step: '1' }), 24);
  assert.equal(periodOf({ label: 'Discharge', min: '0', max: '1439', step: '1' }), 0, 'not without a clock in its name');
  assert.equal(periodOf({ label: 'Time of day', min: '0', max: '1440', step: '1' }), 0, 'not when both ends are held');
  // A saved record keeps its ends only in its step names.
  assert.equal(periodOf({ label: 'Time of day', steps: [{ action: 'to max (1439)' }, { action: 'to min (0)' }] }), 1440);
});

test('visiblyApart: a thin part that moves a few pixels at full size is a visible difference', () => {
  const big = (boxes) => {
    const width = 200,
      height = 100,
      data = new Uint8Array(width * height * 3).fill(40);
    for (const [x0, y0, w, h, v] of boxes)
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    return { width, height, data };
  };
  // A bimetal strip 2 px thick and 120 px long whose tip rises 3 px (the-bimetal-switch, 20 and 24 degrees).
  const cold = big([[40, 50, 120, 2, 200]]),
    warm = big([[40, 50, 80, 2, 200], [120, 47, 40, 2, 200]]);
  assert.equal(visiblePixels(cold, cold), 0);
  assert.equal(visiblePixels(cold, warm), 160);
  assert.equal(visiblyApart(cold, warm), true);
  assert.equal(visiblyApart(cold, warm, 100), false, 'not when the picture changes as much on its own');
  const faint = big([[40, 50, 120, 2, 40 + VISIBLE_DELTA - 1]]);
  assert.equal(visiblyApart(big([]), faint), false, 'a change under the visible delta is not seen');
  assert.equal(visiblyApart(cold, { ...cold, width: 100 }), false, 'pictures of different sizes are not compared');
});

test('stalled: drawing at the start and nothing at the end; an on-demand page is not stalled', () => {
  assert.equal(stalled({ frames: 60 }, { frames: 0 }), true);
  assert.equal(stalled({ frames: 0 }, { frames: 0 }), false);
  assert.equal(stalled({ frames: 60 }, { frames: 58 }), false);
});
