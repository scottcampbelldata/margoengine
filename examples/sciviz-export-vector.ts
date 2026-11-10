import { Figure } from '@margoengine/sciviz';
import { exportVector, type VectorExport } from '@margoengine/sciviz/export-vector';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { meshLayer } from '@margoengine/sciviz/grids';
import { readBumpSlice } from './sciviz-contour-data.js';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
export const figure = await Figure.create(canvas, { axes: false, controls: false, theme: 'light' });
export let result: VectorExport;
export async function show(dataset: string): Promise<VectorExport> {
  for (const layer of figure.layers) figure.remove(layer);
  if (dataset === 'head') {
    document.querySelector('#status')!.textContent = 'Loading OpenNeuro MRI...';
    const full = nrrdGrid(await loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url)));
    const dims = full.dims.map((n) => Math.floor((n - 1) / 8) + 1) as [number, number, number];
    const data = new Float32Array(dims[0] * dims[1] * dims[2]);
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++)
        for (let x = 0; x < dims[0]; x++)
          data[x + dims[0] * (y + dims[1] * z)] = full.data[x * 8 + full.dims[0] * (y * 8 + full.dims[1] * z * 8)];
    document.querySelector('#status')!.textContent = 'Extracting MRI surface...';
    await figure.isosurface(data, 300, { dims, color: '#84bbb3' });
  } else {
    const response = await fetch(new URL('./assets/sciviz/contour/bump.dat', import.meta.url));
    if (!response.ok) throw new TypeError(`NASA data HTTP ${response.status}`);
    const grid = readBumpSlice(await response.text()),
      p: number[] = [],
      values: number[] = [];
    for (let c = 0; c < grid.types.length; c++) {
      const start = c ? grid.offsets[c - 1] : 0,
        ids = Array.from({ length: grid.offsets[c] - start }, (_, k) => grid.connectivity[start + k]);
      for (let i = 1; i + 1 < ids.length; i++)
        for (const id of [ids[0], ids[i], ids[i + 1]]) {
          p.push(grid.points[id * 3], grid.points[id * 3 + 1], 0);
          values.push(grid.pointData![id]);
        }
    }
    const normals = new Float32Array(p.length);
    for (let i = 2; i < p.length; i += 3) normals[i] = 1;
    const xs = p.filter((_, i) => i % 3 === 0),
      ys = p.filter((_, i) => i % 3 === 1);
    meshLayer(
      figure,
      {
        positions: Float32Array.from(p),
        normals,
        values: Float32Array.from(values),
        cells: new Uint32Array(p.length / 9),
        bounds: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), 0, 0],
      },
      { range: [0, 40] },
    );
  }
  document.querySelector('#status')!.textContent = 'Writing vector figure...';
  result = await exportVector(figure, {
    maxTriangles: 50000,
    maxFragments: 250000,
    colorDepth: dataset === 'nasa' ? 1 : 2,
  });
  document.querySelector('#output')!.innerHTML = result.svg;
  document.querySelector('#status')!.textContent =
    `${dataset}: ${result.mode}, ${result.triangles} triangles, ${result.fragments} fragments${result.reason ? `, ${result.reason}` : ''}.`;
  return result;
}
let pending = Promise.resolve();
document.querySelector('#dataset')!.addEventListener('change', (event) => {
  pending = pending.then(() => show((event.target as HTMLSelectElement).value)).then(() => {});
});
document.querySelector('#save')!.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' })),
    a = document.createElement('a');
  a.href = url;
  a.download = 'scientific-figure.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
await show('head');
