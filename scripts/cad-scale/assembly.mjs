// Deterministic CAD-like assemblies for the scale ceiling test (scripts/cad-scale-tests.js). An assembly is a grid of
// machinery modules of 50 parts each: a base plate, two L brackets and a stepped shaft whose sizes differ per module
// (4 distinct geometries per module), and 46 fasteners from 9 shared geometries (screws, washers and nuts in 3 sizes),
// rotated like real fasteners. About 8 % of the parts are distinct; the rest repeat, as in real machinery. Every part is
// a closed solid with hard edges where faces meet and smooth normals on round surfaces. Units are millimetres.
//
// Two encodings of the same parts:
// - OBJ: every part an `o` group of world-space triangles (what a user drops into parseCADAsync). Written in chunks;
//   generation stops once the file passes `limitBytes` (the CAD loader's 64 MiB input cap), and `oversize` says so.
// - GLB: one mesh per distinct geometry; a geometry used more than once is one node with EXT_mesh_gpu_instancing
//   (what a STEP-to-GLB converter writes); a geometry used once is a node with its own translation and rotation.
//   Four PBR materials, one per part family (plate, bracket, shaft, fastener), as a converter carries CAD colours over.

export const PARTS_PER_MODULE = 50;
/** Bump when what this file writes changes, so cached assemblies are rewritten. */
export const GENERATOR = 2;

// glTF materials by geometry key prefix: base colour (linear), metallic, roughness. Moderate metalness, because the
// benchmarks light the parts without an environment map (a fully metallic part would show only its specular lobe).
const MATERIALS = [
  { name: 'painted plate', prefix: 'plate-', color: [0.3, 0.33, 0.36], metallic: 0.3, roughness: 0.55 },
  { name: 'blue bracket', prefix: 'bracket-', color: [0.08, 0.2, 0.42], metallic: 0.1, roughness: 0.45 },
  { name: 'steel shaft', prefix: 'shaft-', color: [0.62, 0.63, 0.65], metallic: 0.7, roughness: 0.3 },
  { name: 'zinc fastener', prefix: '', color: [0.7, 0.68, 0.6], metallic: 0.8, roughness: 0.35 },
];

// --- geometry --------------------------------------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A mesh under construction: positions, normals (3 per vertex) and triangle indices. */
function mesh() {
  return { positions: [], normals: [], indices: [] };
}
function vertex(m, p, n) {
  m.positions.push(p[0], p[1], p[2]);
  m.normals.push(n[0], n[1], n[2]);
  return m.positions.length / 3 - 1;
}
/**
 * One quad (or triangle when `points` has 3 corners) with a normal per corner, wound counter-clockwise seen from the
 * side its normals point to: the winding is taken from the corners, flipped if it disagrees with the normals.
 */
function polygon(m, points, normals) {
  const facing = normals.reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]),
    geometric = cross(sub(points[1], points[0]), sub(points[2], points[0])),
    order = dot(geometric, facing) < 0 ? [...points.keys()].reverse() : [...points.keys()],
    ids = order.map((i) => vertex(m, points[i], normals[i]));
  m.indices.push(ids[0], ids[1], ids[2]);
  if (ids.length === 4) m.indices.push(ids[0], ids[2], ids[3]);
}
const flat = (points, normal) => points.map(() => normal);

/** Closed cylinder along +Y from y0 to y1 at (cx, cz): smooth side, flat caps. */
function cylinder(m, { r, y0, y1, seg, cx = 0, cz = 0 }) {
  const ring = (y) =>
    Array.from({ length: seg + 1 }, (_, i) => {
      const a = (2 * Math.PI * i) / seg;
      return { p: [cx + r * Math.cos(a), y, cz + r * Math.sin(a)], n: [Math.cos(a), 0, Math.sin(a)] };
    });
  const low = ring(y0),
    high = ring(y1);
  for (let i = 0; i < seg; i++) {
    polygon(m, [low[i].p, high[i].p, high[i + 1].p, low[i + 1].p], [low[i].n, high[i].n, high[i + 1].n, low[i + 1].n]);
    polygon(m, [[cx, y1, cz], high[i + 1].p, high[i].p], flat([0, 0, 0], [0, 1, 0]));
    polygon(m, [[cx, y0, cz], low[i].p, low[i + 1].p], flat([0, 0, 0], [0, -1, 0]));
  }
}

/** Distance from the axis to a regular hexagon's edge (circumradius `R`, corners at 0, 60, ... degrees) at angle `a`. */
function hexDistance(R, a) {
  const sector = Math.floor(a / (Math.PI / 3)),
    middle = Math.PI / 6 + sector * (Math.PI / 3);
  return (R * Math.cos(Math.PI / 6)) / Math.cos(a - middle);
}

/** Closed ring along +Y (washer, or a hex nut when `hex`): outer side, inner bore, flat annular top and bottom. */
function ring(m, { outer, inner, y0, y1, seg, hex = false }) {
  const step = (2 * Math.PI) / seg,
    angle = (i) => (i === seg ? 2 * Math.PI - 1e-12 : i * step),
    outerAt = (i) => (hex ? hexDistance(outer, angle(i)) : outer),
    at = (r, i, y) => [r * Math.cos(i * step), y, r * Math.sin(i * step)];
  for (let i = 0; i < seg; i++) {
    const o0 = outerAt(i),
      o1 = outerAt(i + 1);
    // Outer side: radial normals (round) or the hexagon side's own normal (hard corners at the hex vertices).
    const side = hex
      ? (() => {
          const s = Math.floor(angle(i) / (Math.PI / 3)),
            mid = Math.PI / 6 + s * (Math.PI / 3);
          return [
            [Math.cos(mid), 0, Math.sin(mid)],
            [Math.cos(mid), 0, Math.sin(mid)],
          ];
        })()
      : [
          [Math.cos(i * step), 0, Math.sin(i * step)],
          [Math.cos((i + 1) * step), 0, Math.sin((i + 1) * step)],
        ];
    polygon(
      m,
      [at(o0, i, y0), at(o0, i, y1), at(o1, i + 1, y1), at(o1, i + 1, y0)],
      [side[0], side[0], side[1], side[1]],
    );
    // Bore: normals point to the axis.
    const b0 = [-Math.cos(i * step), 0, -Math.sin(i * step)],
      b1 = [-Math.cos((i + 1) * step), 0, -Math.sin((i + 1) * step)];
    polygon(m, [at(inner, i, y0), at(inner, i + 1, y0), at(inner, i + 1, y1), at(inner, i, y1)], [b0, b1, b1, b0]);
    polygon(
      m,
      [at(o1, i + 1, y1), at(o0, i, y1), at(inner, i, y1), at(inner, i + 1, y1)],
      flat([0, 0, 0, 0], [0, 1, 0]),
    );
    polygon(
      m,
      [at(o0, i, y0), at(o1, i + 1, y0), at(inner, i + 1, y0), at(inner, i, y0)],
      flat([0, 0, 0, 0], [0, -1, 0]),
    );
  }
}

/** Closed axis-aligned box from `min` to `max`, one flat normal per face. */
function box(m, min, max) {
  const [x0, y0, z0] = min,
    [x1, y1, z1] = max;
  const faces = [
    [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
      [1, 0, 0],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
      [-1, 0, 0],
    ],
    [
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
      [0, 1, 0],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [0, -1, 0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
      [0, 0, 1],
    ],
    [
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y0, z0],
      [0, 0, -1],
    ],
  ];
  for (const [a, b, c, d, n] of faces) polygon(m, [a, b, c, d], flat([a, b, c, d], n));
}

/** Closed L-profile bracket: legs `a` (along X) and `b` (along Y), thickness `t`, extruded `w` along Z. */
function bracket(m, { a, b, t, w }) {
  const profile = [
      [0, 0],
      [a, 0],
      [a, t],
      [t, t],
      [t, b],
      [0, b],
    ],
    at = ([x, y], z) => [x, y, z];
  // Two caps, each the L split into two quads.
  for (const [z, n] of [
    [w, [0, 0, 1]],
    [0, [0, 0, -1]],
  ]) {
    polygon(m, [at(profile[0], z), at(profile[1], z), at(profile[2], z), at([0, t], z)], flat([0, 0, 0, 0], n));
    polygon(m, [at([0, t], z), at(profile[3], z), at(profile[4], z), at(profile[5], z)], flat([0, 0, 0, 0], n));
  }
  // Six sides; the profile runs counter-clockwise, so (dy, -dx) is each edge's outward normal.
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i],
      q = profile[(i + 1) % profile.length],
      n = unit([q[1] - p[1], -(q[0] - p[0]), 0]);
    polygon(m, [at(p, 0), at(q, 0), at(q, w), at(p, w)], flat([0, 0, 0, 0], n));
  }
}

// --- parts -------------------------------------------------------------------------------------------------------
const SIZES = [3, 4, 5]; // fastener diameters, mm

function screw(d, seg) {
  const m = mesh(),
    length = 4 * d;
  cylinder(m, { r: 0.8 * d, y0: 0, y1: d, seg }); // head
  cylinder(m, { r: d / 2, y0: -length, y1: 0, seg }); // shank
  return m;
}
function washer(d, seg) {
  const m = mesh();
  ring(m, { outer: d, inner: 0.55 * d, y0: 0, y1: 0.2 * d, seg });
  return m;
}
function nut(d, seg) {
  const m = mesh();
  ring(m, { outer: 0.95 * d, inner: 0.5 * d, y0: 0, y1: 0.8 * d, seg: Math.ceil(seg / 6) * 6, hex: true });
  return m;
}
/** Base plate with four round bosses; `module` changes its size a little, so every module's plate is distinct. */
function plate(module, seg) {
  const m = mesh(),
    w = 150 + (module % 11) * 2 + (module % 997) * 1e-3,
    t = 8 + (module % 3);
  box(m, [0, -t, 0], [w, 0, w]);
  for (const [x, z] of [
    [20, 20],
    [w - 20, 20],
    [20, w - 20],
    [w - 20, w - 20],
  ])
    cylinder(m, { r: 8, y0: 0, y1: 6, seg: 2 * seg, cx: x, cz: z });
  return m;
}
function bracketPart(module, which) {
  const m = mesh();
  bracket(m, { a: 40 + (module % 5), b: 50 + which * 5 + (module % 7), t: 6, w: 30 + (module % 997) * 1e-3 });
  return m;
}
/** Stepped shaft along +Y (three diameters). */
function shaft(module, seg) {
  const m = mesh(),
    L = 90 + (module % 13) + (module % 997) * 1e-3;
  cylinder(m, { r: 10, y0: 0, y1: L * 0.3, seg: 2 * seg });
  cylinder(m, { r: 13, y0: L * 0.3, y1: L * 0.7, seg: 2 * seg });
  cylinder(m, { r: 10, y0: L * 0.7, y1: L, seg: 2 * seg });
  return m;
}

// --- placement -----------------------------------------------------------------------------------------------------
/** Quaternion (x, y, z, w) for `angle` radians about the unit `axis`. */
const quat = (axis, angle) => [...axis.map((a) => a * Math.sin(angle / 2)), Math.cos(angle / 2)];
function rotate(q, p) {
  const [x, y, z, w] = q,
    t = [2 * (y * p[2] - z * p[1]), 2 * (z * p[0] - x * p[2]), 2 * (x * p[1] - y * p[0])];
  return [
    p[0] + w * t[0] + (y * t[2] - z * t[1]),
    p[1] + w * t[1] + (z * t[0] - x * t[2]),
    p[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

/**
 * The parts of an assembly of `count` parts: `{ name, key, rotation, translation }`, where `key` names the geometry.
 * `geometry(key)` builds that geometry (cached). `detail` sets round-surface segments: 'low' 12, 'normal' 24, 'high' 48.
 */
export function assembly(count, { detail = 'normal' } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  const seg = { low: 12, normal: 24, high: 48 }[detail];
  if (!seg) throw new RangeError("detail must be 'low', 'normal' or 'high'");
  const modules = Math.ceil(count / PARTS_PER_MODULE),
    columns = Math.ceil(Math.sqrt(modules)),
    parts = [],
    up = [0, 1, 0],
    builders = new Map();
  const add = (name, key, build, rotation, translation) => {
    if (parts.length >= count) return;
    if (!builders.has(key)) builders.set(key, build);
    parts.push({ name, key, rotation, translation });
  };
  for (let module = 0; module < modules && parts.length < count; module++) {
    const ox = (module % columns) * 220,
      oz = Math.floor(module / columns) * 220,
      d = SIZES[module % SIZES.length],
      tag = `m${module}`;
    add(`${tag}-plate`, `plate-${module}`, () => plate(module, seg), [0, 0, 0, 1], [ox, 0, oz]);
    add(`${tag}-bracket-a`, `bracket-${module}-0`, () => bracketPart(module, 0), [0, 0, 0, 1], [ox + 30, 0, oz + 60]);
    add(`${tag}-bracket-b`, `bracket-${module}-1`, () => bracketPart(module, 1), quat(up, Math.PI), [
      ox + 130,
      0,
      oz + 90,
    ]);
    add(`${tag}-shaft`, `shaft-${module}`, () => shaft(module, seg), quat([0, 0, 1], -Math.PI / 2), [
      ox + 25,
      60,
      oz + 75,
    ]);
    for (let i = 0; i < 16; i++) {
      const x = ox + 30 + (i % 4) * 30,
        z = oz + 30 + Math.floor(i / 4) * 30,
        spin = quat(up, ((i * 37 + module * 11) % 360) * (Math.PI / 180));
      // Washer on the plate, screw head on the washer, nut under the plate (plate thickness 8-10 mm).
      add(`${tag}-washer-${i}`, `washer-${d}`, () => washer(d, seg), spin, [x, 0, z]);
      add(`${tag}-screw-${i}`, `screw-${d}`, () => screw(d, seg), spin, [x, 0.2 * d, z]);
      if (i < 14) add(`${tag}-nut-${i}`, `nut-${d}`, () => nut(d, seg), spin, [x, -10 - 0.8 * d, z]);
    }
  }
  const cache = new Map(),
    geometry = (key) => {
      if (!cache.has(key)) cache.set(key, builders.get(key)());
      return cache.get(key);
    };
  return { parts, geometry, keys: [...builders.keys()] };
}

/** Counts and bounds of an assembly, computed from its geometry. */
export function summary({ parts, geometry, keys }) {
  const uses = new Map();
  for (const p of parts) uses.set(p.key, (uses.get(p.key) ?? 0) + 1);
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity],
    local = new Map();
  for (const p of parts) {
    const g = geometry(p.key);
    triangles += g.indices.length / 3;
    // Bounds from the transformed corners of the geometry's local box (exact enough to frame the camera).
    if (!local.has(p.key)) {
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < g.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], g.positions[i + a]);
          hi[a] = Math.max(hi[a], g.positions[i + a]);
        }
      local.set(p.key, [lo, hi]);
    }
    const [lo, hi] = local.get(p.key);
    for (let c = 0; c < 8; c++) {
      const corner = rotate(p.rotation, [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], corner[a] + p.translation[a]);
        max[a] = Math.max(max[a], corner[a] + p.translation[a]);
      }
    }
  }
  return {
    parts: parts.length,
    geometries: keys.length,
    repeated: [...uses.values()].filter((n) => n > 1).length,
    triangles,
    bounds: { min, max },
  };
}

/**
 * Writes the OBJ text through `write(chunk)`; stops once more than `limitBytes` were written. Returns the byte count
 * and whether it stopped early. Coordinates are written to 1e-4 mm, so a vertex two faces share is written identically.
 */
export async function writeOBJ({ parts, geometry }, write, { limitBytes = Infinity } = {}) {
  let bytes = 0,
    lines = [];
  const flush = async () => {
    const chunk = `${lines.join('\n')}\n`;
    lines = [];
    bytes += Buffer.byteLength(chunk);
    await write(chunk);
  };
  lines.push(`# Margo scale-test assembly: ${parts.length} parts`);
  for (const p of parts) {
    const g = geometry(p.key),
      n = g.positions.length / 3;
    lines.push(`o ${p.name}`);
    for (let i = 0; i < n; i++) {
      const w = rotate(p.rotation, [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]]);
      lines.push(
        `v ${(w[0] + p.translation[0]).toFixed(4)} ${(w[1] + p.translation[1]).toFixed(4)} ${(w[2] + p.translation[2]).toFixed(4)}`,
      );
    }
    for (let t = 0; t < g.indices.length; t += 3)
      lines.push(`f ${g.indices[t] - n} ${g.indices[t + 1] - n} ${g.indices[t + 2] - n}`);
    if (lines.length > 20_000) await flush();
    if (bytes > limitBytes) return { bytes, oversize: true };
  }
  await flush();
  return { bytes, oversize: bytes > limitBytes };
}

/**
 * GLB bytes: one mesh per distinct geometry; repeated geometries as EXT_mesh_gpu_instancing nodes; one material per
 * part family.
 */
export function writeGLB({ parts, geometry, keys }) {
  const chunks = [],
    views = [],
    accessors = [],
    meshes = [],
    nodes = [];
  let length = 0;
  const view = (typed) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes);
    const pad = -bytes.length & 3;
    if (pad) chunks.push(new Uint8Array(pad));
    length += bytes.length + pad;
    return views.length - 1;
  };
  const accessor = (typed, type, componentType, extra = {}) => {
    accessors.push({
      bufferView: view(typed),
      componentType,
      count: typed.length / { VEC3: 3, VEC4: 4, SCALAR: 1 }[type],
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const meshOf = new Map();
  for (const key of keys) {
    const g = geometry(key),
      positions = Float32Array.from(g.positions),
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], positions[i + a]);
        hi[a] = Math.max(hi[a], positions[i + a]);
      }
    const wide = positions.length / 3 > 65535,
      indices = wide ? Uint32Array.from(g.indices) : Uint16Array.from(g.indices);
    meshes.push({
      name: key,
      primitives: [
        {
          attributes: {
            POSITION: accessor(positions, 'VEC3', 5126, { min: lo, max: hi }),
            NORMAL: accessor(Float32Array.from(g.normals), 'VEC3', 5126),
          },
          indices: accessor(indices, 'SCALAR', wide ? 5125 : 5123),
          material: MATERIALS.findIndex((m) => key.startsWith(m.prefix)),
        },
      ],
    });
    meshOf.set(key, meshes.length - 1);
  }
  const byKey = new Map();
  for (const p of parts) {
    if (!byKey.has(p.key)) byKey.set(p.key, []);
    byKey.get(p.key).push(p);
  }
  for (const [key, list] of byKey) {
    if (list.length === 1) {
      const [p] = list;
      nodes.push({ name: p.name, mesh: meshOf.get(key), translation: p.translation, rotation: p.rotation });
      continue;
    }
    nodes.push({
      name: `${key} x${list.length}`,
      mesh: meshOf.get(key),
      extensions: {
        EXT_mesh_gpu_instancing: {
          attributes: {
            TRANSLATION: accessor(Float32Array.from(list.flatMap((p) => p.translation)), 'VEC3', 5126),
            ROTATION: accessor(Float32Array.from(list.flatMap((p) => p.rotation)), 'VEC4', 5126),
          },
        },
      },
    });
  }
  const doc = {
      asset: { version: '2.0', generator: 'margo scripts/cad-scale/assembly.mjs' },
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      materials: MATERIALS.map((m) => ({
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: [...m.color, 1],
          metallicFactor: m.metallic,
          roughnessFactor: m.roughness,
        },
      })),
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: length }],
    },
    json = new TextEncoder().encode(JSON.stringify(doc)),
    jsonLength = (json.length + 3) & ~3,
    out = new Uint8Array(28 + jsonLength + length),
    v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  v.setUint32(20 + jsonLength, length, true);
  v.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
