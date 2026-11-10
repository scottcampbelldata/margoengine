import { polishFigure } from '@margoengine/sciviz/format';
import { bandScale, jitterCategories, imageTrace, dendrogramHeatmap } from '@margoengine/sciviz/categorical';
import { createFigure, element } from './sciviz-demo.js';
const data = (await fetch('./assets/sciviz/stats/ghcn.json').then((r) => r.json())) as {
  date: string;
  month: number;
  tmax: number;
  tmin: number;
}[];
const dates = data.map((r) => Date.parse(r.date)),
  tmax = data.map((r) => r.tmax),
  tmin = data.map((r) => r.tmin),
  margin = { top: 35, right: 95, bottom: 55, left: 65 };
const figure = await createFigure(element<HTMLCanvasElement>('primary'), {
  mode: '2d',
  theme: 'light',
  scale: { x: 'date' },
  margin,
  tooltips: false,
});
const existing = await figure.line({ x: dates, y: tmax }, { name: 'Maximum °C', color: '#b95d41' });
const chart = await polishFigure(figure, {
  x: { domain: [dates[0], dates.at(-1)!] },
  y: { domain: [-15, 40] },
  secondaryY: { domain: [0, 110], label: 'Minimum °F', format: { mode: 'fixed', digits: 0 } },
  xFormat: { mode: 'date', date: { month: 'short', year: undefined, day: undefined } },
  yLabel: 'Maximum °C',
  xLabel: '2020, UTC',
  tooltip: '{name}: {x:date} / {y:fixed.1}',
});
const secondary = await chart.line(
  { x: dates, y: tmin.map((v) => 32 + 1.8 * v) },
  { name: 'Minimum °F', color: '#277da8', secondary: true },
);
chart.rangeSelector([
  { label: '30 days', span: 30 * 86400000 },
  { label: '90 days', span: 90 * 86400000 },
]);
const insetFigure = await createFigure(element<HTMLCanvasElement>('inset'), {
  mode: '2d',
  theme: 'light',
  margin: { top: 20, right: 15, bottom: 38, left: 40 },
  tooltips: false,
  legend: false,
});
const inset = await polishFigure(insetFigure, {
  x: { domain: [0, 30] },
  y: { domain: [-10, 20] },
  xLabel: 'January day',
  yLabel: '°C',
  minor: 1,
});
await inset.line({ x: data.slice(0, 31).map((_, i) => i), y: tmax.slice(0, 31) }, { color: '#b95d41' });
chart.addInset(inset, [0.56, 0.08, 0.36, 0.42]);
const brokenFigure = await createFigure(element<HTMLCanvasElement>('broken'), {
  mode: '2d',
  theme: 'light',
  margin,
  tooltips: false,
});
const broken = await polishFigure(brokenFigure, {
  x: { domain: [dates[0], dates.at(-1)!], breaks: [[Date.UTC(2020, 3, 1), Date.UTC(2020, 7, 1)]] },
  y: { domain: [-15, 40], breaks: [[10, 20]] },
  xFormat: { mode: 'date', date: { month: 'short', year: undefined, day: undefined } },
  yLabel: '°C',
  xLabel: '2020 with omitted summer',
});
await broken.line({ x: dates, y: tmax }, { name: 'Maximum °C', color: '#b95d41' });
const labels = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2020, i, 1)).toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
  ),
  bands = bandScale(labels, { range: [0, 12] }),
  catFigure = await createFigure(element<HTMLCanvasElement>('categories'), {
    mode: '2d',
    theme: 'light',
    margin,
    tooltips: false,
  }),
  categories = await polishFigure(catFigure, {
    categories: { x: labels },
    y: { domain: [-15, 40] },
    xLabel: 'Month',
    yLabel: 'Maximum °C',
  });
await categories.scatter(
  {
    x: jitterCategories(
      data.map((r) => labels[r.month - 1]),
      bands,
      { seed: 2020 },
    ),
    y: tmax,
  },
  { name: 'GHCN daily maxima', color: '#277da8', size: 5 },
);
const imageFigure = await createFigure(element<HTMLCanvasElement>('image'), {
    mode: '2d',
    theme: 'light',
    margin,
    axes: false,
  }),
  rgb = new Uint8Array(12 * 31 * 3);
rgb.fill(225);
for (const r of data) {
  const k = ((r.month - 1) * 31 + Number(r.date.slice(8)) - 1) * 3,
    u = (r.tmax + 15) / 55;
  rgb[k] = Math.round(40 + 200 * u);
  rgb[k + 1] = Math.round(180 - 80 * u);
  rgb[k + 2] = Math.round(240 - 180 * u);
}
const image = imageTrace(imageFigure, { data: rgb, width: 31, height: 12 }, { name: 'RGB daily maxima' });
const clusterFigure = await createFigure(element<HTMLCanvasElement>('cluster'), {
    mode: '2d',
    theme: 'light',
    margin,
    axes: false,
  }),
  matrix = Array.from({ length: 12 }, (_, m) =>
    Array.from(
      { length: 28 },
      (_, d) => data.find((r) => r.month === m + 1 && Number(r.date.slice(8)) === d + 1)!.tmax,
    ),
  ),
  cluster = dendrogramHeatmap(clusterFigure, matrix, { name: 'GHCN monthly temperature profiles' });
for (const f of [figure, insetFigure, brokenFigure, catFigure, imageFigure, clusterFigure]) await f.ready();
element('download').addEventListener('click', () => {
  void chart.toSVG().then((svg) => {
    const a = document.createElement('a'),
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.href = url;
    a.download = 'ghcn-chart-polish.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
});
Object.assign(window, {
  chartPolishDemo: {
    chart,
    figure,
    existing,
    secondary,
    broken,
    categories,
    imageFigure,
    image,
    clusterFigure,
    cluster,
    inset,
  },
});
element('status').textContent =
  `Ready: ${data.length} GHCN days; independent axes, breaks, inset, bands, RGB and two dendrograms.`;
