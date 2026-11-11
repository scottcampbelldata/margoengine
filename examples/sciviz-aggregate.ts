import { Figure } from '@margoengine/sciviz';
import { ColumnarTable } from '@margoengine/sciviz/table';
import { bindRasterAggregate, type RasterBinding } from '@margoengine/sciviz/aggregate';
import { createCompute } from '@margoengine/compute';

const canvas = document.querySelector<HTMLCanvasElement>('#plot')!,
  status = document.querySelector<HTMLElement>('#status')!;
export const figure = await Figure.create(canvas, {
  mode: '2d',
  theme: 'light',
  titles: { x: 'Longitude', y: 'Latitude' },
});
export const gpu = await createCompute({ engine: figure.engine });
const data = '/packages/sciviz/tests/fixtures/aggregate/';
const [taxi, cc0, ccby] = await Promise.all(
  ['tlc-pickups.json', 'gbif-CC0_1_0.json', 'gbif-CC_BY_4_0.json'].map(async (name) =>
    (await fetch(data + name)).json(),
  ),
);
export const tables = {
  tlc: new ColumnarTable({
    x: Float64Array.from(taxi, (v: Record<string, string>) => Number(v.pickup_longitude)),
    y: Float64Array.from(taxi, (v: Record<string, string>) => Number(v.pickup_latitude)),
    value: Float64Array.from(taxi, (v: Record<string, string>) => Number(v.fare_amount)),
    category: {
      values: Uint32Array.from(taxi, (v: Record<string, string>) => (Number(v.payment_type) === 1 ? 0 : 1)),
      categories: ['Card', 'Other payment'],
    },
  }),
  gbif: new ColumnarTable({
    x: Float64Array.from([...cc0, ...ccby], (v) => v.decimalLongitude),
    y: Float64Array.from([...cc0, ...ccby], (v) => v.decimalLatitude),
    value: Float64Array.from([...cc0, ...ccby], (v) => v.year ?? NaN),
    category: {
      values: Uint32Array.from([...cc0, ...ccby], (_, i) => (i < cc0.length ? 0 : 1)),
      categories: ['CC0', 'CC BY 4.0'],
    },
  }),
};
export const bounds = { tlc: [-74.1, -73.7, 40.6, 40.9], gbif: [-180, 180, -90, 90] } as const;
export let binding: RasterBinding;
let current: keyof typeof tables = 'tlc';
export async function show(name: keyof typeof tables): Promise<void> {
  binding?.dispose();
  current = name;
  binding = await bindRasterAggregate(figure, tables[name], {
    columns: { x: 'x', y: 'y' },
    value: 'value',
    category: 'category',
    width: 48,
    height: 32,
    bounds: bounds[name],
    gpu,
    shade: { transform: 'eq-hist' },
    name: name === 'tlc' ? 'Taxi pick-ups' : 'GBIF occurrences',
  });
  status.textContent = `${tables[name].length.toLocaleString()} original rows. ${binding.result!.count.reduce((a, b) => a + b, 0).toLocaleString()} points in this view. GPU bins and exact numeric reductions.`;
  status.dataset.ready = 'true';
}
await show('tlc');
document.querySelector<HTMLSelectElement>('#dataset')!.addEventListener('change', (event) => {
  void show((event.target as HTMLSelectElement).value as keyof typeof tables).catch((cause) => {
    status.textContent = String(cause);
  });
});
const shade = () =>
  binding.shade({
    transform: document.querySelector<HTMLSelectElement>('#shade')!.value as 'linear' | 'log' | 'cbrt' | 'eq-hist',
    spread: Number(document.querySelector<HTMLSelectElement>('#spread')!.value),
  });
document.querySelector('#shade')!.addEventListener('change', shade);
document.querySelector('#spread')!.addEventListener('change', shade);
document.querySelector('#reset')!.addEventListener('click', () => {
  figure.setLimits(bounds[current]);
  void binding.refresh();
});
