import type { GeometryData, GeometryGroup } from './data.js';

/** One axis of a face grid: per sample, the inner-box coordinate, the corner direction's slope and the UV fraction. */
interface Profile {
  base: number[];
  slope: number[];
  uv: number[];
}

// Samples across one side of a rounded box, from -half to +half. Each rounded 90-degree edge is split between the two
// faces that meet there, so a face keeps the angles 0..45 degrees of it on each side and every seam vertex is computed
// from the same numbers on both faces (slope exactly 1 at 45 degrees): the mesh has no cracks.
function profile(half: number, radius: number, segments: number): Profile {
  if (radius === 0) return { base: [-half, half], slope: [0, 0], uv: [0, 1] };
  const inner = half - radius,
    angles: number[] = [];
  for (let k = 0; (k * Math.PI) / 2 / segments < Math.PI / 4 - 1e-12; k++) angles.push((k * Math.PI) / 2 / segments);
  const slopes = angles.map(Math.tan).concat(1),
    base: number[] = [],
    slope: number[] = [];
  for (let i = slopes.length - 1; i >= 0; i--) base.push(-inner), slope.push(-slopes[i]);
  // A side as long as the diameter has no flat span: its two 0-degree samples would coincide.
  for (let i = inner > 0 ? 0 : 1; i < slopes.length; i++) base.push(inner), slope.push(slopes[i]);
  // UVs follow arc length along the face's centre line.
  const uv = [0];
  for (let i = 1; i < base.length; i++) {
    const a = Math.sqrt(slope[i - 1] * slope[i - 1] + 1),
      b = Math.sqrt(slope[i] * slope[i] + 1);
    uv.push(
      uv[i - 1] +
        Math.hypot(
          base[i] + radius * (slope[i] / b) - base[i - 1] - radius * (slope[i - 1] / a),
          radius / b - radius / a,
        ),
    );
  }
  const total = uv[uv.length - 1];
  return { base, slope, uv: uv.map((t, i) => (total > 0 ? t / total : i / (uv.length - 1))) };
}

const size = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new RangeError(`roundedBoxGeometry ${label} ${value} is invalid; pass a finite number >= 0`);
  return value;
};

/**
 * Three.js `RoundedBoxGeometry`: a `width` x `height` x `depth` box centred on the origin with every edge and corner
 * rounded to `radius` (clamped to half the smallest side; 0 gives a plain box). Each rounded 90-degree edge has
 * `segments` facets (at least 1; one more when odd, so a vertex sits on the 45-degree seam), and each flat side is one
 * span. Faces are laid out and grouped like `boxGeometry` (six groups: +x, -x, +y, -y, +z, -z), with smooth unit normals
 * and UVs from 0 to 1 along each face's arc length. Neighbouring faces compute their shared vertices from identical
 * numbers, so the surface is closed with no cracks; a radius of half every side gives a sphere.
 */
export function roundedBoxGeometry(width = 1, height = 1, depth = 1, segments = 2, radius = 0.1): GeometryData {
  const w = size(width, 'width') / 2,
    h = size(height, 'height') / 2,
    d = size(depth, 'depth') / 2,
    r = Math.min(size(radius, 'radius'), w, h, d);
  if (typeof segments !== 'number' || !Number.isFinite(segments))
    throw new RangeError(`roundedBoxGeometry segments ${segments} is invalid; pass a finite number >= 1`);
  const n = Math.max(1, Math.floor(segments)),
    axes = [profile(w, r, n), profile(h, r, n), profile(d, r, n)],
    inner = [w - r, h - r, d - r],
    positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    groups: GeometryGroup[] = [];
  // Same face table as boxGeometry: in-plane axes u and v, their directions, the normal axis w and its sign.
  const face = (u: number, v: number, axis: number, udir: number, vdir: number, sign: number, material: number) => {
    const U = axes[u],
      V = axes[v],
      first = positions.length / 3,
      start = indices.length,
      columns = U.base.length,
      p = [0, 0, 0],
      q = [0, 0, 0];
    for (let iy = 0; iy < V.base.length; iy++)
      for (let ix = 0; ix < columns; ix++) {
        const su = U.slope[ix],
          sv = V.slope[iy],
          length = Math.sqrt(su * su + sv * sv + 1);
        // + 0 turns a -0 into 0, as boxGeometry writes flat normals.
        q[u] = (su / length) * udir + 0;
        q[v] = (sv / length) * vdir + 0;
        q[axis] = sign / length;
        p[u] = (U.base[ix] + r * (su / length)) * udir;
        p[v] = (V.base[iy] + r * (sv / length)) * vdir;
        p[axis] = sign * inner[axis] + r * (sign / length);
        positions.push(p[0], p[1], p[2]);
        normals.push(q[0], q[1], q[2]);
        uvs.push(U.uv[ix], 1 - V.uv[iy]);
      }
    for (let iy = 0; iy + 1 < V.base.length; iy++)
      for (let ix = 0; ix + 1 < columns; ix++) {
        const a = first + ix + columns * iy,
          b = first + ix + columns * (iy + 1),
          c = first + ix + 1 + columns * (iy + 1),
          e = first + ix + 1 + columns * iy;
        indices.push(a, b, e, b, c, e);
      }
    groups.push({ start, count: indices.length - start, materialIndex: material });
  };
  face(2, 1, 0, -1, -1, 1, 0);
  face(2, 1, 0, 1, -1, -1, 1);
  face(0, 2, 1, 1, 1, 1, 2);
  face(0, 2, 1, 1, -1, -1, 3);
  face(0, 1, 2, 1, -1, 1, 4);
  face(0, 1, 2, -1, -1, -1, 5);
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    groups,
  };
}
