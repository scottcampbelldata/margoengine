import { Figure } from '@margoengine/sciviz/spec';
import { contourGrid, contourGridGPU, type GridContours } from '@margoengine/sciviz/contour';
import { meshLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import { readBumpSlice } from './sciviz-contour-data.js';
import { element, fail } from './sciviz-demo.js';

export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), { axes: false, controls: false });
const response = await fetch(new URL('./assets/sciviz/contour/bump.dat', import.meta.url));
if (!response.ok) throw new TypeError(`NASA solution HTTP ${response.status}`);
export const grid = readBumpSlice(await response.text());
export const levels = [0.1, 1, 5, 10, 20, 40];
let layer: MeshLayer | undefined;
export let result: GridContours;

export async function show(multiplier = 1, gpu = true): Promise<void> {
  const isos = levels.map(v => v * multiplier);
  result = gpu ? await contourGridGPU(await figure.renderer.compute(), grid, isos) : await contourGrid(grid, isos);
  // Draw independent isolines as narrow data-space ribbons in the existing mesh renderer.
  const p: number[] = [], v: number[] = [], cells: number[] = [];
  for (let i = 0; i < result.lines.positions.length; i += 6) {
    const a = Array.from(result.lines.positions.subarray(i, i + 3)), b = Array.from(result.lines.positions.subarray(i + 3, i + 6));
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const width = 0.0002, offset = [-dy / length * width, dx / length * width, 0];
    const corners = [a.map((x,k)=>x+offset[k]), a.map((x,k)=>x-offset[k]), b.map((x,k)=>x-offset[k]), b.map((x,k)=>x+offset[k])];
    for (const k of [0,1,2,0,2,3]) { p.push(...corners[k]); v.push(result.lines.values[i / 3]); }
    cells.push(result.lines.cells[i / 6], result.lines.cells[i / 6]);
  }
  const normals = new Float32Array(p.length); for (let i = 2; i < p.length; i += 3) normals[i] = 1;
  const set = { positions: new Float32Array(p), normals, values: new Float32Array(v), cells: new Uint32Array(cells), bounds: result.lines.bounds };
  if (layer) layer.update(set); else layer = meshLayer(figure, set, { range: [0, 40], colormap: 'aurora' });
  await figure.ready(); figure.engine.render();
  element('status').textContent = `${gpu ? 'GPU' : 'CPU'}: ${result.lines.cells.length} segments, ${isos.length} levels. Absolute coordinate bound ${result.floatBound.toExponential(2)}.`;
}
let pending = Promise.resolve();
for (const id of ['level', 'backend']) element(id).addEventListener('change', () => {
  pending = pending.then(() => show(Number(element<HTMLInputElement>('level').value), element<HTMLSelectElement>('backend').value === 'gpu')).catch(fail);
});
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
await show();
