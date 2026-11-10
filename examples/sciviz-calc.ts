import { Figure } from '@margoengine/sciviz/spec';
import { calcGrid, calcGridGPU, type CalcOperation } from '@margoengine/sciviz/calc';
import { meshLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import { simplices } from '../packages/sciviz/src/cell-complex.js';
import { readBumpSlice } from './sciviz-contour-data.js';
import { element, fail } from './sciviz-demo.js';
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), { axes: false, controls: false });
const response = await fetch(new URL('./assets/sciviz/contour/bump.dat', import.meta.url));
if (!response.ok) throw new Error(`NASA HTTP ${response.status}`);
export const grid = readBumpSlice(await response.text());
figure.engine.camera.position = [0, 3.2, 0];
figure.engine.camera.target = [0, 0, 0];
figure.engine.camera.up = [0, 0, -1];
let layer: MeshLayer | undefined;
export let derived: Awaited<ReturnType<typeof calcGrid>>;
export async function show() {
  const gpu = await figure.renderer.compute(),
    useGPU = element<HTMLSelectElement>('backend').value === 'gpu';
  const run = (g: Parameters<typeof calcGrid>[0], op: CalcOperation) =>
    useGPU ? calcGridGPU(gpu, g, op) : calcGrid(g, op);
  const gradient = await run(grid, { kind: 'gradient' });
  derived = await run(
    { ...grid, cellArrays: { gradient: gradient.values } },
    { kind: 'expression', association: 'cell', expression: element<HTMLInputElement>('expression').value },
  );
  const positions: number[] = [],
    values: number[] = [],
    cells: number[] = [];
  for (const s of simplices(grid)) {
    for (const id of s.ids) {
      positions.push(grid.points[3 * id], grid.points[3 * id + 1], grid.points[3 * id + 2]);
      values.push(derived.values[s.cell * derived.width]);
    }
    cells.push(s.cell);
  }
  const normals = new Float32Array(positions.length);
  for (let k = 2; k < normals.length; k += 3) normals[k] = 1;
  const set = {
    positions: Float32Array.from(positions),
    normals,
    values: Float32Array.from(values),
    cells: Uint32Array.from(cells),
    bounds: [-1, 1, 0, 1, 0, 0] as const,
  };
  if (layer) figure.remove(layer);
  layer = meshLayer(figure, set, { colormap: 'aurora', range: [0, 10] });
  await figure.ready();
  figure.engine.render();
  element('status').textContent = `Ready. ${derived.values.length} cell values, ${useGPU ? 'GPU' : 'CPU'} calculator.`;
}
element('apply').addEventListener('click', () => void show().catch(fail));
element('backend').addEventListener('change', () => void show().catch(fail));
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
await show();
