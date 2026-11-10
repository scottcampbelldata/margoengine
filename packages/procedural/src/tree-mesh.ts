import type { GeometryData } from '@margoengine/geometry';
import { fault } from '../../shared/errors.js';
import type { TreeSkeleton } from './trees.js';

type V = [number, number, number];
/** A number per branch order, starting at the trunk (zero). Unspecified orders use the preset. */
export type TreeLevels = Readonly<Record<number, number>>;
/** Supported species presets, all in metres with +Y up. */
export type TreeSpecies = 'oak' | 'ash' | 'aspen' | 'birch' | 'pine' | 'spruce' | 'willow';
/** Per-order architectural controls, independent of mesh LOD. */
export interface TreeBranchOptions {
  /** Recursive orders after the trunk, 0..4. Default 2. */
  levels?: number;
  /** Angles in degrees, 0..180. Default species dependent. */
  angle?: TreeLevels;
  /** Children per branch, 0..64. Default [8,5,0]. */
  children?: TreeLevels;
  /** Directional tropism. Default direction [0,1,0], strength 0. */
  force?: { direction: readonly [number, number, number]; strength: number };
  /** Random heading deflection per metre, 0..2. Default 0.1. */
  gnarliness?: TreeLevels;
  /** Length in metres, 0.001..1000. Default [8,3,1.2]. */
  length?: TreeLevels;
  /** Base radius in metres, 0.00001..100. Default [0.35,0.12,0.035]. */
  radius?: TreeLevels;
  /** Longitudinal sections, 1..64. Default [12,8,5]. */
  sections?: TreeLevels;
  /** Radial segments, 3..32. Default [12,8,6]. */
  segments?: TreeLevels;
  /** First child position as fraction of parent length, 0..1. Default 0.35. */
  start?: TreeLevels;
  /** Fraction of radius lost at the tip, 0..1. Default 0.9. */
  taper?: TreeLevels;
  /** Azimuth advance per child in degrees, -720..720. Default 137.507764. */
  twist?: TreeLevels;
}
/** Geometry and matching material controls. Returned atlas bytes are owned by the caller. */
export interface TreeMeshOptions {
  /** Default oak. */
  species?: TreeSpecies;
  /** Default deciduous, or evergreen for pine/spruce. */
  type?: 'deciduous' | 'evergreen';
  /** Unsigned 32-bit integer. Default 1. */
  seed?: number;
  /** Architectural parameters, used by generateParametricTree. */
  branch?: TreeBranchOptions;
  /** Bark radius for an input skeleton, 0.00001..100. Default 0.35. */
  radius?: number;
  /** Minimum tip radius, 0.000001..radius. Default radius/30. */
  tipRadius?: number;
  /** Bark appearance. Defaults oak, white tint, smooth, textured, scale [1,1]. */
  bark?: {
    type?: TreeSpecies;
    tint?: number;
    flatShading?: boolean;
    textured?: boolean;
    textureScale?: readonly [number, number];
  };
  /** Leaf appearance. Defaults species type, double cards, 45 degrees, 12 per terminal path, start 0.3, size 0.5m, variance 0.25, white tint, alphaTest 0.5. */
  leaves?: {
    type?: TreeSpecies;
    billboard?: 'single' | 'double' | 'cluster';
    angle?: number;
    count?: number;
    start?: number;
    size?: number;
    sizeVariance?: number;
    tint?: number;
    alphaTest?: number;
  };
  /** Mesh LOD. Defaults 1,1,1,1; billboard inherits leaves. Endpoints and forks always survive. */
  detail?: {
    sectionStride?: number;
    segmentFactor?: number;
    leafStride?: number;
    leafScale?: number;
    billboard?: 'single' | 'double' | 'cluster';
  };
  /** Checked before bounded synchronous generation. Use a worker to cancel in flight. */
  signal?: AbortSignal;
}
/** Minimal structural input; accepts the result of /trees without conversion. */
export interface TreeMeshSkeleton extends Pick<TreeSkeleton, 'positions' | 'parents'> {
  /** Optional positive radius per node; otherwise derived from terminal support area. */
  radii?: Float64Array;
  /** Optional architectural order per node, used for per-order radial resolution. */
  levels?: Uint8Array;
}
/** Owned tileable bark or alpha-masked foliage atlas in linear RGBA8. */
export interface TreeAtlas {
  width: number;
  height: number;
  data: Uint8Array;
}
/** Material inputs for a PBR material and its sampler. */
export interface TreeSurface {
  type: TreeSpecies;
  tint: number;
  textured: boolean;
  alphaTest: number;
  doubleSided: boolean;
  atlas: TreeAtlas;
}
/** Indexed bark and foliage with normals, UVs and tangents, in skeleton coordinates. */
export interface TreeMesh {
  bark: GeometryData;
  leaves: GeometryData;
  radii: Float64Array;
  materials: { bark: TreeSurface; leaves: TreeSurface };
}
/** Architectural skeleton and its completed mesh. */
export interface ParametricTree extends TreeMesh {
  skeleton: TreeMeshSkeleton;
}
/** Distance-based geometry selection, usable with /lod or an instancing system. */
export interface TreeMeshLOD {
  distance: number;
  hysteresis: number;
  mesh: TreeMesh;
}

const species: TreeSpecies[] = ['oak', 'ash', 'aspen', 'birch', 'pine', 'spruce', 'willow'];
const invalid = () =>
  fault(
    'failed',
    'Invalid tree mesh input; use bounded finite settings and a nonzero, parent-first skeleton with at most 16384 nodes',
    'procedural',
  );
const range = (x: number, lo: number, hi: number, integer = false) =>
  Number.isFinite(x) && x >= lo && x <= hi && (!integer || Number.isInteger(x));
const unit = (v: V): V => {
  const n = Math.hypot(...v);
  return n > 1e-12 ? (v.map((x) => x / n) as V) : [0, 1, 0];
};
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V, b: V, scale = 1): V => a.map((x, k) => x + b[k] * scale) as V;
const frame = (axis: V, previous?: V): V => {
  let v = previous ?? (Math.abs(axis[0]) < 0.8 ? [1, 0, 0] : [0, 0, 1]);
  v = add(v, axis, -dot(v, axis));
  return Math.hypot(...v) < 1e-8 ? unit(cross(axis, Math.abs(axis[0]) < 0.8 ? [1, 0, 0] : [0, 0, 1])) : unit(v);
};
const random = (seed: number) => {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const defaults = {
  angle: [0, 55, 45, 40, 35],
  children: [8, 5, 3, 2, 0],
  gnarliness: [0.1, 0.1, 0.1, 0.1, 0.1],
  length: [8, 3, 1.2, 0.5, 0.2],
  radius: [0.35, 0.12, 0.035, 0.01, 0.003],
  sections: [12, 8, 5, 4, 3],
  segments: [12, 8, 6, 5, 4],
  start: [0.35, 0.25, 0.2, 0.2, 0.2],
  taper: [0.9, 0.9, 0.9, 0.9, 0.9],
  twist: [137.507764, 137.507764, 137.507764, 137.507764, 137.507764],
};
type Field = keyof typeof defaults;
const bounds: Record<Field, [number, number, boolean?]> = {
  angle: [0, 180],
  children: [0, 64, true],
  gnarliness: [0, 2],
  length: [0.001, 1000],
  radius: [0.00001, 100],
  sections: [1, 64, true],
  segments: [3, 32, true],
  start: [0, 1],
  taper: [0, 1],
  twist: [-720, 720],
};
function settings(o: TreeMeshOptions) {
  o.signal?.throwIfAborted();
  const s = o.species ?? 'oak',
    seed = o.seed ?? 1,
    b = o.branch ?? {},
    l = o.leaves ?? {},
    d = o.detail ?? {},
    bark = o.bark ?? {};
  const evergreen = (o.type ?? (s === 'pine' || s === 'spruce' ? 'evergreen' : 'deciduous')) === 'evergreen';
  const get = (key: Field, level: number): number => {
    const base = defaults[key][level];
    if (b[key]?.[level] !== undefined) return b[key]![level];
    if (key === 'children' && level === 0)
      return { oak: 8, ash: 9, aspen: 7, birch: 10, pine: 14, spruce: 18, willow: 12 }[s];
    if (key === 'gnarliness')
      return base * { oak: 1, ash: 0.6, aspen: 0.2, birch: 0.4, pine: 0.3, spruce: 0.15, willow: 1.5 }[s];
    if (key === 'angle' && s === 'willow' && level) return 100;
    if (key === 'length' && level && evergreen) return base * 0.8;
    if (key === 'radius' && s === 'birch') return base * 0.6;
    if (key === 'length' && (s === 'ash' || s === 'aspen')) return base * 1.3;
    if (key === 'start' && !level && evergreen) return 0.1;
    return base;
  };
  const radius = o.radius ?? get('radius', 0),
    tip = o.tipRadius ?? radius / 30;
  const force = b.force ?? { direction: [0, 1, 0], strength: 0 };
  if (
    !species.includes(s) ||
    !range(seed, 0, 0xffffffff, true) ||
    !range(b.levels ?? 2, 0, 4, true) ||
    !range(radius, 0.00001, 100) ||
    !range(tip, 0.000001, radius) ||
    (o.type !== undefined && !['deciduous', 'evergreen'].includes(o.type)) ||
    !Array.isArray(force.direction) ||
    force.direction.length !== 3 ||
    !force.direction.every((x) => range(x, -1, 1)) ||
    !range(force.strength, -2, 2) ||
    !Math.hypot(...force.direction)
  )
    throw invalid();
  for (const key of Object.keys(defaults) as Field[]) {
    if (b[key] && Object.keys(b[key]!).some((k) => !range(Number(k), 0, 4, true))) throw invalid();
    for (let level = 0; level <= 4; level++) if (!range(get(key, level), ...bounds[key])) throw invalid();
  }
  for (const tint of [bark.tint ?? 0xffffff, l.tint ?? 0xffffff]) if (!range(tint, 0, 0xffffff, true)) throw invalid();
  if (
    (bark.type !== undefined && !species.includes(bark.type)) ||
    (l.type !== undefined && !species.includes(l.type)) ||
    (bark.flatShading !== undefined && typeof bark.flatShading !== 'boolean') ||
    (bark.textured !== undefined && typeof bark.textured !== 'boolean')
  )
    throw invalid();
  const scale = bark.textureScale ?? [1, 1];
  if (!Array.isArray(scale) || scale.length !== 2 || !scale.every((x) => range(x, 0.001, 1000))) throw invalid();
  const leaf = {
    type: l.type ?? s,
    billboard: d.billboard ?? l.billboard ?? 'double',
    angle: l.angle ?? 45,
    count: l.count ?? 12,
    start: l.start ?? 0.3,
    size: l.size ?? (evergreen ? 0.7 : 0.5),
    variance: l.sizeVariance ?? 0.25,
    tint: l.tint ?? 0xffffff,
    alphaTest: l.alphaTest ?? 0.5,
  };
  const detail = {
    sectionStride: d.sectionStride ?? 1,
    segmentFactor: d.segmentFactor ?? 1,
    leafStride: d.leafStride ?? 1,
    leafScale: d.leafScale ?? 1,
  };
  if (
    !['single', 'double', 'cluster'].includes(leaf.billboard) ||
    !range(leaf.angle, 0, 180) ||
    !range(leaf.count, 0, 256, true) ||
    !range(leaf.start, 0, 1) ||
    !range(leaf.size, 0.0001, 100) ||
    !range(leaf.variance, 0, 1) ||
    !range(leaf.alphaTest, 0, 1) ||
    !range(detail.sectionStride, 1, 64, true) ||
    !range(detail.segmentFactor, 0.05, 1) ||
    !range(detail.leafStride, 1, 256, true) ||
    !range(detail.leafScale, 0.1, 16)
  )
    throw invalid();
  return { s, seed, b, bark, leaf, detail, radius, tip, scale, get, force, evergreen };
}
function atlas(type: TreeSpecies, leaf: boolean): TreeAtlas {
  const width = 64,
    height = 64,
    data = new Uint8Array(width * height * 4),
    kind = species.indexOf(type);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width,
        v = (y + 0.5) / height,
        i = (y * width + x) * 4;
      if (leaf) {
        const half =
          (type === 'pine' || type === 'spruce' ? 0.45 * (1 - v) : 0.45 * Math.sin(Math.PI * v)) *
          (1 + 0.12 * Math.cos(v * Math.PI * 12));
        const vein = Math.abs(u - 0.5) < 0.015 || Math.abs((((v + Math.abs(u - 0.5) * 1.5) * 10) % 1) - 0.5) < 0.045;
        data.set(
          [vein ? 105 : 40 + kind * 4, vein ? 135 : 95 + Math.round(v * 40), 25, Math.abs(u - 0.5) <= half ? 255 : 0],
          i,
        );
      } else {
        const n =
          0.5 +
          0.25 * Math.cos(2 * Math.PI * (u * 12 + 0.25 * Math.sin(v * 2 * Math.PI))) +
          0.25 * Math.cos(2 * Math.PI * (u * 25 + v * 3));
        const birch = type === 'birch' || type === 'aspen',
          c = birch ? 160 + 70 * n : 45 + 65 * n;
        data.set([c, birch ? c : c * 0.7, birch ? c * 0.9 : c * 0.45, 255], i);
      }
    }
  return { width, height, data };
}
class Builder {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  t: number[] = [];
  ix: number[] = [];
  vertex(p: V, n: V, uv: [number, number], t: V): number {
    const i = this.p.length / 3;
    if (i >= 1_000_000) throw invalid();
    this.p.push(...p);
    this.n.push(...n);
    this.uv.push(...uv);
    this.t.push(...t, 1);
    return i;
  }
  finish(flat = false): GeometryData {
    if (flat) {
      const out = new Builder();
      for (let i = 0; i < this.ix.length; i += 3) {
        const a = this.ix[i],
          b = this.ix[i + 1],
          c = this.ix[i + 2],
          p = (j: number) => this.p.slice(j * 3, j * 3 + 3) as V,
          n = unit(cross(add(p(b), p(a), -1), add(p(c), p(a), -1)));
        for (const j of [a, b, c]) {
          const old = this.t.slice(j * 4, j * 4 + 3) as V;
          out.ix.push(out.vertex(p(j), n, this.uv.slice(j * 2, j * 2 + 2) as [number, number], frame(n, old)));
        }
      }
      return out.finish();
    }
    return {
      positions: Float32Array.from(this.p),
      normals: Float32Array.from(this.n),
      uvs: Float32Array.from(this.uv),
      tangents: Float32Array.from(this.t),
      indices: Uint32Array.from(this.ix),
    };
  }
}
/** Mesh a /trees skeleton with smooth tapered bark, arc-length UVs and seeded leaves. Forks overlap inside parent tubes, as separate branch surfaces. */
export function meshTree(skeleton: TreeMeshSkeleton, options: TreeMeshOptions = {}): TreeMesh {
  const c = settings(options),
    { positions: p, parents } = skeleton,
    n = parents?.length;
  if (
    !(p instanceof Float64Array) ||
    !(parents instanceof Int32Array) ||
    !n ||
    n > 16384 ||
    p.length !== n * 3 ||
    parents[0] !== -1 ||
    !p.every((x) => range(x, -1e6, 1e6)) ||
    (skeleton.radii &&
      (!(skeleton.radii instanceof Float64Array) ||
        skeleton.radii.length !== n ||
        !skeleton.radii.every((x) => range(x, 0.000001, 100)))) ||
    (skeleton.levels &&
      (!(skeleton.levels instanceof Uint8Array) ||
        skeleton.levels.length !== n ||
        !skeleton.levels.every((x) => x <= 4)))
  )
    throw invalid();
  const point = (i: number): V => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]],
    children: number[][] = Array.from({ length: n }, () => []),
    support = new Float64Array(n).fill(1),
    main = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    const q = parents[i];
    if (!range(q, 0, i - 1, true) || Math.hypot(...add(point(i), point(q), -1)) < 1e-7) throw invalid();
    children[q].push(i);
  }
  const weight = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--)
    if (children[i].length) {
      support[i] = 0;
      for (const ch of children[i]) {
        support[i] += support[ch];
        weight[i] += weight[ch] + Math.hypot(...add(point(ch), point(i), -1));
        if (
          (!skeleton.levels || skeleton.levels[ch] === skeleton.levels[i]) &&
          (main[i] < 0 || support[ch] > support[main[i]])
        )
          main[i] = ch;
      }
    }
  const radii =
    skeleton.radii?.slice() ??
    Float64Array.from(weight, (x) => c.tip + (c.radius - c.tip) * Math.sqrt(x / (weight[0] || 1)));
  const bark = new Builder(),
    leaves = new Builder(),
    rng = random(c.seed),
    paths: number[][] = [];
  if (n === 1)
    return {
      bark: bark.finish(),
      leaves: leaves.finish(),
      radii,
      materials: {
        bark: {
          type: c.bark.type ?? c.s,
          tint: c.bark.tint ?? 0xffffff,
          textured: c.bark.textured ?? true,
          alphaTest: 0,
          doubleSided: false,
          atlas: atlas(c.bark.type ?? c.s, false),
        },
        leaves: {
          type: c.leaf.type,
          tint: c.leaf.tint,
          textured: true,
          alphaTest: c.leaf.alphaTest,
          doubleSided: true,
          atlas: atlas(c.leaf.type, true),
        },
      },
    };
  for (let i = 0; i < n; i++)
    if (i === 0 || main[parents[i]] !== i) {
      const path = i === 0 ? [0] : [parents[i], i];
      let j = path.at(-1)!;
      while (main[j] >= 0) {
        j = main[j];
        path.push(j);
      }
      paths.push(path);
    }
  let plannedLeaves = 0;
  for (const path of paths) if (!children[path.at(-1)!].length) plannedLeaves += c.leaf.count;
  if (plannedLeaves > 65536 || paths.reduce((sum, path) => sum + path.length * 33, 0) > 1_000_000) throw invalid();
  for (const path of paths) {
    const distances = [0];
    for (let j = 1; j < path.length; j++)
      distances.push(distances[j - 1] + Math.hypot(...add(point(path[j]), point(path[j - 1]), -1)));
    const arc = new Map(path.map((node, j) => [node, distances[j]]));
    const keep = path.filter(
        (node, j) => j === 0 || j === path.length - 1 || children[node].length > 1 || j % c.detail.sectionStride === 0,
      ),
      segments = Math.max(
        3,
        Math.round(c.get('segments', skeleton.levels?.[path.at(-1)!] ?? 0) * c.detail.segmentFactor),
      );
    let previous: V | undefined,
      ring = -1;
    for (let j = 0; j < keep.length; j++) {
      const id = keep[j],
        pos = point(id),
        before = point(keep[Math.max(0, j - 1)]),
        after = point(keep[Math.min(keep.length - 1, j + 1)]),
        axis = unit(add(after, before, -1)),
        u = frame(axis, previous),
        v = cross(axis, u);
      previous = u;
      const length = Math.hypot(...add(after, before, -1)) || 1,
        slope = (radii[keep[Math.max(0, j - 1)]] - radii[keep[Math.min(keep.length - 1, j + 1)]]) / length,
        start = bark.p.length / 3;
      for (let k = 0; k <= segments; k++) {
        const a = (k === segments ? 0 : k / segments) * 2 * Math.PI,
          radial = add(u.map((x) => x * Math.cos(a)) as V, v, Math.sin(a)),
          normal = unit(add(radial, axis, slope)),
          tangent = add(u.map((x) => -x * Math.sin(a)) as V, v, Math.cos(a));
        bark.vertex(
          add(pos, radial, radii[id]),
          normal,
          [(k / segments) * c.scale[0], arc.get(id)! * c.scale[1]],
          tangent,
        );
      }
      if (ring >= 0)
        for (let k = 0; k < segments; k++)
          bark.ix.push(ring + k, ring + k + 1, start + k, ring + k + 1, start + k + 1, start + k);
      if (j === 0 || j === keep.length - 1) {
        const sign = j === 0 ? -1 : 1,
          normal = axis.map((x) => x * sign) as V,
          center = bark.vertex(pos, normal, [0.5, 0.5], u),
          cap = bark.p.length / 3;
        for (let k = 0; k <= segments; k++) {
          const a = (k === segments ? 0 : k / segments) * Math.PI * 2;
          bark.vertex(
            add(pos, add(u.map((x) => x * Math.cos(a)) as V, v, Math.sin(a)), radii[id]),
            normal,
            [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5],
            u,
          );
          if (k) {
            if (sign > 0) bark.ix.push(center, cap + k - 1, cap + k);
            else bark.ix.push(center, cap + k, cap + k - 1);
          }
        }
      }
      ring = start;
    }
    if (children[path.at(-1)!].length) continue;
    const total = distances.at(-1)!;
    for (let j = 0; j < c.leaf.count; j++) {
      const t = c.leaf.start + (1 - c.leaf.start) * rng(),
        size = c.leaf.size * (1 + c.leaf.variance * (2 * rng() - 1)) * c.detail.leafScale,
        az = rng() * Math.PI * 2;
      if (j % c.detail.leafStride) continue;
      let k = 1;
      while (k < distances.length - 1 && distances[k] < t * total) k++;
      const a = point(path[Math.max(0, k - 1)] ?? 0),
        b = point(path[k] ?? path[0]),
        axis = unit(add(b, a, -1)),
        pos = total ? add(a, add(b, a, -1), (t * total - distances[k - 1]) / (distances[k] - distances[k - 1])) : a,
        base = frame(axis),
        bin = cross(axis, base),
        radial = add(base.map((x) => x * Math.cos(az)) as V, bin, Math.sin(az)),
        angle = (c.leaf.angle * Math.PI) / 180,
        up = unit(add(axis.map((x) => x * Math.cos(angle)) as V, radial, Math.sin(angle))),
        right = unit(cross(up, radial));
      const planes = c.leaf.billboard === 'single' ? 1 : c.leaf.billboard === 'double' ? 2 : 3;
      for (let plane = 0; plane < planes; plane++) {
        const a = (plane * Math.PI) / planes,
          r = add(right.map((x) => x * Math.cos(a)) as V, cross(up, right), Math.sin(a)),
          normal = unit(cross(r, up)),
          start = leaves.p.length / 3;
        for (const [x, y] of [
          [-0.5, 0],
          [0.5, 0],
          [0.5, 1],
          [-0.5, 1],
        ])
          leaves.vertex(add(add(pos, r, x * size), up, y * size), normal, [x + 0.5, y], r);
        leaves.ix.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }
  return {
    bark: bark.finish(c.bark.flatShading),
    leaves: leaves.finish(),
    radii,
    materials: {
      bark: {
        type: c.bark.type ?? c.s,
        tint: c.bark.tint ?? 0xffffff,
        textured: c.bark.textured ?? true,
        alphaTest: 0,
        doubleSided: false,
        atlas: atlas(c.bark.type ?? c.s, false),
      },
      leaves: {
        type: c.leaf.type,
        tint: c.leaf.tint,
        textured: true,
        alphaTest: c.leaf.alphaTest,
        doubleSided: true,
        atlas: atlas(c.leaf.type, true),
      },
    },
  };
}
/** Grow an order-controlled skeleton with taper, twist, gnarl and tropism, then mesh it. */
export function generateParametricTree(options: TreeMeshOptions = {}): ParametricTree {
  const c = settings(options),
    rng = random(c.seed),
    p: number[] = [0, 0, 0],
    parents: number[] = [-1],
    radii: number[] = [c.get('radius', 0)],
    levels: number[] = [0];
  const grow = (root: number, heading: V, level: number, scale: number) => {
    const sections = c.get('sections', level),
      length = c.get('length', level) * scale,
      ids = [root],
      base = c.get('radius', level) * scale;
    let axis = heading,
      pos: V = p.slice(root * 3, root * 3 + 3) as V;
    for (let j = 1; j <= sections; j++) {
      const u = frame(axis),
        v = cross(axis, u),
        gnarl = (c.get('gnarliness', level) * length) / sections;
      axis = unit(
        add(
          add(add(axis, u, (rng() - 0.5) * gnarl), v, (rng() - 0.5) * gnarl),
          unit([...c.force.direction] as V),
          (c.force.strength * length) / sections,
        ),
      );
      pos = add(pos, axis, length / sections);
      if (parents.length >= 16384) throw invalid();
      parents.push(ids.at(-1)!);
      p.push(...pos);
      levels.push(level);
      radii.push(Math.max(0.000001, base * (1 - (c.get('taper', level) * j) / sections)));
      ids.push(parents.length - 1);
    }
    if (level >= (c.b.levels ?? 2)) return;
    const children = c.get('children', level),
      start = c.get('start', level),
      twist = (c.get('twist', level) * Math.PI) / 180;
    for (let j = 0; j < children; j++) {
      const t = start + ((1 - start) * (j + 0.5)) / children,
        index = Math.max(1, Math.min(sections, Math.round(t * sections))),
        id = ids[index],
        prev = ids[index - 1],
        dir = unit(add(p.slice(id * 3, id * 3 + 3) as V, p.slice(prev * 3, prev * 3 + 3) as V, -1)),
        u = frame(dir),
        v = cross(dir, u),
        a = (c.get('angle', level + 1) * Math.PI) / 180,
        phi = j * twist + rng() * 0.3,
        radial = add(u.map((x) => x * Math.cos(phi)) as V, v, Math.sin(phi)),
        next = unit(add(dir.map((x) => x * Math.cos(a)) as V, radial, Math.sin(a)));
      grow(id, next, level + 1, c.evergreen ? Math.max(0.1, 1 - t) * scale : scale);
    }
  };
  grow(0, [0, 1, 0], 0, 1);
  const skeleton = {
    positions: Float64Array.from(p),
    parents: Int32Array.from(parents),
    radii: Float64Array.from(radii),
    levels: Uint8Array.from(levels),
  };
  return { ...meshTree(skeleton, options), skeleton };
}
/** Mesh the identical skeleton at ordered distance thresholds. Defaults 0/100/250m, with fewer rings/cards at distance. */
export function meshTreeLODs(
  skeleton: TreeMeshSkeleton,
  options: TreeMeshOptions = {},
  levels: readonly { distance: number; hysteresis?: number; detail?: TreeMeshOptions['detail'] }[] = [
    { distance: 0 },
    {
      distance: 100,
      detail: { sectionStride: 2, segmentFactor: 0.65, leafStride: 2, leafScale: 1.4, billboard: 'single' },
    },
    {
      distance: 250,
      detail: { sectionStride: 4, segmentFactor: 0.4, leafStride: 4, leafScale: 2, billboard: 'single' },
    },
  ],
): TreeMeshLOD[] {
  if (
    !levels.length ||
    levels.length > 8 ||
    levels[0].distance !== 0 ||
    levels.some(
      (l, i) =>
        !range(l.distance, 0, 1e6) ||
        !range(l.hysteresis ?? 0.05, 0, 0.5) ||
        (i > 0 && l.distance <= levels[i - 1].distance),
    )
  )
    throw invalid();
  return levels.map((l) => ({
    distance: l.distance,
    hysteresis: l.hysteresis ?? 0.05,
    mesh: meshTree(skeleton, { ...options, detail: { ...options.detail, ...l.detail } }),
  }));
}
