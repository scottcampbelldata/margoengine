import { Figure } from '@margoengine/sciviz/spec';
import { cinematicVolume, type CinematicOptions } from '@margoengine/sciviz/cinematic';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
async function load(path: string): Promise<Response> {
  const r = await fetch(new URL(path, import.meta.url), { signal });
  if (!r.ok) throw new TypeError(`Volume HTTP ${r.status}`);
  return r;
}
const em = await (await load('./assets/sciviz/emdb-8117.json')).json();
const packed = await load('./assets/sciviz/emdb-8117.bin');
const data = new Float32Array(
  await new Response(packed.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
);
const ct = await (await load('./assets/sciviz/clip/source.json')).json();
const raw = new DataView(await (await load('./assets/sciviz/clip/ct-org-0-samples.bin')).arrayBuffer());
const values = Float32Array.from({ length: raw.byteLength / 2 }, (_, i) => {
  const x = i % ct.dims[0];
  return raw.getInt16((i - x + ct.dims[0] - 1 - x) * 2, true) * ct.slope + ct.intercept;
});
const ctBounds = ct.bounds.slice();
[ctBounds[0], ctBounds[1]] = [ctBounds[1], ctBounds[0]];
export const figures = await Promise.all(
  ['emdb', 'ct'].map((id) => Figure.create(element<HTMLCanvasElement>(id), { axes: false })),
);
const volumes = [
  figures[0].volume(data, {
    dims: em.dims,
    bounds: em.bounds,
    range: [0, 8],
    opacity: (t) => (t > 0.15 ? Math.min(0.5, t * 0.4) : 0),
    quality: 1,
    shading: false,
    colormap: 'gray',
  }),
  figures[1].volume(values, {
    dims: ct.dims,
    bounds: ctBounds,
    range: [-200, 1800],
    opacity: (t) => (t > 0.15 ? t * t * 0.4 : 0),
    quality: 1,
    shading: false,
    colormap: 'magma',
  }),
];
export const lighting = figures.map((f, i) => cinematicVolume(f, volumes[i], { shadows: { steps: 24 } }));
for (const f of figures) f.engine.camera.position = [1.7, 1.2, 2.1];
function change(): void {
  const mode = element<HTMLSelectElement>('mode').value;
  const options: CinematicOptions =
    mode === 'ao'
      ? { ambientOcclusion: { directions: 6, steps: 6 }, ambient: [0.8, 0.8, 0.8], light: [0.2, 0.2, 0.2] }
      : mode === 'shadow'
        ? { shadows: { steps: 24 } }
        : mode === 'path'
          ? { shadows: { steps: 24 }, pathTracing: { anisotropy: Number(element<HTMLInputElement>('phase').value) } }
          : {};
  lighting.forEach((l) => l.configure(options));
}
element('mode').addEventListener('change', change);
element('phase').addEventListener('input', change);
await Promise.all(figures.map((f) => f.ready()));
element('status').textContent =
  'Ready. Camera motion resets accumulation. Each path adds one sample per frame; select plain march to compare the same classifier without lighting costs.';
window.addEventListener('pagehide', () => figures.forEach((f) => f.dispose()), { once: true });
