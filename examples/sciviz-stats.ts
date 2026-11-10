import {
  errorBarChart,
  boxChart,
  violinChart,
  areaChart,
  stackedChart,
  stepChart,
  densityChart,
  hexbinChart,
  cdfChart,
  qqChart,
  trendChart,
  type StatisticalChart,
} from '@margoengine/sciviz/stats';
interface WeatherDay {
  date: string;
  month: number;
  tmin: number;
  tmax: number;
}
interface Exoplanet {
  pl_name: string;
  pl_orbper: number;
  pl_rade: number;
  pl_orbpererr1: number | null;
  pl_orbpererr2: number | null;
  pl_radeerr1: number | null;
  pl_radeerr2: number | null;
}
async function get<T>(name: string): Promise<T> {
  const r = await fetch(`./assets/sciviz/stats/${name}.json`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Statistics demo HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
const [weather, planets] = await Promise.all([get<WeatherDay[]>('ghcn'), get<Exoplanet[]>('exoplanets')]);
const days = weather.slice(0, 90),
  x = days.map((_, i) => i + 1),
  high = days.map((d) => d.tmax),
  low = days.map((d) => d.tmin);
const groups = Array.from({ length: 4 }, (_, i) => ({
  label: ['Winter', 'Spring', 'Summer', 'Autumn'][i],
  values: weather.filter((d) => Math.floor((d.month % 12) / 3) === i).map((d) => d.tmax),
}));
const complete = planets.filter((p) =>
  [p.pl_orbpererr1, p.pl_orbpererr2, p.pl_radeerr1, p.pl_radeerr2].every((v) => v !== null && Number.isFinite(v)),
);
const cards: [string, StatisticalChart, string, string][] = [
  [
    'Asymmetric x/y error bars',
    errorBarChart(
      complete.map((p) => p.pl_orbper),
      complete.map((p) => p.pl_rade),
      {
        xMinus: complete.map((p) => Math.abs(p.pl_orbpererr2!)),
        xPlus: complete.map((p) => p.pl_orbpererr1!),
        yMinus: complete.map((p) => Math.abs(p.pl_radeerr2!)),
        yPlus: complete.map((p) => p.pl_radeerr1!),
      },
    ),
    'Orbital period, days',
    'Radius, Earth radii',
  ],
  ['Seasonal box plots', boxChart(groups), 'Season', 'Daily maximum, C'],
  ['Seasonal violin plots', violinChart(groups), 'Season', 'Daily maximum, C'],
  ['Area', areaChart(x, high), 'Day of 2020', 'Daily maximum, C'],
  ['Stacked area: signed daily extrema', stackedChart(x, [low, high]), 'Day of 2020', 'Temperature contributions, C'],
  [
    'Stacked bars: signed daily extrema',
    stackedChart(x.slice(0, 20), [low.slice(0, 20), high.slice(0, 20)], { kind: 'bar' }),
    'Day of 2020',
    'Temperature contributions, C',
  ],
  ['Step line', stepChart(x, high), 'Day of 2020', 'Daily maximum, C'],
  [
    '2D density',
    densityChart(
      weather.map((d) => d.tmin),
      weather.map((d) => d.tmax),
    ),
    'Minimum, C',
    'Maximum, C',
  ],
  [
    'Hexagonal binning',
    hexbinChart(
      weather.map((d) => d.tmin),
      weather.map((d) => d.tmax),
      2,
    ),
    'Minimum, C',
    'Maximum, C',
  ],
  ['Empirical CDF', cdfChart(weather.map((d) => d.tmax)), 'Daily maximum, C', 'Cumulative probability'],
  [
    'Q-Q: daily minimum versus maximum',
    qqChart(
      weather.map((d) => d.tmax),
      weather.map((d) => d.tmin),
    ),
    'Minimum quantile, C',
    'Maximum quantile, C',
  ],
  ['Linear trend with 95% mean confidence band', trendChart(x, high), 'Day of 2020', 'Maximum, C'],
  [
    'Robust LOESS with approximate 95% mean band',
    trendChart(x, high, { method: 'loess', span: 0.5 }),
    'Day of 2020',
    'Maximum, C',
  ],
];
for (const [title, chart, xLabel, yLabel] of cards) {
  const section = document.createElement('section'),
    heading = document.createElement('h2'),
    button = document.createElement('button'),
    figure = document.createElement('div');
  heading.textContent = title;
  const svg = chart.toSVG({ title, xLabel, yLabel });
  figure.innerHTML = svg;
  button.textContent = 'Download SVG';
  button.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
      a = document.createElement('a');
    a.href = url;
    a.download = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.svg';
    a.click();
    URL.revokeObjectURL(url);
  });
  section.append(heading, figure, button);
  document.querySelector('main')!.append(section);
}
document.querySelector('#status')!.textContent =
  `${cards.length} charts; ${weather.length} paired GHCN days, ${planets.length} planet records, ${complete.length} with complete x/y uncertainties. Missing uncertainties are omitted from the error-bar chart.`;
