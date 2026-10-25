// The benchmark scenes, described once. Each scene says what it draws and what it measures, and builds the same plain
// data (positions, rotations, colours, lights, camera path) for every engine, so an engine implementation only turns
// that data into its own objects. Margo's implementation is ./margo.js; other engines' implementations live outside
// this repository (docs/benchmarking.md "Comparing engines"). STANDARD lists the cases each browser suite runs, shared
// by the CLI (bench/cli.mjs) and the in-browser runner (bench/web/), so both run the same scenes with the same code.

import { parityScenes } from './parity.js';

export const CANVAS = [1280, 720];
// Margo core's default light (packages/core/src/engine.ts): direction toward the light, intensity, ambient.
export const LIGHT = { direction: [3, 5, 4], intensity: 3, ambient: 0.15 };
// Margo's clear colour (packages/core/src/renderer.ts), display values.
export const CLEAR = [0.018, 0.023, 0.035];

const hex = (h, s, l) => {
  const a = s * Math.min(l, 1 - l),
    f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16)
        .padStart(2, '0');
    };
  return `#${f(0)}${f(8)}${f(4)}`;
};
export const PALETTE = Array.from({ length: 16 }, (_, i) => hex(i * 22.5, 0.55, 0.55));

/** Deterministic pseudo-random numbers in [0, 1) (a 32-bit LCG), so every engine places the same objects. */
export function random(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Camera circling `target` at `radius` and `height`; `at(t)` is the position at t seconds (0.3 rad/s). */
export function orbit(radius, height, far, near = 0.1, target = [0, 0, 0]) {
  return {
    fov: 45,
    near,
    far,
    target,
    at: (t) => [target[0] + Math.cos(t * 0.3) * radius, target[1] + height, target[2] + Math.sin(t * 0.3) * radius],
  };
}

/** n boxes of 0.5 m on a 1 m cubic grid, 16 colours. */
export function boxes(n) {
  const side = Math.ceil(Math.cbrt(n)),
    half = (side - 1) / 2,
    items = new Array(n);
  for (let i = 0; i < n; i++)
    items[i] = {
      position: [(i % side) - half, (Math.floor(i / side) % side) - half, Math.floor(i / side / side) - half],
      rotation: [0, (i * 0.7) % Math.PI, 0],
      color: i % PALETTE.length,
    };
  return {
    items,
    size: 0.5,
    material: { roughness: 0.5, metalness: 0.1 },
    camera: orbit(Math.max(3, side * 2), Math.max(1.5, side * 0.8), Math.max(100, side * 6)),
  };
}

/** n boxes on a flat grid at y = 0.25 standing on a floor slab whose top is y = 0 (lights and shadows scenes). */
export function yard(n) {
  const side = Math.ceil(Math.sqrt(n)),
    half = (side - 1) / 2,
    pick = random(7),
    items = new Array(n);
  for (let i = 0; i < n; i++)
    items[i] = {
      position: [((i % side) - half) * 1.5, 0.25 + Math.floor(pick() * 3) * 0.5, (Math.floor(i / side) - half) * 1.5],
      rotation: [0, pick() * Math.PI, 0],
      color: i % PALETTE.length,
    };
  const extent = side * 1.5;
  return {
    items,
    size: 0.5,
    material: { roughness: 0.5, metalness: 0.1 },
    floor: { size: [extent + 4, 0.1, extent + 4], position: [0, -0.05, 0], color: '#9a9488', roughness: 0.85 },
    extent,
    camera: orbit(extent * 0.8, extent * 0.45, extent * 6),
  };
}

/** `n` boxes on the yard grid, each with its own size, so each is a distinct geometry (BatchedMesh against one mesh each). */
function shapes(n) {
  const def = yard(n),
    pick = random(5);
  for (const item of def.items) item.size = [0.2 + pick() * 0.5, 0.2 + pick() * 0.5, 0.2 + pick() * 0.5];
  return def;
}

/** `n` boxes sharing `count` distinct PBR materials (colour, roughness and metalness spread over the range). */
function materials(n, count) {
  const def = boxes(n),
    pick = random(3);
  def.materials = Array.from({ length: count }, (_, i) => ({
    color: hex((i * 137.5) % 360, 0.5 + pick() * 0.3, 0.45 + pick() * 0.2),
    roughness: 0.05 + 0.9 * ((i % 16) / 15),
    metalness: Math.floor(i / 16) % 2 ? 0.9 : 0.05,
  }));
  for (const [i, item] of def.items.entries()) item.material = i % count;
  return def;
}

/** `count` coloured point lights circling over the yard; `at(i, t)` is light i's position at t seconds. */
function lights(n, count) {
  const def = yard(n),
    pick = random(11),
    r = def.extent / 2;
  const orbits = Array.from({ length: count }, () => ({
    radius: r * (0.15 + 0.85 * pick()),
    phase: pick() * Math.PI * 2,
    speed: 0.2 + pick() * 0.6,
    height: 1 + pick() * 2,
  }));
  def.lights = orbits.map((o) => ({
    color: [0.4 + 0.6 * pick(), 0.4 + 0.6 * pick(), 0.4 + 0.6 * pick()],
    intensity: 6,
    range: Math.max(4, r * 0.5),
    at: (t) => [Math.cos(o.phase + t * o.speed) * o.radius, o.height, Math.sin(o.phase + t * o.speed) * o.radius],
  }));
  return def;
}

/** SciFiHelmet on a floor slab, lit by a procedural HDR sky (IBL) and the directional light with shadows. */
export const HELMET = {
  file: 'scifi-helmet.glb',
  floor: { size: [6, 0.1, 6], position: [0, -1.05, 0], color: '#9a9488', roughness: 0.85, metalness: 0 },
  camera: orbit(3.3, 0.55, 100, 0.05),
  shadow: { resolution: 2048 },
};
/** Models the gltf scene opens, from the assets folder (examples/assets; sources in THIRD-PARTY-NOTICES.md). */
export const MODELS = {
  'scifi-helmet': { file: 'scifi-helmet.glb', radius: 1.2 },
  'flight-helmet': { file: 'flight-helmet.glb', radius: 0.5, target: [0, 0.3, 0] },
  'robot-expressive': { file: 'robot-expressive.glb', radius: 6, target: [0, 2.5, 0] },
};
/** Equirectangular RGBA float sky: smooth gradient plus a bright sun lobe. */
export function sky(width = 256, height = 128) {
  const data = new Float32Array(width * height * 4),
    sun = [0.5, 0.6, -0.62];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const phi = 2 * Math.PI * ((x + 0.5) / width - 0.5),
        theta = (Math.PI * (y + 0.5)) / height,
        d = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi)];
      const up = Math.max(d[1], 0),
        dot = Math.max(0, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]),
        s = 40 * dot ** 256;
      data.set([0.35 + 0.25 * up + s, 0.4 + 0.35 * up + s, 0.5 + 0.6 * up + s * 0.9, 1], (y * width + x) * 4);
    }
  return { width, height, data };
}

export const CAD_MATERIALS = {
  plate: { color: '#8d99a6', roughness: 0.5, metalness: 0.6 },
  bracket: { color: '#4f7cac', roughness: 0.4, metalness: 0.2 },
  bolt: { color: '#c9ccd1', roughness: 0.3, metalness: 0.9 },
  nut: { color: '#b0a17a', roughness: 0.35, metalness: 0.9 },
  washer: { color: '#d8d8d8', roughness: 0.3, metalness: 0.9 },
};
/**
 * The synthetic CAD assembly of examples/package-benchmarks/cad: modules of 27 parts (plate, two brackets, two
 * fastener sets of 4 bolt + washer + nut) and 3 group nodes, zones of 32 modules, 5 levels deep. A flat node list in
 * creation order; `parent` indexes into it (-1 = scene root). `shapes` holds each part's indexed triangle data.
 */
export async function cad(parts) {
  const { partShapes } = await import('../../examples/package-benchmarks/cad/assembly.js');
  const modules = Math.ceil(parts / 27),
    nodes = [],
    columns = Math.ceil(Math.sqrt(modules)),
    spacing = 0.55;
  const add = (parent, shape, position, rotation = [0, 0, 0]) => nodes.push({ parent, shape, position, rotation }) - 1;
  const root = add(-1, null, [0, 0, 0]);
  let zone;
  for (let m = 0; m < modules; m++) {
    if (m % 32 === 0) zone = add(root, null, [0, 0, 0]);
    const module = add(
      zone,
      null,
      [((m % columns) - columns / 2) * spacing, 0, (Math.floor(m / columns) - columns / 2) * spacing],
      [0, ((m % 4) * Math.PI) / 2, 0],
    );
    add(module, 'plate', [0, 0, 0]);
    add(module, 'bracket', [-0.08, 0.012, 0]);
    add(module, 'bracket', [0.08, 0.012, 0], [0, Math.PI, 0]);
    for (const side of [-1, 1]) {
      const set = add(module, null, [0, 0, side * 0.11]);
      for (const x of [-0.16, -0.06, 0.06, 0.16]) {
        add(set, 'bolt', [x, 0.02, 0]);
        add(set, 'washer', [x, -0.003, 0]);
        add(set, 'nut', [x, -0.013, 0]);
      }
    }
  }
  const extent = columns * spacing;
  return {
    nodes,
    shapes: partShapes(),
    parts: nodes.filter((n) => n.shape).length,
    camera: orbit(extent * 0.75, extent * 0.75 * 0.65, 2000, 0.05),
  };
}

/**
 * Every scene: what it draws, what it measures, its parameters with defaults, and `data(params, {assets})`, the
 * engine-neutral description an engine builds (`assets` is the URL of the folder holding the models, with a slash). Frame metrics (CPU and GPU ms per frame, frames per second, serial frame latency, JS
 * heap, GPU memory) come from the shared harness for every scene; `measures` names the ones the scene is about.
 */
export const SCENES = {
  startup: {
    title: 'Startup',
    draws: 'One lit box through the smallest app path the engine has (Margo: core + stage, `createStage`).',
    measures: ['loadMs (navigation to the first finished frame)', 'firstFrameMs', 'createMs', 'jsBytes'],
    fresh: 'browser',
    params: {},
    data: () => ({ color: '#84d6bd', size: 1, camera: orbit(3, 1.6, 100) }),
  },
  boxes: {
    title: 'Boxes',
    draws:
      'n boxes of 0.5 m on a cubic grid with 16 colours and an orbiting camera. move=1 spins every box every frame; ' +
      'mode=instanced draws them through the engine instancing API (static matrices, one batch); mode=culled through ' +
      'its GPU-culled instancing, where it has one (Margo: @margoengine/culling CulledInstances). views=4 draws the ' +
      'boxes four times a frame, one quarter of the canvas each (split screen), through four cameras on the same ' +
      'orbit a quarter turn apart.',
    measures: ['cpuMs', 'gpuMs', 'fps', 'buildMs', 'drawCalls'],
    params: { n: 10_000, mode: 'mesh', move: 0, views: 1 },
    data: (p) => boxes(p.n),
  },
  materials: {
    title: 'Materials',
    draws: '4,096 boxes sharing 256 distinct PBR materials (colour, roughness and metalness spread over the range).',
    measures: ['cpuMs', 'gpuMs', 'fps'],
    params: { n: 4096, count: 256 },
    data: (p) => materials(p.n, p.count),
  },
  lights: {
    title: 'Lights',
    draws: '1,000 boxes on a floor lit by 64 coloured point lights that move every frame.',
    measures: ['cpuMs', 'gpuMs', 'fps'],
    params: { n: 1000, lights: 64 },
    data: (p) => lights(p.n, p.lights),
  },
  shadows: {
    title: 'Shadows',
    draws: '1,000 boxes on a floor, the directional light casting a 2048 x 2048 shadow map, camera orbiting.',
    measures: ['cpuMs', 'gpuMs', 'fps'],
    params: { n: 1000, resolution: 2048 },
    data: (p) => ({ ...yard(p.n), resolution: p.resolution }),
  },
  post: {
    title: 'Post-processing',
    draws: '1,000 boxes on a floor through ambient occlusion, bloom, tone mapping and FXAA.',
    measures: ['cpuMs', 'gpuMs', 'fps'],
    params: { n: 1000 },
    data: (p) => ({ ...yard(p.n), effects: ['ambient-occlusion', 'bloom', 'tonemap', 'fxaa'] }),
  },
  shapes: {
    title: 'Distinct shapes',
    draws:
      'n boxes on a floor, each with its own size (n distinct geometries). mode=mesh draws one object each; ' +
      'mode=batched draws them all as one batched mesh (Margo: @margoengine/materials/batched).',
    measures: ['cpuMs', 'gpuMs', 'fps', 'drawCalls'],
    params: { n: 1000, mode: 'mesh' },
    data: (p) => shapes(p.n),
  },
  cad: {
    title: 'CAD assembly',
    draws: 'The synthetic 5-level CAD assembly (plates, brackets, bolts, washers, nuts) with n parts, one object each.',
    measures: ['cpuMs', 'gpuMs', 'fps', 'buildMs'],
    params: { n: 10_000 },
    data: (p) => cad(p.n),
  },
  gltf: {
    title: 'glTF load',
    draws: 'Opens one GLB with the engine glTF loader (default light), then renders it with an orbiting camera.',
    measures: ['buildMs (load and parse to scene objects)', 'firstFrameMs', 'cpuMs', 'gpuMs'],
    params: { model: 'scifi-helmet' },
    data: (p, { assets }) => {
      const m = MODELS[p.model];
      if (!m) throw new Error(`unknown model ${p.model}; one of ${Object.keys(MODELS).join(', ')}`);
      return {
        ...m,
        url: assets + m.file,
        camera: orbit(m.radius * 2.8, m.radius * 0.5, m.radius * 100, m.radius / 50, m.target),
      };
    },
  },
  helmet: {
    title: 'Lit glTF',
    draws: 'SciFiHelmet on a floor with image-based lighting from a procedural sky and a 2048 shadow map.',
    measures: ['cpuMs', 'gpuMs', 'fps', 'buildMs'],
    params: {},
    data: (p, { assets }) => ({ ...HELMET, url: assets + HELMET.file, sky: sky() }),
  },
  react: {
    title: 'React',
    draws:
      'n boxes declared as React components (Margo: @margoengine/react); every frame re-renders all n with new ' +
      'rotations, so cpuMs is reconcile + commit + draw.',
    measures: ['buildMs (mount)', 'cpuMs (re-render + frame)', 'gpuMs'],
    params: { n: 1000 },
    data: (p) => boxes(p.n),
  },
  ...computeScenes(),
  ...vizScenes(),
};

/**
 * GPU compute task scenes (bench/suites/compute.mjs). Each call queues the job on inputs already in GPU memory and
 * waits until the GPU has finished it (no read-back). `work(params)` is the job's size in the unit its rate is quoted
 * in, so every engine is judged on the same amount of work.
 */
function computeScenes() {
  const floats = (n, seed) => {
    const pick = random(seed),
      out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = pick() * 2 - 1;
    return out;
  };
  const task = (title, draws, n, work, data) => ({
    kind: 'task',
    suite: 'data',
    title,
    draws,
    measures: ['taskMs (queue + GPU finish, inputs on the GPU)', 'coldMs (first call: shader compile)'],
    // backend 'cpu': the same job on @margoengine/compute's CPU fallback (createCompute({ backend: 'cpu' })).
    params: { n, backend: 'webgpu' },
    work,
    data,
  });
  const bytes = (per) => (p) => ({ amount: p.n * per, unit: 'GB/s', scale: 1e9 });
  return {
    'compute-sort': task(
      'Sort',
      'One call sorts n f32 keys (uniform in [-1, 1)) ascending into a new array. Rate: keys per second.',
      1 << 20,
      (p) => ({ amount: p.n, unit: 'Mkeys/s', scale: 1e6 }),
      (p) => ({ values: floats(p.n, 101) }),
    ),
    'compute-scan': task(
      'Prefix sum',
      'One call computes the inclusive prefix sum of n f32 values into a new array. Rate: 8n bytes (read + write).',
      1 << 20,
      bytes(8),
      (p) => ({ values: floats(p.n, 102) }),
    ),
    'compute-reduce': task(
      'Sum',
      'One call sums n f32 values to one value. Rate: 4n bytes read.',
      1 << 20,
      bytes(4),
      (p) => ({ values: floats(p.n, 103) }),
    ),
    'compute-histogram': task(
      'Histogram',
      'One call counts n f32 values into 256 equal bins over [-1, 1]. Rate: 4n bytes read.',
      1 << 20,
      bytes(4),
      (p) => ({ values: floats(p.n, 104), bins: 256, range: [-1, 1] }),
    ),
    'compute-random': task(
      'Random normals',
      'One call draws n standard normal f32 samples (counter-based generator, fixed seed). Rate: 4n bytes written.',
      1 << 20,
      bytes(4),
      () => ({ seed: 42 }),
    ),
    'compute-matmul': task(
      'Matrix product',
      'One call multiplies two n x n f32 matrices (entries uniform in [-1, 1)). Rate: 2n^3 floating-point operations.',
      1024,
      (p) => ({ amount: 2 * p.n ** 3, unit: 'GFLOP/s', scale: 1e9 }),
      (p) => ({ a: floats(p.n * p.n, 105), b: floats(p.n * p.n, 106) }),
    ),
    'compute-fft': task(
      'FFT',
      'One call takes the complex FFT of n real f32 samples (n a power of two). Rate: the conventional 5 n log2(n) ' +
        'operations of a complex FFT.',
      1 << 20,
      (p) => ({ amount: 5 * p.n * Math.log2(p.n), unit: 'GFLOP/s', scale: 1e9 }),
      (p) => ({ values: floats(p.n, 107) }),
    ),
    'compute-spmv': task(
      'Sparse matrix-vector product',
      'One call multiplies the 2-D Laplacian of an n x n grid (5-point stencil, n^2 rows, CSR) by a vector. Rate: ' +
        'the least traffic it needs (values and columns per entry; row offsets, x and y once per row).',
      512,
      (p) => {
        const rows = p.n * p.n,
          nnz = 5 * rows - 4 * p.n;
        return { amount: nnz * 8 + rows * 12, unit: 'GB/s', scale: 1e9 };
      },
      (p) => laplacian(p.n),
    ),
    'compute-cg': task(
      'Conjugate gradient',
      'One call runs 100 Jacobi-preconditioned conjugate gradient iterations on the 2-D Laplacian of an n x n grid ' +
        '(tolerance 0, one residual read-back). Rate: iterations per second.',
      256,
      () => ({ amount: 100, unit: 'iter/s', scale: 1 }),
      (p) => laplacian(p.n),
    ),
  };
}

/** The 2-D Laplacian of an n x n grid as coordinates (5-point stencil, Dirichlet boundary). */
function laplacian(n) {
  const rows = [],
    cols = [],
    values = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const at = i * n + j;
      rows.push(at);
      cols.push(at);
      values.push(4);
      for (const [d, ok] of [
        [-n, i > 0],
        [n, i < n - 1],
        [-1, j > 0],
        [1, j < n - 1],
      ])
        if (ok) {
          rows.push(at);
          cols.push(at + d);
          values.push(-1);
        }
    }
  return { rows, cols, values, size: n * n };
}

/** Data visualisation frame scenes (bench/suites/viz.mjs): one figure, the camera circling it. */
function vizScenes() {
  const camera = orbit(3.9, 1.7, 100, 0.01);
  const frame = (title, draws, n, data) => ({
    suite: 'data',
    title,
    draws,
    measures: ['buildMs (data to first figure)', 'cpuMs', 'gpuMs', 'fps'],
    params: { n },
    data: (p) => ({ ...data(p), camera }),
  });
  return {
    'viz-scatter': frame(
      'Scatter plot',
      'n points in a 3D scatter plot coloured by a colour map (a noisy helix), with axes; level of detail off ' +
        '(the point budget covers every point).',
      1_000_000,
      (p) => {
        const pick = random(201),
          x = new Float32Array(p.n),
          y = new Float32Array(p.n),
          z = new Float32Array(p.n);
        for (let i = 0; i < p.n; i++) {
          const t = (i / p.n) * 40;
          x[i] = Math.cos(t) * (1 + 0.3 * pick());
          y[i] = Math.sin(t) * (1 + 0.3 * pick());
          z[i] = t / 40 + 0.05 * pick();
        }
        return { x, y, z };
      },
    ),
    'viz-surface': frame(
      'Surface plot',
      'An n x n height field (sin x cos y ripples) coloured by height with 12 contour lines, with axes.',
      1024,
      (p) => {
        const z = new Float32Array(p.n * p.n);
        for (let j = 0; j < p.n; j++)
          for (let i = 0; i < p.n; i++) z[j * p.n + i] = Math.sin(i / (p.n / 12)) * Math.cos(j / (p.n / 9));
        return { z };
      },
    ),
    'viz-volume': frame(
      'Volume rendering',
      'An n^3 scalar field (a Gaussian blob with ripples) ray-marched with a colour map and opacity ramp, with axes.',
      128,
      (p) => {
        const v = new Float32Array(p.n ** 3),
          h = p.n / 2;
        for (let k = 0; k < p.n; k++)
          for (let j = 0; j < p.n; j++)
            for (let i = 0; i < p.n; i++) {
              const r = Math.hypot(i - h, j - h, k - h) / h;
              v[(k * p.n + j) * p.n + i] = Math.exp(-3 * r * r) * (0.75 + 0.25 * Math.cos(r * 12));
            }
        return { values: v };
      },
    ),
  };
}

// The parity scenes (docs/whitepaper/perf-vs-threejs.md), built from the helpers above.
Object.assign(SCENES, parityScenes({ PALETTE, boxes, orbit, random, yard }));

/** The cases each browser suite runs (scene + parameters). */
export const STANDARD = {
  startup: [{ scene: 'startup' }],
  render: [
    { scene: 'boxes', params: { n: 10_000 } },
    { scene: 'materials' },
    { scene: 'lights' },
    { scene: 'shadows' },
    { scene: 'post' },
  ],
  objects: [
    { scene: 'boxes', params: { n: 10_000 } },
    { scene: 'boxes', params: { n: 10_000, move: 1 } },
    { scene: 'boxes', params: { n: 10_000, mode: 'instanced' } },
    { scene: 'boxes', params: { n: 10_000, mode: 'instanced', move: 1 } },
  ],
  instanced: [
    ...[1000, 10_000, 50_000].flatMap((n) =>
      ['instanced', 'culled'].map((mode) => ({ scene: 'boxes', params: { n, mode } })),
    ),
    ...['instanced', 'culled'].map((mode) => ({ scene: 'boxes', params: { n: 10_000, mode, move: 1 } })),
  ],
  scaling: [
    ...[1, 100, 1000, 10_000, 100_000].map((n) => ({ scene: 'boxes', params: { n } })),
    ...[100_000, 250_000].map((n) => ({ scene: 'boxes', params: { n, mode: 'instanced' } })),
    // Four views of one scene (docs/multi-view-roadmap.md): the per-view cost against the single-view cases above.
    ...[10_000, 100_000].map((n) => ({ scene: 'boxes', params: { n, views: 4 } })),
    // Shadow casters (render has 1,000): every caster is drawn into each of the 4 cascades.
    ...[400, 5000, 10_000].map((n) => ({ scene: 'shadows', params: { n } })),
    // Distinct geometries: one draw each, against one batched mesh for all of them.
    ...[1000, 10_000].flatMap((n) => ['mesh', 'batched'].map((mode) => ({ scene: 'shapes', params: { n, mode } }))),
  ],
  gltf: [
    { scene: 'gltf', params: { model: 'scifi-helmet' } },
    { scene: 'gltf', params: { model: 'flight-helmet' } },
    { scene: 'gltf', params: { model: 'robot-expressive' } },
    { scene: 'helmet' },
  ],
  cad: [
    { scene: 'cad', params: { n: 10_000 } },
    { scene: 'cad', params: { n: 50_000 } },
  ],
  memory: [
    { scene: 'boxes', params: { n: 10_000 } },
    { scene: 'boxes', params: { n: 100_000, mode: 'instanced' } },
    { scene: 'helmet' },
  ],
  react: [{ scene: 'react', params: { n: 1000 } }],
  compute: [
    ...[1 << 16, 1 << 20, 1 << 22].map((n) => ({ scene: 'compute-sort', params: { n } })),
    ...[1 << 20, 1 << 24].flatMap((n) =>
      ['compute-scan', 'compute-reduce', 'compute-histogram', 'compute-random'].map((scene) => ({
        scene,
        params: { n },
      })),
    ),
    ...[256, 1024, 2048].map((n) => ({ scene: 'compute-matmul', params: { n } })),
    ...[1 << 16, 1 << 20, 1 << 22].map((n) => ({ scene: 'compute-fft', params: { n } })),
    // The CPU fallback on the same jobs, at the sizes it finishes in reasonable time.
    ...['compute-sort', 'compute-scan', 'compute-reduce', 'compute-histogram', 'compute-random', 'compute-fft'].map(
      (scene) => ({ scene, params: { n: 1 << 20, backend: 'cpu' } }),
    ),
    ...[256, 512].map((n) => ({ scene: 'compute-matmul', params: { n, backend: 'cpu' } })),
    ...[256, 1024].map((n) => ({ scene: 'compute-spmv', params: { n } })),
    { scene: 'compute-cg', params: { n: 256 } },
    { scene: 'compute-spmv', params: { n: 256, backend: 'cpu' } },
    { scene: 'compute-cg', params: { n: 128, backend: 'cpu' } },
  ],
  viz: [
    ...[100_000, 1_000_000, 4_000_000].map((n) => ({ scene: 'viz-scatter', params: { n } })),
    ...[256, 1024].map((n) => ({ scene: 'viz-surface', params: { n } })),
    ...[64, 128].map((n) => ({ scene: 'viz-volume', params: { n } })),
  ],
};

/** Parameters with the scene defaults filled in. */
export function sceneParams(scene, params = {}) {
  const def = SCENES[scene];
  if (!def) throw new Error(`unknown scene ${scene}; one of ${Object.keys(SCENES).join(', ')}`);
  return { ...def.params, ...params };
}

/** Stable case id: scene, then every parameter that differs from the default (boxes-n100000-instanced). */
export function caseId(scene, params = {}) {
  const def = SCENES[scene].params,
    parts = [scene];
  for (const [k, v] of Object.entries({ ...def, ...params })) {
    if (k === 'mode') {
      if (v !== 'mesh') parts.push(v);
    } else if (k === 'move') {
      if (v) parts.push('moving');
    } else if (k === 'model') parts.push(v);
    else if (k === 'n') parts.push(`${v}`);
    else if (v !== def[k]) parts.push(`${k}${v}`);
  }
  return parts.join('-');
}
