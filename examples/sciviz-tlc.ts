import { Figure } from '@margoengine/sciviz';
import { createCompute } from '@margoengine/compute';
import { loadTable, CrossFilter, bindTableAggregate } from '@margoengine/sciviz/table';

const status = document.querySelector<HTMLElement>('#status')!;
export const table = await loadTable('/packages/sciviz/tests/fixtures/table/tlc-trips.parquet');
export const filter = new CrossFilter(table), distance = filter.dimension('trip_distance');
export const histogram = await Figure.create(document.querySelector<HTMLCanvasElement>('#histogram')!, { mode: '2d' });
export const heatmap = await Figure.create(document.querySelector<HTMLCanvasElement>('#heatmap')!, { mode: '2d' });
export const gpu = await createCompute({ device: histogram.renderer.device! });
const x = { column: 'trip_distance', bins: 20, range: [0, 20] as const };
export const bars = bindTableAggregate(filter, histogram, { x, gpu, kind: 'histogram' });
export const cells = bindTableAggregate(filter, heatmap, { x, y: { column: 'fare_amount', bins: 24, range: [0, 120] }, gpu, kind: 'heatmap' });
export async function update(maximum: number): Promise<void> {
  distance.filterRange(0, maximum);
  await Promise.all([bars.refresh(), cells.refresh()]);
  await Promise.all([histogram.ready(), heatmap.ready()]); histogram.render(); heatmap.render();
  status.textContent = `${filter.count.toLocaleString()} of ${table.length.toLocaleString()} trips pass. Counts are GPU reductions; nulls and out-of-chart values are excluded from their bins.`;
}
await update(20);
document.querySelector<HTMLInputElement>('#range')!.addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value); document.querySelector<HTMLOutputElement>('#distance')!.value = String(value);
  void update(value).catch((error: unknown) => { status.textContent = String(error); });
});
status.dataset.ready = 'true';
addEventListener('pagehide', () => { bars.dispose(); cells.dispose(); distance.dispose(); filter.dispose(); gpu.dispose(); histogram.dispose(); heatmap.dispose(); }, { once: true });
