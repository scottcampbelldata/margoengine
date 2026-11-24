import test from 'node:test';
import assert from 'node:assert/strict';
import { Tween, cubicBezier } from '../dist/index.js';
import { customEase, easeFromSamples, easeFromStroke } from '../dist/custom-ease.js';

const curve = (kind, points) => ({ version: 1, kind, points });
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('linear runs straight between the points', () => {
  const ease = customEase(curve('linear', [[0, 0], [0.25, 1], [1, 0]]));
  near(ease(0.125), 0.5);
  near(ease(0.25), 1);
  near(ease(0.625), 0.5);
});

test('smooth passes through every point, and stays between neighbours where the data does', () => {
  const points = [[0, 0], [0.1, 0.5], [0.15, 0.55], [0.6, 0.6], [0.65, 1], [1, 1]],
    ease = customEase(curve('smooth', points));
  for (const [x, y] of points) near(ease(x), y);
  // Rising data gives a rising curve: a plain spline through these points rises past 0.6 and falls back.
  let previous = 0;
  for (let i = 0; i <= 4000; i++) {
    const y = ease(i / 4000);
    assert.ok(y >= previous - 1e-12, `falls at ${i / 4000}`);
    previous = y;
  }
  // A peak stays a peak: the curve does not overshoot it.
  const hill = customEase(curve('smooth', [[0, 0], [0.5, 1], [1, 0]]));
  for (let i = 0; i <= 1000; i++) assert.ok(hill(i / 1000) <= 1);
  // A flat stretch stays flat.
  const flat = customEase(curve('smooth', [[0, 0], [0.3, 0.5], [0.7, 0.5], [1, 1]]));
  for (let i = 0; i <= 100; i++) near(flat(0.3 + (i / 100) * 0.4), 0.5);
});

test('smooth has no kink at a point: the slope is the same from both sides', () => {
  const ease = customEase(curve('smooth', [[0, 0], [0.4, 0.3], [1, 1]])),
    h = 1e-6;
  const left = (ease(0.4) - ease(0.4 - h)) / h,
    right = (ease(0.4 + h) - ease(0.4)) / h;
  // Each side is a one-sided difference, off from the slope by about h times the curvature, here under 10.
  near(left, right, 2e-5);
});

test('one bezier segment is the same curve as cubicBezier', () => {
  const ease = customEase(curve('bezier', [[0, 0], [0.42, 0], [0.58, 1], [1, 1]])),
    css = cubicBezier(0.42, 0, 0.58, 1);
  for (let i = 0; i <= 200; i++) near(ease(i / 200), css(i / 200), 1e-9);
});

test('bezier segments join, and a curve can overshoot and end away from 1', () => {
  const points = [[0, 0], [0.1, 1.4], [0.3, 1.4], [0.5, 1], [0.6, 0.8], [0.8, 0.5], [1, 0.5]],
    ease = customEase(curve('bezier', points));
  near(ease(0.5), 1, 1e-9);
  near(ease(1), 0.5);
  // The y of the first segment at s = 1/2 is (0 + 3 * 1.4 + 3 * 1.4 + 1) / 8, and its x (0 + 0.3 + 0.9 + 0.5) / 8.
  // The solver stops within 1e-7 of x, and the slope here is below 10.
  near(ease(0.2125), 1.175, 1e-6);
  assert.ok(ease(0.2125) > 1);
});

test('outside 0..1 it holds the end values, and every value is finite', () => {
  const ease = customEase(curve('smooth', [[0, 0.2], [1, 0.8]]));
  assert.equal(ease(-1), 0.2);
  assert.equal(ease(0), 0.2);
  assert.equal(ease(1), 0.8);
  assert.equal(ease(2), 0.8);
});

test('the JSON round trip gives the same curve, from text or from the object', () => {
  for (const data of [
    curve('smooth', [[0, 0], [0.4, 1], [0.7, 0.8], [1, 1]]),
    curve('linear', [[0, 0], [0.5, 2], [1, 1]]),
    curve('bezier', [[0, 0], [0.2, 0.9], [0.4, 1.2], [1, 1]]),
  ]) {
    const ease = customEase(data),
      text = JSON.stringify(ease),
      back = customEase(text);
    assert.deepEqual(JSON.parse(text), data);
    assert.deepEqual(back.curve, data);
    assert.deepEqual(customEase(JSON.parse(text)).toJSON(), data);
    for (let i = 0; i <= 100; i++) assert.equal(back(i / 100), ease(i / 100));
  }
  // Inside an object too.
  const saved = JSON.stringify({ hop: customEase(curve('linear', [[0, 0], [1, 1]])) });
  assert.equal(JSON.parse(saved).hop.kind, 'linear');
});

test('changing the data afterwards does not change the ease', () => {
  const points = [[0, 0], [1, 1]],
    ease = customEase(curve('linear', points));
  points[1][1] = 5;
  near(ease(0.5), 0.5);
  assert.equal(ease.curve.points[1][1], 1);
});

test('it drives a tween like any easing', () => {
  const tween = new Tween(),
    light = { intensity: 0 };
  tween.to(light, 'intensity', 2, { duration: 1, easing: customEase(curve('linear', [[0, 0], [0.5, 1], [1, 1]])) });
  tween.update(0.25);
  near(light.intensity, 1);
});

test('samples are evenly spaced points', () => {
  const ease = easeFromSamples([0, 0.1, 0.9, 1]);
  near(ease(1 / 3), 0.1);
  near(ease(2 / 3), 0.9);
  assert.equal(ease.curve.kind, 'smooth');
  near(easeFromSamples([0, 1, 0], 'linear')(0.25), 0.5);
});

test('a stroke is scaled to 0..1, loses the samples that went back, and thins out within the tolerance', () => {
  // Pixels: y grows down the screen, so this stroke falls in y and still reads as 0 to 1.
  const stroke = [];
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    stroke.push([100 + 300 * t, 500 - 200 * (t * t * (3 - 2 * t))]);
  }
  stroke.splice(200, 0, [200, 400]); // the pen went back
  const ease = easeFromStroke(stroke, 0.002);
  assert.ok(ease.curve.points.length < 40, `${ease.curve.points.length} points`);
  near(ease(0), 0);
  near(ease(1), 1);
  // Kept points are within 0.002 of the dropped ones as lines; the smooth curve through them lies closer than a linear
  // one on this S-curve, and 0.004 allows both for the line and the cubic.
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000;
    near(ease(t), t * t * (3 - 2 * t), 0.004);
  }
  // A straight stroke needs only its two ends.
  assert.equal(easeFromStroke([[0, 0], [1, 1], [2, 2], [3, 3]]).curve.points.length, 2);
});

test('bad curves throw', () => {
  const bad = [
    null,
    { kind: 'smooth', points: [[0, 0], [1, 1]] },
    curve('steps', [[0, 0], [1, 1]]),
    curve('smooth', [[0, 0]]),
    curve('smooth', 'x'),
    curve('smooth', [[0.1, 0], [1, 1]]),
    curve('smooth', [[0, 0], [0.9, 1]]),
    curve('smooth', [[0, 0], [0.5, 1], [0.5, 2], [1, 1]]),
    curve('linear', [[0, 0], [0.6, 1], [0.5, 2], [1, 1]]),
    curve('smooth', [[0, NaN], [1, 1]]),
    curve('smooth', [[0], [1, 1]]),
    curve('bezier', [[0, 0], [0.5, 0], [1, 1]]),
    curve('bezier', [[0, 0], [1.2, 0], [0.5, 1], [1, 1]]),
    curve('bezier', [[0, 0], [0.5, 0], [-0.1, 1], [1, 1]]),
  ];
  for (const data of bad) assert.throws(() => customEase(data), RangeError, JSON.stringify(data));
  assert.throws(() => customEase('{not json'), SyntaxError);
  assert.throws(() => easeFromStroke([[0, 0]]), RangeError);
  assert.throws(() => easeFromStroke([[0, 1], [1, 1]]), RangeError);
  assert.throws(() => easeFromStroke([[0, 0], [1, 1]], -1), RangeError);
  assert.throws(() => easeFromStroke([[0, 0], [NaN, 1]]), RangeError);
});
