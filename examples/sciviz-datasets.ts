import { Figure } from '@margoengine/sciviz';
import { openDataSet, type DataSet } from '@margoengine/sciviz/datasets';
import { meshLayer, type MeshLayer, type TriangleSet } from '@margoengine/sciviz/grids';
import { element, fail, signal } from './sciviz-demo.js';

export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), { axes: false, controls: false });
figure.engine.stop();
figure.engine.camera.position = [0, 3.2, 0];
figure.engine.camera.target = [0, 0, 0];
figure.engine.camera.up = [0, 0, -1];
export let dataset: DataSet;
let layer: MeshLayer | undefined;

function surface(grid: DataSet): TriangleSet {
  const positions: number[] = [],
    values: number[] = [],
    cells: number[] = [],
    bounds = [Infinity, -Infinity, Infinity, -Infinity, 0, 0];
  for (let c = 0; c < grid.types.length; c++) {
    const start = c ? grid.offsets[c - 1] : 0,
      ids = Array.from({ length: grid.offsets[c] - start }, (_, k) => grid.connectivity[start + k]);
    if (grid.types[c] !== 9 && grid.types[c] !== 5) throw new TypeError('Demo expects the original NASA surface grid');
    for (let t = 1; t < ids.length - 1; t++) {
      for (const id of [ids[0], ids[t], ids[t + 1]]) {
        for (let a = 0; a < 3; a++) {
          const v = grid.points[3 * id + a];
          positions.push(v);
          bounds[2 * a] = Math.min(bounds[2 * a], v);
          bounds[2 * a + 1] = Math.max(bounds[2 * a + 1], v);
        }
        values.push(grid.points[3 * id]);
      }
      cells.push(c);
    }
  }
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return {
    positions: Float32Array.from(positions),
    normals,
    values: Float32Array.from(values),
    cells: Uint32Array.from(cells),
    bounds: bounds as TriangleSet['bounds'],
  };
}

export async function show(format: string): Promise<void> {
  const original = format === 'plot3d',
    name = original ? 'flatplate_clust2_4levelsdown_35x25.p2dfmt' : `flatplate.${format}`;
  if (!['plot3d', 'vts', 'vtr', 'vtm'].includes(format)) throw new TypeError('Choose a listed dataset format');
  dataset = await openDataSet(new URL(`./assets/sciviz/datasets/${name}`, import.meta.url), {
    signal,
    ...(original ? { format: 'plot3d' as const, plot3d: { dimensions: 2 as const } } : {}),
  });
  // The composite intentionally contains both exact and projected views of the same surface; show its exact block.
  const grid = format === 'vtm' ? dataset.blocks![1]! : dataset;
  const triangles = surface(grid);
  if (layer) layer.update(triangles);
  else layer = meshLayer(figure, triangles, { range: [-0.5, 2], colormap: 'viridis' });
  await figure.ready();
  figure.engine.render();
  element('status').textContent =
    `${format}: ${grid.points.length / 3} points, ${grid.types.length} cells; ${dataset.kind}.`;
  element<HTMLCanvasElement>('viewport').dataset.ready = format;
}
let pending = Promise.resolve();
element('format').addEventListener('change', () => {
  pending = pending.then(() => show(element<HTMLSelectElement>('format').value)).catch(fail);
});
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
await show('plot3d');
