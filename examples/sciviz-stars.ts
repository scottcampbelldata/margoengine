import type { RectsLayer, ScatterLayer } from '@margoengine/sciviz';
import { SelectionStore, bindSelection, type SelectionBinding } from '@margoengine/sciviz/link';
import { createFigure, element, exportButton, fail, floats } from './sciviz-demo.js';

// Public-domain 2MASS sample; exact provenance and query in assets/sciviz/stars.json.
export const figure = await createFigure(element<HTMLCanvasElement>('viewport'), {
  aspect: [1, 0.6, 0.45],
  pointBudget: 1_000_000,
  titles: { x: 'RA (deg)', y: 'Dec (deg)', z: 'J - Ks (mag)' },
});
export const histogram = await createFigure(element<HTMLCanvasElement>('histogram'), {
  mode: '2d',
  titles: { x: 'J - Ks (mag)', y: 'Sources' },
});
export const heatmap = await createFigure(element<HTMLCanvasElement>('heatmap'), {
  mode: '2d',
  titles: { x: 'J - Ks (mag)', y: 'Ks (mag)' },
});
export let cloud: ScatterLayer;
export let bars: RectsLayer;
export let selection: SelectionStore;
export let cloudBinding: SelectionBinding;
export let settled = Promise.resolve();
export let selected = 1_000_000;
const bindings: SelectionBinding[] = [];
figure.engine.camera.position = element('viewport').clientWidth < 600 ? [2.6, 1.7, 2.9] : [1.8, 1.2, 2];

try {
  const data = await floats(new URL('./assets/sciviz/stars.bin', import.meta.url));
  const n = data.length / 4,
    keys = Uint32Array.from({ length: n }, (_, i) => i);
  const x = data.subarray(0, n),
    y = data.subarray(n, 2 * n),
    colour = data.subarray(2 * n, 3 * n),
    magnitude = data.subarray(3 * n);
  selection = new SelectionStore(keys);
  const updateCloud = async () => {
    cloudBinding?.dispose();
    const next = await figure.scatter(
      { x, y, z: colour, color: colour },
      {
        size: 1.5,
        colormap: 'coolwarm',
        range: [0, 2],
        edl: element<HTMLInputElement>('edl').checked,
      },
    );
    cloud = cloud ? figure.replace(cloud, next) : next;
    cloudBinding = bindSelection(figure, cloud, selection, { rowIds: keys, source: 'sky', mode: 'fade' });
    await figure.ready();
  };
  await updateCloud();
  bars = await histogram.histogram(colour, { bins: 48, range: [-0.5, 3], color: '#9bd9d0' });
  const groups: number[][] = Array.from({ length: 48 }, () => []);
  const cells: number[][] = Array.from({ length: 48 * 48 }, () => []);
  for (let i = 0; i < n; i++) {
    if (colour[i] < -0.5 || colour[i] > 3) continue;
    const bin = Math.min(47, Math.floor(((colour[i] + 0.5) / 3.5) * 48));
    groups[bin].push(i);
    if (magnitude[i] >= 4 && magnitude[i] <= 16)
      cells[Math.min(47, Math.floor(((magnitude[i] - 4) / 12) * 48)) * 48 + bin].push(i);
  }
  bindings.push(bindSelection(histogram, bars, selection, { groups, source: 'colour-bin', mode: 'filter' }));
  const density = await heatmap.heatmap(
    Float32Array.from(cells, (cell) => cell.length),
    {
      nx: 48,
      ny: 48,
      x: [-0.5, 3],
      y: [4, 16],
      colormap: 'aurora',
      name: 'Colour against magnitude',
    },
  );
  bindings.push(
    bindSelection(heatmap, density, selection, { groups: cells, source: 'colour-magnitude-bin', mode: 'fade' }),
  );
  const update = () => {
    selected = selection.rowIds.length;
    for (let i = 0; i < groups.length; i++)
      bars.values[i] = groups[i].reduce((sum, key) => sum + Number(selection.has(key)), 0);
    element('status').textContent =
      `${selected.toLocaleString('en')} of ${n.toLocaleString('en')} sources selected. Shift toggles; Ctrl/Meta adds; Alt intersects. Click a histogram or heatmap bin to select its rows.`;
  };
  selection.subscribe(update);
  update();
  figure.colorbar('coolwarm', [0, 2], { label: 'J - Ks (mag)' });
  element('drag').addEventListener('change', () => {
    figure.dragMode = element<HTMLSelectElement>('drag').value as 'orbit' | 'box' | 'lasso';
  });
  element('edl').addEventListener('change', () => {
    settled = settled.then(updateCloud);
    void settled.catch(fail);
  });
  element('reset').addEventListener('click', () => selection.clear());
  element('undo').addEventListener('click', () => selection.undo());
  exportButton(figure, '2mass-star-catalogue');
  await Promise.all([histogram.ready(), heatmap.ready()]);
  element('viewport').dataset.ready = 'true';
} catch (error) {
  fail(error);
}
window.addEventListener(
  'pagehide',
  () => {
    cloudBinding?.dispose();
    for (const binding of bindings) binding.dispose();
    selection?.dispose();
    figure.dispose();
    histogram.dispose();
    heatmap.dispose();
  },
  { once: true },
);
