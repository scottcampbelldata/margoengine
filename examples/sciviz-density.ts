import { Figure, type CreateFigureOptions } from '@margoengine/sciviz';
import { densityScatter } from '@margoengine/sciviz/density';
import { createFallbackFigure } from '@margoengine/sciviz/fallback';
import { readCSV } from '@margoengine/sciviz/table';
import { element } from './sciviz-demo.js';

const signal = AbortSignal.timeout(120000);
async function asset(name: string): Promise<Response> {
  const response = await fetch(new URL(`./assets/sciviz/${name}`, location.href), { signal });
  if (!response.ok) throw new TypeError(`Data HTTP ${response.status}: ${name}`);
  return response;
}
const fallback = new URLSearchParams(location.search).get('backend') === 'webgl2';
const compat = fallback ? await import('@margoengine/webgl2-compat') : undefined;
const create = fallback
  ? (c: HTMLCanvasElement, o: CreateFigureOptions) => createFallbackFigure(c, { ...o, compat: compat! })
  : Figure.create;
const starsData = new Float32Array(
  await new Response((await asset('stars.bin')).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
);
const n = starsData.length / 4,
  positions = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  positions[i * 3] = starsData[i];
  positions[i * 3 + 1] = starsData[n + i];
}
export const stars = await create(element<HTMLCanvasElement>('stars'), {
  mode: '2d',
  limits: [0, 360, -90, 90],
  titles: { x: 'RA (degrees)', y: 'Dec (degrees)' },
});
export const starDensity = densityScatter(stars, positions, { mode: 'kernel', bandwidth: 3, opacity: 0.12 });
export const table = readCSV(await (await asset('limits/taxi.csv')).text());
const taxiPositions = new Float32Array(table.length * 3);
for (let i = 0; i < table.length; i++) {
  taxiPositions[i * 3] = Number(table.value('pickup_longitude', i));
  taxiPositions[i * 3 + 1] = Number(table.value('pickup_latitude', i));
}
export const taxi = await create(element<HTMLCanvasElement>('taxi'), {
  mode: '2d',
  limits: [-74.05, -73.75, 40.6, 40.9],
  titles: { x: 'Longitude (degrees)', y: 'Latitude (degrees)' },
});
export const taxiDensity = densityScatter(taxi, taxiPositions, {
  mode: 'kernel',
  bandwidth: 3,
  opacity: 0.8,
  color: '#f0c36a',
});
export const exact = await taxiDensity.aggregate(table, {
  x: { column: 'pickup_longitude', bins: 32, range: [-75, -72] },
  y: { column: 'pickup_latitude', bins: 32, range: [40, 42] },
  value: 'total_amount',
  signal,
});
element('star-count').textContent = `${n.toLocaleString()} original sources; every visible source votes once.`;
element('taxi-count').textContent =
  `Exact table: ${exact.count.reduce((a, b) => a + b, 0).toLocaleString()} pick-ups; $${exact.sum.reduce((a, b) => a + b, 0).toFixed(2)} total charges. Zoomed view clips the geography; statistics retain the declared range.`;
const mode = element<HTMLSelectElement>('mode'),
  bandwidth = element<HTMLInputElement>('bandwidth');
function update(): void {
  const style = { mode: mode.value as 'count' | 'kernel', bandwidth: Number(bandwidth.value) };
  starDensity.setStyle(style);
  taxiDensity.setStyle(style);
  element('sigma').textContent = `${style.bandwidth} pixels`;
}
mode.addEventListener('change', update);
bandwidth.addEventListener('input', update);
await Promise.all([stars.ready(), taxi.ready()]);
element('status').textContent =
  `Ready. ${fallback ? 'WebGL2 compatibility' : 'WebGPU'}; no point budget. Screen opacity is a visual summary; exact bins remain separately available.`;
