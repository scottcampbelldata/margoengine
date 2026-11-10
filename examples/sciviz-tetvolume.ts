import { Figure } from '@margoengine/sciviz';
import { tetrahedralVolume } from '@margoengine/sciviz/tetvolume';
import { qualityVolume } from '@margoengine/sciviz/volume-quality';
import { CellLocator, resampleToImage } from '@margoengine/sciviz/probe';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
async function bytes(name: string): Promise<ArrayBuffer> {
  const r = await fetch(new URL(`./assets/sciviz/tmr-tet-${name}.bin`, import.meta.url), { signal });
  if (!r.ok) throw new Error(`NASA subset ${r.status}`);
  return r.arrayBuffer();
}
const [p, v, c] = await Promise.all([bytes('points'), bytes('values'), bytes('cells')]);
export const grid = {
  points: new Float32Array(p),
  pointData: new Float32Array(v),
  connectivity: new Uint32Array(c),
  offsets: Uint32Array.from({ length: c.byteLength / 16 }, (_, i) => (i + 1) * 4),
  types: new Uint8Array(c.byteLength / 16).fill(10),
};
const bounds: [number, number, number, number, number, number] = [
  Infinity,
  -Infinity,
  Infinity,
  -Infinity,
  Infinity,
  -Infinity,
];
for (let i = 0; i < grid.points.length; i++) {
  const axis = i % 3;
  bounds[axis * 2] = Math.min(bounds[axis * 2], grid.points[i]);
  bounds[axis * 2 + 1] = Math.max(bounds[axis * 2 + 1], grid.points[i]);
}
const span = [bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]],
  aspect = span.map((v) => v / Math.max(...span)) as [number, number, number];
export const direct = await Figure.create(element<HTMLCanvasElement>('direct'), {
  axes: false,
  controls: false,
  aspect,
  limits: bounds,
});
export const reference = await Figure.create(element<HTMLCanvasElement>('reference'), {
  axes: false,
  controls: false,
  aspect,
  limits: bounds,
});
for (const f of [direct, reference]) {
  f.engine.camera.position = [1.8, 1.5, 1.7];
  f.engine.camera.target = [0, 0, 0];
  f.engine.stop();
}
let opaqueProjection = false;
const opacity = () => (opaqueProjection ? 1 : 0.05);
const referenceStep = 0.03,
  alpha = 13 / 255;
export const volume = tetrahedralVolume(direct, grid, {
  range: [0, 400],
  colormap: 'inferno',
  opacity,
  referenceStep,
  quality: 4,
  shading: false,
  signal,
});
const locator = await CellLocator.create(grid, { signal }),
  dims = [65, 3, 65] as const;
export const resampled = await resampleToImage(locator, dims, bounds, { signal });
locator.dispose();
if (!resampled.grid.pointData) throw new Error('NASA reference field missing');
const voxel = Math.min(...span.map((v, i) => v / (dims[i] - 1))),
  density = (1 - (1 - alpha) ** (voxel / referenceStep)) / alpha;
export const source = reference.volume(resampled.grid.pointData, {
  dims,
  bounds,
  range: [0, 400],
  colormap: 'inferno',
  opacity,
  density,
  quality: 4,
  shading: false,
});
export const quality = qualityVolume(reference, source, { emptySpaceSkipping: false, adaptive: false, jitter: false });
function update(): void {
  const d = Number(element<HTMLInputElement>('density').value),
    mode = element<HTMLSelectElement>('mode').value === 'mip' ? 'mip' : 'composite';
  if (opaqueProjection !== (mode === 'mip')) {
    opaqueProjection = mode === 'mip';
    volume.source.setClassification();
    source.setClassification();
  }
  volume.source.density = d;
  source.density = mode === 'mip' ? d : (1 - (1 - Math.min(1, alpha * d)) ** (voxel / referenceStep)) / alpha;
  volume.source.mode = mode;
  source.mode = mode;
  direct.engine.render();
  reference.engine.render();
}
for (const id of ['density', 'mode']) element(id).addEventListener('input', update);
await Promise.all([direct.ready(), reference.ready()]);
update();
element('status').textContent =
  `Ready. ${volume.cellCount} direct tetrahedra; ${dims.join(' x ')} reference image, ${resampled.valid.reduce((a, b) => a + b, 0)} valid samples. Matched physical extinction distance in composite mode.`;
window.addEventListener(
  'pagehide',
  () => {
    direct.dispose();
    reference.dispose();
  },
  { once: true },
);
