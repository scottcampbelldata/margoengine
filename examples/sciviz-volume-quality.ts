import { Figure } from '@margoengine/sciviz';
import { qualityVolume } from '@margoengine/sciviz/volume-quality';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { CellLocator, plotOverLine, linkProbePlot } from '@margoengine/sciviz/probe';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
export const grid = nrrdGrid(await loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url), { signal }));
export const figure = await Figure.create(element<HTMLCanvasElement>('volume'), {
  axes: false,
  aspect: [174 / 254, 1, 1],
});
export const chart = await Figure.create(element<HTMLCanvasElement>('profile'), {
  mode: '2d',
  controls: false,
  titles: { x: 'Distance (mm)', y: 'Original T1 intensity' },
});
figure.engine.camera.position = [1.6, 1.1, 1.9];
chart.engine.stop();
export const source = figure.volume(grid.data, {
  dims: grid.dims,
  bounds: grid.bounds,
  range: [0, 800],
  colormap: 'gray',
  density: 1,
  quality: 1.5,
  opacity: [
    [0, 0],
    [0.14, 0],
    [0.35, 0.04],
    [1, 0.2],
  ],
});
export const quality = qualityVolume(figure, source, { isovalue: 320, refinement: 16, color: [0.85, 0.9, 1] });
export const locator = await CellLocator.create(
  { dims: grid.dims, bounds: grid.bounds, pointData: grid.data },
  { signal },
);
const [x0, x1, y0, y1, z0, z1] = grid.bounds;
export const profile = await plotOverLine(
  locator,
  [x0 + (x1 - x0) * 0.1, (y0 + y1) / 2, (z0 + z1) / 2, x0 + (x1 - x0) * 0.9, (y0 + y1) / 2, (z0 + z1) / 2],
  { samples: 151, signal },
);
export const link = await linkProbePlot(figure, chart, profile);
function update(): void {
  const mode = element<HTMLSelectElement>('mode').value;
  source.mode = mode === 'mip' ? 'mip' : 'composite';
  quality.configure({
    isovalue: mode === 'iso' ? Number(element<HTMLInputElement>('iso').value) : undefined,
    refinement: 16,
    color: [0.85, 0.9, 1],
    emptySpaceSkipping: element<HTMLInputElement>('skip').checked,
    jitter: element<HTMLInputElement>('jitter').checked,
    adaptive: element<HTMLInputElement>('adaptive').checked ? {} : false,
  });
}
for (const id of ['mode', 'iso', 'skip', 'jitter', 'adaptive']) element(id).addEventListener('input', update);
await Promise.all([figure.ready(), chart.ready()]);
figure.engine.render();
chart.engine.render();
element('status').textContent =
  `Ready. ${grid.dims.join(' x ')} real T1 samples, ${profile.valid.reduce((a, b) => a + b, 0)} valid interior probe samples. Refined isosurfaces write depth; compositing ends at opaque scene depth.`;
window.addEventListener(
  'pagehide',
  () => {
    link.dispose();
    locator.dispose();
    chart.dispose();
    figure.dispose();
  },
  { once: true },
);
