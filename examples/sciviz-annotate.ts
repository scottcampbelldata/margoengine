import { annotate, type Annotation, type AnnotationPoint } from '@margoengine/sciviz/annotate';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { decodeFigureValue, type FigureSpec } from '@margoengine/sciviz/spec';
import { createFigure, element, signal } from './sciviz-demo.js';
const fetchAsset = async (name: string) => {
  const r = await fetch(new URL('./assets/sciviz/' + name, import.meta.url), { signal });
  if (!r.ok) throw new Error(`Data HTTP ${r.status}`);
  return r;
};
const meta = await (await fetchAsset('clip/source.json')).json();
const bytes = await (await fetchAsset('clip/ct-org-0-samples.bin')).arrayBuffer(),
  view = new DataView(bytes);
export const ctData = {
  data: Float32Array.from(
    { length: bytes.byteLength / 2 },
    (_, i) => view.getInt16(i * 2, true) * meta.slope + meta.intercept,
  ),
  dims: meta.dims as [number, number, number],
  bounds: meta.bounds as [number, number, number, number, number, number],
};
export const t1Data = nrrdGrid(await loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url), { signal }));
export const ct = await createFigure(element<HTMLCanvasElement>('ct'), { axes: false, controls: true });
export const t1 = await createFigure(element<HTMLCanvasElement>('t1'), { axes: false, controls: true });
ct.volume(ctData.data, {
  ...ctData,
  range: [-200, 1600],
  colormap: 'gray',
  opacity: [
    [0, 0],
    [0.3, 0],
    [0.6, 0.4],
    [1, 0.9],
  ],
});
t1.volume(t1Data.data, {
  ...t1Data,
  range: [0, 500],
  colormap: 'gray',
  opacity: [
    [0, 0],
    [0.2, 0],
    [0.5, 0.1],
    [1, 0.8],
  ],
});
await Promise.all([ct.ready(), t1.ready()]);
function records(bounds: readonly number[]): Annotation[] {
  const c = [0, 1, 2].map((i) => (bounds[2 * i] + bounds[2 * i + 1]) / 2),
    span = [0, 1, 2].map((i) => Math.abs(bounds[2 * i + 1] - bounds[2 * i]));
  const p = (x: number, y: number, z = 0): AnnotationPoint => [
    c[0] + span[0] * x,
    c[1] + span[1] * y,
    c[2] + span[2] * z,
  ];
  return [
    { id: 'ruler', kind: 'ruler', points: [p(-0.25, -0.2), p(0.25, -0.2)], unit: 'mm' },
    { id: 'angle', kind: 'angle', points: [p(-0.2, 0.1), p(0, 0.1), p(0, 0.3)] },
    { id: 'length', kind: 'polyline', points: [p(-0.3, 0), p(-0.2, 0.1), p(-0.3, 0.2)], unit: 'mm' },
    { id: 'roi', kind: 'box', points: [p(-0.2, -0.15, -0.15), p(0.2, 0.15, 0.15)], text: 'Editable box ROI' },
    { id: 'sphere', kind: 'sphere', points: [p(0.2, 0.1), p(0.3, 0.1)], unit: 'mm' },
    { id: 'arrow', kind: 'arrow', points: [p(0.3, 0.3), p(0.15, 0.15)], text: 'Anatomy' },
    { id: 'scale', kind: 'scale', points: [p(-0.3, -0.35), p(-0.1, -0.35)], unit: 'mm' },
    { id: 'note', kind: 'text', points: [p(0, 0.35)], text: 'Physical coordinates' },
    { id: 'rectangle', kind: 'rectangle', points: [p(-0.4, 0.2), p(-0.3, 0.3)] },
    { id: 'ellipse', kind: 'ellipse', points: [p(0.3, -0.3), p(0.4, -0.2)] },
  ];
}
export const ctAnnotations = annotate(ct, { annotations: records(ctData.bounds) }),
  t1Annotations = annotate(t1, { annotations: records(t1Data.bounds) });
for (const [figure, controller, data, threshold] of [
  [ct, ctAnnotations, ctData, 300],
  [t1, t1Annotations, t1Data, 200],
] as const) {
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
  canvas.addEventListener('click', (event) => {
    const r = canvas.getBoundingClientRect(),
      hit = controller.pickVolume(data, event.clientX - r.left, event.clientY - r.top, (v) => v > threshold);
    if (hit) {
      const record: Annotation = {
        id: 'picked',
        kind: 'text',
        points: [hit.position],
        text: `Voxel ${hit.index}: ${hit.value.toFixed(1)}`,
      };
      if (controller.annotations.some((a) => a.id === 'picked')) controller.update('picked', record);
      else controller.add(record);
    }
  });
}
let saved: FigureSpec | undefined;
const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};
element('png').onclick = () => void ct.toPNG().then((b) => download(b, 'ct-annotations.png'));
element('svg').onclick = () =>
  void ct.toSVG().then((s) => download(new Blob([s], { type: 'image/svg+xml' }), 'ct-annotations.svg'));
element('save').onclick = () =>
  void ct.toJSON().then((s) => {
    saved = s;
    download(new Blob([JSON.stringify(s)], { type: 'application/json' }), 'ct-figure.json');
  });
element('restore').onclick = () => {
  if (saved?.annotations)
    void decodeFigureValue(saved.annotations).then((value) =>
      ctAnnotations.restore((value as { records: Annotation[] }).records),
    );
};
window.addEventListener(
  'pagehide',
  () => {
    ct.dispose();
    t1.dispose();
  },
  { once: true },
);
element('status').textContent =
  'CT and T1 loaded. Rulers, angles, paths, scale bars, arrows, shapes and editable ROIs share PNG, SVG and saved figure state.';
element('status').dataset.ready = 'true';
