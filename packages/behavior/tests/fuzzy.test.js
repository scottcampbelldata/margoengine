import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FuzzySystem,
  and,
  or,
  not,
  very,
  fairly,
  is,
  triangle,
  trapezoid,
  leftShoulder,
  rightShoulder,
  sCurve,
  gaussian,
  singleton,
  membership,
  defuzzify,
} from '../dist/fuzzy.js';

test('membership shapes match analytic boundary, midpoint and shoulder values', () => {
  for (const [set, points] of [
    [
      triangle(0, 2, 4),
      [
        [0, 0],
        [1, 0.5],
        [2, 1],
        [3, 0.5],
        [4, 0],
        [5, 0],
      ],
    ],
    [
      triangle(0, 0, 4),
      [
        [0, 1],
        [2, 0.5],
        [4, 0],
      ],
    ],
    [
      trapezoid(0, 1, 3, 4),
      [
        [0, 0],
        [0.5, 0.5],
        [1, 1],
        [2, 1],
        [3.5, 0.5],
        [4, 0],
      ],
    ],
    [
      leftShoulder(0, 2, 4),
      [
        [-1, 0],
        [0, 1],
        [2, 1],
        [3, 0.5],
        [4, 0],
      ],
    ],
    [
      rightShoulder(0, 2, 4),
      [
        [0, 0],
        [1, 0.5],
        [2, 1],
        [4, 1],
        [5, 0],
      ],
    ],
    [
      sCurve(0, 4),
      [
        [0, 0],
        [1, 0.125],
        [2, 0.5],
        [3, 0.875],
        [4, 1],
      ],
    ],
    [
      sCurve(0, 4, 'left'),
      [
        [0, 1],
        [1, 0.875],
        [2, 0.5],
        [3, 0.125],
        [4, 0],
      ],
    ],
    [
      singleton(2),
      [
        [1, 0],
        [2, 1],
        [3, 0],
      ],
    ],
  ])
    for (const [x, y] of points) assert.equal(membership(set, x), y);
  assert.equal(membership(gaussian(5, 2), 5), 1);
  assert.equal(membership(gaussian(5, 2), 7), Math.exp(-0.5));
});
test('centroid, mean of maxima and weighted representatives have distinct analytical results', () => {
  const sets = [
    { set: trapezoid(0, 0, 2, 2), strength: 1 },
    { set: trapezoid(6, 6, 10, 10), strength: 0.5 },
  ];
  assert.equal(defuzzify(sets, { samples: 1000 }), 4.5);
  assert.equal(defuzzify(sets, { samples: 1000, method: 'mean-of-max' }), 1);
  assert.equal(defuzzify(sets, { method: 'max-average' }), 10 / 3);
  assert.equal(defuzzify([{ set: triangle(0, 2, 4), strength: 0.5 }]), 2);
  assert.equal(
    defuzzify([
      { set: singleton(3), strength: 0.5 },
      { set: singleton(9), strength: 1 },
    ]),
    7,
  );
  assert.equal(
    defuzzify(
      [
        { set: singleton(3), strength: 0.5 },
        { set: singleton(9), strength: 1 },
      ],
      { method: 'mean-of-max' },
    ),
    9,
  );
  assert.equal(defuzzify([{ set: singleton(3), strength: 1 }]), 3);
  assert.equal(defuzzify([], { fallback: 5 }), 5);
  assert.equal(defuzzify([{ set: triangle(0, 2, 4), strength: 0 }], { fallback: 7 }), 7);
});
test('compound rules and hedges use min/max/complement, max aggregation and reset between agents', () => {
  const a = is('input', 'high'),
    document = {
      inputs: { input: { sets: { high: rightShoulder(0, 1, 2) } } },
      outputs: { out: { sets: { low: singleton(0), high: singleton(10) } } },
      rules: [
        { if: and(a, not(a)), then: { variable: 'out', set: 'low' } },
        { if: or(very(a), fairly(a)), then: { variable: 'out', set: 'high' }, weight: 0.5 },
        { if: very(a), then: { variable: 'out', set: 'high' } },
      ],
    };
  const system = new FuzzySystem(document);
  const expected = (10 * (Math.sqrt(0.25) * 0.5)) / (0.25 + Math.sqrt(0.25) * 0.5);
  assert.equal(system.evaluate({ input: 0.25 }).out, expected);
  assert.equal(system.evaluate({ input: 1 }).out, 10);
  assert.equal(system.evaluate({ input: 0 }).out, 0);
  document.rules.length = 0;
  assert.equal(system.evaluate({ input: 1 }).out, 10);
  const json = JSON.parse(JSON.stringify(system));
  assert.equal(new FuzzySystem(json).evaluate({ input: 1 }).out, 10);
  assert.throws(() => system.evaluate({}), /Missing/);
});
test('bad shapes, rules, cycles and options reject before producing an invalid decision', () => {
  assert.throws(() => triangle(2, 1, 3), /ordered/);
  assert.throws(() => gaussian(0, 0), /sigma/);
  assert.throws(() => membership(singleton(0), NaN), /finite/);
  assert.throws(() => defuzzify([], { samples: 0 }), /samples/);
  assert.throws(() => defuzzify([], { method: 'unknown' }), /Unknown/);
  assert.throws(() => defuzzify([{ set: triangle(0, 1, 2), strength: 2 }]), /0..1/);
  const base = {
    inputs: { x: { sets: { a: singleton(0) } } },
    outputs: { y: { sets: { b: singleton(1) } } },
    rules: [{ if: is('x', 'a'), then: { variable: 'y', set: 'b' } }],
  };
  assert.throws(
    () => new FuzzySystem({ ...base, rules: [{ if: is('x', 'missing'), then: { variable: 'y', set: 'b' } }] }),
    /Unknown/,
  );
  const cycle = not(is('x', 'a'));
  cycle.term = cycle;
  assert.throws(
    () => new FuzzySystem({ ...base, rules: [{ if: cycle, then: { variable: 'y', set: 'b' } }] }),
    /cyclic/,
  );
  assert.throws(
    () => new FuzzySystem({ ...base, rules: [{ if: and(), then: { variable: 'y', set: 'b' } }] }),
    /needs a term/,
  );
});
