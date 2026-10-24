// The benchmark scenes, described once. Each scene says what it draws and what it measures, and builds the same plain
// data (positions, rotations, colours, lights, camera path) for every engine, so an engine implementation only turns
// that data into its own objects. Margo's implementation is ./margo.js; other engines' implementations live outside
// this repository (docs/benchmarking.md "Comparing engines"). STANDARD lists the cases each browser suite runs, shared
// by the CLI (bench/cli.mjs) and the in-browser runner (bench/web/), so both run the same scenes with the same code.

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
function yard(n) {
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

/** DamagedHelmet on a floor slab, lit by a procedural HDR sky (IBL) and the directional light with shadows. */
export const HELMET = {
  file: 'damaged-helmet.glb',
  floor: { size: [6, 0.1, 6], position: [0, -1.05, 0], color: '#9a9488', roughness: 0.85, metalness: 0 },
  camera: orbit(3.3, 0.55, 100, 0.05),
  shadow: { resolution: 2048 },
};
/** Models the gltf scene opens, from the assets folder (examples/assets; sources in THIRD-PARTY-NOTICES.md). */
export const MODELS = {
  'damaged-helmet': { file: 'damaged-helmet.glb', radius: 1.2 },
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
      'mode=instanced draws them through the engine instancing API (static matrices, one batch). views=4 draws the ' +
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
    params: { model: 'damaged-helmet' },
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
    draws: 'DamagedHelmet on a floor with image-based lighting from a procedural sky and a 2048 shadow map.',
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
};

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
  scaling: [
    ...[1, 100, 1000, 10_000, 100_000].map((n) => ({ scene: 'boxes', params: { n } })),
    ...[100_000, 250_000].map((n) => ({ scene: 'boxes', params: { n, mode: 'instanced' } })),
    // Four views of one scene (docs/multi-view-roadmap.md): the per-view cost against the single-view cases above.
    ...[10_000, 100_000].map((n) => ({ scene: 'boxes', params: { n, views: 4 } })),
    // Shadow casters (render has 1,000): every caster is drawn into each of the 4 cascades.
    ...[400, 5000, 10_000].map((n) => ({ scene: 'shadows', params: { n } })),
  ],
  gltf: [
    { scene: 'gltf', params: { model: 'damaged-helmet' } },
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
