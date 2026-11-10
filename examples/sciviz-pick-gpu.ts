import { Figure, type CreateFigureOptions } from '@margoengine/sciviz';
import { createFallbackFigure } from '@margoengine/sciviz/fallback';
import { GpuPicking } from '@margoengine/sciviz/pick-gpu';
import { element } from './sciviz-demo.js';

const signal = AbortSignal.timeout(120000);
async function asset(name: string): Promise<Response> {
  const response = await fetch(new URL(`./assets/sciviz/${name}`, location.href), { signal });
  if (!response.ok) throw new TypeError(`Data HTTP ${response.status}: ${name}`);
  return response;
}
const useCompat = new URLSearchParams(location.search).get('backend') === 'webgl2';
const compat = useCompat ? await import('@margoengine/webgl2-compat') : undefined;
const create = useCompat
  ? (canvas: HTMLCanvasElement, options: CreateFigureOptions) => createFallbackFigure(canvas, { ...options, compat: compat! })
  : Figure.create;
export const stars = await create(element<HTMLCanvasElement>('stars'), {
  mode: '2d',
  controls: false,
  limits: [0, 360, -90, 90],
  titles: { x: 'RA (degrees)', y: 'Dec (degrees)' },
});
export const ct = await create(element<HTMLCanvasElement>('ct'), { axes: false });
ct.engine.camera.position = [1.8, 1.4, 2.5];
const values = new Float32Array(
    await new Response((await asset('stars.bin')).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
  ),
  n = values.length / 4;
export const cloud = await stars.scatter(
  { x: values.subarray(0, n), y: values.subarray(n, 2 * n), color: values.subarray(2 * n, 3 * n) },
  {
    size: 2,
    range: [0, 2],
    colormap: 'coolwarm',
  },
);
const meta = await (await asset('clip/source.json')).json();
const samples = new Int16Array(await (await asset('clip/ct-org-0-samples.bin')).arrayBuffer());
export const volume = ct.volume(
  Float32Array.from(samples, (value) => value * meta.slope + meta.intercept),
  {
    dims: meta.dims,
    range: [-1000, 1000],
    opacity: [
      [0, 0],
      [0.1, 0],
      [0.4, 0.08],
      [1, 0.3],
    ],
    colormap: 'gray',
    shading: true,
  },
);
export const starPicking = new GpuPicking(stars),
  ctPicking = new GpuPicking(ct);
starPicking.attachHover();
ctPicking.attachHover();
for (const [fig, output] of [
  [stars, element('star-hit')],
  [ct, element('ct-hit')],
] as const) {
  fig.addEventListener('hover', (event) => {
    const hit = event.detail;
    output.textContent = hit
      ? `Index ${hit.index}; (${hit.x.toFixed(3)}, ${hit.y.toFixed(3)}, ${hit.z.toFixed(3)}); value ${hit.value?.toFixed(3) ?? 'none'}`
      : 'No hit.';
  });
  fig.addEventListener('pickerror', (event) => {
    element('status').textContent = String(event.detail);
  });
}
await Promise.all([stars.ready(), ct.ready()]);
stars.render();
ct.render();
element('status').textContent =
  `Ready. ${n.toLocaleString()} stars and ${samples.length.toLocaleString()} CT samples. GPU ID passes read 256 bytes per query.`;
window.addEventListener(
  'pagehide',
  () => {
    starPicking.dispose();
    ctPicking.dispose();
    stars.dispose();
    ct.dispose();
  },
  { once: true },
);
