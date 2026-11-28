// Mesh builder: faces, strips, parametric grids and placed copies of other geometry collected into one GeometryData,
// with optional linear rgba vertex colours, UVs and creased smooth normals.
//
// Smooth normals weight each face by its corner angle (Thurmer, Wuthrich 1998, "Computing vertex normals from polygonal
// facets", JGT 3(1); Max 1999, "Weights for computing vertex normals from facet normals", JGT 4(2)) and keep a crease
// where neighbouring faces differ by more than the given angle (`creasedNormals`).
import type { Geometry } from '@margoengine/core';
import { SRGBToLinear } from '@margoengine/math';
import { type GeometryData, toGeometry } from './data.js';
import type { MutableVec3 } from './math.js';
import { triangulate } from './triangulate.js';
import { applyMatrix4, creasedNormals, mergeVertices } from './utils.js';

type P3 = ArrayLike<number>;
/** A colour: `#rgb`, `#rrggbb` or `#rrggbbaa` (sRGB, decoded to linear), or linear `[r, g, b]` / `[r, g, b, a]`. */
export type ColorInput = string | readonly number[];
/** Linear rgba. */
export type Rgba = [number, number, number, number];

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;
/** Parses a {@link ColorInput} to linear rgba; alpha defaults to 1. Throws RangeError for anything else. */
export function parseColor(color: ColorInput): Rgba {
  if (typeof color === 'string') {
    if (!HEX.test(color)) throw new RangeError(`Invalid colour "${color}"; pass #rgb, #rrggbb or #rrggbbaa`);
    const h = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join('') : color.slice(1);
    const v = (k: number) => parseInt(h.slice(k * 2, k * 2 + 2), 16) / 255;
    return [SRGBToLinear(v(0)), SRGBToLinear(v(1)), SRGBToLinear(v(2)), h.length === 8 ? v(3) : 1];
  }
  if ((color.length !== 3 && color.length !== 4) || !color.every((c) => Number.isFinite(c)))
    throw new RangeError('Invalid colour; pass [r, g, b] or [r, g, b, a] with finite linear values');
  return [color[0], color[1], color[2], color.length === 4 ? color[3] : 1];
}

/** Options of {@link GeometryBuilder}. */
export interface GeometryBuilderOptions {
  /** Store linear rgba vertex colours in the result (`colors`). Default false. */
  colors?: boolean;
  /** Colour of vertices added without one. Default white. */
  color?: ColorInput;
  /**
   * Smooth the normals of faces added by `triangle`, `quad`, `polygon` and `strip`: a crease angle in degrees (faces
   * meeting at a larger angle stay sharp), or true for fully smooth (180). Default false: every face is flat.
   * `grid` and `append` keep their own normals.
   */
  smooth?: boolean | number;
  /** Weld vertices whose every attribute matches in `data()`, so smooth runs share vertices. Default true. */
  weld?: boolean;
}

/** Per-face options of `triangle`, `quad` and `polygon`. */
export interface FaceOptions {
  /** Colour of the face's vertices. Default the builder's current colour. */
  color?: ColorInput;
  /** One [u, v] per corner. Defaults: triangle (0,0) (1,0) (0,1); quad (0,0) (1,0) (1,1) (0,1); polygon planar. */
  uvs?: readonly (readonly number[])[];
  /** Reverse the winding so the face shows its other side. Default false. */
  flip?: boolean;
}

/** Options of `polygon`. */
export interface PolygonOptions extends FaceOptions {
  /** Holes: point loops in the polygon's plane. */
  holes?: readonly (readonly P3[])[];
}

/** Options of `strip`. */
export interface StripOptions {
  /** Colour of the strip. Default the builder's current colour. */
  color?: ColorInput;
  /** Join the last point of each row back to the first. Default false. */
  closed?: boolean;
  /** Reverse the winding. Default false. */
  flip?: boolean;
  /** V coordinates of the two rows. Default [0, 1]; U runs along the rows by arc length, 0 to 1. */
  v?: readonly [number, number];
}

/** Options of `grid`. */
export interface GridOptions {
  /** Colour, or a function of (u, v) giving one per vertex. Default the builder's current colour. */
  color?: ColorInput | ((u: number, v: number) => ColorInput);
  /** Normal at (u, v). Default: the unit cross product of the surface's derivatives in u and v (central differences). */
  normal?: (u: number, v: number) => P3;
  /** Reverse the winding and the normals. Default false. */
  flip?: boolean;
}

/** Placement of a copy: scale, then roll (z), pitch (x) and yaw (y) in radians, then position; or a full matrix. */
export interface PlaceOptions {
  /** Translation. Default [0, 0, 0]. */
  position?: P3;
  /** Turn about +y in radians. Default 0. */
  yaw?: number;
  /** Turn about +x in radians. Default 0. */
  pitch?: number;
  /** Turn about +z in radians. Default 0. */
  roll?: number;
  /** Uniform or per-axis scale. Default 1. */
  scale?: number | P3;
  /** Column-major 4x4 matrix applied after the other fields. Default none. */
  matrix?: ArrayLike<number>;
  /** Colour every vertex of the copy. Default: the copy's own colours, or the builder's current colour. */
  color?: ColorInput;
}

/** Column-major 4x4 matrix of a {@link PlaceOptions}: matrix * translate * yaw * pitch * roll * scale. */
export function placementMatrix(options: PlaceOptions = {}): Float64Array {
  const { position = [0, 0, 0], yaw = 0, pitch = 0, roll = 0, scale = 1, matrix } = options;
  const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
  if (
    ![...Array.from(position), ...Array.from(s), yaw, pitch, roll].every(Number.isFinite) ||
    s.length !== 3 ||
    position.length !== 3
  )
    throw new RangeError('Invalid placement; pass finite position, scale and angles');
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cx = Math.cos(pitch),
    sx = Math.sin(pitch),
    cz = Math.cos(roll),
    sz = Math.sin(roll);
  // R = Ry * Rx * Rz, columns scaled.
  const r = [
    cy * cz + sy * sx * sz,
    cx * sz,
    -sy * cz + cy * sx * sz,
    -cy * sz + sy * sx * cz,
    cx * cz,
    sy * sz + cy * sx * cz,
    sy * cx,
    -sx,
    cy * cx,
  ];
  const out = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[c * 4 + k] = r[c * 3 + k] * s[c];
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  if (!matrix) return out;
  if (matrix.length !== 16) throw new RangeError('Expected a 4x4 matrix with 16 values');
  const m = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let k = 0; k < 4; k++) {
      let v = 0;
      for (let j = 0; j < 4; j++) v += matrix[j * 4 + k] * out[c * 4 + j];
      m[c * 4 + k] = v;
    }
  return m;
}

/** A copy of `data` placed by `options` (positions, normals and tangents transformed; colours set when given). */
export function placeGeometry(data: GeometryData, options: PlaceOptions = {}): GeometryData {
  const placed = applyMatrix4(data, placementMatrix(options));
  return options.color === undefined ? placed : tintGeometry(placed, options.color);
}

/** A copy of `data` with every vertex coloured `color` (linear rgba in `colors`). */
export function tintGeometry(data: GeometryData, color: ColorInput): GeometryData {
  const rgba = parseColor(color),
    count = data.positions.length / 3,
    colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set(rgba, i * 4);
  const out: GeometryData = { ...data, colors };
  if (data.groups) out.groups = data.groups.map((g) => ({ ...g }));
  return out;
}

const sub3 = (a: P3, b: P3): MutableVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: P3, b: P3): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (a: P3, fallback: P3 = [0, 1, 0]): MutableVec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
};
/** Newell's normal of a polygon (unnormalized; its length is twice the area). */
function newell(points: readonly P3[]): MutableVec3 {
  const n: MutableVec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function check(points: readonly P3[], label: string): void {
  for (const p of points)
    if (!p || p.length < 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]))
      throw new RangeError(`${label}: pass finite [x, y, z] points`);
}

/**
 * Collects triangles into one `GeometryData`. Faces are counter-clockwise when seen from their front; flat faces get
 * their normal from that winding. Every method returns the builder, so calls chain.
 *
 * ```js
 * const builder = new GeometryBuilder({ colors: true, smooth: 30 });
 * builder.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], { color: '#c79554' });
 * const geometry = builder.geometry();
 * ```
 */
export class GeometryBuilder {
  readonly #positions: number[] = [];
  readonly #normals: number[] = [];
  readonly #uvs: number[] = [];
  readonly #colors: number[] = [];
  readonly #indices: number[] = [];
  /** Indices of the flat faces, which `smooth` reshades. */
  readonly #flat: number[] = [];
  readonly #options: GeometryBuilderOptions;
  #color: Rgba;

  constructor(options: GeometryBuilderOptions = {}) {
    const smooth = options.smooth;
    if (smooth !== undefined && typeof smooth !== 'boolean' && !(smooth >= 0 && smooth <= 180))
      throw new RangeError('GeometryBuilder smooth must be a boolean or an angle from 0 to 180 degrees');
    this.#options = options;
    this.#color = parseColor(options.color ?? [1, 1, 1, 1]);
  }

  /** Vertices added so far. */
  get vertexCount(): number {
    return this.#positions.length / 3;
  }

  /** Triangles added so far. */
  get triangleCount(): number {
    return this.#indices.length / 3;
  }

  /** Sets the colour of vertices added from now on without their own. */
  setColor(color: ColorInput): this {
    this.#color = parseColor(color);
    return this;
  }

  /** Adds one vertex and returns its index, for use with `index`. */
  vertex(position: P3, normal: P3, uv: ArrayLike<number> = [0, 0], color?: ColorInput | Rgba): number {
    check([position, normal], 'GeometryBuilder.vertex');
    const c = color === undefined ? this.#color : parseColor(color);
    this.#positions.push(position[0], position[1], position[2]);
    this.#normals.push(normal[0], normal[1], normal[2]);
    this.#uvs.push(uv[0] ?? 0, uv[1] ?? 0);
    this.#colors.push(c[0], c[1], c[2], c[3]);
    return this.#positions.length / 3 - 1;
  }

  /** Adds a triangle over vertices made with `vertex`. */
  index(a: number, b: number, c: number): this {
    const n = this.vertexCount;
    for (const i of [a, b, c])
      if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError('GeometryBuilder.index: pass vertex indices');
    this.#indices.push(a, b, c);
    return this;
  }

  #face(
    points: readonly P3[],
    uvs: readonly (readonly number[])[],
    triangles: readonly number[],
    options: FaceOptions,
  ) {
    const normal = unit3(newell(points));
    const color = options.color === undefined ? this.#color : parseColor(options.color);
    const base = this.vertexCount;
    points.forEach((p, k) => this.vertex(p, normal, uvs[k], color));
    for (let t = 0; t < triangles.length; t += 3) {
      const a = base + triangles[t],
        b = base + triangles[t + (options.flip ? 2 : 1)],
        c = base + triangles[t + (options.flip ? 1 : 2)];
      this.#indices.push(a, b, c);
      this.#flat.push(a, b, c);
    }
    if (options.flip) for (let i = base * 3; i < this.#normals.length; i++) this.#normals[i] = -this.#normals[i];
  }

  /** A flat triangle a, b, c. */
  triangle(a: P3, b: P3, c: P3, options: FaceOptions = {}): this {
    check([a, b, c], 'GeometryBuilder.triangle');
    this.#face(
      [a, b, c],
      options.uvs ?? [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      [0, 1, 2],
      options,
    );
    return this;
  }

  /** A flat quad a, b, c, d (two triangles, split along a to c). */
  quad(a: P3, b: P3, c: P3, d: P3, options: FaceOptions = {}): this {
    check([a, b, c, d], 'GeometryBuilder.quad');
    this.#face(
      [a, b, c, d],
      options.uvs ?? [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [0, 1, 2, 0, 2, 3],
      options,
    );
    return this;
  }

  /**
   * A planar polygon, convex or not, with optional holes, triangulated by ear clipping. The outline is
   * counter-clockwise from the front (holes either way). Default UVs are plane coordinates in world units.
   */
  polygon(points: readonly P3[], options: PolygonOptions = {}): this {
    const holes = options.holes ?? [];
    check(points, 'GeometryBuilder.polygon');
    for (const hole of holes) check(hole, 'GeometryBuilder.polygon hole');
    if (points.length < 3) throw new RangeError('GeometryBuilder.polygon: pass at least three points');
    const n = unit3(newell(points), [0, 0, 1]);
    // A plane basis: e1 along the axis least aligned with n.
    const ax = Math.abs(n[0]),
      ay = Math.abs(n[1]),
      az = Math.abs(n[2]);
    const e1 = unit3(cross3(ay <= ax && ay <= az ? [0, 1, 0] : ax <= az ? [1, 0, 0] : [0, 0, 1], n));
    const e2 = cross3(n, e1);
    const all = [...points, ...holes.flat()];
    const flat: number[] = [];
    for (const p of all)
      flat.push(p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]);
    const holeStarts: number[] = [];
    let at = points.length;
    for (const hole of holes) {
      holeStarts.push(at);
      at += hole.length;
    }
    const tris = triangulate(flat, holeStarts);
    // Ear clipping may wind either way; turn every triangle to face n.
    for (let t = 0; t < tris.length; t += 3) {
      const i = tris[t],
        j = tris[t + 1],
        k = tris[t + 2];
      const area =
        (flat[j * 2] - flat[i * 2]) * (flat[k * 2 + 1] - flat[i * 2 + 1]) -
        (flat[k * 2] - flat[i * 2]) * (flat[j * 2 + 1] - flat[i * 2 + 1]);
      if (area < 0) (tris[t + 1] = k), (tris[t + 2] = j);
    }
    const uvs = options.uvs ?? all.map((_, k) => [flat[k * 2], flat[k * 2 + 1]]);
    const color = options.color === undefined ? this.#color : parseColor(options.color);
    const base = this.vertexCount,
      normal = options.flip ? [-n[0], -n[1], -n[2]] : n;
    all.forEach((p, k) => this.vertex(p, normal, uvs[k], color));
    for (let t = 0; t < tris.length; t += 3) {
      const a = base + tris[t],
        b = base + tris[t + (options.flip ? 2 : 1)],
        c = base + tris[t + (options.flip ? 1 : 2)];
      this.#indices.push(a, b, c);
      this.#flat.push(a, b, c);
    }
    return this;
  }

  /**
   * Quads joining two rows of equal length: a[i], a[i + 1], b[i + 1], b[i] for each step. U runs along the rows by
   * arc length and V is `options.v`. Faces are flat unless the builder smooths.
   */
  strip(a: readonly P3[], b: readonly P3[], options: StripOptions = {}): this {
    check(a, 'GeometryBuilder.strip');
    check(b, 'GeometryBuilder.strip');
    if (a.length !== b.length || a.length < 2)
      throw new RangeError('GeometryBuilder.strip: pass two rows of the same length, at least two points each');
    const closed = options.closed ?? false,
      [v0, v1] = options.v ?? [0, 1],
      steps = closed ? a.length : a.length - 1;
    const along = [0];
    for (let i = 1; i <= steps; i++) {
      const p = a[i % a.length],
        q = a[i - 1];
      along.push(along[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    const total = along[steps] || 1;
    const face: FaceOptions = { flip: options.flip };
    if (options.color !== undefined) face.color = options.color;
    for (let i = 0; i < steps; i++) {
      const j = (i + 1) % a.length,
        u0 = along[i] / total,
        u1 = along[i + 1] / total;
      face.uvs = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      this.quad(a[i], a[j], b[j], b[i], face);
    }
    return this;
  }

  /**
   * A parametric patch: `fn(u, v)` with u in [0, 1] over `nu` steps and v over `nv` steps, (nu + 1) x (nv + 1)
   * shared vertices with UV (u, v). The front is where the derivative in u crossed with the one in v points.
   */
  grid(nu: number, nv: number, fn: (u: number, v: number) => P3, options: GridOptions = {}): this {
    if (!Number.isInteger(nu) || !Number.isInteger(nv) || nu < 1 || nv < 1)
      throw new RangeError('GeometryBuilder.grid: pass whole step counts of at least 1');
    const base = this.vertexCount,
      sign = options.flip ? -1 : 1,
      h = 1e-4,
      paint = options.color;
    const at = (u: number, v: number) => {
      const p = fn(u, v);
      check([p], 'GeometryBuilder.grid');
      return p;
    };
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const u = i / nu,
          v = j / nv,
          p = at(u, v);
        let n: P3;
        if (options.normal) n = unit3(options.normal(u, v));
        else {
          const du = sub3(at(Math.min(1, u + h), v), at(Math.max(0, u - h), v)),
            dv = sub3(at(u, Math.min(1, v + h)), at(u, Math.max(0, v - h)));
          n = unit3(cross3(du, dv));
        }
        const color = paint === undefined ? this.#color : typeof paint === 'function' ? paint(u, v) : paint;
        this.vertex(p, [n[0] * sign, n[1] * sign, n[2] * sign], [u, v], color);
      }
    const row = nu + 1;
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i,
          b = a + 1,
          c = a + row + 1,
          d = a + row;
        if (options.flip) this.#indices.push(a, c, b, a, d, c);
        else this.#indices.push(a, b, c, a, c, d);
      }
    return this;
  }

  /** Appends a copy of `data`, placed by `options`; its normals, UVs, groups ignored, colours kept or set. */
  append(data: GeometryData, options: PlaceOptions = {}): this {
    const placed = applyMatrix4(data, placementMatrix(options));
    const base = this.vertexCount,
      count = placed.positions.length / 3,
      color = options.color === undefined ? undefined : parseColor(options.color);
    for (let i = 0; i < count; i++) {
      this.#positions.push(placed.positions[i * 3], placed.positions[i * 3 + 1], placed.positions[i * 3 + 2]);
      this.#normals.push(placed.normals[i * 3], placed.normals[i * 3 + 1], placed.normals[i * 3 + 2]);
      this.#uvs.push(placed.uvs[i * 2] ?? 0, placed.uvs[i * 2 + 1] ?? 0);
      const c = color ?? (placed.colors ? Array.from(placed.colors.subarray(i * 4, i * 4 + 4)) : this.#color);
      this.#colors.push(c[0], c[1], c[2], c[3]);
    }
    for (const i of placed.indices) this.#indices.push(base + i);
    return this;
  }

  /** The collected mesh. Smooths the flat faces when the builder was made with `smooth`, then welds. */
  data(): GeometryData {
    const positions = Float32Array.from(this.#positions),
      normals = Float32Array.from(this.#normals);
    const smooth = this.#options.smooth;
    if (smooth && this.#flat.length) {
      const angle = smooth === true ? 180 : smooth;
      const shaded = creasedNormals(positions, { indices: this.#flat, angle, tolerance: 1e-6 });
      for (const v of this.#flat) normals.set(shaded.subarray(v * 3, v * 3 + 3), v * 3);
    }
    let out: GeometryData = {
      positions,
      normals,
      uvs: Float32Array.from(this.#uvs),
      indices: Uint32Array.from(this.#indices),
    };
    if (this.#options.colors) out.colors = Float32Array.from(this.#colors);
    if (this.#options.weld !== false && positions.length) out = mergeVertices(out, { tolerance: 1e-7 });
    return out;
  }

  /** The collected mesh as a core `Geometry` (positions, normals and indices). */
  geometry(): Geometry {
    return toGeometry(this.data());
  }
}
