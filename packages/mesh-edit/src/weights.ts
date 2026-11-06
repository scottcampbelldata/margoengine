// @margoengine/mesh-edit/weights: named per-vertex weights that survive edits, and a brush to paint them, so rigging
// can happen in the browser. Groups live beside the mesh, keyed by vertex index, and `remap` carries them through any
// edit's `vertexMap`.
import type { Vec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges } from './polygon.js';
import type { MeshEditResult, PolygonMesh } from './types.js';

/** How {@link paintMeshWeights} changes a weight. */
export type WeightPaintMode = 'replace' | 'add' | 'subtract' | 'smooth';

/** Brush settings for {@link paintMeshWeights}. */
export interface WeightPaintOptions {
  /** Brush center in mesh space. */
  center: Vec3;
  /** Brush radius, positive. */
  radius: number;
  /** Weight the brush paints toward (`replace`) or adds and takes away (`add`, `subtract`), 0 to 1. Default 1. */
  value?: number;
  /** How much one dab applies, 0 to 1. Default 1. */
  strength?: number;
  /** What the dab does. Default `'replace'`. */
  mode?: WeightPaintMode;
  /** Fade toward the edge: `'smooth'`, `'linear'` or `'constant'`. Default `'smooth'`. */
  falloff?: 'smooth' | 'linear' | 'constant';
  /** After painting, rescale every group at the touched vertices so their weights sum to 1. Default false. */
  normalize?: boolean;
}

/** Options for {@link VertexGroups.skinAttributes}. */
export interface SkinAttributeOptions {
  /** Most joints per vertex, 1 to 8. Default 4, what glTF and `Skin` take. */
  influences?: number;
  /** Joint index for each group. Default each group's position in `names`. */
  joints?: Readonly<Record<string, number>>;
}

/** Skinning attributes, `influences` values per vertex. */
export interface SkinAttributes {
  joints: Uint16Array;
  weights: Float32Array;
  influences: number;
  /** Vertices with no weight in any group; they get joint 0 at full weight. */
  unweighted: number[];
}

/** Weights as stored when saved: sparse `[vertex, weight]` pairs per group. */
export interface VertexGroupsJSON {
  vertexCount: number;
  groups: Record<string, [number, number][]>;
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name.length)
    throw new TypeError('Vertex group name must be a nonempty string; supply a group name.');
}

/**
 * Named per-vertex weights for one mesh, from 0 to 1. Vertices not in a group have weight 0. After an edit, call
 * {@link VertexGroups.remap} with its result: a kept vertex keeps its weight, every copy of a split vertex inherits it,
 * and vertices the edit created between others take the mean of their neighbors.
 *
 * ```ts
 * const groups = new VertexGroups(mesh.vertices.length);
 * groups.set('arm', 0, 1);
 * const edit = extrudeMeshFace(mesh, mesh.faces[0].id, 0.25);
 * const after = groups.remap(edit);
 * ```
 */
export class VertexGroups {
  #count: number;
  #groups = new Map<string, Map<number, number>>();

  /** @throws RangeError for a bad vertex count. */
  constructor(vertexCount: number) {
    if (!Number.isInteger(vertexCount) || vertexCount < 0)
      throw new RangeError('Vertex count must be a whole number; pass mesh.vertices.length.');
    this.#count = vertexCount;
  }

  /** Number of vertices these weights describe. */
  get vertexCount(): number {
    return this.#count;
  }

  /** Group names, in the order they were added. */
  get names(): string[] {
    return [...this.#groups.keys()];
  }

  /** Whether the group exists. */
  has(name: string): boolean {
    return this.#groups.has(name);
  }

  /** Add an empty group, if it is new. @throws TypeError for a bad name. */
  add(name: string): void {
    checkName(name);
    if (!this.#groups.has(name)) this.#groups.set(name, new Map());
  }

  /** Remove a group. Returns whether it existed. */
  remove(name: string): boolean {
    return this.#groups.delete(name);
  }

  /** Rename a group, keeping its position. @throws TypeError for a bad name; RangeError for a missing group or a name in use. */
  rename(from: string, to: string): void {
    checkName(to);
    if (!this.#groups.has(from)) throw new RangeError(`No vertex group ${from}; check groups.names.`);
    if (from === to) return;
    if (this.#groups.has(to)) throw new RangeError(`Vertex group ${to} already exists; choose another name.`);
    this.#groups = new Map([...this.#groups].map(([name, weights]) => [name === from ? to : name, weights]));
  }

  /** The weight of `vertex` in group `name`; 0 when absent. */
  get(name: string, vertex: number): number {
    return this.#groups.get(name)?.get(vertex) ?? 0;
  }

  /**
   * Set one weight, creating the group if needed. A weight of 0 removes the entry.
   * @throws TypeError for a bad name; RangeError for a vertex that does not exist or a weight outside 0 to 1.
   */
  set(name: string, vertex: number, weight: number): void {
    checkName(name);
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= this.#count)
      throw new RangeError('Vertex group vertex must exist in the mesh; choose an index under vertexCount.');
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Vertex weight must be 0 to 1; choose a fraction.');
    this.add(name);
    if (weight) this.#groups.get(name)!.set(vertex, weight);
    else this.#groups.get(name)!.delete(vertex);
  }

  /** Every weight of a group, one per vertex. */
  weights(name: string): Float32Array {
    const out = new Float32Array(this.#count);
    for (const [vertex, weight] of this.#groups.get(name) ?? []) out[vertex] = weight;
    return out;
  }

  /** Rescale so each vertex's weights across all groups sum to 1. Vertices with no weight stay that way. */
  normalize(vertices?: Iterable<number>): void {
    const sums = new Map<number, number>();
    for (const group of this.#groups.values())
      for (const [vertex, weight] of group) sums.set(vertex, (sums.get(vertex) ?? 0) + weight);
    const only = vertices ? new Set(vertices) : null;
    for (const group of this.#groups.values())
      for (const [vertex, weight] of group)
        if (!only || only.has(vertex)) group.set(vertex, weight / sums.get(vertex)!);
  }

  /**
   * The weights after an edit, as a new object: follow `result.vertexMap`, then give each created vertex that no input
   * vertex maps to the mean of its edge neighbors. Works with every mesh-edit command that returns a vertex map.
   * @throws TypeError when the edit's vertex map does not match `vertexCount`.
   */
  remap(result: Pick<MeshEditResult, 'mesh' | 'vertexMap'>): VertexGroups {
    if (result.vertexMap.length !== this.#count)
      throw new TypeError('Edit vertex map does not match this vertex count; remap once per edit, in order.');
    const count = result.mesh.vertices.length,
      out = new VertexGroups(count),
      // How many input vertices became each output vertex: welded inputs average, and those with no weight count.
      shares = new Uint16Array(count),
      rings: number[][] = Array.from({ length: count }, () => []);
    for (const list of result.vertexMap) for (const v of list) shares[v]++;
    for (const edge of collectPolygonEdges(result.mesh)) {
      const [a, b] = edge.vertices;
      rings[a].push(b);
      rings[b].push(a);
    }
    for (const [name, group] of this.#groups) {
      const weights = new Float64Array(count);
      out.add(name);
      for (const [vertex, weight] of group) for (const v of result.vertexMap[vertex]) weights[v] += weight / shares[v];
      // New vertices fill in from those already known, ring by ring.
      let waiting: number[] = [];
      for (let v = 0; v < count; v++) if (!shares[v]) waiting.push(v);
      const known = shares.map((n) => (n ? 1 : 0));
      while (waiting.length) {
        const later: number[] = [],
          ready: [number, number][] = [];
        for (const v of waiting) {
          const near = rings[v].filter((n) => known[n]);
          if (near.length) ready.push([v, near.reduce((sum, n) => sum + weights[n], 0) / near.length]);
          else later.push(v);
        }
        if (!ready.length) break;
        for (const [v, weight] of ready) {
          weights[v] = weight;
          known[v] = 1;
        }
        waiting = later;
      }
      weights.forEach((weight, v) => {
        if (weight) out.set(name, v, Math.min(1, weight));
      });
    }
    return out;
  }

  /**
   * Joint indices and weights for skinning: each vertex's strongest `influences` groups, rescaled to sum to 1, strongest
   * first. Feed them to `Skin` from `@margoengine/animation`.
   * @throws RangeError for `influences` outside 1 to 8, or a group with no joint in `joints`.
   */
  skinAttributes(options: SkinAttributeOptions = {}): SkinAttributes {
    assertOptions(options, 'Skin attributes');
    const { influences = 4, joints } = options;
    if (!Number.isInteger(influences) || influences < 1 || influences > 8)
      throw new RangeError('Skin influences must be an integer from 1 to 8; 4 suits glTF.');
    const perVertex: [number, number][][] = Array.from({ length: this.#count }, () => []);
    this.names.forEach((name, index) => {
      const joint = joints ? joints[name] : index;
      if (joint === undefined) throw new RangeError(`Vertex group ${name} has no joint; add it to joints.`);
      for (const [vertex, weight] of this.#groups.get(name)!) perVertex[vertex].push([joint, weight]);
    });
    const outJoints = new Uint16Array(this.#count * influences),
      outWeights = new Float32Array(this.#count * influences),
      unweighted: number[] = [];
    perVertex.forEach((list, vertex) => {
      if (!list.length) {
        unweighted.push(vertex);
        outWeights[vertex * influences] = 1;
        return;
      }
      list.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
      const kept = list.slice(0, influences),
        total = kept.reduce((sum, item) => sum + item[1], 0);
      kept.forEach(([joint, weight], i) => {
        outJoints[vertex * influences + i] = joint;
        outWeights[vertex * influences + i] = weight / total;
      });
    });
    return { joints: outJoints, weights: outWeights, influences, unweighted };
  }

  /** A plain copy for saving; {@link VertexGroups.fromJSON} reads it back. */
  toJSON(): VertexGroupsJSON {
    return {
      vertexCount: this.#count,
      groups: Object.fromEntries([...this.#groups].map(([name, group]) => [name, [...group]])),
    };
  }

  /** Rebuild from {@link VertexGroups.toJSON}. @throws TypeError or RangeError for bad data. */
  static fromJSON(data: VertexGroupsJSON): VertexGroups {
    if (!data || typeof data !== 'object' || typeof data.groups !== 'object' || data.groups === null)
      throw new TypeError('Vertex groups data needs vertexCount and groups; pass a toJSON result.');
    const out = new VertexGroups(data.vertexCount);
    for (const [name, pairs] of Object.entries(data.groups)) {
      out.add(name);
      for (const [vertex, weight] of pairs) out.set(name, vertex, weight);
    }
    return out;
  }
}

const curves = {
  smooth: (t: number) => {
    const s = 1 - t;
    return s * s * (3 - 2 * s);
  },
  linear: (t: number) => 1 - t,
  constant: () => 1,
};

/**
 * One dab of a weight brush on group `group`, creating it if needed. `replace` moves weights toward `value`, `add` and
 * `subtract` change them by `value`, and `smooth` moves them toward their edge neighbors' mean. Returns the vertices
 * touched. Distance is straight-line, so a brush can reach both sides of a thin part.
 * @throws TypeError for a bad mesh, name or mode; RangeError for groups of another size or an option outside its limits.
 */
export function paintMeshWeights(
  groups: VertexGroups,
  mesh: PolygonMesh,
  group: string,
  options: WeightPaintOptions,
): number[] {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Weight paint');
  checkName(group);
  if (groups.vertexCount !== mesh.vertices.length)
    throw new RangeError('Vertex groups do not match this mesh; remap them after each edit.');
  const { center, radius, value = 1, strength = 1, mode = 'replace', falloff = 'smooth', normalize = false } = options;
  if (!Array.isArray(center) || center.length !== 3 || !center.every((x) => Number.isFinite(x)))
    throw new TypeError('Weight paint center must be three finite numbers; supply [x, y, z].');
  if (!(radius > 0 && Number.isFinite(radius)))
    throw new RangeError('Weight paint radius must be positive; choose a size.');
  if (!(value >= 0 && value <= 1)) throw new RangeError('Weight paint value must be 0 to 1; choose a fraction.');
  if (!(strength >= 0 && strength <= 1))
    throw new RangeError('Weight paint strength must be 0 to 1; choose a fraction.');
  if (!['replace', 'add', 'subtract', 'smooth'].includes(mode))
    throw new TypeError("Weight paint mode must be 'replace', 'add', 'subtract' or 'smooth'; choose one.");
  if (!Object.hasOwn(curves, falloff))
    throw new TypeError("Weight paint falloff must be 'smooth', 'linear' or 'constant'; choose one.");
  groups.add(group);
  const curve = curves[falloff],
    touched: number[] = [],
    rings: number[][] = mesh.vertices.map(() => []),
    next = new Map<number, number>();
  if (mode === 'smooth')
    for (const edge of collectPolygonEdges(mesh)) {
      const [a, b] = edge.vertices;
      rings[a].push(b);
      rings[b].push(a);
    }
  mesh.vertices.forEach((p, v) => {
    const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    if (d >= radius) return;
    const amount = curve(d / radius) * strength,
      now = groups.get(group, v);
    let weight = now;
    if (mode === 'replace') weight = now + (value - now) * amount;
    else if (mode === 'add') weight = now + value * amount;
    else if (mode === 'subtract') weight = now - value * amount;
    else if (rings[v].length) {
      const mean = rings[v].reduce((sum, n) => sum + groups.get(group, n), 0) / rings[v].length;
      weight = now + (mean - now) * amount;
    }
    next.set(v, Math.min(1, Math.max(0, weight)));
    touched.push(v);
  });
  for (const [v, weight] of next) groups.set(group, v, weight);
  if (normalize) groups.normalize(touched);
  return touched;
}
