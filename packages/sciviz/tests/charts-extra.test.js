import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../dist/charts-extra.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
test('public NOAA and EIA fixtures match provenance and contain real observations', () => {
  const root = new URL('../../../examples/assets/sciviz/charts-extra/', import.meta.url);
  const source = JSON.parse(readFileSync(new URL('source.json', root)));
  for (const [file, hash] of Object.entries(source.outputs))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL(file, root)))
        .digest('hex'),
      hash,
    );
  const wind = JSON.parse(readFileSync(new URL('wind.json', root)));
  assert.ok(wind.length > 600);
  const bins = c.windRoseBins(
    wind.map((w) => w.direction ?? NaN),
    wind.map((w) => w.speed),
  );
  assert.equal(bins.total, wind.length);
  const energy = JSON.parse(readFileSync(new URL('energy.json', root)));
  assert.ok(energy.links.length >= 15);
  assert.equal(energy.links.find((l) => l.source === 'Natural gas' && l.target === 'Transport').value, 1358.248);
  assert.equal(energy.links.find((l) => l.source === 'Petroleum' && l.target === 'Industrial').value, 8586.118);
  const nodes = [...new Set(energy.links.flatMap((l) => [l.source, l.target]))].map((id) => ({ id }));
  assert.equal(c.sankeyLayout(nodes, energy.links).links.length, energy.links.length);
});
const root = {
  label: 'Energy',
  children: [
    {
      label: 'Fossil',
      children: [
        { label: 'Gas', value: 6 },
        { label: 'Coal', value: 3 },
      ],
    },
    { label: 'Renewable', value: 2 },
    { label: 'Nuclear', value: 1 },
  ],
};
test('meteorological rose wraps north, bins boundary speeds and includes calm in percentages', () => {
  const b = c.windRoseBins([0, 359, 360, -1, 90, NaN, NaN], [2, 2, 5, 10, 1, 0, 8], { sectors: 4 });
  assert.deepEqual(b.counts, [
    [0, 2, 1, 1],
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(b.calm, 1);
  assert.equal(b.total, 6);
  assert.match(c.windRoseChart([0, 90], [2, 2], { percentage: true }).toSVG(), /percent of all/);
  assert.throws(() => c.windRoseBins([0], [1], { speedBreaks: [0, 1, 1, Infinity] }));
});
test('polar handles degree/radian conversion, log radii and validates bounds', () => {
  const a = c.polarChart([0, 90, 180], [1, 2, 3]),
    b = c.polarChart([0, Math.PI / 2, Math.PI], [1, 2, 3], { radians: true });
  assert.deepEqual(a.marks, b.marks);
  assert.ok(
    !c
      .polarChart([0, 90], [1, 10], { radialScale: 'log', radialDomain: [1, 10] })
      .toSVG()
      .includes('NaN'),
  );
  assert.throws(() => c.polarChart([0], [1], { radialDomain: [2, 3] }));
});
test('ternary affine normalization puts pure components on corners', () => {
  const t = c.ternaryChart(
    [
      [10, 0, 0],
      [0, 7, 0],
      [0, 0, 1],
      [1, 1, 1],
    ],
    { labels: ['top', 'left', 'right'] },
  );
  assert.match(t.marks.at(-4).path, /M497,90/);
  assert.match(t.marks.at(-1).path, /M497,390/);
  assert.throws(() => c.ternaryChart([[0, 0, 0]]));
});
test('financial candles and OHLC have independently encoded open close high low', () => {
  const rows = [
    { x: 0, open: 2, close: 3, high: 4, low: 1 },
    { x: 1, open: 3, close: 2, high: 4, low: 1 },
    { x: 2, open: 2, close: 2, high: 4, low: 1 },
  ];
  const a = c.candlestickChart(rows),
    b = c.ohlcChart(rows);
  assert.notEqual(a.marks.at(-1).path, b.marks.at(-1).path);
  assert.ok(a.marks.some((m) => m.stroke === '#60956a'));
  assert.ok(a.marks.some((m) => m.stroke === '#d47a46'));
  assert.throws(() => c.ohlcChart([{ ...rows[0], low: 3 }]));
  assert.throws(() => c.ohlcChart([rows[0], rows[0]]));
});
test('pie single full circle, donut hole, zeros, escaping and positive totals', () => {
  assert.equal((c.pieChart([{ label: '<Gas>', value: 1 }]).marks[0].path.match(/A240/g) || []).length, 2);
  assert.match(c.donutChart([{ label: '<Gas>', value: 1 }]).marks[0].path, /A120/);
  assert.match(c.pieChart([{ label: '<Gas>', value: 1 }]).toSVG(), /&lt;Gas&gt;/);
  assert.throws(() => c.pieChart([{ label: 'zero', value: 0 }]));
  assert.throws(() => c.donutChart([{ label: 'a', value: 1 }], { hole: 1 }));
});
test('squarified treemap conserves every nested area without overlaps', () => {
  const cells = c.treemapLayout(root);
  near(cells[0].width * cells[0].height, 840 * 480);
  for (const cell of cells) {
    near(cell.width * cell.height, (840 * 480 * cell.value) / 12);
    assert.ok(cell.width >= 0 && cell.height >= 0);
  }
  const siblings = cells.filter((x) => x.depth === 1);
  near(
    siblings.reduce((s, n) => s + n.width * n.height, 0),
    840 * 480,
  );
  for (let i = 0; i < siblings.length; i++)
    for (let j = i + 1; j < siblings.length; j++) {
      const a = siblings[i],
        b = siblings[j];
      assert.ok(
        a.x + a.width <= b.x + 1e-8 ||
          b.x + b.width <= a.x + 1e-8 ||
          a.y + a.height <= b.y + 1e-8 ||
          b.y + b.height <= a.y + 1e-8,
      );
    }
  const cycle = { label: 'cycle' };
  cycle.children = [cycle];
  assert.throws(() => c.sunburstChart(cycle));
  assert.throws(() => c.treemapChart({ label: 'ambiguous', value: 4, children: [{ label: 'a', value: 1 }] }));
});
test('sunburst has every hierarchy node and level-specific annular scales', () => {
  const s = c.sunburstChart(root);
  assert.equal(s.marks.length, 6);
  assert.match(s.marks[0].path, /A80/);
  assert.match(s.marks.at(-1).path, /A160/);
});
test('Sugiyama layering and dummy routing preserve widths at every node and port', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    links = [
      { source: 'a', target: 'b', value: 3 },
      { source: 'b', target: 'c', value: 2 },
      { source: 'c', target: 'd', value: 2 },
      { source: 'a', target: 'd', value: 1 },
    ],
    s = c.sankeyLayout(nodes, links);
  assert.deepEqual(
    s.nodes.map((n) => n.layer),
    [0, 1, 2, 3],
  );
  assert.equal(s.links.at(-1).points.length, 6);
  s.links.forEach((l) => near(l.width / l.value, s.scale));
  for (const n of s.nodes) {
    const ports = [];
    for (const l of s.links) {
      if (l.source === n.id) ports.push([l.points[0][1] - l.width / 2, l.points[0][1] + l.width / 2]);
      if (l.target === n.id) ports.push([l.points.at(-1)[1] - l.width / 2, l.points.at(-1)[1] + l.width / 2]);
    }
    for (const p of ports) {
      assert.ok(p[0] >= n.y - 1e-8);
      assert.ok(p[1] <= n.y + n.height + 1e-8);
    }
  }
  assert.throws(() => c.sankeyLayout(nodes, [...links, { source: 'd', target: 'a', value: 1 }]));
  assert.throws(() => c.sankeyLayout(nodes, links, { layers: { a: 0, b: 0, c: 1, d: 2 } }));
  const cross = c.sankeyLayout(
    ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    [
      { source: 'a', target: 'd', value: 1 },
      { source: 'b', target: 'c', value: 1 },
    ],
  );
  assert.ok(cross.nodes[3].y < cross.nodes[2].y);
});
test('alluvial identifies categories per stage and aggregates equal transitions', () => {
  const a = c.alluvialChart([
    { stages: ['same', 'same', 'end'], value: 2 },
    { stages: ['same', 'same', 'end'], value: 3 },
  ]);
  assert.equal(a.kind, 'Alluvial');
  assert.equal(a.marks.filter((m) => m.width > 1).length, 2);
  assert.match(a.toSVG(), /: 5/);
  assert.throws(() =>
    c.alluvialChart([
      { stages: ['a', 'b'], value: 1 },
      { stages: ['a'], value: 1 },
    ]),
  );
});
test('radar uses independent spoke domains and rejects out of range values', () => {
  const a = c.radarChart(
    [
      { label: 'A', domain: [0, 10] },
      { label: 'B', domain: [0, 100] },
      { label: 'C', domain: [-1, 1] },
    ],
    [{ label: 'one', values: [5, 50, 0] }],
  );
  assert.match(a.marks.at(-1).path, /M500,190/);
  assert.throws(() => c.radarChart([{ label: 'A' }, { label: 'B' }, { label: 'C' }], [{ label: 'a', values: [1, 2] }]));
});
test('calendar uses UTC dates, leap days, week starts, gaps and color scale', () => {
  const a = c.calendarHeatmap([{ date: '2024-02-29', value: 5 }], { year: 2024 });
  assert.equal(a.marks.length, 366 + 6);
  assert.ok(a.marks.some((m) => m.label === '2024-02-29: 5'));
  assert.throws(() => c.calendarHeatmap([{ date: '2023-02-29', value: 1 }]));
  assert.throws(() =>
    c.calendarHeatmap([
      { date: '2024-01-01', value: 1 },
      { date: '2024-01-01', value: 2 },
    ]),
  );
  assert.throws(() => a.toSVG({ width: 0 }));
  assert.doesNotMatch(a.toSVG(), /NaN|Infinity|<image/);
});
