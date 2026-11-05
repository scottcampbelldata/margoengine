// Splits triangles until no edge is longer than a limit, always at the middle of the longest edge (M. Rivara, "Algorithms
// for refining triangular grids", 1984), so angles stay bounded. An edge is split exactly when it is over the limit,
// whichever triangle reaches it first, so neighbours agree without talking to each other: no cracks, even across seams
// where vertices are duplicated.
import type { GeometryData, GeometryGroup } from './data.js';

/** Options of {@link tessellateGeometry}. */
export interface TessellateOptions {
  /** Throws past this many triangles, so a tiny limit cannot run out of memory. Default 5,000,000. */
  maxTriangles?: number;
}

/** Result of {@link tessellateWithParents}. */
export interface TessellateResult {
  data: GeometryData;
  /**
   * Two entries per added vertex: the vertices it is halfway between, in order, so an added vertex `v` has parents at
   * `(v - originalCount) * 2`. Parents can be added vertices too, always earlier ones.
   */
  parents: Uint32Array;
}

/** Keeps an index pair in one number; vertex counts stay far below this. */
const PAIR = 2 ** 26;

/** Grows a float attribute by appending values. */
class Column {
  values: Float32Array;
  length: number;

  constructor(source: Float32Array) {
    this.values = new Float32Array(Math.max(source.length * 2, 16));
    this.values.set(source);
    this.length = source.length;
  }

  add(size: number): number {
    const start = this.length;
    this.length += size;
    if (this.length > this.values.length) {
      const larger = new Float32Array(this.values.length * 2);
      larger.set(this.values);
      this.values = larger;
    }
    return start;
  }

  done(): Float32Array {
    return this.values.slice(0, this.length);
  }
}

/** Halves the direction between two unit vectors: their sum, unit length again. The first wins when they cancel. */
function blendUnit(values: Float32Array, out: number, a: number, b: number): void {
  const x = values[a] + values[b],
    y = values[a + 1] + values[b + 1],
    z = values[a + 2] + values[b + 2],
    length = Math.hypot(x, y, z);
  values[out] = length > 0 ? x / length : values[a];
  values[out + 1] = length > 0 ? y / length : values[a + 1];
  values[out + 2] = length > 0 ? z / length : values[a + 2];
}

/**
 * Like {@link tessellateGeometry}, and also says where each added vertex came from, so attributes of your own, such
 * as morph targets, can follow: `value[v] = (value[a] + value[b]) / 2`.
 */
export function tessellateWithParents(
  data: GeometryData,
  maxEdge: number,
  options: TessellateOptions = {},
): TessellateResult {
  const { maxTriangles = 5_000_000 } = options,
    vertices = data.positions.length / 3;
  if (!(maxEdge > 0) || !Number.isFinite(maxEdge))
    throw new RangeError('Invalid maxEdge; pass a finite length above 0');
  if (!(maxTriangles >= 1)) throw new RangeError('Invalid maxTriangles; pass a number of at least 1');
  if (!Number.isInteger(vertices) || data.indices.length % 3)
    throw new RangeError('Invalid geometry; pass xyz positions and whole triangles');
  for (const index of data.indices)
    if (index >= vertices) throw new RangeError(`Index ${index} is past the last vertex; pass indices below ${vertices}`);
  for (const value of data.positions)
    if (!Number.isFinite(value)) throw new RangeError('Invalid position; pass finite coordinates');
  const P = new Column(data.positions),
    N = new Column(data.normals),
    UV = new Column(data.uvs),
    T = data.tangents && new Column(data.tangents),
    hasNormals = data.normals.length === vertices * 3,
    hasUVs = data.uvs.length === vertices * 2,
    hasTangents = data.tangents?.length === vertices * 4,
    limit = maxEdge * maxEdge,
    midpoints = new Map<number, number>(),
    parents: number[] = [],
    indices: number[] = [],
    stack: number[] = [],
    ends: number[] = [];

  const lengthSquared = (a: number, b: number): number => {
    const v = P.values;
    return (v[a * 3] - v[b * 3]) ** 2 + (v[a * 3 + 1] - v[b * 3 + 1]) ** 2 + (v[a * 3 + 2] - v[b * 3 + 2]) ** 2;
  };

  const midpoint = (a: number, b: number): number => {
    const key = Math.min(a, b) * PAIR + Math.max(a, b),
      known = midpoints.get(key);
    if (known !== undefined) return known;
    const vertex = P.length / 3,
      p = P.add(3);
    for (let k = 0; k < 3; k++) P.values[p + k] = (P.values[a * 3 + k] + P.values[b * 3 + k]) / 2;
    if (hasNormals) {
      const n = N.add(3);
      blendUnit(N.values, n, a * 3, b * 3);
    }
    if (hasUVs) {
      const uv = UV.add(2);
      UV.values[uv] = (UV.values[a * 2] + UV.values[b * 2]) / 2;
      UV.values[uv + 1] = (UV.values[a * 2 + 1] + UV.values[b * 2 + 1]) / 2;
    }
    if (T && hasTangents) {
      const t = T.add(4);
      blendUnit(T.values, t, a * 4, b * 4);
      T.values[t + 3] = T.values[a * 4 + 3];
    }
    midpoints.set(key, vertex);
    parents.push(a, b);
    return vertex;
  };

  for (let t = 0; t < data.indices.length; t += 3) {
    stack.push(data.indices[t], data.indices[t + 1], data.indices[t + 2]);
    while (stack.length) {
      const c = stack.pop()!,
        b = stack.pop()!,
        a = stack.pop()!,
        ab = lengthSquared(a, b),
        bc = lengthSquared(b, c),
        ca = lengthSquared(c, a),
        longest = Math.max(ab, bc, ca);
      if (longest <= limit) {
        indices.push(a, b, c);
        if (indices.length / 3 + stack.length / 3 > maxTriangles)
          throw new RangeError(`Tessellation passed ${maxTriangles} triangles; pass a larger maxEdge or maxTriangles`);
        continue;
      }
      // Each half goes back on the stack, first half on top, so triangles keep their source's order.
      if (longest === ab) {
        const m = midpoint(a, b);
        stack.push(m, b, c, a, m, c);
      } else if (longest === bc) {
        const m = midpoint(b, c);
        stack.push(a, m, c, a, b, m);
      } else {
        const m = midpoint(c, a);
        stack.push(m, b, c, a, b, m);
      }
      if (stack.length / 3 > maxTriangles)
        throw new RangeError(`Tessellation passed ${maxTriangles} triangles; pass a larger maxEdge or maxTriangles`);
    }
    ends.push(indices.length);
  }

  const result: GeometryData = {
    positions: P.done(),
    normals: N.done(),
    uvs: UV.done(),
    indices: Uint32Array.from(indices),
  };
  if (T) result.tangents = T.done();
  if (data.groups) {
    const at = (index: number) => (index >= 3 ? ends[Math.floor(index / 3) - 1] : 0);
    result.groups = data.groups.map((group): GeometryGroup => {
      const start = at(group.start);
      return { ...group, start, count: at(group.start + group.count) - start };
    });
  }
  return { data: result, parents: Uint32Array.from(parents) };
}

/**
 * Splits triangles until no edge is longer than `maxEdge`, so vertex displacement, morphing and curved deformations
 * have enough vertices to work with. Normals, UVs and tangents are interpolated and groups follow their triangles. The
 * surface itself does not change, and the input is left alone.
 */
export function tessellateGeometry(data: GeometryData, maxEdge: number, options: TessellateOptions = {}): GeometryData {
  return tessellateWithParents(data, maxEdge, options).data;
}
