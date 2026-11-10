import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Curve,
  CurveSet,
  Interpolant,
  LinearInterpolant,
  StepInterpolant,
  DiscreteInterpolant,
  SmoothstepInterpolant,
  CubicInterpolant,
} from '@margoengine/math/curve';
const near = (a, b, e = 1e-10) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

test('sampled interpolants clamp endpoints, seek in any order and own immutable sample copies', () => {
  const times = [-2, 0, 3],
    values = [2, 4, 10],
    result = new Float64Array(1);
  const interpolation = new LinearInterpolant(times, values, 1, result);
  times[1] = 100;
  values[1] = 200;
  for (const [time, value] of [
    [1.5, 7],
    [-100, 2],
    [100, 10],
    [0, 4],
    [-1, 3],
    [3, 10],
  ]) {
    assert.equal(interpolation.evaluate(time), result);
    near(result[0], value);
  }
  assert.throws(() => {
    interpolation.parameterPositions[0] = 99;
  }, TypeError);
  assert.equal(new Interpolant([1], [7]).evaluate(100)[0], 7);
});

test('step and smoothstep values include exact keys and independently known weights', () => {
  for (const Class of [StepInterpolant, DiscreteInterpolant]) {
    const curve = new Class([0, 1, 2], [10, 20, 30]);
    for (const [time, value] of [
      [-1, 10],
      [0.99, 10],
      [1, 20],
      [1.99, 20],
      [2, 30],
      [3, 30],
    ])
      assert.equal(curve.evaluate(time)[0], value);
  }
  const smooth = new SmoothstepInterpolant([2, 6], [3, 11]);
  near(smooth.evaluate(3)[0], 4.25);
  near(smooth.evaluate(4)[0], 7);
  near(smooth.evaluate(5)[0], 9.75);
});

test('packed tuples and caller-owned number arrays use the same scalar interpolants', () => {
  const result = [];
  const curve = new LinearInterpolant([0, 2], [0, 10, 4, 6], 2, result);
  assert.equal(curve.evaluate(1), result);
  assert.deepEqual(result, [2, 8]);
  const cubic = new CubicInterpolant([0, 1, 3], [0, 0, 1, 2, 3, 6], 2);
  for (const time of [0, 0.25, 1, 2, 3]) {
    const value = cubic.evaluate(time);
    near(value[0], time);
    near(value[1], time * 2);
  }
});

test('cubic Hermite matches an independent uniform cardinal polynomial and nonuniform linear data', () => {
  const curve = new CubicInterpolant([0, 1, 2, 3], [0, 2, 1, 4]);
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    // Cardinal polynomial for values (0,2,1,4), derivatives 0.5 and 1 at the two inner keys.
    const expected = 2 + 0.5 * u - 5 * u * u + 3.5 * u * u * u;
    near(curve.evaluate(1 + u)[0], expected);
  }
  const linear = new CubicInterpolant([-3, 0, 0.1, 7], [-5, 1, 1.2, 15]);
  for (const time of [-3, -2, 0, 0.02, 0.1, 2, 6, 7]) near(linear.evaluate(time)[0], 2 * time + 1);
  // First derivatives agree across a nonuniform knot.
  const h = 1e-6,
    k = 0.1;
  near(
    (linear.evaluate(k)[0] - linear.evaluate(k - h)[0]) / h,
    (linear.evaluate(k + h)[0] - linear.evaluate(k)[0]) / h,
    1e-8,
  );
});

test('cubic natural, flat and wrapped endpoint policies have their specified derivatives', () => {
  const data = [
      [0, 1, 2, 3],
      [0, 2, 1, 0],
    ],
    h = 1e-4;
  const natural = new CubicInterpolant(...data);
  const f = (t) => natural.evaluate(t)[0];
  near((f(0) - 2 * f(h) + f(2 * h)) / (h * h), 0, 0.002);
  const flat = new CubicInterpolant(...data, 1, undefined, { endingStart: 'flat', endingEnd: 'flat' });
  near((flat.evaluate(h)[0] - flat.evaluate(0)[0]) / h, 0, 0.001);
  near((flat.evaluate(3)[0] - flat.evaluate(3 - h)[0]) / h, 0, 0.001);
  const wrap = new CubicInterpolant(...data, 1, undefined, { endingStart: 'wrap', endingEnd: 'wrap' });
  const start = (wrap.evaluate(h)[0] - wrap.evaluate(0)[0]) / h;
  const end = (wrap.evaluate(3)[0] - wrap.evaluate(3 - h)[0]) / h;
  near(start, end, 0.002);
});

test('keyed curves sort, replace duplicates, edit, clone and invalidate interpolation caches', () => {
  const curve = new Curve(
    [
      [2, 10],
      [0, 2],
      [1, 4],
    ],
    'linear',
  );
  assert.equal(curve.length, 3);
  near(curve.value(0.5), 3);
  assert.deepEqual(curve.keys, [
    [0, 2],
    [1, 4],
    [2, 10],
  ]);
  curve.add(1, 8);
  near(curve.value(0.5), 5);
  assert.equal(curve.length, 3);
  const key = curve.get(1);
  key[1] = 99;
  assert.deepEqual(curve.get(1), [1, 8]);
  const clone = curve.clone();
  clone.add(0, -2);
  assert.equal(curve.value(0), 2);
  curve.type = 'step';
  assert.equal(curve.value(0.5), 2);
  curve.type = 'smoothstep';
  near(curve.value(0.25), 2 + 6 * 0.15625);
  curve.type = 'cubic';
  curve.tension = 0;
  near(curve.value(0.25), 2 + 6 * 0.15625);
  curve.tension = 0.5;
  assert.notEqual(curve.value(0.25), 2 + 6 * 0.15625);
  assert.deepEqual(curve.closest(0.5), [1, 8]);
  assert.deepEqual(curve.remove(1), [1, 8]);
  assert.equal(curve.remove(-1), undefined);
  assert.equal(curve.sort(), curve);
  assert.equal(new Curve().value(2), 0);
  assert.equal(new Curve([2, 7]).value(-100), 7);
});

test('quantized tuning tables include endpoints, clamp values and interleave curve channels', () => {
  const curve = new Curve([0, -1, 1, 3], 'linear');
  assert.deepEqual([...curve.quantize(5)], [-1, 0, 1, 2, 3]);
  assert.deepEqual([...curve.quantize(3, 0.25, 0.75)], [0, 1, 2]);
  assert.deepEqual([...curve.quantizeClamped(5, 0, 2)], [0, 0, 1, 2, 2]);
  const set = new CurveSet([curve, [0, 10, 1, 20]]);
  set.type = 'linear';
  assert.deepEqual(set.value(0.5), [1, 15]);
  assert.deepEqual([...set.quantize(3)], [-1, 10, 1, 15, 3, 20]);
  assert.deepEqual([...set.quantizeClamped(3, 0, 12)], [0, 10, 1, 12, 3, 12]);
  const clone = set.clone();
  clone.get(0).add(0, 100);
  assert.equal(set.get(0).value(0), -1);
});

test('invalid keys, controls and dimensions reject before altering valid curve state', () => {
  for (const [times, values, size] of [
    [[], [], 1],
    [[0, 0], [1, 2], 1],
    [[1, 0], [1, 2], 1],
    [[0], [1], 0],
    [[0, 1], [1], 1],
    [[0, Infinity], [1, 2], 1],
  ])
    assert.throws(() => new LinearInterpolant(times, values, size), RangeError);
  assert.throws(() => new LinearInterpolant([0], [1], 1, new Float32Array(0)), RangeError);
  assert.throws(() => new Interpolant([0], [1], 1, undefined, 'bad'), TypeError);
  assert.throws(() => new CubicInterpolant([0], [1], 1, undefined, { endingStart: 'bad' }), TypeError);
  assert.throws(() => new Curve([0, 1, 2]), RangeError);
  assert.throws(() => new Curve([[0, 1, 2]]), RangeError);
  const curve = new Curve([0, 1, 1, 2]);
  curve.value(0.3);
  for (const operation of [
    () => curve.add(NaN, 2),
    () => curve.add(1, Infinity),
    () => {
      curve.type = 'bad';
    },
    () => {
      curve.tension = -1;
    },
    () => curve.value(NaN),
    () => curve.quantize(1),
    () => curve.quantizeClamped(3, 2, 1),
  ])
    assert.throws(operation);
  assert.deepEqual(curve.keys, [
    [0, 1],
    [1, 2],
  ]);
  assert.equal(curve.type, 'smoothstep');
  assert.equal(curve.tension, 0.5);
});

test('curve channel editing retains modes and independent ownership', () => {
  const defaults = new CurveSet();
  assert.equal(defaults.length, 1);
  const set = new CurveSet(2);
  set.type = 'step';
  const added = set.add([0, 1, 1, 2]);
  assert.equal(added.type, 'step');
  assert.equal(set.length, 3);
  assert.equal(set.remove(2), added);
  assert.equal(set.remove(-1), undefined);
  set.get(0).add(0, 5);
  assert.equal(set.clearKeys(), set);
  assert.deepEqual(set.value(0), [0, 0]);
  assert.equal(set.clear(), set);
  assert.equal(set.length, 0);
  assert.equal(set.add().type, 'step');
  const variadic = new CurveSet([0, 1, 1, 3], [0, 10, 1, 20]);
  variadic.type = 'linear';
  assert.deepEqual(variadic.value(0.5), [2, 15]);
  const curve = new Curve([0, 1, 1, 2]);
  curve.value(0.5);
  assert.equal(curve.clear(), curve);
  assert.equal(curve.value(0.5), 0);
  assert.equal(curve.closest(1), null);
  assert.throws(() => new CurveSet(-1), RangeError);
});

test('nonuniform cubic joins preserve the first derivative for nonlinear tuning data', () => {
  const curve = new CubicInterpolant([0, 0.2, 2, 7], [1, 4, -2, 3]),
    h = 1e-6;
  for (const time of [0.2, 2]) {
    const left = (curve.evaluate(time)[0] - curve.evaluate(time - h)[0]) / h;
    const right = (curve.evaluate(time + h)[0] - curve.evaluate(time)[0]) / h;
    near(left, right, 0.0002);
  }
  const set = new CurveSet(0);
  set.type = 'step';
  assert.equal(set.clone().add().type, 'step');
  assert.throws(() => new CurveSet(2).value(0, new Float32Array(1)), RangeError);
});
