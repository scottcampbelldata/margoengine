// Feature edges of a triangle mesh and gradients along a line. Optional entry: pages that draw neither do not load it.
import { parseColor, type ColorInput } from './color.js';
import { Line, type LineOptions } from './line.js';

/** A triangle mesh as core's `Geometry` holds it: interleaved vertices and triangle indices. */
export interface EdgeSource {
  /** Interleaved vertices with the position first. */
  vertices: ArrayLike<number>;
  /** Three per triangle. */
  indices: ArrayLike<number>;
}
/** `featureEdges` settings. */
export interface FeatureEdgeOptions {
  /** Keep an edge whose two faces meet at more than this many degrees, 0 to 180. Default 30. */
  angle?: number;
  /** Numbers per vertex in `vertices`. Default 6, core's position and normal. */
  stride?: number;
  /** Keep edges with one face, the outline of an open surface. Default true. */
  boundary?: boolean;
  /** Positions closer than this count as one point, so a seam of split vertices is not an edge. Default 1e-5. */
  tolerance?: number;
}

/**
 * The creases, boundaries and non-manifold edges of a mesh, as point pairs for a `segments` line (6 numbers per edge).
 * Vertices at one position count as one, so hard-shaded meshes with split normals work. Degenerate triangles are left
 * out, and an edge with three or more faces is always kept.
 * @throws RangeError for an angle outside 0 to 180, a bad stride or tolerance, or an index past the vertices.
 */
export function featureEdges(
  { vertices, indices }: EdgeSource,
  { angle = 30, stride = 6, boundary = true, tolerance = 1e-5 }: FeatureEdgeOptions = {},
): Float32Array {
  if (!(angle >= 0 && angle <= 180)) throw new RangeError('Invalid crease angle; pass degrees from 0 to 180');
  if (!Number.isInteger(stride) || stride < 3)
    throw new RangeError('Invalid stride; pass 3 or more numbers per vertex');
  if (!(tolerance > 0)) throw new RangeError('Invalid tolerance; pass a positive distance');
  const count = Math.floor(vertices.length / stride),
    weld = new Map<string, number>(),
    ids = new Int32Array(count);
  // The first vertex at each rounded position stands for all of them.
  for (let v = 0; v < count; v++) {
    const at = v * stride,
      key = `${Math.round(vertices[at] / tolerance)},${Math.round(vertices[at + 1] / tolerance)},${Math.round(vertices[at + 2] / tolerance)}`;
    let id = weld.get(key);
    if (id === undefined) weld.set(key, (id = v));
    ids[v] = id;
  }
  // Per undirected edge: how many faces, and the first face's unit normal.
  const edges = new Map<number, { faces: number; normal: number[]; keep: boolean; a: number; b: number }>(),
    limit = Math.cos((angle * Math.PI) / 180);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const face = [indices[t], indices[t + 1], indices[t + 2]];
    if (face.some((v) => !(v >= 0 && v < count)))
      throw new RangeError(`Invalid triangle index at ${t}; pass indices below the vertex count`);
    const [p, q, r] = face.map((v) => ids[v]);
    if (p === q || q === r || r === p) continue;
    const ux = vertices[q * stride] - vertices[p * stride],
      uy = vertices[q * stride + 1] - vertices[p * stride + 1],
      uz = vertices[q * stride + 2] - vertices[p * stride + 2],
      vx = vertices[r * stride] - vertices[p * stride],
      vy = vertices[r * stride + 1] - vertices[p * stride + 1],
      vz = vertices[r * stride + 2] - vertices[p * stride + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (!length) continue;
    const normal = [nx / length, ny / length, nz / length];
    for (const [a, b] of [
      [p, q],
      [q, r],
      [r, p],
    ]) {
      const key = Math.min(a, b) * count + Math.max(a, b),
        edge = edges.get(key);
      if (!edge) {
        edges.set(key, { faces: 1, normal, keep: false, a, b });
        continue;
      }
      edge.faces++;
      const cos = edge.normal[0] * normal[0] + edge.normal[1] * normal[1] + edge.normal[2] * normal[2];
      if (edge.faces > 2 || cos < limit - 1e-6) edge.keep = true;
    }
  }
  const out: number[] = [];
  for (const { faces, keep, a, b } of edges.values())
    if (keep || (boundary && faces === 1))
      out.push(
        vertices[a * stride],
        vertices[a * stride + 1],
        vertices[a * stride + 2],
        vertices[b * stride],
        vertices[b * stride + 1],
        vertices[b * stride + 2],
      );
  return new Float32Array(out);
}

/** The {@link featureEdges} of a geometry as a `Line`. Give it `mesh` to follow a mesh, like the other helpers. */
export class EdgesHelper extends Line {
  constructor(source: EdgeSource, options: FeatureEdgeOptions & Omit<LineOptions, 'positions' | 'mode'> = {}) {
    const { angle, stride, boundary, tolerance, ...line } = options;
    super({
      ...line,
      mode: 'segments',
      positions: featureEdges(source, { angle, stride, boundary, tolerance }),
    });
  }
}

/** `gradientColors` settings. */
export interface GradientOptions {
  /** How the points join, as on `Line`. `segments` runs the gradient over each pair of points. Default 'strip'. */
  mode?: 'strip' | 'segments';
  /** Where each colour sits, 0 to 1 and rising. Default evenly spaced. */
  stops?: readonly number[];
}

/**
 * Colours for `line.setColors` or `LineOptions.colors` that run through `colors` by distance along the line, 3 numbers per
 * point. The shader blends between points, so a stop that falls inside a long segment is reached only at its ends:
 * add points where the colour must be exact.
 * @throws RangeError for fewer than two colours, or stops that do not rise from 0 to 1 or do not match the colours.
 */
export function gradientColors(
  positions: ArrayLike<number>,
  colors: readonly ColorInput[],
  { mode = 'strip', stops }: GradientOptions = {},
): Float32Array {
  if (colors.length < 2) throw new RangeError('Invalid gradient; pass two or more colours');
  const at = stops ?? colors.map((_, i) => i / (colors.length - 1));
  if (at.length !== colors.length || at.some((v, i) => !(v >= 0 && v <= 1) || (i > 0 && v < at[i - 1])))
    throw new RangeError('Invalid gradient stops; pass one rising value from 0 to 1 per colour');
  const linear = colors.map((c) => parseColor(c)),
    points = Math.floor(positions.length / 3),
    out = new Float32Array(points * 3),
    paint = (point: number, t: number) => {
      let k = 0;
      while (k < at.length - 2 && t > at[k + 1]) k++;
      const span = at[k + 1] - at[k],
        f = span > 0 ? Math.min(1, Math.max(0, (t - at[k]) / span)) : t < at[k] ? 0 : 1;
      for (let c = 0; c < 3; c++) out[point * 3 + c] = linear[k][c] + (linear[k + 1][c] - linear[k][c]) * f;
    };
  if (mode === 'segments') {
    for (let p = 0; p + 1 < points; p += 2) {
      paint(p, 0);
      paint(p + 1, 1);
    }
    return out;
  }
  const lengths = new Float64Array(points);
  for (let p = 1; p < points; p++) {
    const a = (p - 1) * 3,
      b = p * 3;
    lengths[p] =
      lengths[p - 1] +
      Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
  }
  const total = lengths[points - 1] || 1;
  for (let p = 0; p < points; p++) paint(p, lengths[p] / total);
  return out;
}
