import {
  colormapNames,
  colorScale,
  tolPalette,
  encodingLegend,
  type ColormapName,
} from '@margoengine/sciviz/colormaps';
import { createFigure, element, floats, fail, exportButton } from './sciviz-demo.js';

export const ocean = await createFigure(element<HTMLCanvasElement>('ocean'), {
  mode: '2d',
  titles: { x: 'Longitude (deg)', y: 'Latitude (deg)' },
});
export const stars = await createFigure(element<HTMLCanvasElement>('stars'), {
  mode: '2d',
  titles: { x: 'J - Ks (mag)', y: 'Ks (mag)' },
});
const select = element<HTMLSelectElement>('map'),
  scale = element<HTMLSelectElement>('scale');
for (const name of colormapNames) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  select.append(o);
}
select.value = 'lab-linear-blue-yellow';
const [field, points] = await Promise.all([
  fetch('./assets/sciviz/contour2d/oisst.json', { signal: AbortSignal.timeout(60000) }).then((r) => {
    if (!r.ok) throw new Error(`OISST HTTP ${r.status}`);
    return r.json();
  }),
  floats(new URL('./assets/sciviz/stars.bin', import.meta.url)),
]);
const n = points.length / 4,
  count = Math.min(n, 20000),
  colors = points.slice(2 * n, 2 * n + count),
  magnitudes = points.slice(3 * n, 3 * n + count);
const palette = tolPalette('high-contrast');
let layer: Awaited<ReturnType<typeof ocean.heatmap>> | undefined;
let bar: ReturnType<typeof ocean.colorbar> | undefined;
export async function redraw(): Promise<void> {
  const map = colorScale(select.value as ColormapName, {
    domain: [-2, 35],
    scale: scale.value === 'symlog' ? 'symlog' : 'linear',
    constant: 2,
    boundaries: scale.value === 'bins' ? [-2, 0, 5, 10, 15, 20, 25, 30, 35] : undefined,
    nan: '#777777',
    under: '#221144',
    over: '#fff4a3',
  });
  const next = await ocean.heatmap(
    field.values.map((v: number | null) => (v === null ? NaN : v)),
    {
      nx: field.x.length,
      ny: field.y.length,
      x: [field.x[0], field.x.at(-1)],
      y: [field.y[0], field.y.at(-1)],
      colormap: map,
      range: [-2, 35],
    },
  );
  layer = layer ? ocean.replace(layer, next) : next;
  bar?.dispose();
  bar = ocean.colorbar(map, [-2, 35], { label: 'SST (Celsius)' });
  await ocean.ready();
  element('status').textContent =
    `${field.values.length} OISST cells, ${count} 2MASS sources. ${select.value}; ${scale.value}.`;
}
await stars.scatter(
  { x: colors, y: magnitudes, color: colors, size: Float32Array.from(magnitudes, (v) => (v < 8 ? 4 : v < 12 ? 2 : 1)) },
  {
    size: 2,
    colormap: colorScale('lab-diverging-blue-red', { domain: [-0.5, 3], scale: 'symlog', constant: 0.2 }),
    range: [-0.5, 3],
    shape: 'round',
  },
);
await stars.scatter(
  { x: [colors[0]], y: [magnitudes[0]] },
  { size: 10, color: '#ddaa33', shape: 'square', name: 'First catalogue source' },
);
encodingLegend(
  stars,
  [
    { name: 'Ks < 8', shape: 'dot', size: 8, color: '#e3eaf3' },
    { name: '8 <= Ks < 12', shape: 'dot', size: 4, color: '#e3eaf3' },
    { name: 'Ks >= 12', shape: 'dot', size: 2, color: '#e3eaf3' },
    {
      name: 'First source',
      shape: 'square',
      size: 10,
      color: `rgb(${palette[1].map((v) => Math.round(v * 255)).join(' ')})`,
    },
  ],
  { title: 'Source size and shape', position: 'top-right' },
);
export let settled = redraw();
await settled;
await stars.ready();
for (const control of [select, scale])
  control.addEventListener('change', () => {
    settled = settled.then(redraw);
    void settled.catch(fail);
  });
// The shared export helper uses id=export and keeps the full colour legend.
exportButton(ocean, 'oisst-colour-encoding');
element('ocean').dataset.ready = 'true';
element('stars').dataset.ready = 'true';
window.addEventListener(
  'pagehide',
  () => {
    ocean.dispose();
    stars.dispose();
  },
  { once: true },
);
