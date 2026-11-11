// Random points on a mesh surface. A triangle is drawn from the cumulative table of its weights; a point inside it
// comes from barycentric coordinates. With vertex weights the density is linear across each triangle, so a painted
// weight map is followed exactly instead of being averaged per triangle: density proportional to one barycentric
// coordinate is the Dirichlet(2, 1, 1) distribution, whose coordinates are spacings of three sorted uniform numbers.
import type { GeometryData } from './data.js';
import type { MutableVec2, MutableVec3 } from './math.js';

/** Options of {@link MeshSurfaceSampler}. */
export interface MeshSurfaceSamplerOptions {
  /** One value of at least 0 per vertex: the density of points there. Omitted, density is even over the area. */
  weights?: ArrayLike<number>;
  /** Vertex colours, 3 or 4 values per vertex (`GeometryData` holds none). Omitted, samples are white. */
  colors?: ArrayLike<number>;
  /** Random numbers in [0, 1). Omitted, a generator seeded with `seed`, so the same mesh gives the same points. */
  random?: () => number;
  /** Seed of the built-in generator. Default 1. */
  seed?: number;
}

/** One point on a surface. */
export interface SurfaceSample {
  position: MutableVec3;
  /** Unit normal, interpolated from the vertex normals; the face normal where those cancel out or are absent. */
  normal: MutableVec3;
  uv: MutableVec2;
  /** RGBA, interpolated; white without `colors`, and alpha 1 with three-value colours. */
  color: [number, number, number, number];
  /** Index of the triangle the point lies on. */
  triangle: number;
  /** Barycentric coordinates of the point on the triangle's three corners. */
  barycentric: MutableVec3;
}

/** Many points on a surface as flat arrays, ready for instance buffers. */
export interface SurfacePoints {
  /** xyz per point. */
  positions: Float32Array;
  /** xyz per point. */
  normals: Float32Array;
  /** uv per point. */
  uvs: Float32Array;
  /** rgba per point. */
  colors: Float32Array;
  /** One triangle index per point. */
  triangles: Uint32Array;
}

/** The mulberry32 generator: small, fast and good enough for scattering; 32 bits of state from `seed`. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks random points on a triangle mesh, weighted by area or by a per-vertex value, with position, normal, UV and
 * colour at each point: for scattering grass, fur, debris and particles on any model. Building it reads the mesh once;
 * each sample then costs one binary search over the triangles.
 *
 * ```ts
 * const sampler = new MeshSurfaceSampler(sphereGeometry(1, 32, 16));
 * const {positions, normals} = sampler.samplePoints(10_000);
 * ```
 */
export class MeshSurfaceSampler {
  /** Surface area of the mesh, whatever the weights: points per unit area times this gives a count. */
  readonly area: number;
  private readonly data: GeometryData;
  private readonly weights: ArrayLike<number> | undefined;
  private readonly colors: ArrayLike<number> | undefined;
  private readonly colorSize: number;
  private readonly random: () => number;
  /** Running total of the triangle weights. */
  private readonly table: Float64Array;
  /** The last triangle with any weight. */
  private readonly last: number;

  /**
   * @param data - The mesh; `normals` and `uvs` may be empty.
   * @param options - See {@link MeshSurfaceSamplerOptions}.
   * @throws TypeError when `random` is not a function.
   * @throws RangeError when an attribute has the wrong length, an index is out of range, a value is not finite or
   *   negative, or nothing has both area and weight.
   */
  constructor(data: GeometryData, options: MeshSurfaceSamplerOptions = {}) {
    const P = data.positions,
      I = data.indices,
      vertices = P.length / 3,
      { weights, colors, random, seed = 1 } = options;
    if (!Number.isInteger(vertices) || I.length % 3)
      throw new RangeError('MeshSurfaceSampler needs whole triangles; pass xyz per vertex and 3 indices per face');
    if (data.normals.length && data.normals.length !== P.length)
      throw new RangeError('MeshSurfaceSampler normals must be xyz per vertex or empty; match the positions');
    if (data.uvs.length && data.uvs.length !== vertices * 2)
      throw new RangeError('MeshSurfaceSampler uvs must be uv per vertex or empty; match the positions');
    if (weights && weights.length !== vertices)
      throw new RangeError(`MeshSurfaceSampler has ${weights.length} weights; pass one per vertex (${vertices})`);
    if (colors && colors.length !== vertices * 3 && colors.length !== vertices * 4)
      throw new RangeError('MeshSurfaceSampler colors must be 3 or 4 values per vertex; match the positions');
    if (random !== undefined && typeof random !== 'function')
      throw new TypeError('MeshSurfaceSampler random must be a function; pass () => number in [0, 1)');
    if (!Number.isFinite(seed))
      throw new RangeError(`MeshSurfaceSampler seed ${seed} is invalid; pass a finite number`);
    for (const [name, list] of [['uvs', data.uvs], ['normals', data.normals], ['colors', colors]] as const)
      if (list)
        for (let i = 0; i < list.length; i++)
          if (!Number.isFinite(list[i]))
            throw new RangeError(`MeshSurfaceSampler ${name} must be finite (index ${i} is ${list[i]}); fix the mesh`);
    if (weights)
      for (let v = 0; v < vertices; v++)
        if (!(weights[v] >= 0 && weights[v] < Infinity))
          throw new RangeError(`MeshSurfaceSampler weight ${weights[v]} is invalid; pass finite values >= 0`);
    const triangles = I.length / 3,
      table = new Float64Array(triangles);
    let area = 0,
      total = 0,
      last = -1;
    for (let t = 0; t < triangles; t++) {
      const a = I[t * 3],
        b = I[t * 3 + 1],
        c = I[t * 3 + 2];
      if (!(a < vertices && b < vertices && c < vertices))
        throw new RangeError(`MeshSurfaceSampler triangle ${t} indexes past the vertices; fix the indices`);
      const size = triangleArea(P, a, b, c);
      if (!Number.isFinite(size)) throw new RangeError('MeshSurfaceSampler positions must be finite; fix the mesh');
      area += size;
      const weight = weights ? (size * (weights[a] + weights[b] + weights[c])) / 3 : size;
      if (weight > 0) last = t;
      table[t] = total += weight;
    }
    if (last < 0)
      throw new RangeError('MeshSurfaceSampler found no area to sample; pass triangles with area and a weight above 0');
    this.area = area;
    this.data = data;
    this.weights = weights;
    this.colors = colors;
    this.colorSize = colors ? colors.length / vertices : 0;
    this.random = random ?? seeded(seed);
    this.table = table;
    this.last = last;
  }

  /**
   * One random point. Pass a `target` from an earlier call to fill it instead of allocating.
   *
   * @param target - Optional sample to overwrite and return.
   */
  sample(target: SurfaceSample = emptySample()): SurfaceSample {
    const { data, table, random, weights } = this,
      search = random() * table[this.last];
    // The first triangle whose running total passes the draw; triangles with no weight add nothing, so never qualify.
    let low = 0,
      high = this.last;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (table[middle] > search) high = middle;
      else low = middle + 1;
    }
    const I = data.indices,
      a = I[low * 3],
      b = I[low * 3 + 1],
      c = I[low * 3 + 2],
      bary = target.barycentric;
    if (weights) this.linear(weights[a], weights[b], weights[c], bary);
    else {
      const s = Math.sqrt(random()),
        r = random();
      bary[0] = 1 - s;
      bary[1] = s * (1 - r);
      bary[2] = s * r;
    }
    target.triangle = low;
    this.interpolate(a, b, c, target);
    return target;
  }

  /**
   * `count` random points as flat arrays.
   *
   * @throws RangeError when `count` is not an integer of at least 0.
   */
  samplePoints(count: number): SurfacePoints {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError(`MeshSurfaceSampler count ${count} is invalid; pass an integer >= 0`);
    const positions = new Float32Array(count * 3),
      normals = new Float32Array(count * 3),
      uvs = new Float32Array(count * 2),
      colors = new Float32Array(count * 4),
      triangles = new Uint32Array(count),
      point = emptySample();
    for (let i = 0; i < count; i++) {
      this.sample(point);
      positions.set(point.position, i * 3);
      normals.set(point.normal, i * 3);
      uvs.set(point.uv, i * 2);
      colors.set(point.color, i * 4);
      triangles[i] = point.triangle;
    }
    return { positions, normals, uvs, colors, triangles };
  }

  /** Barycentric coordinates with density linear between the corner weights: a mix of one Dirichlet(2, 1, 1) each. */
  private linear(wa: number, wb: number, wc: number, bary: MutableVec3): void {
    const { random } = this,
      pick = random() * (wa + wb + wc),
      corner = pick < wa ? 0 : pick < wa + wb || wc === 0 ? 1 : 2,
      x = random(),
      y = random(),
      z = random(),
      high = Math.max(x, y, z),
      // The median by comparison: adding and subtracting would round, and could leave a coordinate below 0.
      middle = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
    // Four spacings of three sorted numbers are Dirichlet(1, 1, 1, 1); two of them added make the Dirichlet(2).
    bary[corner] = middle;
    bary[(corner + 1) % 3] = high - middle;
    bary[(corner + 2) % 3] = 1 - high;
  }

  /** Fills the attributes of `out` from its barycentric coordinates on corners `a`, `b`, `c`. */
  private interpolate(a: number, b: number, c: number, out: SurfaceSample): void {
    const { positions: P, normals: N, uvs: UV } = this.data,
      [u, v, w] = out.barycentric,
      p = out.position,
      n = out.normal;
    for (let k = 0; k < 3; k++) p[k] = u * P[a * 3 + k] + v * P[b * 3 + k] + w * P[c * 3 + k];
    let length = 0;
    if (N.length) {
      for (let k = 0; k < 3; k++) n[k] = u * N[a * 3 + k] + v * N[b * 3 + k] + w * N[c * 3 + k];
      length = Math.hypot(n[0], n[1], n[2]);
    }
    if (!(length > 1e-12)) {
      const ux = P[b * 3] - P[a * 3],
        uy = P[b * 3 + 1] - P[a * 3 + 1],
        uz = P[b * 3 + 2] - P[a * 3 + 2],
        vx = P[c * 3] - P[a * 3],
        vy = P[c * 3 + 1] - P[a * 3 + 1],
        vz = P[c * 3 + 2] - P[a * 3 + 2];
      n[0] = uy * vz - uz * vy;
      n[1] = uz * vx - ux * vz;
      n[2] = ux * vy - uy * vx;
      length = Math.hypot(n[0], n[1], n[2]);
    }
    n[0] /= length;
    n[1] /= length;
    n[2] /= length;
    if (UV.length) {
      out.uv[0] = u * UV[a * 2] + v * UV[b * 2] + w * UV[c * 2];
      out.uv[1] = u * UV[a * 2 + 1] + v * UV[b * 2 + 1] + w * UV[c * 2 + 1];
    } else out.uv[0] = out.uv[1] = 0;
    const { colors, colorSize } = this,
      color = out.color;
    if (!colors) {
      color[0] = color[1] = color[2] = color[3] = 1;
      return;
    }
    for (let k = 0; k < colorSize; k++)
      color[k] = u * colors[a * colorSize + k] + v * colors[b * colorSize + k] + w * colors[c * colorSize + k];
    if (colorSize === 3) color[3] = 1;
  }
}

function emptySample(): SurfaceSample {
  return {
    position: [0, 0, 0],
    normal: [0, 0, 1],
    uv: [0, 0],
    color: [1, 1, 1, 1],
    triangle: 0,
    barycentric: [1, 0, 0],
  };
}

function triangleArea(P: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = P[b * 3] - P[a * 3],
    uy = P[b * 3 + 1] - P[a * 3 + 1],
    uz = P[b * 3 + 2] - P[a * 3 + 2],
    vx = P[c * 3] - P[a * 3],
    vy = P[c * 3 + 1] - P[a * 3 + 1],
    vz = P[c * 3 + 2] - P[a * 3 + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
