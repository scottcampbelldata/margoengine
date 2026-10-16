// Browser side of the GPU culling benchmark and pixel check. Driven by culling.mjs.
// The same synthetic assembly as bench.js, drawn either as core meshes ('core') or by @margoengine/culling
// ('none' = draw all, 'frustum', 'occlusion'); parts keep core's per-shape order in both.
import { Engine, PbrMaterial } from '../../../packages/core/dist/index.js';
import { Stats } from '../../../packages/stats/dist/index.js';
import { CulledInstances } from '../../../packages/culling/dist/index.js';
import { toGeometry } from '../../../packages/geometry/dist/index.js';
import { withGPUTiming } from '../gpu-timing.js';
import { buildAssembly, partShapes, ENTITIES_PER_MODULE } from './assembly.js';

const now = () => performance.now();
const stat = (values) => {
  const v = [...values].sort((a, b) => a - b),
    at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return v.length
    ? {
        n: v.length,
        median: +at(0.5).toFixed(4),
        p95: +at(0.95).toFixed(4),
        max: +v.at(-1).toFixed(4),
        mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4),
      }
    : null;
};

// World matrices for buildAssembly's layout (root and zones are identity), column-major.
const multiply = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const pose = ([x, y, z], yaw = 0) => {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1];
};
const materials = () => ({
  plate: new PbrMaterial({ color: '#8d99a6', roughness: 0.5, metalness: 0.6 }),
  bracket: new PbrMaterial({ color: '#4f7cac', roughness: 0.4, metalness: 0.2 }),
  bolt: new PbrMaterial({ color: '#c9ccd1', roughness: 0.3, metalness: 0.9 }),
  nut: new PbrMaterial({ color: '#b0a17a', roughness: 0.35, metalness: 0.9 }),
  washer: new PbrMaterial({ color: '#d8d8d8', roughness: 0.3, metalness: 0.9 }),
});
// layout 'sheet' is bench.js's flat grid; 'stack' stacks the same modules in a cube of layers 0.13 m apart (a dense block).
export function assemblyBatches(modules, { twin = false, layout = 'sheet' } = {}) {
  const shapes = partShapes(),
    geometries = Object.fromEntries(Object.entries(shapes).map(([name, data]) => [name, toGeometry(data)])),
    mats = materials();
  const lists = Object.fromEntries(Object.keys(shapes).map((name) => [name, []])),
    stack = layout === 'stack',
    columns = stack ? Math.ceil(Math.cbrt(modules)) : Math.ceil(Math.sqrt(modules)),
    spacing = stack ? 0.45 : 0.55;
  for (let m = 0; m < modules; m++) {
    const row = Math.floor(m / columns),
      layer = stack ? Math.floor(row / columns) : 0;
    const module = pose(
      [
        ((m % columns) - columns / 2) * spacing,
        (layer - columns / 2) * 0.13,
        ((stack ? row % columns : row) - columns / 2) * spacing,
      ],
      ((m % 4) * Math.PI) / 2,
    );
    const part = (parent, name, position, yaw) => lists[name].push(...multiply(parent, pose(position, yaw)));
    part(module, 'plate', [0, 0, 0]);
    part(module, 'bracket', [-0.08, 0.012, 0], 0);
    part(module, 'bracket', [0.08, 0.012, 0], Math.PI);
    for (const side of [-1, 1]) {
      const set = multiply(module, pose([0, 0, side * 0.11]));
      for (const x of [-0.16, -0.06, 0.06, 0.16]) {
        part(set, 'bolt', [x, 0.02, 0]);
        part(set, 'washer', [x, -0.003, 0]);
        part(set, 'nut', [x, -0.013, 0]);
      }
    }
  }
  const batches = Object.keys(shapes).map((name) => ({
    geometry: geometries[name],
    material: mats[name],
    transforms: new Float32Array(lists[name]),
  }));
  // Coplanar twin of every plate in another colour: with greater-equal depth the later batch must win everywhere.
  if (twin)
    batches.splice(1, 0, {
      geometry: geometries.plate,
      material: new PbrMaterial({ color: '#c04020', roughness: 0.5, metalness: 0.1 }),
      transforms: batches[0].transforms.slice(),
    });
  return { batches, extent: columns * spacing, triangles: batches.map((b) => b.geometry.indices.length / 3) };
}

async function create(canvas, capacity) {
  return withGPUTiming(true, () => Engine.create(canvas, { capacity, camera: { fov: 45, near: 0.05, far: 2000 } }));
}

async function run({
  modules,
  mode = 'occlusion',
  view = 'orbit',
  layout = 'sheet',
  frames = 240,
  warmup = 60,
  low = false,
}) {
  if (low) globalThis.margoLow = 1;
  const canvas = document.getElementById('view'),
    result = { modules, mode, view, layout, msaa: low ? 1 : 4, crossOriginIsolated };
  const core = mode === 'core',
    capacity = core ? Math.min(100_000, modules * ENTITIES_PER_MODULE + Math.ceil(modules / 32) + 1) : 64;
  let t = now();
  const engine = await create(canvas, capacity);
  result.engineCreateMs = now() - t;
  const errors = [];
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  t = now();
  let parts, extent, triangles;
  if (core) {
    const a = buildAssembly(engine, modules);
    extent = a.extent;
    result.parts = a.parts.length;
    triangles = a.parts.reduce((s, p) => s + p.geometry.indices.length / 3, 0);
  } else {
    const a = assemblyBatches(modules, { layout });
    extent = a.extent;
    parts = new CulledInstances(a.batches, { culling: mode });
    engine.use(parts);
    result.parts = parts.count;
    result.shapeTriangles = a.triangles;
    triangles = a.batches.reduce((s, b, i) => s + (a.triangles[i] * b.transforms.length) / 16, 0);
  }
  result.buildMs = now() - t;
  result.triangles = triangles;
  // orbit/still: the overview of bench.js. grazing: inside the assembly, 0.3 m above the plates, orbiting its centre.
  const grazing = view === 'grazing',
    r = extent * (grazing ? 0.3 : 0.75);
  let angle = view === 'still' ? 0.8 : 0;
  const orbit = (a) => {
    engine.camera.position = [Math.cos(a) * r, grazing ? 0.3 : r * 0.65, Math.sin(a) * r];
    engine.camera.target = [0, 0, 0];
  };
  orbit(angle);
  t = now();
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  result.firstFrameMs = now() - t;
  const stats = new Stats({ profiling: true });
  engine.use(stats);
  const rawRender = engine.render.bind(engine),
    cpu = [],
    intervals = [],
    gpu = [],
    passes = [];
  let frameNo = 0,
    last = 0,
    lastGpu = null,
    done,
    started = now();
  const finished = new Promise((res) => (done = res));
  engine.render = (o) => {
    const s = now();
    rawRender(o);
    const total = now() - s;
    frameNo++;
    if (frameNo > warmup) {
      cpu.push(total);
      if (last) intervals.push(s - last);
      if (stats.gpuTime !== null && stats.gpuTime !== lastGpu) {
        gpu.push(stats.gpuTime);
        passes.push(Array.from(stats.gpuPassMilliseconds.subarray(0, stats.gpuPassCount)));
        lastGpu = stats.gpuTime;
      }
    }
    last = s;
    if (frameNo >= warmup + frames && (gpu.length >= 12 || s - started > 45_000)) done();
  };
  engine.onFrame((_, delta) => {
    if (view !== 'still') {
      angle += delta * 0.3;
      orbit(angle);
    }
  });
  engine.start();
  await finished;
  engine.stop();
  engine.render = rawRender;
  engine.removePlugin('stats');
  result.frame = {
    cpuMs: stat(cpu),
    intervalMs: stat(intervals),
    fps: +(1000 / stat(intervals).median).toFixed(1),
    gpuMs: stat(gpu),
    gpuPassMedianMs: passes.length ? passes[0].map((_, i) => stat(passes.map((p) => p[i] ?? 0)).median) : null,
  };
  // Serial frames: wait for the GPU after each submit (upper bound for GPU work per frame).
  const c = [],
    g = [];
  for (let i = 0; i < 30; i++) {
    if (view !== 'still') {
      angle += 0.05;
      orbit(angle);
    }
    const s = now();
    engine.render();
    const m = now();
    await engine.gpu.queue.onSubmittedWorkDone();
    c.push(m - s);
    g.push(now() - m);
  }
  result.serial = { cpuMs: stat(c), gpuTailMs: stat(g), frameMs: stat(c.map((v, i) => v + g[i])) };
  if (parts) {
    const counts = await parts.readCounts();
    result.drawnParts = counts.reduce((a, b) => a + b, 0);
    result.drawnTriangles = counts.reduce((a, n, i) => a + n * result.shapeTriangles[i], 0);
  } else result.drawnParts = engine.stats.visible;
  result.errors = errors;
  engine.dispose();
  return result;
}

// Pixel check: two engines render the same parts along one camera path, one culled ('occlusion' or 'frustum') and one
// drawing everything ('none'); every frame's canvas is compared byte for byte.
async function check({ modules = 1024, frames = 160, culling = 'occlusion', layout = 'sheet' } = {}) {
  const a = assemblyBatches(modules, { twin: true, layout }),
    b = assemblyBatches(modules, { twin: true, layout });
  const tested = await create(document.getElementById('view'), 64),
    reference = await create(document.getElementById('reference'), 64);
  const errors = [];
  for (const e of [tested, reference])
    e.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const parts = new CulledInstances(a.batches, { culling }),
    all = new CulledInstances(b.batches, { culling: 'none' });
  tested.use(parts);
  reference.use(all);
  const scratch = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }),
    extent = a.extent;
  const read = (canvas) => {
    scratch.canvas.width = canvas.width;
    scratch.canvas.height = canvas.height;
    scratch.drawImage(canvas, 0, 0);
    return scratch.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  // Sheet path: high orbit, descend to a grazing flight just above the plates, then below the sheet looking up.
  // Stack path: orbit the block while descending to its mid height, then fly straight through it between two layers.
  const top = Math.ceil(Math.cbrt(modules)) * 0.065;
  const path =
    layout === 'stack'
      ? (f) => {
          const t = f / (frames - 1);
          if (t < 0.5) {
            const a = t * Math.PI * 3,
              r = extent * (1.2 - t),
              h = top * 3 * (1 - 2 * t) + 0.12;
            return [
              [Math.cos(a) * r, h, Math.sin(a) * r],
              [0, 0, 0],
            ];
          }
          const x = -extent * 0.8 + (t - 0.5) * 2 * extent * 1.6,
            c = Math.ceil(Math.cbrt(modules)),
            y = (Math.floor(c / 2) - c / 2) * 0.13 + 0.1145; /* gap between the two middle layers */
          return [
            [x, y, 0.11],
            [x + 1, y - 0.01, 0.12],
          ];
        }
      : (f) => {
          const t = f / (frames - 1),
            a = t * Math.PI * 2.2,
            phase = Math.min(1, t * 2.5);
          if (t < 0.75) {
            const r = extent * (0.75 - 0.6 * phase),
              h = r * (0.65 - 0.6 * phase) + 0.05;
            return [
              [Math.cos(a) * r, h, Math.sin(a) * r],
              [0, 0, 0],
            ];
          }
          const r = extent * 0.3;
          return [
            [Math.cos(a) * r, -0.4, Math.sin(a) * r],
            [0, 0.02, 0],
          ];
        };
  const perFrame = [];
  let differing = 0,
    drawnMin = Infinity,
    drawnMax = 0;
  for (let f = 0; f < frames; f++) {
    const [position, target] = path(f);
    for (const e of [tested, reference]) {
      e.camera.position = position;
      e.camera.target = target;
    }
    tested.render();
    const left = read(tested.canvas);
    reference.render();
    const right = read(reference.canvas);
    let diff = 0,
      lit = 0;
    for (let i = 0; i < left.length; i += 4) {
      if (
        left[i] !== right[i] ||
        left[i + 1] !== right[i + 1] ||
        left[i + 2] !== right[i + 2] ||
        left[i + 3] !== right[i + 3]
      )
        diff++;
      if (Math.abs(left[i] - 5) + Math.abs(left[i + 1] - 6) + Math.abs(left[i + 2] - 9) > 3) lit++;
    }
    differing += diff;
    if (f % 8 === 0 || diff) {
      await tested.gpu.queue.onSubmittedWorkDone();
      const counts = await parts.readCounts(),
        drawn = counts.reduce((x, y) => x + y, 0);
      drawnMin = Math.min(drawnMin, drawn);
      drawnMax = Math.max(drawnMax, drawn);
      perFrame.push({
        frame: f,
        differingPixels: diff,
        nonBackgroundPixels: lit,
        drawnParts: drawn,
        position: position.map((v) => +v.toFixed(3)),
      });
    }
  }
  const twinRed = (() => {
    const px = read(tested.canvas);
    let red = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > px[i + 2] + 40) red++;
    return red;
  })();
  const result = {
    modules,
    culling,
    layout,
    frames,
    parts: parts.count,
    size: [tested.canvas.width, tested.canvas.height],
    differingPixels: differing,
    drawnPartsMin: drawnMin,
    drawnPartsMax: drawnMax,
    lastFrameTwinPixels: twinRed,
    perFrame,
    errors,
  };
  tested.dispose();
  reference.dispose();
  return result;
}

window.culling = { run, check };
window.ready = true;
