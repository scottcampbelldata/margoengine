// Engine-neutral scene definitions shared by the Margo and three.js sides of the vs-three.js benchmark. Everything here
// is plain data (positions, Euler XYZ rotations, colours, camera path) so both engines build exactly the same scene.

export const CANVAS = [1280, 720];
// Margo core's default light (packages/core/src/engine.ts): direction toward the light [3, 5, 4], intensity 3, white,
// ambient 0.15. three.js multiplies ambient by albedo / PI (BRDF_Lambert); Margo by albedo, hence the PI on the three side.
export const LIGHT = { direction: [3, 5, 4], intensity: 3, ambient: 0.15 };
// Margo's clear colour (packages/core/src/renderer.ts), written as display values.
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

/** N boxes of 0.5 m on a 1 m cubic grid. `move` boxes (the first ones) spin about y every frame. */
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
    camera: orbit(side * 1.25, side * 0.55, side * 6),
  };
}

export const CAD_MATERIALS = {
  plate: { color: '#8d99a6', roughness: 0.5, metalness: 0.6 },
  bracket: { color: '#4f7cac', roughness: 0.4, metalness: 0.2 },
  bolt: { color: '#c9ccd1', roughness: 0.3, metalness: 0.9 },
  nut: { color: '#b0a17a', roughness: 0.35, metalness: 0.9 },
  washer: { color: '#d8d8d8', roughness: 0.3, metalness: 0.9 },
};
/**
 * The CAD assembly of examples/package-benchmarks/cad (assembly.js buildAssembly): modules of 27 parts (plate, two
 * brackets, two fastener sets of 4 bolt + washer + nut) and 3 group nodes, zones of 32 modules, 5 levels deep.
 * Returns a flat node list in creation order; `parent` indexes into it (-1 = root of the scene).
 */
export async function cad(parts) {
  const { partShapes } = await import('../cad/assembly.js'); // loaded only by the CAD scene
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

/** DamagedHelmet on a floor slab, lit by a procedural HDR sky (IBL) and the directional light with shadows. */
export const HELMET = {
  url: '/examples/assets/damaged-helmet.glb',
  floor: { size: [6, 0.1, 6], position: [0, -1.05, 0], color: '#9a9488', roughness: 0.85, metalness: 0 },
  camera: orbit(3.3, 0.55, 100, 0.05),
  shadow: { resolution: 2048 },
};
// Same sky as gates/post-stack.html: equirectangular RGBA float, smooth gradient plus a bright sun lobe.
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

/** Camera circling the origin at `radius`/`height`; `at(t)` gives position for t seconds (0.3 rad/s). */
function orbit(radius, height, far, near = 0.1) {
  return {
    fov: 45,
    near,
    far,
    target: [0, 0, 0],
    at: (t) => [Math.cos(t * 0.3) * radius, height, Math.sin(t * 0.3) * radius],
  };
}
