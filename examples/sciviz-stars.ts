// 2MASS published RA, Dec, J-Ks and Ks, stored as four float32 columns in a local gzip.
import { Figure, type RectsLayer, type ScatterLayer } from '@margoengine/sciviz';
import { element, exportButton, fail, floats } from './sciviz-demo.js';

export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  aspect: [1, 0.6, 0.45],
  pointBudget: 1_000_000,
  titles: { x: 'RA (deg)', y: 'Dec (deg)', z: 'J - Ks (mag)' },
});
export const histogram = await Figure.create(element<HTMLCanvasElement>('histogram'), {
  mode: '2d',
  titles: { x: 'J - Ks (mag)', y: 'Sources' },
});
export let cloud: ScatterLayer;
export let bars: RectsLayer;
export let settled = Promise.resolve();
export let selected = 1_000_000;
figure.engine.camera.position = element('viewport').clientWidth < 600 ? [2.6, 1.7, 2.9] : [1.8, 1.2, 2];

try {
  const data = await floats(new URL('./assets/sciviz/stars.bin', import.meta.url));
  const n = data.length / 4;
  const x = data.subarray(0, n),
    y = data.subarray(n, 2 * n);
  const colour = data.subarray(2 * n, 3 * n);
  const updateCloud = async () => {
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
    await figure.ready();
  };
  const updateHistogram = async (indices?: Uint32Array) => {
    selected = indices?.length ?? n;
    const values = indices ? Float32Array.from(indices, (i) => colour[i]) : colour;
    // Fixed edges make selections comparable. Values outside this display range are excluded.
    if (!values.length) {
      if (bars) bars.visible = false;
    } else {
      const next = await histogram.histogram(values, { bins: 48, range: [-0.5, 3], color: '#9bd9d0' });
      bars = bars ? histogram.replace(bars, next) : next;
    }
    element('status').textContent =
      `${selected.toLocaleString('en')} of ${n.toLocaleString('en')} sources selected. Histogram shows J - Ks from -0.5 to 3 mag.`;
    await histogram.ready();
  };
  await updateCloud();
  await updateHistogram();
  figure.colorbar('coolwarm', [0, 2], { label: 'J - Ks (mag)' });
  figure.addEventListener('selection', (event) => {
    const indices = event.detail.points.find((p) => p.layer === cloud)?.indices ?? new Uint32Array();
    settled = settled.then(() => updateHistogram(indices));
    void settled.catch(fail);
  });
  element('drag').addEventListener('change', () => {
    figure.dragMode = element<HTMLSelectElement>('drag').value as 'orbit' | 'box' | 'lasso';
  });
  element('edl').addEventListener('change', () => {
    settled = settled.then(updateCloud);
    void settled.catch(fail);
  });
  element('reset').addEventListener('click', () => {
    settled = settled.then(() => updateHistogram());
    void settled.catch(fail);
  });
  exportButton(figure, '2mass-star-catalogue');
  element('viewport').dataset.ready = 'true';
} catch (error) {
  fail(error);
}
window.addEventListener(
  'pagehide',
  () => {
    figure.dispose();
    histogram.dispose();
  },
  { once: true },
);
