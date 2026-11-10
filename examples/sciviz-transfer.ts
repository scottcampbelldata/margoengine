import { Figure } from '@margoengine/sciviz';
import {
  transferPreset,
  transferHistogram,
  TransferFunction,
  preintegrateTransfer,
  transferEditor,
} from '@margoengine/sciviz/transfer';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
async function load(path: string): Promise<Response> {
  const r = await fetch(new URL(path, import.meta.url), { signal });
  if (!r.ok) throw new TypeError(`CT asset HTTP ${r.status}`);
  return r;
}
const meta = await (await load('./assets/sciviz/clip/source.json')).json(),
  bytes = await (await load('./assets/sciviz/clip/ct-org-0-samples.bin')).arrayBuffer(),
  view = new DataView(bytes);
export const data = Float32Array.from({ length: bytes.byteLength / 2 }, (_, i) => {
  const x = i % meta.dims[0],
    row = i - x;
  return view.getInt16((row + meta.dims[0] - 1 - x) * 2, true) * meta.slope + meta.intercept;
});
const bounds = meta.bounds.slice();
[bounds[0], bounds[1]] = [bounds[1], bounds[0]];
export const reference = await Figure.create(element<HTMLCanvasElement>('reference'), { axes: false, controls: false }),
  figure = await Figure.create(element<HTMLCanvasElement>('volume'), { axes: false, controls: false });
reference.engine.stop();
figure.engine.stop();
for (const f of [reference, figure]) f.engine.camera.position = [1.8, 1.2, 2];
const preset = transferPreset('ct-bone');
export const histogram = await transferHistogram(data, {
  dims: meta.dims,
  bounds,
  range: preset.state.range,
  resolution: 128,
  signal,
});
export const transfer = new TransferFunction({
  ...preset.state,
  mode: '2d',
  gradientMax: histogram.gradientMax,
  widgets: [{ kind: 'gaussian', center: [500, 40], sigma: [500, 35], rgba: [1, 0.6, 0.25, 0.3] }],
});
const options = { dims: meta.dims, bounds, range: preset.state.range, shading: true, quality: 1.5 };
export const layer = figure.volume(data, options),
  plain = reference.volume(data, options);
plain.setClassification(
  await preintegrateTransfer(preset, { step: 1 / plain.quality, density: plain.density, signal }),
);
export const editor = transferEditor(element('editor'), transfer, {
  layer,
  histogram,
  render: () => figure.engine.render(),
});
await Promise.all([figure.ready(), reference.ready()]);
figure.engine.render();
reference.engine.render();
element('status').textContent =
  `Ready. ${histogram.valid} real CT samples; gradient upper bound ${histogram.gradientMax.toFixed(2)} HU/mm. Presets remap to the current scalar domain. Triangle width and height are edited through their three vertices.`;
window.addEventListener(
  'pagehide',
  () => {
    editor.dispose();
    figure.dispose();
    reference.dispose();
  },
  { once: true },
);
