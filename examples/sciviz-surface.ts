// Surface plot demo: a 256 x 256 height field z = sum of two radial waves, recomputed every frame on the GPU by one
// fused @margoengine/compute expression into a GpuArray that the sciviz surface layer reads in place. The colour map
// and contours follow the fixed range [-1.6, 1.6]; prefers-reduced-motion holds the waves still.
import { createCompute } from '@margoengine/compute';
import { Figure, type ColormapName, type SurfaceLayer } from '@margoengine/sciviz/spec';
import { still } from './multi-view.js';

declare global {
  interface Window {
    surfaceDemo?: { frames: number };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!,
  status = document.querySelector<HTMLParagraphElement>('#status')!,
  mapSelect = document.querySelector<HTMLSelectElement>('#map')!,
  animate = document.querySelector<HTMLInputElement>('#animate')!;
const N = 256,
  RANGE: [number, number] = [-1.6, 1.6];

try {
  const figure = await Figure.create(canvas, { titles: { x: 'x', y: 'y', z: 'height' }, aspect: [1, 1, 0.45] });
  const gpu = await createCompute({ engine: figure.engine });
  // Grid coordinates in [-6, 6], made once.
  const index = gpu.arange(0, N * N, 1, 'f32');
  const x = index
      .mod(N)
      .mul(12 / (N - 1))
      .sub(6)
      .eval(),
    y = index
      .floorDiv(N)
      .mul(12 / (N - 1))
      .sub(6)
      .eval();
  index.dispose();
  const r1 = x.add(2).hypot(y.sub(1)).eval(),
    r2 = x.sub(2.5).hypot(y.add(1.5)).eval();
  const heights = gpu.zeros([N, N]);
  const wave = (time: number) =>
    // Two damped radial waves, written into the surface's own buffer every frame.
    gpu
      .kernel(/* wgsl */ `
      struct P { time: f32, count: u32 }
      @group(0) @binding(0) var<storage, read> r1: array<f32>;
      @group(0) @binding(1) var<storage, read> r2: array<f32>;
      @group(0) @binding(2) var<storage, read_write> z: array<f32>;
      @group(0) @binding(3) var<uniform> p: P;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x >= p.count) { return; }
        let a = r1[id.x]; let b = r2[id.x];
        z[id.x] = cos(2.0 * a - 2.4 * p.time) * exp(-0.18 * a) + 0.8 * cos(2.6 * b - 3.1 * p.time) * exp(-0.22 * b);
      }`)
      .bind({ r1, r2, z: heights, p: { time, count: N * N } });
  const step = wave(0);
  step.run({ count: N * N });
  let layer: SurfaceLayer = figure.surface(heights, {
    x: [-6, 6],
    y: [-6, 6],
    range: RANGE,
    colormap: 'aurora',
    contours: 12,
  });
  let bar = figure.colorbar('aurora', RANGE, { label: 'height' });
  mapSelect.addEventListener('change', () => {
    const map = mapSelect.value as ColormapName;
    figure.remove(layer);
    bar.dispose();
    layer = figure.surface(heights, { x: [-6, 6], y: [-6, 6], range: RANGE, colormap: map, contours: 12 });
    bar = figure.colorbar(map, RANGE, { label: 'height' });
  });
  window.surfaceDemo = { frames: 0 };
  const start = performance.now();
  const tick = () => {
    if (animate.checked && !still) {
      step.set('p', { time: (performance.now() - start) / 1000, count: N * N }).run({ count: N * N });
      window.surfaceDemo!.frames++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => figure.dispose(), { once: true });
  status.textContent = `${(N * N).toLocaleString('en')} heights recomputed per frame on the GPU and drawn in place.`;
  await figure.ready();
  canvas.dataset.ready = 'true';
} catch (error) {
  status.textContent = `Could not start: ${(error as Error).message}`;
}
