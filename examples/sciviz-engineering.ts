import { Figure } from '@margoengine/sciviz';
import { readCGNS } from '@margoengine/sciviz/cgns';
import { readExodus } from '@margoengine/sciviz/exodus';
import { gridSurface, meshLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import type { DataSet } from '@margoengine/sciviz/datasets';
import { element, fail, signal } from './sciviz-demo.js';

export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), { axes: false, controls: false });
figure.engine.stop();
figure.engine.camera.position = [2, 1.8, 3];
figure.engine.camera.target = [0, 0, 0];
let layer: MeshLayer | undefined;
export let dataset: DataSet;
export async function show(format: string): Promise<void> {
  if (format !== 'cgns' && format !== 'exodus') throw new TypeError('Choose a listed engineering format');
  const path =
    '../packages/sciviz/tests/fixtures/engineering/' + (format === 'cgns' ? 'nasa-struct-hdf.cgns' : 'seacas-can.ex2');
  dataset = await (format === 'cgns' ? readCGNS : readExodus)(new URL(path, import.meta.url), {
    signal,
    scalar: format === 'exodus' ? 'EQPS' : undefined,
  });
  const grid = dataset.blocks?.[0] ?? dataset,
    box = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < grid.points.length; i++) {
    const d = i % 3;
    box[d * 2] = Math.min(box[d * 2], grid.points[i]);
    box[d * 2 + 1] = Math.max(box[d * 2 + 1], grid.points[i]);
  }
  const extent = Math.max(...[0, 1, 2].map((d) => box[d * 2 + 1] - box[d * 2])),
    points = Float64Array.from(
      grid.points,
      (v, i) => (2 * (v - (box[(i % 3) * 2] + box[(i % 3) * 2 + 1]) / 2)) / extent,
    ),
    pointData =
      format === 'cgns'
        ? Float64Array.from({ length: points.length / 3 }, (_, i) => grid.points[i * 3])
        : grid.pointData;
  const triangles = gridSurface({ ...grid, points, pointData });
  let lo = Infinity,
    hi = -Infinity;
  for (const v of triangles.values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (hi === lo) hi = lo + 1;
  layer?.dispose();
  layer = meshLayer(figure, triangles, { range: [lo, hi], colormap: 'viridis' });
  await figure.ready();
  figure.engine.render();
  element('status').textContent =
    `${format}: ${grid.points.length / 3} points, ${grid.types.length} cells, ${triangles.cells.length} surface triangles.`;
  element<HTMLCanvasElement>('viewport').dataset.ready = format;
}
let pending = Promise.resolve();
element('format').addEventListener('change', () => {
  pending = pending.then(() => show(element<HTMLSelectElement>('format').value)).catch(fail);
});
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
await show('cgns');
