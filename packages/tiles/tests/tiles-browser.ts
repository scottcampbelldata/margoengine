// Real-GPU fixture for @margoengine/tiles: a generated city-scale tileset (6-level quadtree over 8 km, 1365 b3dm
// tiles, anchored in ECEF at 40 N 75.6 W) streamed by TilesRenderer through gltf-pro and drawn by the engine.
// tests/tiles-browser.mjs drives it and checks the numbers. Built imports, so it uses the published package boundary.
import { Engine } from '../../core/dist/extension.js';
import { TilesRenderer } from '../dist/index.js';
import { cityTileset, memoryFetch } from './generator.js';

const W = 480,
  H = 270,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 120, 1800], target: [0, 0, 0], far: 20_000, near: 1 },
  }),
  errors: string[] = [];
engine.stop();
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
(engine as unknown as { scene: { background: string } }).scene.background = '#000000';

const city = cityTileset({ levels: 6, size: 8192, format: 'b3dm', height: 30 }),
  memory = memoryFetch(city.files);

async function frame(): Promise<void> {
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
}
function pixels(): Uint8ClampedArray {
  engine.render();
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const context = copy.getContext('2d')!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, W, H).data;
}
const lit = (data: Uint8ClampedArray, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return data[i] + data[i + 1] + data[i + 2] > 30;
};
function project(world: readonly number[]): [number, number, number] {
  const m = engine.camera.matrix,
    [x, y, z] = world;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [((cx / cw + 1) / 2) * W, ((1 - cy / cw) / 2) * H, cw];
}

let tiles: TilesRenderer;
async function converge(limit = 600): Promise<{ frames: number; ms: number }> {
  const started = performance.now();
  for (let i = 0; i < limit; i++) {
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    const p = tiles.tileset.progress;
    if (i > 2 && tiles.last.pending === 0 && p.loading === 0 && p.queued === 0)
      return { frames: i, ms: performance.now() - started };
  }
  throw new Error(`tileset did not settle in ${limit} frames: ${JSON.stringify(tiles.tileset.progress)}`);
}
function snapshot() {
  const depths: Record<number, number> = {};
  for (const t of tiles.last.selected) depths[t.depth] = (depths[t.depth] ?? 0) + 1;
  return {
    selected: tiles.last.selected.length,
    depths,
    progress: tiles.tileset.progress,
    requests: memory.requests.length,
  };
}

async function run(name: string): Promise<unknown> {
  if (name === 'city') {
    tiles = await TilesRenderer.load(engine, memory.url, {
      fetch: memory.fetch,
      maxConcurrentRequests: 8,
      memoryBudget: 80_000,
    });
    const timing = await converge();
    const data = pixels();
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
    // Every on-screen leaf building: its centre (the tile volume's centre, through the float64 frame) must be drawn.
    const centres = tiles.last.selected
      .filter((t) => t.children.length === 0)
      .map((t) => project(tiles.toWorld(t.bounds.center)))
      .filter(([x, y, w]) => w > 0 && x > 8 && x < W - 8 && y > 8 && y < H - 8);
    const drawn = centres.filter(([x, y]) => lit(data, x, y)).length;
    // Sky above the horizon stays background.
    const sky = !lit(data, W / 2, 4);
    return {
      ...timing,
      ...snapshot(),
      lit: count,
      leavesOnScreen: centres.length,
      leavesDrawn: drawn,
      sky,
      errors: [...errors],
    };
  }
  // Fly 3 km east, low: new leaves load there, old ones are evicted under the 80 kB budget, models are disposed.
  const before = memory.requests.length;
  let unloads = 0;
  tiles.tileset.on('tileunload', () => unloads++);
  engine.camera.position = [3000, 60, 600];
  engine.camera.target = [3000, 0, -400];
  const timing = await converge();
  const data = pixels();
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
  return {
    ...timing,
    ...snapshot(),
    newRequests: memory.requests.length - before,
    unloads,
    lit: count,
    errors: [...errors],
  };
}

(window as unknown as { tilesFixture: unknown }).tilesFixture = {
  run,
  dispose: () => {
    tiles.dispose();
    return { plugins: engine.hasPlugin(tiles.name), errors: [...errors] };
  },
};
