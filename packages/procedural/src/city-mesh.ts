// Meshes for a city from `generateCity`: the road surface and its markings, kerbs, pavements and ground, and every
// building at a level of detail set by its distance, merged by material and by square chunks so each can be culled.
// Level of detail by distance as in Parish and Müller 2001, section 6.2 (https://doi.org/10.1145/383259.383292): far
// buildings are simple volumes. Our own code.
import type { GeometryData } from '@margoengine/geometry/utils';
import { fault } from '../../shared/errors.js';
import {
  BUILDING_STYLE_SETS,
  generateBuilding,
  type Building,
  type BuildingMaterial,
  type BuildingPart,
  type BuildingStyle,
} from './building-rules.js';
import { add2, clipHalf, dot2, left, length2, mul2, sub2, unit2, type Poly, type V2 } from './city-geometry.js';
import type { City, CityBuilding, CityProp } from './city.js';
import { generateTreeMesh } from './foliage.js';
import { MeshBuilder, type V3 } from './mesh-builder.js';

/** A ground part of a city, besides the building parts. */
export type CityGroundPart = 'road' | 'markings' | 'centre-lines' | 'kerb' | 'pavement' | 'paving' | 'lawn';
/** A part of the street trees and lamps. */
export type CityFurniturePart = 'trunk' | 'leaves' | 'lamp-post' | 'lamp-head';
/** `massing` is walls, roof and a band of glass per storey; the others are the details of `generateBuilding`. */
export type CityDetail = 'massing' | 'far' | 'mid' | 'near';
/** Options for {@link buildCity}. */
export interface CityMeshOptions {
  /** `auto` picks each building's detail by its distance from `focus`; else every building takes this one. */
  readonly detail?: 'auto' | CityDetail;
  /** The viewpoint on the ground, world `[x, z]`, for `auto`. Default the city's centre. */
  readonly focus?: readonly [number, number];
  /** `auto`: buildings nearer than these distances, metres, take near, mid and far detail. Default `[25, 70, 260]`. */
  readonly distances?: readonly [number, number, number];
  /** Side of the square chunks the meshes are split into, metres, 20 to 8000. Default 120. */
  readonly chunk?: number;
  /** Lane lines and zebra crossings. Default true. */
  readonly markings?: boolean;
  /**
   * Meshes for the trees and lamps of the city. Default true. With `auto`, trees nearer than the second distance have
   * full crowns, nearer than the third coarse ones, and farther ones eight triangles; lamps stop at the third.
   */
  readonly furniture?: boolean;
  /** Wall colour variants per style, 1 to 8, so neighbours differ. Default 4. */
  readonly variants?: number;
  /** Stop above this many triangles. Default 20 million. */
  readonly maxTriangles?: number;
  /** Called after each building with how many are built and how many there are. */
  readonly onProgress?: (built: number, total: number) => void;
  /** Checked between buildings. */
  readonly signal?: AbortSignal;
}
/** One mesh: a part of one material in one chunk. */
export interface CityPart {
  readonly name: CityGroundPart | CityFurniturePart | BuildingPart;
  readonly material: BuildingMaterial;
  /** Positions (world), normals, UVs in metres, tangents and indices. */
  readonly geometry: GeometryData;
  /** The chunk's column and row: `floor(x / chunk)`, `floor(z / chunk)`. The road surface is one part, `[0, 0]`. */
  readonly chunk: readonly [number, number];
}
/** The meshes of a city. */
export interface CityMeshes {
  readonly parts: readonly CityPart[];
  readonly triangles: number;
  /** How many buildings took each detail. */
  readonly buildings: Readonly<Record<CityDetail, number>>;
}

const paint = (color: readonly [number, number, number], roughness: number): BuildingMaterial => ({
  color,
  roughness,
  metalness: 0,
});
const GROUND: Record<CityGroundPart, BuildingMaterial> = {
  road: paint([0.045, 0.047, 0.05], 0.92),
  markings: paint([0.62, 0.62, 0.6], 0.75),
  'centre-lines': paint([0.62, 0.4, 0.035], 0.75),
  kerb: paint([0.36, 0.35, 0.33], 0.85),
  pavement: paint([0.27, 0.26, 0.24], 0.88),
  paving: paint([0.17, 0.16, 0.145], 0.9),
  lawn: paint([0.06, 0.115, 0.03], 0.96),
};
const FURNITURE: Record<CityFurniturePart, BuildingMaterial> = {
  trunk: paint([0.09, 0.062, 0.038], 0.95),
  leaves: paint([0.055, 0.13, 0.032], 0.85),
  'lamp-post': { color: [0.06, 0.065, 0.07], roughness: 0.5, metalness: 0.7 },
  'lamp-head': paint([0.8, 0.76, 0.62], 0.35),
};
/** Wall tints, multiplied onto a style's wall colour. */
const TINTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [0.78, 0.76, 0.74],
  [1.04, 0.93, 0.8],
  [0.82, 0.9, 1],
  [0.62, 0.55, 0.5],
  [1.08, 1.06, 1],
  [0.9, 0.72, 0.62],
  [0.72, 0.8, 0.74],
];
const UP: V3 = [0, 1, 0];

type Arrays = GeometryData & { uvs: Float32Array; tangents: Float32Array; indices: Uint32Array };
function merge(list: Arrays[]): GeometryData {
  if (list.length === 1) return list[0];
  let vertices = 0,
    indices = 0;
  for (const g of list) {
    vertices += g.positions.length / 3;
    indices += g.indices.length;
  }
  const out = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    uvs: new Float32Array(vertices * 2),
    tangents: new Float32Array(vertices * 4),
    indices: new Uint32Array(indices),
  };
  let v = 0,
    i = 0;
  for (const g of list) {
    out.positions.set(g.positions, v * 3);
    out.normals.set(g.normals as Float32Array, v * 3);
    out.uvs.set(g.uvs, v * 2);
    out.tangents.set(g.tangents, v * 4);
    for (let k = 0; k < g.indices.length; k++) out.indices[i + k] = g.indices[k] + v;
    v += g.positions.length / 3;
    i += g.indices.length;
  }
  return out;
}

/** Walls, roof and one glass band a storey, in the building's local frame. */
function massing(b: CityBuilding): Partial<Record<BuildingPart, Arrays>> {
  const set = BUILDING_STYLE_SETS[b.options.style],
    walls = new MeshBuilder(),
    roof = new MeshBuilder(),
    glass = new MeshBuilder(),
    { width: W, depth: D, storeys, origin, yaw } = b.options,
    kind = b.options.roof ?? set.roof,
    x = W / 2,
    z = D / 2,
    corners: V2[] = [
      [-x, z],
      [x, z],
      [x, -z],
      [-x, -z],
    ];
  let eaves = set.plinth;
  for (const h of storeys) eaves += h;
  const top = kind === 'flat' ? eaves + (b.options.parapet ?? set.parapet) : eaves;
  corners.forEach((a, i) => {
    const c = corners[(i + 1) % 4],
      out: V3 = [
        [0, 0, 1],
        [1, 0, 0],
        [0, 0, -1],
        [-1, 0, 0],
      ][i] as unknown as V3;
    walls.poly(
      [
        [a[0], 0, a[1]],
        [c[0], 0, c[1]],
        [c[0], top, c[1]],
        [a[0], top, a[1]],
      ],
      out,
    );
    const u = unit2(sub2(c, a)),
      l = length2(sub2(c, a)),
      p = add2(add2(a, mul2(u, Math.min(0.7, l / 6))), [out[0] * 0.03, out[2] * 0.03]),
      q = add2(sub2(c, mul2(u, Math.min(0.7, l / 6))), [out[0] * 0.03, out[2] * 0.03]);
    let y = set.plinth;
    for (const h of storeys) {
      glass.poly(
        [
          [p[0], y + h * 0.32, p[1]],
          [q[0], y + h * 0.32, q[1]],
          [q[0], y + h * 0.8, q[1]],
          [p[0], y + h * 0.8, p[1]],
        ],
        out,
      );
      y += h;
    }
  });
  if (kind === 'flat') {
    roof.poly(
      corners.map(([cx, cz]): V3 => [cx, eaves + 0.02, cz]),
      UP,
    );
  } else {
    // A ridge along the longer side; hips pull its ends in by the half depth.
    const alongX = W >= D,
      half = Math.min(W, D) / 2,
      long = Math.max(W, D) / 2,
      rise = Math.tan(((b.options.pitch ?? set.pitch) * Math.PI) / 180) * half,
      inset = kind === 'gable' || kind === 'shed' ? 0 : Math.min(long, half),
      at = (l: number, s: number, y: number): V3 => (alongX ? [l, y, s] : [s, y, l]),
      r0 = at(-(long - inset), 0, eaves + rise),
      r1 = at(long - inset, 0, eaves + rise);
    for (const s of [-1, 1]) roof.poly([at(-long, s * half, eaves), at(long, s * half, eaves), r1, r0], at(0, s, 1));
    for (const [l, r] of [
      [-1, r0],
      [1, r1],
    ] as const)
      (inset ? roof : walls).poly(
        [at(l * long, -half, eaves), at(l * long, half, eaves), r],
        at(l, 0, inset ? 0.5 : 0),
      );
  }
  return {
    walls: walls.finish(origin as V3, yaw) as Arrays,
    roof: roof.finish(origin as V3, yaw) as Arrays,
    glass: glass.finish(origin as V3, yaw) as Arrays,
  };
}

/** A copy of a mesh scaled, turned by yaw about +y and moved. */
function placed(g: Arrays, { position, yaw, scale }: CityProp): Arrays {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    turn = (v: ArrayLike<number>, stride: number, k: number, shift: readonly number[]): Float32Array => {
      const out = Float32Array.from(v);
      for (let i = 0; i < out.length; i += stride) {
        const x = v[i] * k,
          z = v[i + 2] * k;
        out[i] = shift[0] + x * c + z * s;
        out[i + 1] = shift[1] + v[i + 1] * k;
        out[i + 2] = shift[2] - x * s + z * c;
      }
      return out;
    },
    still = [0, 0, 0];
  return {
    positions: turn(g.positions, 3, scale, position),
    normals: turn(g.normals as Float32Array, 3, 1, still),
    tangents: turn(g.tangents, 4, 1, still),
    uvs: g.uvs,
    indices: g.indices,
  };
}

/** A tree in the three levels: full crown, coarse crown, and an eight triangle crown on its trunk's height. */
function treeKinds(): Partial<Record<'trunk' | 'leaves', Arrays>>[] {
  const coarse = generateTreeMesh('broadleaf', { detail: 0 }),
    full = generateTreeMesh('broadleaf', { detail: 1 }),
    crown = new MeshBuilder(),
    top: V3 = [0.2, 7.4, 0],
    foot: V3 = [0.2, 3.2, 0],
    ring: V3[] = [
      [3, 5.3, 0],
      [0.2, 5.3, 2.8],
      [-2.6, 5.3, 0],
      [0.2, 5.3, -2.8],
    ];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % 4],
      out: V3 = [a[0] + b[0] - 0.4, 0, a[2] + b[2]];
    crown.poly([a, b, top], [out[0], 2, out[2]]);
    crown.poly([a, b, foot], [out[0], -2, out[2]]);
  });
  const stem = new MeshBuilder();
  stem.frustum([0, 0, 0], [0.1, 4, 0], 0.3, 0.2, 4, false);
  return [
    { trunk: full.trunk as Arrays, leaves: full.canopy as Arrays },
    { trunk: coarse.trunk as Arrays, leaves: coarse.canopy as Arrays },
    { trunk: stem.finish() as Arrays, leaves: crown.finish() as Arrays },
  ];
}

/** A lamp post six metres high with an arm over the road toward +z. */
function lampKind(): Record<'lamp-post' | 'lamp-head', Arrays> {
  const post = new MeshBuilder(),
    head = new MeshBuilder();
  post.frustum([0, 0, 0], [0, 6, 0], 0.11, 0.07, 6);
  post.beam([0, 5.95, 0], [0, 6.15, 1.3], 0.07, 0.07);
  head.box([0, 6.1, 1.5], [0.17, 0.07, 0.3]);
  return { 'lamp-post': post.finish() as Arrays, 'lamp-head': head.finish() as Arrays };
}

/** A strip of paint on the road, `width` wide, from a to b. */
function stripe(mesh: MeshBuilder, a: V2, b: V2, width: number, y: number): void {
  const side = mul2(left(unit2(sub2(b, a))), width / 2),
    corner = (q: V2): V3 => [q[0], y, q[1]];
  mesh.poly([corner(add2(a, side)), corner(add2(b, side)), corner(sub2(b, side)), corner(sub2(a, side))], UP);
}

/**
 * The meshes of a city. The work yields to the event loop about every 12 ms, so a page stays responsive.
 * @throws MargoError `failed` for a bad option or past `maxTriangles`; the signal's reason when aborted.
 */
export async function buildCity(city: City, options: CityMeshOptions = {}): Promise<CityMeshes> {
  const invalid = (name: string, rule: string) =>
    fault('failed', `Invalid buildCity option ${name}; use ${rule}`, 'procedural');
  if (!city?.options || !city.buildings || !city.blocks || !city.roads)
    throw invalid('city', 'a City from generateCity');
  const {
    detail = 'auto',
    focus = [city.options.centre[0] + city.options.origin[0], city.options.centre[1] + city.options.origin[2]],
    distances = [25, 70, 260],
    chunk = 120,
    markings = true,
    furniture = true,
    variants = 4,
    maxTriangles = 20e6,
    onProgress,
    signal,
  } = options;
  if (!['auto', 'massing', 'far', 'mid', 'near'].includes(detail))
    throw invalid('detail', 'auto, massing, far, mid or near');
  if (!Array.isArray(focus) || focus.length !== 2 || !focus.every(Number.isFinite))
    throw invalid('focus', 'a point [x, z]');
  if (
    !Array.isArray(distances) ||
    distances.length !== 3 ||
    !(distances[0] >= 0 && distances[1] >= distances[0] && distances[2] >= distances[1])
  )
    throw invalid('distances', 'three distances of 0 or more, each at least the one before');
  if (!(chunk >= 20 && chunk <= 8000)) throw invalid('chunk', 'a number from 20 to 8000');
  if (!Number.isInteger(variants) || variants < 1 || variants > 8) throw invalid('variants', 'an integer from 1 to 8');
  if (!(maxTriangles > 0)) throw invalid('maxTriangles', 'a number above 0');
  signal?.throwIfAborted();

  const groups = new Map<string, { part: Omit<CityPart, 'geometry'>; list: Arrays[] }>();
  let triangles = 0;
  const push = (name: CityPart['name'], material: BuildingMaterial, at: readonly [number, number], g: Arrays) => {
    if (!g.indices.length) return;
    triangles += g.indices.length / 3;
    if (triangles > maxTriangles)
      throw fault(
        'failed',
        `The city passes ${maxTriangles} triangles; lower the detail or distances, or raise maxTriangles`,
        'procedural',
      );
    const key = `${name}|${material.color}|${material.roughness}|${material.metalness}|${at}`,
      group = groups.get(key);
    if (group) group.list.push(g);
    else groups.set(key, { part: { name, material, chunk: at }, list: [g] });
  };
  const chunkOf = (q: readonly [number, number]): [number, number] => [
    Math.floor(q[0] / chunk),
    Math.floor(q[1] / chunk),
  ];
  let last = performance.now();
  const breathe = async () => {
    signal?.throwIfAborted();
    if (performance.now() - last < 12) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    last = performance.now();
  };

  const [, base] = city.options.origin,
    curb = city.options.curb,
    surface = new MeshBuilder();
  surface.poly(
    city.edge.map(([x, z]): V3 => [x, base, z]),
    UP,
  );
  push('road', GROUND.road, [0, 0], surface.finish() as Arrays);

  const ground = new Map<string, { name: CityGroundPart; at: [number, number]; mesh: MeshBuilder }>();
  const meshOf = (name: CityGroundPart, at: [number, number]) => {
    const key = `${name}|${at}`;
    let entry = ground.get(key);
    if (!entry) ground.set(key, (entry = { name, at, mesh: new MeshBuilder() }));
    return entry.mesh;
  };

  const top = base + curb,
    up =
      (y: number) =>
      (q: V2): V3 => [q[0], y, q[1]];
  for (const block of city.blocks) {
    await breathe();
    const at = chunkOf(block.centre),
      // Back to positive area in (x, z), the clipping's order.
      kerb = [...block.polygon].reverse() as V2[],
      inner = [...block.inner].reverse() as V2[];
    if (curb > 0)
      for (let i = 0; i < kerb.length; i++) {
        const a = kerb[i],
          b = kerb[(i + 1) % kerb.length],
          n = left(unit2(sub2(b, a)));
        meshOf('kerb', at).poly([up(base)(a), up(base)(b), up(top)(b), up(top)(a)], [-n[0], 0, -n[1]]);
      }
    const fill = block.use === 'park' || block.use === 'residential' ? 'lawn' : 'paving';
    // The pavement is the kerb polygon less the inner one, cut into one convex piece for each inner edge.
    let rest: Poly = { p: kerb, e: kerb.map(() => 0) };
    for (let i = 0; i < inner.length && rest.p.length; i++) {
      const a = inner[i],
        n = left(unit2(sub2(inner[(i + 1) % inner.length], a))),
        c = dot2(n, a),
        outside = clipHalf(rest, [-n[0], -n[1]], -c, 0);
      if (outside.p.length) meshOf('pavement', at).poly(outside.p.map(up(top)), UP);
      rest = clipHalf(rest, n, c, 0);
    }
    if (rest.p.length) meshOf(inner.length ? fill : 'pavement', at).poly(rest.p.map(up(top)), UP);
  }

  if (markings) {
    // The widest road at each node sets how far lines and crossings stand back from it.
    const meeting = city.nodes.map(() => [] as number[]);
    city.roads.forEach((road, i) => {
      meeting[road.from].push(i);
      meeting[road.to].push(i);
    });
    const y = base + 0.012;
    for (let i = 0; i < city.roads.length; i++) {
      const road = city.roads[i],
        a = city.nodes[road.from],
        b = city.nodes[road.to],
        l = length2(sub2(b, a));
      if (!(l > 1)) continue;
      await breathe();
      const u = unit2(sub2(b, a)),
        n = left(u),
        at = chunkOf([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]),
        // A junction is where three or more roads meet; a bend of two keeps its lines.
        back = (node: number) => {
          if (meeting[node].length < 3) return 0;
          let widest = 0;
          for (const k of meeting[node]) if (k !== i) widest = Math.max(widest, city.roads[k].width);
          return widest / 2 + 0.6;
        },
        start = back(road.from),
        end = back(road.to),
        crossing = (stand: number) => (stand > 0 ? stand + 3.6 : 0),
        from = crossing(start),
        to = l - crossing(end),
        along = (s: number, off: number): V2 => add2(add2(a, mul2(u, s)), mul2(n, off));
      if (to - from > 2) {
        const white = meshOf('markings', at);
        if (road.kind === 'avenue') {
          const centre = meshOf('centre-lines', at);
          for (const off of [-0.16, 0.16]) stripe(centre, along(from, off), along(to, off), 0.12, y);
          for (const side of [-1, 1])
            for (let s = from; s + 1 < to; s += 9)
              stripe(
                white,
                along(s, (side * road.width) / 4),
                along(Math.min(to, s + 3), (side * road.width) / 4),
                0.12,
                y,
              );
        } else if (road.width >= 6) {
          for (let s = from; s + 1 < to; s += 9) stripe(white, along(s, 0), along(Math.min(to, s + 3), 0), 0.12, y);
        }
      }
      // Zebra crossings just outside each junction, where the road is long enough for them.
      for (const [stand, s0] of [
        [start, start],
        [end, l - end - 3],
      ] as const) {
        if (!stand || l < start + end + (start ? 3 : 0) + (end ? 3 : 0)) continue;
        const white = meshOf('markings', at),
          half = road.width / 2 - 0.5,
          count = Math.floor((2 * half + 0.5) / 1);
        for (let k = 0; k < count; k++) {
          const off = -((count - 1) / 2) + k;
          stripe(white, along(s0, off), along(s0 + 3, off), 0.5, y);
        }
      }
    }
  }
  for (const { name, at, mesh } of ground.values()) push(name, GROUND[name], at, mesh.finish() as Arrays);

  const palettes = new Map<BuildingStyle, Building['palette']>();
  const paletteOf = (style: BuildingStyle) => {
    let p = palettes.get(style);
    if (!p)
      palettes.set(
        style,
        (p = generateBuilding({ style, detail: 'far', interior: 'none', width: 8, depth: 8, storeys: [3] }).palette),
      );
    return p;
  };
  if (furniture) {
    const away = (p: CityProp) => Math.hypot(p.position[0] - focus[0], p.position[2] - focus[1]),
      trees = city.trees.length ? treeKinds() : [],
      lamp = lampKind(),
      fixed = { near: 0, mid: 0, far: 1, massing: 2, auto: -1 }[detail];
    for (const tree of city.trees) {
      await breathe();
      const d = away(tree),
        level = fixed >= 0 ? fixed : d < distances[1] ? 0 : d < distances[2] ? 1 : 2,
        at = chunkOf([tree.position[0], tree.position[2]]);
      for (const name of ['trunk', 'leaves'] as const)
        push(name, FURNITURE[name], at, placed(trees[level][name] as Arrays, tree));
    }
    for (const prop of city.lamps) {
      await breathe();
      if (detail === 'massing' || (detail === 'auto' && away(prop) >= distances[2])) continue;
      const at = chunkOf([prop.position[0], prop.position[2]]);
      for (const name of ['lamp-post', 'lamp-head'] as const) push(name, FURNITURE[name], at, placed(lamp[name], prop));
    }
  }

  const counts: Record<CityDetail, number> = { massing: 0, far: 0, mid: 0, near: 0 };
  for (let i = 0; i < city.buildings.length; i++) {
    await breathe();
    const b = city.buildings[i],
      { origin, width, depth, style, seed } = b.options;
    let level: CityDetail;
    if (detail === 'auto') {
      const d = Math.max(0, Math.hypot(origin[0] - focus[0], origin[2] - focus[1]) - Math.hypot(width, depth) / 2);
      level = d < distances[0] ? 'near' : d < distances[1] ? 'mid' : d < distances[2] ? 'far' : 'massing';
    } else level = detail;
    counts[level]++;
    const parts =
        level === 'massing'
          ? massing(b)
          : (generateBuilding({
              ...b.options,
              detail: level,
              interior: level === 'far' ? 'none' : 'cells',
            }).parts as Partial<Record<BuildingPart, Arrays>>),
      palette = paletteOf(style),
      tint = TINTS[(seed >>> 0) % variants],
      at = chunkOf([origin[0], origin[2]]);
    for (const [name, g] of Object.entries(parts) as [BuildingPart, Arrays][]) {
      let material = palette[name];
      if (name === 'walls')
        material = {
          ...material,
          color: [
            Math.min(1, material.color[0] * tint[0]),
            Math.min(1, material.color[1] * tint[1]),
            Math.min(1, material.color[2] * tint[2]),
          ],
        };
      push(name, material, at, g);
    }
    onProgress?.(i + 1, city.buildings.length);
  }
  signal?.throwIfAborted();
  return {
    parts: [...groups.values()].map(({ part, list }) => ({ ...part, geometry: merge(list) })),
    triangles,
    buildings: counts,
  };
}
