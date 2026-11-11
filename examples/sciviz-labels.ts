import { Figure } from '@margoengine/sciviz/spec';
import {
  fusionVolume,
  labelLegend,
  type VolumeLabel,
  type VolumeMix,
  type FusionLayer,
} from '@margoengine/sciviz/labels';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
async function response(path: string): Promise<Response> {
  const r = await fetch(new URL(path, import.meta.url), { signal });
  if (!r.ok) throw new TypeError(`MRI asset HTTP ${r.status}`);
  return r;
}
async function bytes(path: string): Promise<ArrayBuffer> {
  const r = await response(path);
  return new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
const [meta, imageBytes, labelBytes, head] = await Promise.all([
  response('./assets/sciviz/msd-brain.json').then((r) => r.json()),
  bytes('./assets/sciviz/msd-brain.bin'),
  bytes('./assets/sciviz/msd-labels.bin'),
  loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url), { signal }),
]);
const data = new Float32Array(imageBytes),
  labels = new Uint8Array(labelBytes);
export const figure = await Figure.create(element<HTMLCanvasElement>('volume'), { axes: false, controls: false }),
  rgbFigure = await Figure.create(element<HTMLCanvasElement>('rgb'), { axes: false, controls: false });
for (const f of [figure, rgbFigure]) {
  f.engine.stop();
  f.engine.camera.position = [1.8, 1.2, 2];
}
const baseLabels: readonly VolumeLabel[] = [
  { id: 1, name: meta.labels['1'], rgba: [1, 0.15, 0.04, 0.06] },
  { id: 2, name: meta.labels['2'], rgba: [0.05, 0.3, 1, 0.035] },
  { id: 3, name: meta.labels['3'], rgba: [0.2, 1, 0.1, 0.12] },
];
const palette = (outlines: boolean): VolumeLabel[] =>
  baseLabels.map((l) => ({
    ...l,
    outline: outlines ? { rgba: [l.rgba[0], l.rgba[1], l.rgba[2], 0.4], width: 1 } : undefined,
  }));
let layer: FusionLayer, legend: ReturnType<typeof labelLegend>;
function rebuild(): void {
  legend?.dispose();
  if (layer) figure.remove(layer);
  layer = fusionVolume(
    figure,
    [
      {
        kind: 'labels',
        dims: meta.dims,
        transform: meta.transform,
        data: labels,
        labels: palette(element<HTMLInputElement>('outline').checked),
      },
      {
        kind: 'components',
        dims: meta.dims,
        transform: meta.transform,
        data,
        components: meta.ranges.map((range: [number, number], c: number) => ({
          range,
          weight: c === 0 ? 1 : 0.3,
          transfer: (value: number) => {
            const t = Math.max(0, Math.min(1, value / (range[1] * 0.65)));
            const colours = [
              [0.7, 0.75, 1],
              [0.9, 0.8, 0.65],
              [1, 0.6, 0.4],
              [0.6, 0.8, 1],
            ][c];
            return [colours[0] * t, colours[1] * t, colours[2] * t, Math.max(0, t - 0.12) ** 2 * 0.025] as const;
          },
        })),
      },
    ],
    { mix: element<HTMLSelectElement>('mix').value as VolumeMix },
  );
  legend = labelLegend(element('legend'), layer);
  figure.engine.render();
}
rebuild();
element('mix').addEventListener('change', rebuild);
element('outline').addEventListener('change', rebuild);
const grid = nrrdGrid(head),
  rgb = new Float32Array(grid.data.length * 4);
for (let i = 0; i < grid.data.length; i++) {
  const t = Math.max(0, Math.min(1, grid.data[i] / 715));
  rgb.set([t, t, t, Math.max(0, t - 0.12) ** 2 * 0.08], i * 4);
}
fusionVolume(rgbFigure, [{ kind: 'rgba', dims: grid.dims, bounds: grid.bounds, data: rgb }]);
await Promise.all([figure.ready(), rgbFigure.ready()]);
figure.engine.render();
rgbFigure.engine.render();
element('status').textContent =
  `Ready. ${meta.dims.join(' x ')} measured MRI samples, four independent functions and three categorical labels, fused before compositing. Labels use nearest integer samples; intensity and colour use linear interpolation.`;
window.addEventListener(
  'pagehide',
  () => {
    legend.dispose();
    figure.dispose();
    rgbFigure.dispose();
  },
  { once: true },
);
