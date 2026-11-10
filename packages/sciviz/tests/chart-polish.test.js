import test from 'node:test';
import assert from 'node:assert/strict';
import { numberFormatter, brokenScale, minorTicks, tooltipTemplate } from '../dist/format.js';
import { bandScale, jitterCategories, hierarchicalCluster, dendrogramSegments } from '../dist/categorical.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
test('locale, SI, engineering, percentages, fixed, dates and rounding carry are explicit', () => {
  assert.equal(numberFormatter({ mode: 'si' })(1200), '1.2k');
  assert.equal(numberFormatter({ mode: 'si', digits: 1 })(999999), '1M');
  assert.equal(numberFormatter({ mode: 'engineering' })(0.000123), '123e-6');
  assert.equal(numberFormatter({ mode: 'fixed', digits: 2, locale: 'de-DE' })(12.5), '12,50');
  assert.equal(numberFormatter({ mode: 'percent', digits: 1 })(0.125), '12.5%');
  assert.equal(numberFormatter({ mode: 'fixed', digits: 1 })(-0), '0.0');
  assert.match(numberFormatter({ mode: 'date' })(Date.UTC(2020, 1, 29)), /Feb.*29.*2020/);
  assert.doesNotMatch(numberFormatter({ mode: 'engineering' })(Number.MIN_VALUE), /Infinity|NaN/);
  assert.throws(() => numberFormatter({ digits: 20 }));
});
test('piecewise scales preserve endpoints and retained distances, exposing inverse gaps', () => {
  const s = brokenScale({
    domain: [0, 100],
    breaks: [
      [20, 40],
      [60, 80],
    ],
    gap: 0.05,
  });
  near(s.forward(0), 0);
  near(s.forward(100), 1);
  for (const x of [0, 10, 20, 40, 50, 60, 80, 90, 100]) near(s.inverse(s.forward(x)), x);
  near(s.forward(40) - s.forward(20), 0.05);
  near(s.forward(20) - s.forward(0), s.forward(60) - s.forward(40));
  assert.ok(Number.isNaN(s.inverse(s.forward(30))));
  assert.throws(() =>
    brokenScale({
      domain: [0, 1],
      breaks: [
        [0.1, 0.5],
        [0.3, 0.7],
      ],
    }),
  );
  assert.deepEqual(minorTicks([0, 10], 4), [2, 4, 6, 8]);
  assert.throws(() => minorTicks([1, 0]));
});
test('tooltip templates format numbers while leaving text as text and unknown tokens unchanged', () => {
  assert.equal(
    tooltipTemplate('{name}: {x:fixed.2} {y:percent} {unknown}', { name: '<img>', x: 1.2, y: 0.5 }),
    '<img>: 1.20 50% {unknown}',
  );
});
test('categorical band centers, reverse ranges, gaps and seeded jitter conserve membership', () => {
  const a = bandScale(['A', 'B', 'C'], { range: [0, 3] });
  near(a.bandwidth, 0.9);
  for (const s of a.domain) {
    assert.equal(a.invert(a.center(s)), s);
  }
  const b = bandScale(['A', 'B'], { range: [10, 0] });
  assert.equal(b.invert(b.center('A')), 'A');
  assert.equal(b.invert(b.center('B')), 'B');
  assert.ok(Number.isNaN(a.center('missing')));
  assert.equal(a.invert(-1), undefined);
  const values = ['A', 'B', 'A', 'C'],
    p = jitterCategories(values, a, { seed: 42 });
  assert.deepEqual(p, jitterCategories(values, a, { seed: 42 }));
  p.forEach((v, i) => assert.equal(a.invert(v), values[i]));
  assert.throws(() => bandScale(['A', 'A']));
  assert.throws(() => jitterCategories(values, a, { width: 2 }));
});
test('single/complete/average hierarchy match independent small Euclidean examples', () => {
  const points = [[0], [2], [8], [10]],
    single = hierarchicalCluster(points, 'single'),
    complete = hierarchicalCluster(points, 'complete'),
    average = hierarchicalCluster(points);
  assert.deepEqual(
    single.merges.map((m) => m.distance),
    [2, 2, 6],
  );
  assert.deepEqual(
    complete.merges.map((m) => m.distance),
    [2, 2, 10],
  );
  assert.deepEqual(
    average.merges.map((m) => m.distance),
    [2, 2, 8],
  );
  assert.deepEqual(
    [...average.order].sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
  assert.equal(dendrogramSegments(average).length, 3 * 12);
  assert.deepEqual(hierarchicalCluster([[4]]), { merges: [], order: [0] });
  assert.throws(() => hierarchicalCluster([[NaN], [0]]));
  assert.throws(() => hierarchicalCluster([[1], [1, 2]]));
});
