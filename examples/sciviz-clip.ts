import { Figure } from '@margoengine/sciviz';
import { thresholdGrid, clipGrid, type AnalysisImage, type AnalysisGrid } from '@margoengine/sciviz/clip';
import { gridSurface, meshLayer, type MeshLayer, type TriangleSet } from '@margoengine/sciviz/grids';
import { readBumpSlice } from './sciviz-contour-data.js';
import { element, fail } from './sciviz-demo.js';

async function fetchAsset(path: string): Promise<Response> {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new TypeError(`Scientific data HTTP ${response.status}`);
  return response;
}
const meta = await (await fetchAsset('./assets/sciviz/clip/source.json')).json();
const bytes = await (await fetchAsset('./assets/sciviz/clip/ct-org-0-samples.bin')).arrayBuffer(), view = new DataView(bytes);
export const image: AnalysisImage = { dims: meta.dims, bounds: meta.bounds,
  pointData: Float64Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(2 * i, true) * meta.slope + meta.intercept) };
export const grid = readBumpSlice(await (await fetchAsset('./assets/sciviz/contour/bump.dat')).text());
export const ct = await Figure.create(element<HTMLCanvasElement>('ct'), { axes: false, controls: false });
export const nasa = await Figure.create(element<HTMLCanvasElement>('nasa'), { axes: false, controls: false });
ct.engine.stop(); nasa.engine.stop();
ct.engine.camera.position = [1.8, 1.4, 2.0];
nasa.engine.camera.position = [0, 3.2, 0];
nasa.engine.camera.target = [0, 0, 0];
nasa.engine.camera.up = [0, 0, -1];
let ctLayer: MeshLayer | undefined;
export let selected: AnalysisGrid;
export const clipped = await clipGrid(grid, { kind: 'plane', normal: [0, 1, 0], offset: -0.08 }, { invert: true });

// Surface-cell adapter: the filter already returns individual triangles; preserve its values and cell provenance.
const positions: number[] = [], values: number[] = [], cells: number[] = [];
for (let c = 0; c < clipped.types.length; c++) {
  for (let k = c ? clipped.offsets[c - 1] : 0; k < clipped.offsets[c]; k++) {
    const id = clipped.connectivity[k]; positions.push(clipped.points[3 * id], clipped.points[3 * id + 1], clipped.points[3 * id + 2]); values.push(clipped.pointData![id]);
  }
  cells.push(clipped.sourceCells![c]);
}
const normals = new Float32Array(positions.length); for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
for (let i = 0; i < positions.length; i++) { const a = i % 3; bounds[2 * a] = Math.min(bounds[2 * a], positions[i]); bounds[2 * a + 1] = Math.max(bounds[2 * a + 1], positions[i]); }
const set: TriangleSet = { positions: new Float32Array(positions), normals, values: new Float32Array(values), cells: new Uint32Array(cells), bounds: bounds as unknown as TriangleSet['bounds'] };
meshLayer(nasa, set, { range: [0, 40], colormap: 'viridis' }); await nasa.ready(); nasa.engine.render();
export async function setThreshold(lower = 300): Promise<void> {
  selected = await thresholdGrid(image, [lower, 3000], { mode: 'any' });
  const cellData = Float64Array.from({ length: selected.types.length }, (_, c) => {
    let maximum = -Infinity;
    for (let k = c ? selected.offsets[c - 1] : 0; k < selected.offsets[c]; k++) maximum = Math.max(maximum, selected.pointData![selected.connectivity[k]]);
    return maximum;
  });
  const set = gridSurface({ ...selected, cellData }, { values: 'cell' });
  if (ctLayer) ctLayer.update(set); else ctLayer = meshLayer(ct, set, { range: [150, 1500], colormap: 'viridis' });
  await ct.ready(); ct.engine.render();
  element('status').textContent = `CT ${selected.types.length} retained cells at ${lower} to 3000 HU. NASA ${clipped.types.length} cut triangles; all point and cell arrays retained.`;
}
let pending = Promise.resolve();
element('threshold').addEventListener('change', () => { pending = pending.then(() => setThreshold(Number(element<HTMLInputElement>('threshold').value))).catch(fail); });
window.addEventListener('pagehide', () => { ct.dispose(); nasa.dispose(); }, { once: true });
await setThreshold();
