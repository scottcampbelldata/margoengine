import { createCompute } from '@margoengine/compute';
import { ColumnarTable } from '@margoengine/sciviz/table';
import { SelectionStore } from '@margoengine/sciviz/link';
import { parallelCoordinates, scatterMatrix } from '@margoengine/sciviz/parcoords';

const source = await (await fetch('/examples/assets/sciviz/stats/exoplanets.json')).json() as { pl_name: string; pl_orbper: number; pl_rade: number; pl_orbpererr1: number | null }[];
export const table = new ColumnarTable({ period: Float64Array.from(source, (v) => v.pl_orbper), radius: Float64Array.from(source, (v) => v.pl_rade), uncertainty: Float64Array.from(source, (v) => v.pl_orbpererr1 ?? NaN) });
export const selection = new SelectionStore(source.map((v) => v.pl_name));
const options = { axes: [{ column: 'period', label: 'Period (days)', scale: 'log' as const }, { column: 'radius', label: 'Radius (Earth radii)' }, { column: 'uncertainty', label: 'Period uncertainty (days)' }], selection, rowIds: source.map((v) => v.pl_name) };
export const parallel = await parallelCoordinates(document.querySelector<HTMLCanvasElement>('#parallel')!, table, options);
export const matrix = await scatterMatrix(document.querySelector<HTMLCanvasElement>('#matrix')!, table, options);
export const controls = parallel.controls(document.querySelector<HTMLElement>('#controls')!);
export const gpu = await createCompute({ device: parallel.figure.renderer.device! });
const status = document.querySelector<HTMLElement>('#status')!;
const refresh = () => { status.textContent = `${selection.rowIds.length} of ${source.length} planets selected. Every cell uses the same physical column scale.`; };
selection.addEventListener('change', refresh); refresh();
let density = false;
document.querySelector<HTMLButtonElement>('#density')!.addEventListener('click', () => {
  density = !density;
  if (density) void parallel.density({ gpu }).catch((error: unknown) => { status.textContent = String(error); }); else parallel.lines();
  document.querySelector<HTMLButtonElement>('#density')!.textContent = density ? 'Show individual lines' : 'Show pixel density';
});
document.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', () => selection.clear());
document.querySelector<HTMLButtonElement>('#undo')!.addEventListener('click', () => selection.undo());
await Promise.all([parallel.ready(), matrix.ready()]); status.dataset.ready = 'true';
addEventListener('pagehide', () => { controls.dispose(); parallel.dispose(); matrix.dispose(); gpu.dispose(); selection.dispose(); }, { once: true });
