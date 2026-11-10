import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as stats from '../dist/stats.js';
import * as maths from '../dist/maths.js';
const near = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) <= t, `${a} != ${b}`);

test('box quartiles, adjacent-value whiskers and outliers use interpolated order statistics', () => {
  assert.deepEqual(stats.boxSummary([0, 1, 2, 3, 4, 100, NaN]), {
    count: 6,
    q1: 1.25,
    median: 2.5,
    q3: 3.75,
    lower: 0,
    upper: 4,
    outliers: [100],
  });
  assert.deepEqual(stats.boxSummary([2]), { count: 1, q1: 2, median: 2, q3: 2, lower: 2, upper: 2, outliers: [] });
  for (const name of [
    'boxSummary',
    'kernelDensity',
    'silvermanBandwidth',
    'density2D',
    'hexbin2D',
    'empiricalCDF',
    'quantilePairs',
    'stepSeries',
    'stackSeries',
    'errorBarSegments',
    'linearTrend',
    'loessTrend',
  ])
    assert.equal(stats[name], maths[name], `${name} has one math implementation`);
});
test('Silverman bandwidth and Gaussian KDE match their analytical formulas and integrate to unity', () => {
  const a = [-2, -1, 0, 1, 2],
    h = 0.9 * Math.min(Math.sqrt(2.5), 2 / 1.34) * 5 ** -0.2;
  near(stats.silvermanBandwidth(a), h);
  const p = stats.kernelDensity([0], [0, 1], 1);
  near(p[0][1], 1 / Math.sqrt(2 * Math.PI));
  near(p[1][1], Math.exp(-0.5) / Math.sqrt(2 * Math.PI));
  const at = Array.from({ length: 1001 }, (_, i) => -8 + (16 * i) / 1000),
    d = stats.kernelDensity(a, at, h);
  let area = 0;
  for (let i = 1; i < d.length; i++) area += ((d[i][0] - d[i - 1][0]) * (d[i][1] + d[i - 1][1])) / 2;
  near(area, 1, 1e-8);
  assert.ok(stats.silvermanBandwidth([0, 0, 0]) > 0);
  near(stats.density2D([0], [0], [0], [0], [1, 2])[0], 1 / (4 * Math.PI));
});
test('hexbin membership conserves observations, including boundary ties, negatives and missing values', () => {
  const x = [0, 0.1, Math.sqrt(3), -Math.sqrt(3), NaN],
    y = [0, 0.1, 0, 0, 1],
    bins = stats.hexbin2D(x, y, 1);
  assert.equal(
    bins.reduce((n, b) => n + b.count, 0),
    4,
  );
  assert.equal(bins.length, 3);
  assert.deepEqual(
    bins.flatMap((b) => b.indices).sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
  for (const b of bins) for (const p of b.vertices) near(Math.hypot(p[0] - b.center[0], p[1] - b.center[1]), 1);
});
test('ECDF collapses ties, Q-Q reproduces affine transforms and all step placements are explicit', () => {
  assert.deepEqual(stats.empiricalCDF([2, 1, 2, 3, NaN]), [
    [1, 0.25],
    [2, 0.75],
    [3, 1],
  ]);
  for (const [x, y] of stats.quantilePairs([1, 3, 5, 7], [0, 1, 2, 3])) near(y, 2 * x + 1);
  assert.deepEqual(stats.stepSeries([0, 2], [1, 3], 'pre'), [
    [0, 1],
    [0, 3],
    [2, 3],
  ]);
  assert.deepEqual(stats.stepSeries([0, 2], [1, 3], 'post'), [
    [0, 1],
    [2, 1],
    [2, 3],
  ]);
  assert.deepEqual(stats.stepSeries([0, 2], [1, 3], 'mid'), [
    [0, 1],
    [1, 1],
    [1, 3],
    [2, 3],
  ]);
  const p = stats.stepSeries([0, 1, 2], [1, NaN, 3]);
  assert.ok(p[1].every(Number.isNaN));
  assert.deepEqual(p[2], [2, 3]);
});
test('signed stacks and normalization conserve separate positive/negative column totals', () => {
  const s = stats.stackSeries([
    [1, -2, NaN],
    [3, -4, 5],
  ]);
  assert.deepEqual([...s[1].lower], [1, -2, 0]);
  assert.deepEqual([...s[1].upper], [4, -6, 5]);
  const n = stats.stackSeries(
    [
      [1, -2],
      [3, -4],
    ],
    true,
  );
  near(n[1].upper[0], 1);
  near(n[1].upper[1], -1);
});
test('asymmetric error geometry retains both axes and owns its endpoints', () => {
  const x = [5],
    y = [10],
    e = stats.errorBarSegments(x, y, { xMinus: [1], xPlus: [2], yMinus: [3], yPlus: [4] });
  assert.deepEqual(e, [
    [
      [4, 10],
      [7, 10],
    ],
    [
      [5, 7],
      [5, 14],
    ],
  ]);
  x[0] = 99;
  assert.equal(e[0][0][0], 4);
  assert.deepEqual(stats.errorBarSegments([5], [10], { yMinus: [2] }), [
    [
      [5, 8],
      [5, 12],
    ],
  ]);
});
test('OLS coefficients and Student-t 95% bands agree with an independent scipy calculation', () => {
  const r = stats.linearTrend([0, 1, 2, 3, 4], [1, 2, 1, 3, 4], { at: [0, 2, 4] });
  near(r.slope, 0.7);
  near(r.intercept, 0.8);
  near(r.residualVariance, 19 / 30);
  // scipy.stats.t.ppf(.975,3)=3.182446305284263; covariance sigma2*[1/n+(x-mean)^2/Sxx].
  const critical = 3.182446305284263;
  r.points.forEach((p) => {
    near(p.upper - p.y, critical * Math.sqrt((19 / 30) * (0.2 + (p.x - 2) ** 2 / 10)), 1e-8);
    near(p.y - p.lower, p.upper - p.y);
  });
  const exact = stats.linearTrend([1e8, 1e8 + 1, 1e8 + 2], [2, 4, 6]);
  near(exact.slope, 2);
  near(exact.points[1].y, 4);
  near(exact.points[1].upper, 4);
});
test('Student-t critical values handle fractional LOESS residual degrees of freedom without clipping', () => {
  near(stats.studentTCritical(1), 12.706204736432095, 1e-8);
  near(stats.studentTCritical(2), 4.302652729696142, 1e-8);
  assert.ok(stats.studentTCritical(0.2) > 100000, 'fractional-df tail must exceed the old fixed 2048 search cap');
  near(stats.studentTCritical(0.2), 768848.4797012262, 768848.4797012262 * 1e-10);
  near(stats.studentTCritical(0.5), 164.55767348048818, 1e-8);
  assert.ok(stats.studentTCritical(0.5) > stats.studentTCritical(1));
  assert.throws(
    () => stats.studentTCritical(0),
    (e) => e.code === 'out-of-range',
  );
});
test('robust LOESS reproduces affine data and rejects an outlier without changing the input', () => {
  const x = Array.from({ length: 40 }, (_, i) => i),
    y = x.map((v) => 1 + 2 * v);
  for (const p of stats.loessTrend(x, y, { span: 0.6 })) near(p.y, 1 + 2 * p.x, 1e-10);
  const noisy = y.map((v, i) => v + 0.1 * Math.sin(i));
  noisy[20] += 100;
  const before = [...noisy];
  const plain = stats.loessTrend(x, noisy, { span: 0.6, iterations: 0 }),
    robust = stats.loessTrend(x, noisy, { span: 0.6, iterations: 2 });
  assert.ok(Math.abs(robust[20].y - 41) < Math.abs(plain[20].y - 41) / 10);
  assert.deepEqual(noisy, before);
  for (const p of robust) assert.ok(p.lower <= p.y && p.upper >= p.y && Number.isFinite(p.lower));
});
test('every chart exports vector marks, axes and escaped labels, including gaps and large constant axes', () => {
  const x = [0, 1, 2, 3, 4, 5, 6, 7],
    y = [1, 3, 2, 5, 4, 7, 6, 8],
    groups = [{ label: '<group>', values: y }];
  const charts = [
    stats.errorBarChart(x, y, { xMinus: x.map(() => 0.1), yMinus: x.map(() => 0.2) }),
    stats.boxChart(groups),
    stats.violinChart(groups),
    stats.areaChart(x, y),
    stats.stackedChart(x, [y, y]),
    stats.stackedChart(x, [y, y], { kind: 'bar' }),
    stats.stepChart(x, y),
    stats.cdfChart(y),
    stats.qqChart(y, x),
    stats.densityChart(x, y, 8),
    stats.hexbinChart(x, y, 0.8),
    stats.trendChart(x, y),
    stats.trendChart(x, y, { method: 'loess', span: 1 }),
  ];
  for (const chart of charts) {
    const svg = chart.toSVG({ title: '<test>' });
    assert.match(svg, /&lt;test&gt;/);
    assert.match(svg, /<path/);
    assert.ok(!svg.includes('<image'));
    assert.ok(!svg.includes('NaN'));
    assert.ok(!svg.includes('Infinity'));
  }
  const large = new stats.StatisticalChart([{ kind: 'point', points: [[1e100, 1e100]], color: '#123' }]);
  assert.ok(!large.toSVG().includes('NaN'));
  const gap = stats.stepChart([0, 1, 2], [1, NaN, 3]).toSVG();
  assert.match(gap, /d="M[^\"]+M/);
});
test('invalid inputs fail with coded errors and oversized density/loess work rejects before loops', () => {
  for (const f of [
    () => stats.boxSummary([]),
    () => stats.kernelDensity([1], [0], 0),
    () => stats.hexbin2D([1], [2], 0),
    () => stats.errorBarSegments([1], [2], { xMinus: [-1] }),
    () => stats.linearTrend([1, 1, 1], [1, 2, 3]),
    () => stats.loessTrend([0, 1, 2], [1, 2, 3], { span: 0 }),
    () => stats.stackSeries([[1], [1, 2]]),
    () => stats.density2D([0], [0], [0], [0], [0, 1]),
  ])
    assert.throws(f, (e) => e.code === 'out-of-range');
  assert.throws(() => stats.kernelDensity(new Array(10000).fill(0), new Array(1000).fill(0)));
});
test('frozen GHCN and NASA inputs retain hashes and yield real chart output', () => {
  const base = new URL('../../../examples/assets/sciviz/stats/', import.meta.url),
    source = JSON.parse(readFileSync(new URL('source.json', base)));
  for (const s of source.sources) {
    const bytes = readFileSync(new URL(s.file, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), s.sha256);
    const rows = JSON.parse(bytes);
    assert.ok(rows.length >= 40);
    const values = rows.map((r) => (s.file === 'ghcn.json' ? r.tmax : r.pl_rade));
    assert.match(stats.cdfChart(values).toSVG(), /<path/);
  }
});
