import { MargoError } from '@margoengine/math/errors';

/** Most particles, and most vertices over all of them (the material mesh's own limit of 1,000,000 vertices). */
export const MAX_SOLID_PARTICLES = 1_000_000;
export const MAX_SOLID_VERTICES = 1_000_000;

type V3 = [number, number, number];

/** A shape to copy into particles: positions (xyz triples), optional normals, uvs (uv pairs) and indices (default: every 3 vertices). */
export interface SolidShape {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  indices?: ArrayLike<number>;
}

/** The merged mesh as flat arrays. Pass it to `createMesh` of `@margoengine/materials` (it takes this shape as is). */
export interface SolidGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** rgba per vertex, 0 to 1. */
  colors: Float32Array;
  indices: Uint32Array;
}

/** A vertex range, in vertices, as `setGeometry(geometry, range)` of a material mesh takes it. */
export interface SolidRange {
  start: number;
  count: number;
}

/** One particle of the system. Edit it in `updateParticle`, then `setParticles` writes it into the merged mesh. */
export interface SolidParticle {
  /** Index in the system, in creation order. */
  readonly idx: number;
  /** The id `addShape` or `digest` returned for the shape this particle copies. */
  readonly shapeId: number;
  /** World position (default [0,0,0]). */
  position: V3;
  /** Euler angles in radians about x (pitch), y (yaw) and z (roll), applied in the order roll, pitch, yaw. Ignored while `rotationQuaternion` is set. */
  rotation: V3;
  /** Unit quaternion [x, y, z, w], or null (default) to use `rotation`. Normalised on write. */
  rotationQuaternion: [number, number, number, number] | null;
  /** Scale per axis, applied before the rotation (default [1,1,1]). */
  scaling: V3;
  /** rgba, 0 to 1 (default white). */
  color: [number, number, number, number];
  /** The rectangle [u0, v0, u1, v1] the shape's 0 to 1 uvs map into (default [0,0,1,1]). */
  uvs: [number, number, number, number];
  /** Free for the caller (speed, age ...). */
  velocity: V3;
  props: unknown;
  /** False: `updateParticle` is not called, and the particle is not drawn or picked (default true). */
  alive: boolean;
  /** False: the particle is updated but collapsed to a point, not drawn or picked (default true). */
  isVisible: boolean;
  /** World box of the particle as last written (a point while hidden). */
  readonly boundingBox: { min: V3; max: V3 };
}

export interface SolidOptions {
  /** Called by `setParticles` for each alive particle in its range before it is written (default none). */
  updateParticle?: (particle: SolidParticle) => void;
}

export interface SolidShapeOptions {
  /** Sets each new particle's start (`particle`, its index in the shape, its index in the system). Default none. */
  positionFunction?: (particle: SolidParticle, indexInShape: number, indexInSystem: number) => void;
  /** Moves each template vertex of each particle once at creation (`vertex` is edited in place). Default none. */
  vertexFunction?: (particle: SolidParticle, vertex: V3, vertexIndex: number) => void;
  /** Start colour of the shape's particles (default white). */
  color?: readonly [number, number, number, number];
}

/** `number` particles, or `facetNb` triangles in each (`number` wins when both are given); default `facetNb` 1. */
export interface SolidDigestOptions extends SolidShapeOptions {
  number?: number;
  facetNb?: number;
}

export interface SolidRay {
  origin: ArrayLike<number>;
  direction: ArrayLike<number>;
}

export interface SolidPickOptions {
  /** Farthest hit in world units (default Infinity). */
  maxDistance?: number;
  /** Count hits on back faces too (default true; false needs counter-clockwise faces seen from the ray). */
  backFaces?: boolean;
}

export interface SolidPick {
  particleIndex: number;
  shapeId: number;
  /** Triangle number in the merged index buffer. */
  faceId: number;
  /** Triangle number inside the particle's own shape. */
  localFaceId: number;
  /** World distance along the (normalised) ray. */
  distance: number;
  point: V3;
}

interface Template {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

const finiteList = (v: unknown, name: string, size: number): ArrayLike<number> => {
  const a = v as ArrayLike<number>;
  if (!a || typeof a !== 'object' || typeof a.length !== 'number' || a.length % size)
    throw new TypeError(
      `Solid particle ${name} must be a list of ${size}-number groups; pass a Float32Array or number[]`,
    );
  for (let i = 0; i < a.length; i++)
    if (typeof a[i] !== 'number' || !Number.isFinite(a[i]))
      throw new RangeError(`Solid particle ${name}[${i}] is not a finite number; pass finite values`);
  return a;
};

/** Area-weighted vertex normals, for a shape that gives none. */
function computeNormals(p: ArrayLike<number>, idx: ArrayLike<number>): Float32Array {
  const n = new Float32Array(p.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3],
      ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2],
      f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i + k] += f[k];
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l) for (let k = 0; k < 3; k++) n[i + k] /= l;
    else n[i + 1] = 1;
  }
  return n;
}

function template(shape: SolidShape): Template {
  if (!shape || typeof shape !== 'object')
    throw new TypeError('Solid shape must be {positions, normals?, uvs?, indices?}; pass a geometry object');
  const positions = finiteList(shape.positions, 'positions', 3),
    count = positions.length / 3;
  if (count < 3) throw new RangeError('Solid shape needs at least one triangle; pass 3 or more vertices');
  const indices = shape.indices
    ? finiteList(shape.indices, 'indices', 3)
    : Array.from({ length: count - (count % 3) }, (_, i) => i);
  if (!indices.length || (!shape.indices && count % 3))
    throw new RangeError('Solid shape needs whole triangles; pass indices or a multiple of 3 vertices');
  for (let i = 0; i < indices.length; i++)
    if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= count)
      throw new RangeError(`Solid shape indices[${i}] is ${indices[i]}; pass whole numbers below ${count}`);
  const normals = shape.normals ? finiteList(shape.normals, 'normals', 3) : computeNormals(positions, indices),
    uvs = shape.uvs ? finiteList(shape.uvs, 'uvs', 2) : new Float32Array(count * 2);
  if (normals.length !== positions.length || uvs.length !== count * 2)
    throw new RangeError('Solid shape normals and uvs need one entry per vertex, as many as positions');
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

interface Slot {
  p: SolidParticle;
  t: Template;
  vertex: number;
  tri: number;
}

const whole = (v: unknown, name: string, min: number, max: number): number => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
    throw new RangeError(`Solid ${name} must be a whole number from ${min} to ${max}; got ${String(v)}`);
  return v as number;
};

/**
 * Solid particle system: many small meshes (a shape per `addShape` or `digest`) merged into ONE vertex and index
 * buffer, so the whole system is one draw. Each particle keeps a position, rotation (Euler or quaternion), scaling,
 * colour, uv rectangle, `alive` and `isVisible`. `setParticles(start?, end?)` runs `updateParticle` over a range and
 * rewrites only that range's vertices, reporting the vertex range to re-upload (`takeDirty`). `pick(ray)` tests the
 * merged buffer as it was last written, so what is drawn is what is picked.
 *
 * Build in order: `addShape` / `digest` (any number), `build()`, then `setParticles` and `pick`. Calls out of order
 * throw `MargoError` `'state'`; any call after `dispose()` throws `'disposed'`.
 */
export class SolidParticleSystem {
  updateParticle: ((p: SolidParticle) => void) | undefined;
  /** Every particle, in creation order. Read-only list; edit the particles in it. */
  readonly particles: SolidParticle[] = [];
  private slots: Slot[] = [];
  private shapes = 0;
  private data: SolidGeometry | null = null;
  private dirty: SolidRange | null = null;
  private dead = false;
  private busy = false;
  private vertices = 0;
  private triangles = 0;

  constructor(options: SolidOptions = {}) {
    if (options.updateParticle !== undefined && typeof options.updateParticle !== 'function')
      throw new TypeError('Solid updateParticle must be a function; pass (particle) => void');
    this.updateParticle = options.updateParticle;
  }

  private live(): void {
    if (this.dead) throw new MargoError('disposed', 'SolidParticleSystem is disposed; create a new one');
  }

  private add(t: Template, shapeId: number, o: SolidShapeOptions, indexInShape: number): void {
    const idx = this.particles.length,
      p: SolidParticle = {
        idx,
        shapeId,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        rotationQuaternion: null,
        scaling: [1, 1, 1],
        color: o.color ? [...o.color] : [1, 1, 1, 1],
        uvs: [0, 0, 1, 1],
        velocity: [0, 0, 0],
        props: undefined,
        alive: true,
        isVisible: true,
        boundingBox: { min: [0, 0, 0], max: [0, 0, 0] },
      };
    if (o.vertexFunction) {
      t = { ...t, positions: Float32Array.from(t.positions) };
      const v: V3 = [0, 0, 0];
      for (let i = 0; i < t.positions.length / 3; i++) {
        v[0] = t.positions[i * 3];
        v[1] = t.positions[i * 3 + 1];
        v[2] = t.positions[i * 3 + 2];
        o.vertexFunction(p, v, i);
        t.positions.set(v, i * 3);
      }
    }
    this.slots.push({ p, t, vertex: this.vertices, tri: this.triangles });
    this.particles.push(p);
    this.vertices += t.positions.length / 3;
    this.triangles += t.indices.length / 3;
    o.positionFunction?.(p, indexInShape, idx);
  }

  private room(particles: number, vertices: number): void {
    this.live();
    if (this.data) throw new MargoError('state', 'SolidParticleSystem is built; add shapes before build()');
    if (this.particles.length + particles > MAX_SOLID_PARTICLES || this.vertices + vertices > MAX_SOLID_VERTICES)
      throw new RangeError(
        `Solid system holds at most ${MAX_SOLID_PARTICLES} particles and ${MAX_SOLID_VERTICES} vertices; use fewer or smaller shapes`,
      );
  }

  /**
   * Adds `count` particles that copy `shape`. Returns the shape's id.
   * @throws TypeError / RangeError for a bad shape, count or option; MargoError `'state'` once built.
   */
  addShape(shape: SolidShape, count: number, options: SolidShapeOptions = {}): number {
    const t = template(shape);
    whole(count, 'count', 1, MAX_SOLID_PARTICLES);
    this.room(count, count * (t.positions.length / 3));
    const id = this.shapes++;
    for (let i = 0; i < count; i++) this.add(t, id, options, i);
    return id;
  }

  /**
   * Splits `shape` into particles of whole triangles (an explosion, a shattering): `number` particles or `facetNb`
   * triangles each (default 1). Each particle sits at the centre of its triangles' vertices, its own copy of them.
   * Returns the shape id; `particles` gains ceil(triangles / facetNb) entries.
   */
  digest(shape: SolidShape, options: SolidDigestOptions = {}): number {
    const t = template(shape),
      faces = t.indices.length / 3,
      facetNb =
        options.number !== undefined
          ? Math.ceil(faces / whole(options.number, 'digest number', 1, faces))
          : whole(options.facetNb ?? 1, 'digest facetNb', 1, faces),
      n = Math.ceil(faces / facetNb);
    this.room(n, faces * 3);
    const id = this.shapes++;
    for (let k = 0; k < n; k++) {
      const first = k * facetNb,
        last = Math.min(faces, first + facetNb),
        m = (last - first) * 3,
        part: Template = {
          positions: new Float32Array(m * 3),
          normals: new Float32Array(m * 3),
          uvs: new Float32Array(m * 2),
          indices: Uint32Array.from({ length: m }, (_, i) => i),
        },
        c = [0, 0, 0];
      for (let i = 0; i < m; i++) {
        const src = t.indices[first * 3 + i];
        for (let a = 0; a < 3; a++) {
          part.positions[i * 3 + a] = t.positions[src * 3 + a];
          part.normals[i * 3 + a] = t.normals[src * 3 + a];
          c[a] += t.positions[src * 3 + a] / m;
        }
        part.uvs.set(t.uvs.subarray(src * 2, src * 2 + 2), i * 2);
      }
      for (let i = 0; i < m; i++) for (let a = 0; a < 3; a++) part.positions[i * 3 + a] -= c[a];
      this.add(part, id, { ...options, positionFunction: undefined }, k);
      const p = this.particles[this.particles.length - 1];
      p.position = [c[0], c[1], c[2]];
      options.positionFunction?.(p, k, p.idx);
    }
    return id;
  }

  /**
   * Allocates the merged buffers and writes every particle once. Returns the geometry (also `geometry`).
   * @throws MargoError `'state'` when already built or empty.
   */
  build(): SolidGeometry {
    this.live();
    if (this.data) throw new MargoError('state', 'SolidParticleSystem is already built; build() runs once');
    if (!this.particles.length)
      throw new MargoError('state', 'SolidParticleSystem has no particles; call addShape or digest first');
    const V = this.vertices,
      g = (this.data = {
        positions: new Float32Array(V * 3),
        normals: new Float32Array(V * 3),
        uvs: new Float32Array(V * 2),
        colors: new Float32Array(V * 4),
        indices: new Uint32Array(this.triangles * 3),
      });
    for (const s of this.slots)
      for (let i = 0; i < s.t.indices.length; i++) g.indices[s.tri * 3 + i] = s.t.indices[i] + s.vertex;
    this.setParticles(0, this.particles.length - 1, false);
    return g;
  }

  /** The merged mesh. Throws `'state'` before `build()`. */
  get geometry(): SolidGeometry {
    this.live();
    if (!this.data) throw new MargoError('state', 'SolidParticleSystem is not built; call build() first');
    return this.data;
  }

  /**
   * Updates and writes particles `start` to `end` (inclusive; default all). With `update` false (default true) the
   * `updateParticle` callback is not called and the particles are only rewritten. Writes only their vertices.
   * @throws RangeError for a bad range or a non-finite particle value (naming the particle); MargoError `'state'` before
   * `build()` or when called from inside `updateParticle`.
   */
  setParticles(start = 0, end: number = this.particles.length - 1, update = true): this {
    const g = this.geometry;
    if (this.busy) throw new MargoError('state', 'setParticles is running; do not call it from updateParticle');
    const n = this.particles.length;
    whole(start, 'setParticles start', 0, n - 1);
    whole(end, 'setParticles end', start, n - 1);
    this.busy = true;
    try {
      for (let i = start; i <= end; i++) {
        const s = this.slots[i];
        if (update && s.p.alive && this.updateParticle) this.updateParticle(s.p);
        write(s, g);
      }
    } finally {
      this.busy = false;
    }
    const a = this.slots[start].vertex,
      last = this.slots[end],
      b = last.vertex + last.t.positions.length / 3;
    if (this.dirty) {
      const lo = Math.min(this.dirty.start, a),
        hi = Math.max(this.dirty.start + this.dirty.count, b);
      this.dirty = { start: lo, count: hi - lo };
    } else this.dirty = { start: a, count: b - a };
    return this;
  }

  /** The vertex range written since the last call (for `mesh.setGeometry(geometry, range)`), or null; clears it. */
  takeDirty(): SolidRange | null {
    this.live();
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** The box around every drawn particle (alive and visible), or null when none is. */
  getBounds(): { min: V3; max: V3 } | null {
    this.geometry;
    const min: V3 = [Infinity, Infinity, Infinity],
      max: V3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const { p } of this.slots)
      if (p.alive && p.isVisible) {
        any = true;
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], p.boundingBox.min[a]);
          max[a] = Math.max(max[a], p.boundingBox.max[a]);
        }
      }
    return any ? { min, max } : null;
  }

  /**
   * The nearest triangle the ray hits among alive, visible particles as last written, or null. Each particle's box is
   * tested first, then its triangles (Moller and Trumbore 1997).
   */
  pick(ray: SolidRay, options: SolidPickOptions = {}): SolidPick | null {
    const g = this.geometry,
      o = finiteList(ray?.origin, 'ray origin', 3),
      d0 = finiteList(ray?.direction, 'ray direction', 3);
    if (o.length !== 3 || d0.length !== 3) throw new RangeError('Solid ray origin and direction need 3 numbers each');
    const len = Math.hypot(d0[0], d0[1], d0[2]);
    if (!len) throw new RangeError('Solid ray direction is zero; pass a direction with length');
    const max = options.maxDistance ?? Infinity,
      back = options.backFaces ?? true;
    if (typeof max !== 'number' || !(max > 0) || typeof back !== 'boolean')
      throw new TypeError('Solid pick options: maxDistance a number above 0, backFaces a boolean');
    const d = [d0[0] / len, d0[1] / len, d0[2] / len];
    let best: SolidPick | null = null,
      limit = max;
    for (const s of this.slots) {
      const p = s.p;
      if (!p.alive || !p.isVisible || !slab(o, d, p.boundingBox, limit)) continue;
      const tris = s.t.indices.length / 3;
      for (let t = 0; t < tris; t++) {
        const [i, j, k] = [0, 1, 2].map((e) => g.indices[(s.tri + t) * 3 + e] * 3),
          P = g.positions,
          hit = triangle(o, d, P, i, j, k, back);
        if (hit !== null && hit <= limit) {
          limit = hit;
          best = {
            particleIndex: p.idx,
            shapeId: p.shapeId,
            faceId: s.tri + t,
            localFaceId: t,
            distance: hit,
            point: [o[0] + d[0] * hit, o[1] + d[1] * hit, o[2] + d[2] * hit],
          };
        }
      }
    }
    return best;
  }

  /** Frees the buffers and the particles. Safe to call twice. */
  dispose(): void {
    this.dead = true;
    this.data = null;
    this.slots = [];
    this.particles.length = 0;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Writes one particle's vertices, colours, uvs and box into the merged buffers. */
function write(s: Slot, g: SolidGeometry): void {
  const { p, t } = s,
    n = t.positions.length / 3,
    pos = p.position,
    sc = p.scaling,
    col = p.color,
    uv = p.uvs;
  for (const [name, list] of [
    ['position', pos],
    ['scaling', sc],
    ['color', col],
    ['uvs', uv],
    ['rotation', p.rotation],
  ] as const)
    for (const v of list)
      if (typeof v !== 'number' || !Number.isFinite(v))
        throw new RangeError(`Solid particle ${p.idx} ${name} is not finite; set finite numbers`);
  const q = p.rotationQuaternion;
  if (q && (q.length !== 4 || q.some((v) => !Number.isFinite(v)) || !Math.hypot(q[0], q[1], q[2], q[3])))
    throw new RangeError(
      `Solid particle ${p.idx} rotationQuaternion must be 4 finite numbers, not all zero; use null for none`,
    );
  const draw = p.alive && p.isVisible,
    // R as three rows
    R = q ? fromQuaternion(q) : fromEuler(p.rotation),
    out = p.boundingBox,
    P = g.positions,
    N = g.normals,
    inv = sc.map((v) => 1 / (v || 1));
  out.min = [Infinity, Infinity, Infinity];
  out.max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const v = (s.vertex + i) * 3,
      x = t.positions[i * 3] * sc[0],
      y = t.positions[i * 3 + 1] * sc[1],
      z = t.positions[i * 3 + 2] * sc[2];
    for (let a = 0; a < 3; a++) {
      P[v + a] = draw ? R[a * 3] * x + R[a * 3 + 1] * y + R[a * 3 + 2] * z + pos[a] : pos[a];
      out.min[a] = Math.min(out.min[a], P[v + a]);
      out.max[a] = Math.max(out.max[a], P[v + a]);
    }
    const nx = t.normals[i * 3] * inv[0],
      ny = t.normals[i * 3 + 1] * inv[1],
      nz = t.normals[i * 3 + 2] * inv[2],
      m = [0, 1, 2].map((a) => R[a * 3] * nx + R[a * 3 + 1] * ny + R[a * 3 + 2] * nz),
      l = Math.hypot(m[0], m[1], m[2]) || 1;
    for (let a = 0; a < 3; a++) N[v + a] = m[a] / l;
    const w = s.vertex + i;
    g.uvs[w * 2] = uv[0] + t.uvs[i * 2] * (uv[2] - uv[0]);
    g.uvs[w * 2 + 1] = uv[1] + t.uvs[i * 2 + 1] * (uv[3] - uv[1]);
    g.colors.set(col, w * 4);
  }
}

/** Row-major 3x3 of the unit quaternion [x, y, z, w]. */
function fromQuaternion(q: readonly number[]): number[] {
  const l = Math.hypot(q[0], q[1], q[2], q[3]),
    [x, y, z, w] = q.map((v) => v / l);
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

/** Row-major 3x3 of Ry(yaw) * Rx(pitch) * Rz(roll). */
function fromEuler(r: readonly number[]): number[] {
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(r[0]),
    Math.sin(r[0]),
    Math.cos(r[1]),
    Math.sin(r[1]),
    Math.cos(r[2]),
    Math.sin(r[2]),
  ];
  return [
    cy * cz + sy * sx * sz,
    -cy * sz + sy * sx * cz,
    sy * cx,
    cx * sz,
    cx * cz,
    -sx,
    -sy * cz + cy * sx * sz,
    sy * sz + cy * sx * cz,
    cy * cx,
  ];
}

/** Ray against a box (slab test); true when it enters before `limit`. */
function slab(o: ArrayLike<number>, d: number[], b: { min: V3; max: V3 }, limit: number): boolean {
  let near = 0,
    far = limit;
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return false;
      continue;
    }
    let t0 = (b.min[a] - o[a]) / d[a],
      t1 = (b.max[a] - o[a]) / d[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return false;
  }
  return true;
}

/** Moller-Trumbore ray/triangle distance (ray direction unit), or null. */
function triangle(
  o: ArrayLike<number>,
  d: number[],
  P: Float32Array,
  i: number,
  j: number,
  k: number,
  back: boolean,
): number | null {
  const e1 = [P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]],
    e2 = [P[k] - P[i], P[k + 1] - P[i + 1], P[k + 2] - P[i + 2]],
    h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
    det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (det === 0 || (!back && det < 0)) return null;
  const f = 1 / det,
    s = [o[0] - P[i], o[1] - P[i + 1], o[2] - P[i + 2]],
    u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0 || u > 1) return null;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
    v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
  if (v < 0 || u + v > 1) return null;
  const t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
  return t > 0 ? t : null;
}
