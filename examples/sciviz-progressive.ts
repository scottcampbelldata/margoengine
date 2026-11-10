import { Figure } from '@margoengine/sciviz';
import { createFallbackFigure } from '@margoengine/sciviz/fallback';
import { arraySource, brickedVolume } from '@margoengine/sciviz/bricks';
import { cinematicVolume } from '@margoengine/sciviz/cinematic';
import { progressiveRendering } from '@margoengine/sciviz/progressive';

const fallback = new URLSearchParams(location.search).get('backend') === 'webgl2';
const compat = fallback ? await import('@margoengine/webgl2-compat') : undefined;
const signal = AbortSignal.timeout(120000);
async function load(path: string): Promise<Response> {
  const response = await fetch(new URL(path, import.meta.url), { signal });
  if (!response.ok) throw new TypeError(`Volume HTTP ${response.status}; reload the recorded data`);
  return response;
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
const ids = ['bricks', 'emdb', 'ct'];
export const figures = await Promise.all(
  ids.map((id) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`#${id}`)!;
    return compat ? createFallbackFigure(canvas, { axes: false, compat }) : Figure.create(canvas, { axes: false });
  }),
);
const options = {
  dims: em.dims,
  bounds: em.bounds,
  range: [0, 8] as const,
  opacity: (t: number) => (t > 0.15 ? Math.min(0.5, t * 0.4) : 0),
  quality: 1,
  shading: false,
  colormap: 'gray' as const,
};
export const bricks = brickedVolume(figures[0], arraySource(data, em.dims), {
  ...options,
  brickSize: 32,
  memoryBudget: 32 * 1024 * 1024,
});
export const volumes = [
  figures[1].volume(data, options),
  figures[2].volume(values, {
    dims: ct.dims,
    bounds: ctBounds,
    range: [-200, 1800],
    quality: 1,
    shading: false,
    colormap: 'magma',
    opacity: (t) => (t > 0.15 ? t * t * 0.4 : 0),
  }),
];
export const lighting = volumes.map((volume, i) =>
  cinematicVolume(figures[i + 1], volume, {
    shadows: { steps: 24 },
    pathTracing: { samples: 64, bounces: 4 },
  }),
);
export let controllers = figures.map((f) => progressiveRendering(f));
for (const f of figures) f.engine.camera.position = [1.7, 1.2, 2.1];
figures.forEach((f, i) =>
  f.engine.onFrame(() => {
    const s = controllers[i].state;
    document.querySelector(`#${ids[i]}-state`)!.textContent =
      `${s.moving ? 'Moving' : 'Refining'}: dimensions ${Math.round(s.resolutionScale * 100)}%, samples ${Math.round(s.sampleScale * 100)}%, refinement ${Math.round(s.progress * 100)}%`;
  }),
);
document.querySelector('#apply')!.addEventListener('click', () => {
  const frameBudgetMs = Number(document.querySelector<HTMLInputElement>('#budget')!.value);
  if (!(frameBudgetMs > 0 && Number.isFinite(frameBudgetMs))) return;
  controllers.forEach((c) => c.dispose());
  controllers = figures.map((f) => progressiveRendering(f, { frameBudgetMs }));
});
await Promise.all([...figures.map((f) => f.ready()), bricks.ready({ signal })]);
document.querySelector('#status')!.textContent =
  'Ready. Bricks reload through the engine restore hooks; cinematic histories restart after camera or device changes.';
window.addEventListener('pagehide', () => figures.forEach((f) => f.dispose()), { once: true });
