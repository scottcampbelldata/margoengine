import * as c from '@margoengine/sciviz/charts-extra';
const [wind, energy] = await Promise.all([
  fetch('./assets/sciviz/charts-extra/wind.json').then((r) => r.json()) as Promise<
    { date: string; direction: number | null; speed: number }[]
  >,
  fetch('./assets/sciviz/charts-extra/energy.json').then((r) => r.json()) as Promise<{
    links: c.FlowLink[];
    unit: string;
    year: number;
  }>,
]);
const direction = wind.map((w) => w.direction ?? NaN),
  speed = wind.map((w) => w.speed),
  byDay = new Map<string, number[]>();
wind.forEach((w) => {
  const key = w.date.slice(0, 10);
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key)!.push(w.speed);
});
const candles = [...byDay].map(([date, v]) => ({
  x: Date.parse(date),
  open: v[0],
  close: v.at(-1)!,
  high: Math.max(...v),
  low: Math.min(...v),
}));
const sources = [...new Set(energy.links.map((l) => l.source))],
  sectors = [...new Set(energy.links.map((l) => l.target))];
const totals = sources.map((label) => ({
  label,
  value: energy.links.filter((l) => l.source === label).reduce((s, l) => s + l.value, 0),
}));
const hierarchy: c.HierarchyNode = {
  label: 'US energy',
  children: sources.map((source) => ({
    label: source,
    children: energy.links.filter((l) => l.source === source).map((l) => ({ label: l.target, value: l.value })),
  })),
};
const rose = c.windRoseBins(direction, speed),
  radial = rose.counts.map((r) => r.reduce((s, v) => s + v, 0));
const charts: [string, c.ExtraChart][] = [
  ['Hourly winds, direction-from and speed bins', c.windRoseChart(direction, speed, { percentage: true })],
  [
    'Directional observation counts',
    c.polarChart(
      radial.map((_, i) => (i * 360) / radial.length),
      radial,
      { close: true },
    ),
  ],
  [
    'Coal / gas / petroleum fractions by sector',
    c.ternaryChart(
      sectors.map(
        (s) =>
          sources
            .filter((x) => ['Coal', 'Natural gas', 'Petroleum'].includes(x))
            .map((x) => energy.links.find((l) => l.source === x && l.target === s)?.value ?? 0) as [
            number,
            number,
            number,
          ],
      ),
      { labels: sources.filter((x) => ['Coal', 'Natural gas', 'Petroleum'].includes(x)) as [string, string, string] },
    ),
  ],
  ['Daily wind speed OHLC, m/s', c.candlestickChart(candles, { dateAxis: true })],
  ['Daily wind speed ticks, m/s', c.ohlcChart(candles, { dateAxis: true })],
  ['Primary energy by source', c.pieChart(totals)],
  ['Primary energy shares', c.donutChart(totals)],
  ['Source and sector hierarchy', c.sunburstChart(hierarchy)],
  ['Source and sector areas', c.treemapChart(hierarchy)],
  [
    'US EIA primary source to sector, trillion Btu',
    c.sankeyChart(
      [...sources, ...sectors].map((id) => ({ id })),
      energy.links,
    ),
  ],
  [
    'Primary source / sector / end use',
    c.alluvialChart(
      energy.links.map((l) => ({
        stages: [l.source, l.target, l.target === 'Electric power' ? 'Electric power' : 'Direct end use'],
        value: l.value,
      })),
    ),
  ],
  [
    'Sector profiles, independent source scales',
    c.radarChart(
      sources.map((label) => ({ label })),
      sectors.map((label) => ({
        label,
        values: sources.map((s) => energy.links.find((l) => l.source === s && l.target === label)?.value ?? 0),
      })),
    ),
  ],
  [
    'Daily maximum wind speed, m/s',
    c.calendarHeatmap(
      [...byDay].map(([date, v]) => ({ date, value: Math.max(...v) })),
      { year: 2023 },
    ),
  ],
];
for (const [title, chart] of charts) {
  const section = document.createElement('section'),
    h = document.createElement('h2'),
    button = document.createElement('button');
  h.textContent = title;
  section.append(h);
  const svg = chart.toSVG({ title });
  section.insertAdjacentHTML('beforeend', svg);
  button.textContent = 'Download SVG';
  button.onclick = () => {
    const a = document.createElement('a'),
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.href = url;
    a.download = chart.kind.toLowerCase().replaceAll(' ', '-') + '.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  section.append(button);
  document.querySelector('main')!.append(section);
}
document.querySelector('#status')!.textContent =
  `13 charts; ${wind.length} NOAA winds; ${energy.links.length} EIA flows. All vector SVG.`;
