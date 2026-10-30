// Dual viewport (launch showcase): one scene built twice by the same code, on native WebGPU (left) and on the WebGL2
// compatibility layer (right), with the pixel difference and both frame times measured live in the visitor's browser.
// The native engine is made first; then the layer is installed with `force` (this page has WebGPU), the second engine
// is made on it, and the layer is uninstalled again: devices made while it was installed keep working, so each engine
// keeps the GPU it started on. Without WebGPU the page's gate has installed the layer and only the right side runs.
// Under prefers-reduced-motion the scene starts still (the "Turn the scene" box unchecked).
import { createStage, type Mesh, type Stage } from 'margoengine';
import { Shadows } from '@margoengine/shadows';

declare global {
  interface Window {
    dualViewport?: { frames: number; compare(): Diff | null; stages: (Stage | null)[] };
  }
}
/** The pixel difference of the two views: share of pixels with d > 2, mean and largest d. */
interface Diff {
  over2: number;
  mean: number;
  max: number;
  pixels: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>('status'),
  nativeCanvas = $<HTMLCanvasElement>('native'),
  layerCanvas = $<HTMLCanvasElement>('layer'),
  exact = $<HTMLInputElement>('exact'),
  spin = $<HTMLInputElement>('spin');
spin.checked = !matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Wraps `gpu.requestAdapter` so the next device made from it is recorded (for `onSubmittedWorkDone`). */
function recordDevice(gpu: GPU, into: { device?: GPUDevice }): () => void {
  const request = gpu.requestAdapter;
  gpu.requestAdapter = async (options) => {
    const adapter = await request.call(gpu, options);
    if (adapter) {
      const requestDevice = adapter.requestDevice;
      adapter.requestDevice = async (descriptor) => (into.device = await requestDevice.call(adapter, descriptor));
    }
    return adapter;
  };
  return () => {
    gpu.requestAdapter = request;
  };
}

/** The demo scene: a floor, five shapes with PBR materials and directional shadows. Returns the meshes that turn. */
function build(stage: Stage): Mesh[] {
  const floor = stage.box({ size: [14, 0.2, 9], position: [0, -0.1, 0], color: '#56647a', roughness: 0.9 });
  const shadows = Shadows.attach(stage.engine, { resolution: 2048, distance: 30 });
  shadows.add(floor, { static: true });
  const shapes = [
    stage.box({ size: [1.4, 1.4, 1.4], position: [-4.4, 1, 0], color: '#e0a040', roughness: 0.35, metalness: 0.6 }),
    stage.sphere({ radius: 0.9, segments: 48, position: [-2.2, 1, 0.6], color: '#58b0e0', roughness: 0.2 }),
    stage.box({ size: [1.2, 2, 1.2], position: [0, 1, -0.4], color: '#e06a8c', roughness: 0.6 }),
    stage.sphere({ radius: 0.9, segments: 48, position: [2.2, 1, 0.6], color: '#8fd47a', roughness: 0.8 }),
    stage.box({ size: [1.4, 0.6, 1.4], position: [4.4, 0.4, 0], color: '#d8e4f5', roughness: 0.1, metalness: 1 }),
  ];
  for (const mesh of shapes) shadows.add(mesh);
  return shapes;
}

/** The backbuffer size for a canvas: its CSS size times the pixel ratio, at least 1 x 1. */
const size = (canvas: HTMLCanvasElement): [number, number] => [
  Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)),
  Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio)),
];
const camera = {
  position: [0, 4.5, 10.5] as [number, number, number],
  target: [0, 0.8, 0] as [number, number, number],
};

/** One side: its stage, the meshes that turn, the device it draws with and its last 60 frame times. */
interface Side {
  stage: Stage;
  shapes: Mesh[];
  device?: GPUDevice;
  cpu: number[];
  gpu: number[];
}
let sides: (Side | null)[] = [null, null],
  angle = 0,
  frames = 0,
  last: Diff | null = null,
  life = new AbortController();

async function makeSide(canvas: HTMLCanvasElement): Promise<Side> {
  const into: { device?: GPUDevice } = {},
    restore = recordDevice(navigator.gpu, into);
  try {
    const stage = await createStage(canvas, {
      backend: 'webgpu',
      controls: false,
      autoStart: false,
      camera,
      ...(exact.checked ? { exactSize: size(canvas) } : {}),
      onError: (error) => {
        status.textContent = String(error);
      },
    });
    return { stage, shapes: build(stage), device: into.device, cpu: [], gpu: [] };
  } finally {
    restore();
  }
}

async function start(): Promise<void> {
  life.abort();
  life = new AbortController();
  for (const side of sides) side?.stage.dispose();
  sides = [null, null];
  last = null;
  const signal = life.signal,
    hasNative = (await navigator.gpu.requestAdapter())?.info.vendor !== 'margo-webgl2';
  if (hasNative) {
    sides[0] = await makeSide(nativeCanvas);
    // The second engine on the layer; install({force}) makes navigator.gpu the layer's until uninstall().
    const compat = await import('@margoengine/webgl2-compat');
    await compat.install({ force: true });
    try {
      sides[1] = await makeSide(layerCanvas);
    } finally {
      compat.uninstall();
    }
  } else {
    nativeCanvas.closest('figure')!.querySelector('figcaption')!.textContent = 'No WebGPU in this browser';
    sides[1] = await makeSide(layerCanvas);
  }
  if (signal.aborted) return;
  status.textContent = hasNative
    ? 'Both views run. Pixels are compared every second while the scene turns, and on demand.'
    : 'This browser has no WebGPU, so only the WebGL2 side runs and there is nothing to compare against.';
  let previous = performance.now(),
    sinceCompare = 0;
  const frame = (now: number) => {
    if (signal.aborted) return;
    const delta = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    if (spin.checked) angle += delta * 0.4;
    for (const side of sides) {
      if (!side) continue;
      for (const [i, mesh] of side.shapes.entries()) mesh.setRotation([0, angle * (i % 2 ? -1 : 1), 0]);
      const t = performance.now();
      side.stage.engine.render();
      push(side.cpu, performance.now() - t);
      side.device?.queue.onSubmittedWorkDone().then(() => push(side.gpu, performance.now() - t));
    }
    frames++;
    sinceCompare += delta;
    // Read both canvases in the task that drew them, before the browser presents and may clear them.
    if (frames === 3 || sinceCompare >= 1) {
      sinceCompare = 0;
      compareNow();
    }
    show();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.querySelector('#viewport, #native')?.setAttribute('data-ready', 'true');
  document.body.dataset.ready = 'true';
}

const push = (list: number[], value: number) => {
  list.push(value);
  if (list.length > 60) list.shift();
};
const median = (list: number[]) => (list.length ? [...list].sort((a, b) => a - b)[list.length >> 1] : NaN);
const ms = (value: number) => (Number.isFinite(value) ? `${value.toFixed(2)} ms` : '-');

/** Reads both canvases (same size required) and measures d per pixel. Null when one side is missing. */
function compareNow(): Diff | null {
  if (!sides[0] || !sides[1]) return null;
  const width = Math.min(nativeCanvas.width, layerCanvas.width),
    height = Math.min(nativeCanvas.height, layerCanvas.height),
    read = (canvas: HTMLCanvasElement) => {
      const flat = new OffscreenCanvas(width, height).getContext('2d')!;
      flat.drawImage(canvas, 0, 0, width, height, 0, 0, width, height);
      return flat.getImageData(0, 0, width, height).data;
    };
  const a = read(nativeCanvas),
    b = read(layerCanvas);
  let over2 = 0,
    sum = 0,
    max = 0;
  for (let k = 0; k < a.length; k += 4) {
    const d = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
    sum += d;
    if (d > 2) over2++;
    if (d > max) max = d;
  }
  const pixels = width * height;
  last = { over2: over2 / pixels, mean: sum / pixels, max, pixels };
  return last;
}

function show(): void {
  if (last) {
    $('over2').textContent = `${(last.over2 * 100).toFixed(3)}% of ${last.pixels.toLocaleString('en')} pixels`;
    $('mean').textContent = `mean ${last.mean.toFixed(3)}, largest ${last.max}`;
  } else if (!sides[0]) $('over2').textContent = 'no native WebGPU to compare with';
  const [n, l] = sides;
  if (n) $('time-native').textContent = `${ms(median(n.cpu))}, ${ms(median(n.gpu))}`;
  if (l) $('time-layer').textContent = `${ms(median(l.cpu))}, ${ms(median(l.gpu))}`;
}

$('compare').addEventListener('click', () => {
  // Draw both once more first, so the comparison reads the same frame from each.
  for (const side of sides) side?.stage.engine.render();
  compareNow();
  show();
});
exact.addEventListener('change', () => void start().catch(fail));
const fail = (error: unknown) => {
  status.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
};
window.dualViewport = {
  get frames() {
    return frames;
  },
  compare: () => {
    for (const side of sides) side?.stage.engine.render();
    return compareNow();
  },
  get stages() {
    return sides.map((side) => side?.stage ?? null);
  },
};
addEventListener('pagehide', () => {
  life.abort();
  for (const side of sides) side?.stage.dispose();
});
await start().catch(fail);
