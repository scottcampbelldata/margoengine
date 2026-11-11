// Picking scattered instances (`@margoengine/scatter/pick`): a ray or a sphere against every instance of a batch, for
// selection and harvesting. CPU only, on the transforms the app already holds (`instanceTransforms`,
// `groundTransforms`, a `ScatterBatch`). Broad phase: a uniform XZ grid of the instances' world boxes walked front to
// back by a 2D digital differential analyser (Amanatides and Woo 1987). Narrow phase: the ray in each instance's local
// space against its box (slab test, Kay and Kajiya 1986) and, when a mesh is given, against its triangles
// (Moller and Trumbore 1997).
import { rangeError, typeError } from '../../shared/errors.js';

/** A point or vector in world or local units. */
export type PickVec3 = readonly [x: number, y: number, z: number];
/** A local-space box around the mesh every instance draws. */
export interface PickBox {
  readonly min: PickVec3;
  readonly max: PickVec3;
}
/** The mesh every instance draws, for exact hits. `positions` holds x, y, z at the start of every `stride` floats. */
export interface PickMesh {
  readonly positions: Float32Array;
  /** Floats per vertex (default 3; a `ScatterBatch`'s `vertices` use 20). */
  readonly stride?: number;
  readonly indices: Uint32Array | Uint16Array;
}
/** Options of `new InstancePicker(transforms, options)`. */
export interface InstancePickerOptions {
  /** Local box of the drawn mesh. Default: the box of `mesh`. */
  readonly bounds?: PickBox;
  /** Test the mesh's triangles after the box, so a ray through the gaps of a tree misses it. Default: box only. */
  readonly mesh?: PickMesh;
  /** Side of a grid cell in world units, above 0. Default: from the instances' spread and size. */
  readonly cell?: number;
}
/** The nearest instance a ray hits. */
export interface InstanceHit {
  /** Instance number: its place in the transforms. */
  readonly index: number;
  /** World distance from the ray origin. */
  readonly distance: number;
  /** World point hit. */
  readonly point: [number, number, number];
}

const MAX_CELLS = 1024;

/** The box of `positions` (x, y, z at the start of every `stride` floats). */
export function boundsOf(positions: Float32Array, stride = 3): PickBox {
  if (!(positions instanceof Float32Array) || !Number.isInteger(stride) || stride < 3 || positions.length < 3)
    throw typeError('boundsOf takes a Float32Array of positions and a stride of 3 or more', 'scatter');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += stride)
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

const vec = (v: unknown): v is ArrayLike<number> =>
  v != null && typeof (v as ArrayLike<number>).length === 'number' && (v as ArrayLike<number>).length >= 3;
const finite3 = (v: ArrayLike<number>) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/**
 * Ray and sphere picks over scattered instances. Holds a copy of the transforms; `remove` takes an instance out of
 * every later pick (a harvested plant), and `kept()` gives the transforms left, to draw again.
 */
export class InstancePicker {
  readonly count: number;
  readonly #m: Float32Array;
  readonly #box: Float64Array;
  readonly #tri?: { p: Float32Array; s: number; i: Uint32Array | Uint16Array };
  readonly #cellOption?: number;
  readonly #gone: Uint8Array;
  // Per instance: world box (min xyz, max xyz) and inverse of the 3x3 part (9) plus translation (3); a 0 determinant
  // leaves the instance unpickable (a scale of 0 draws nothing).
  readonly #world: Float32Array;
  readonly #inv: Float64Array;
  #removed = 0;
  #dirty = true;
  #grid = { x0: 0, z0: 0, cell: 1, nx: 1, nz: 1, y0: 0, y1: 0, start: new Uint32Array(2), items: new Uint32Array(0) };
  #stamp: Uint32Array;
  #query = 0;

  constructor(transforms: Float32Array, options: InstancePickerOptions = {}) {
    if (!(transforms instanceof Float32Array) || transforms.length % 16 !== 0)
      throw typeError('InstancePicker takes transforms: a Float32Array of 16 floats per instance', 'scatter');
    const { bounds, mesh, cell } = options ?? {};
    if (mesh !== undefined) {
      const stride = mesh?.stride ?? 3;
      if (
        !(mesh?.positions instanceof Float32Array) ||
        !(mesh.indices instanceof Uint32Array || mesh.indices instanceof Uint16Array) ||
        !Number.isInteger(stride) ||
        stride < 3 ||
        mesh.indices.length % 3 !== 0 ||
        mesh.indices.some((i) => i * stride + 2 >= mesh.positions.length)
      )
        throw typeError('A pick mesh is { positions, stride?, indices } with indices into positions', 'scatter');
      this.#tri = { p: mesh.positions, s: stride, i: mesh.indices };
    }
    const box = bounds ?? (mesh ? boundsOf(mesh.positions, mesh.stride ?? 3) : undefined);
    if (box === undefined)
      throw typeError('InstancePicker needs bounds { min, max } or a mesh { positions, indices }', 'scatter');
    if (
      !vec(box.min) ||
      !vec(box.max) ||
      !finite3(box.min) ||
      !finite3(box.max) ||
      !(box.min[0] <= box.max[0] && box.min[1] <= box.max[1] && box.min[2] <= box.max[2])
    )
      throw rangeError('A pick box is { min: [x, y, z], max: [x, y, z] } with min at most max', 'scatter');
    if (cell !== undefined && !(Number.isFinite(cell) && cell > 0))
      throw rangeError('A pick cell is a number of world units above 0', 'scatter');
    this.#cellOption = cell;
    this.#box = new Float64Array([box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2]]);
    this.count = transforms.length / 16;
    this.#m = transforms.slice();
    this.#gone = new Uint8Array(this.count);
    this.#world = new Float32Array(this.count * 6);
    this.#inv = new Float64Array(this.count * 12);
    this.#stamp = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) this.#place(i);
  }

  /** Instances not removed. */
  get active(): number {
    return this.count - this.#removed;
  }

  #index(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw rangeError('A pick instance index is an integer 0..count - 1', 'scatter');
  }

  // World box and inverse transform of instance i.
  #place(i: number): void {
    const m = this.#m,
      o = i * 16,
      b = this.#box,
      w = this.#world,
      inv = this.#inv,
      q = i * 12;
    const a = m[o],
      bq = m[o + 4],
      c = m[o + 8],
      d = m[o + 1],
      e = m[o + 5],
      f = m[o + 9],
      g = m[o + 2],
      h = m[o + 6],
      k = m[o + 10];
    const A = e * k - f * h,
      B = f * g - d * k,
      C = d * h - e * g,
      det = a * A + bq * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-30) inv[q] = Number.NaN;
    else {
      const r = 1 / det;
      inv.set(
        [
          A * r,
          (c * h - bq * k) * r,
          (bq * f - c * e) * r,
          B * r,
          (a * k - c * g) * r,
          (c * d - a * f) * r,
          C * r,
          (bq * g - a * h) * r,
          (a * e - bq * d) * r,
          m[o + 12],
          m[o + 13],
          m[o + 14],
        ],
        q,
      );
    }
    // World box: centre and half extents through the absolute 3x3 (Arvo 1990).
    for (let r = 0; r < 3; r++) {
      const row = [m[o + r], m[o + 4 + r], m[o + 8 + r]];
      let centre = m[o + 12 + r],
        half = 0;
      for (let s = 0; s < 3; s++) {
        centre += row[s] * (b[s] + b[s + 3]) * 0.5;
        half += Math.abs(row[s]) * (b[s + 3] - b[s]) * 0.5;
      }
      w[i * 6 + r] = centre - half;
      w[i * 6 + 3 + r] = centre + half;
    }
    this.#dirty = true;
  }

  #build(): void {
    const n = this.count,
      w = this.#world;
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity,
      size = 0,
      live = 0;
    for (let i = 0; i < n; i++) {
      if (this.#gone[i] || !Number.isFinite(this.#inv[i * 12]) || !(w[i * 6] <= w[i * 6 + 3])) continue;
      live++;
      x0 = Math.min(x0, w[i * 6]);
      y0 = Math.min(y0, w[i * 6 + 1]);
      z0 = Math.min(z0, w[i * 6 + 2]);
      x1 = Math.max(x1, w[i * 6 + 3]);
      y1 = Math.max(y1, w[i * 6 + 4]);
      z1 = Math.max(z1, w[i * 6 + 5]);
      size += Math.max(w[i * 6 + 3] - w[i * 6], w[i * 6 + 5] - w[i * 6 + 2]);
    }
    if (!live) {
      this.#grid = { x0: 0, z0: 0, cell: 1, nx: 1, nz: 1, y0: 1, y1: 0, start: new Uint32Array(2), items: new Uint32Array(0) };
      this.#dirty = false;
      return;
    }
    // The world boxes are float32: widen the grid's view of them a little, so rounding never drops a cell a box
    // reaches (the hit test itself is exact, in local space).
    const pad = 1e-5 * (Math.max(Math.abs(x0), Math.abs(x1), Math.abs(z0), Math.abs(z1), Math.abs(y0), Math.abs(y1)) + 1);
    x0 -= pad;
    z0 -= pad;
    y0 -= pad;
    x1 += pad;
    z1 += pad;
    y1 += pad;
    const spread = Math.max(x1 - x0, z1 - z0);
    // About one instance per cell, never smaller than the mean instance, and at most MAX_CELLS a side.
    let cell = this.#cellOption ?? Math.max(size / live, spread / Math.ceil(Math.sqrt(live)));
    cell = Math.max(cell, spread / MAX_CELLS);
    const nx = Math.min(MAX_CELLS, Math.floor((x1 - x0) / cell) + 1),
      nz = Math.min(MAX_CELLS, Math.floor((z1 - z0) / cell) + 1);
    const cx = (v: number) => Math.min(nx - 1, Math.max(0, Math.floor((v - x0) / cell))),
      cz = (v: number) => Math.min(nz - 1, Math.max(0, Math.floor((v - z0) / cell)));
    const start = new Uint32Array(nx * nz + 1);
    const each = (fn: (c: number, i: number) => void) => {
      for (let i = 0; i < n; i++) {
        if (this.#gone[i] || !Number.isFinite(this.#inv[i * 12]) || !(w[i * 6] <= w[i * 6 + 3])) continue;
        const ax = cx(w[i * 6] - pad),
          bx = cx(w[i * 6 + 3] + pad),
          az = cz(w[i * 6 + 2] - pad),
          bz = cz(w[i * 6 + 5] + pad);
        for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) fn(z * nx + x, i);
      }
    };
    each((c) => start[c + 1]++);
    for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
    const items = new Uint32Array(start[nx * nz]),
      fill = start.slice(0, nx * nz);
    each((c, i) => (items[fill[c]++] = i));
    this.#grid = { x0, z0, cell, nx, nz, y0, y1, start, items };
    this.#dirty = false;
  }

  // Ray parameter of the first hit on instance i, or Infinity; the ray is world origin o, unit direction d.
  #hit(i: number, o: ArrayLike<number>, d: ArrayLike<number>, far: number): number {
    const v = this.#inv,
      q = i * 12;
    const px = o[0] - v[q + 9],
      py = o[1] - v[q + 10],
      pz = o[2] - v[q + 11];
    const lo = [v[q] * px + v[q + 1] * py + v[q + 2] * pz, v[q + 3] * px + v[q + 4] * py + v[q + 5] * pz, v[q + 6] * px + v[q + 7] * py + v[q + 8] * pz];
    const ld = [
      v[q] * d[0] + v[q + 1] * d[1] + v[q + 2] * d[2],
      v[q + 3] * d[0] + v[q + 4] * d[1] + v[q + 5] * d[2],
      v[q + 6] * d[0] + v[q + 7] * d[1] + v[q + 8] * d[2],
    ];
    const b = this.#box;
    // The three slab entry times of a point or corner hit round one step apart, so hit or miss is decided on the box
    // grown by 8 machine epsilons of its farthest corner from the ray origin (as `Ray.intersectBox` in math); `tn`,
    // the distance returned, stays the exact entry.
    const pad =
      8 *
      Number.EPSILON *
      Math.hypot(
        Math.max(Math.abs(b[0] - lo[0]), Math.abs(b[3] - lo[0])),
        Math.max(Math.abs(b[1] - lo[1]), Math.abs(b[4] - lo[1])),
        Math.max(Math.abs(b[2] - lo[2]), Math.abs(b[5] - lo[2])),
      );
    let tn = 0,
      near = 0,
      tf = far;
    for (let k = 0; k < 3; k++) {
      if (ld[k] === 0) {
        if (lo[k] < b[k] || lo[k] > b[k + 3]) return Infinity;
        continue;
      }
      let t0 = (b[k] - lo[k]) / ld[k],
        t1 = (b[k + 3] - lo[k]) / ld[k];
      if (t0 > t1) [t0, t1] = [t1, t0];
      const slack = pad / Math.abs(ld[k]);
      if (t0 > tn) tn = t0;
      if (t0 - slack > near) near = t0 - slack;
      if (t1 + slack < tf) tf = t1 + slack;
      if (near > tf) return Infinity;
    }
    const tri = this.#tri;
    if (!tri) return tn;
    // Both faces count: a blade or a leaf card is hit from either side.
    let best = Infinity;
    const { p, s, i: ix } = tri;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * s,
        bb = ix[t + 1] * s,
        c = ix[t + 2] * s;
      const e1x = p[bb] - p[a],
        e1y = p[bb + 1] - p[a + 1],
        e1z = p[bb + 2] - p[a + 2],
        e2x = p[c] - p[a],
        e2y = p[c + 1] - p[a + 1],
        e2z = p[c + 2] - p[a + 2];
      const hx = ld[1] * e2z - ld[2] * e2y,
        hy = ld[2] * e2x - ld[0] * e2z,
        hz = ld[0] * e2y - ld[1] * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det === 0) continue;
      const inv = 1 / det,
        sx = lo[0] - p[a],
        sy = lo[1] - p[a + 1],
        sz = lo[2] - p[a + 2];
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y,
        qy = sz * e1x - sx * e1z,
        qz = sx * e1y - sy * e1x;
      const w = (ld[0] * qx + ld[1] * qy + ld[2] * qz) * inv;
      if (w < 0 || u + w > 1) continue;
      const hitT = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hitT >= 0 && hitT <= far && hitT < best) best = hitT;
    }
    return best;
  }

  #ray(origin: ArrayLike<number>, direction: ArrayLike<number>, maxDistance: number): [number, number, number] {
    if (!vec(origin) || !vec(direction) || !finite3(origin) || !finite3(direction))
      throw rangeError('A pick ray needs a finite origin and a direction other than 0', 'scatter');
    const len = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(len > 0)) throw rangeError('A pick ray needs a finite origin and a direction other than 0', 'scatter');
    if (!(maxDistance > 0)) throw rangeError('A pick maxDistance is above 0 (default Infinity)', 'scatter');
    return [direction[0] / len, direction[1] / len, direction[2] / len];
  }

  // Walks the grid cells the ray crosses, front to back; visit(i) returns the best hit so far, which ends the walk once
  // it lies inside the cells already walked.
  #walk(o: ArrayLike<number>, d: readonly number[], far: number, visit: (i: number) => number): void {
    if (this.#dirty) this.#build();
    const g = this.#grid,
      x1 = g.x0 + g.nx * g.cell,
      z1 = g.z0 + g.nz * g.cell;
    // Clip to the grid's box (x, z) and the instances' height range (y).
    let t0 = 0,
      t1 = far;
    const lo = [g.x0, g.y0, g.z0],
      hi = [x1, g.y1, z1];
    for (let k = 0; k < 3; k++) {
      if (d[k] === 0) {
        if (o[k] < lo[k] || o[k] > hi[k]) return;
        continue;
      }
      let a = (lo[k] - o[k]) / d[k],
        b = (hi[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return;
    }
    const sx = o[0] + d[0] * t0,
      sz = o[2] + d[2] * t0;
    let x = Math.min(g.nx - 1, Math.max(0, Math.floor((sx - g.x0) / g.cell))),
      z = Math.min(g.nz - 1, Math.max(0, Math.floor((sz - g.z0) / g.cell)));
    const stepX = d[0] > 0 ? 1 : -1,
      stepZ = d[2] > 0 ? 1 : -1;
    const dX = d[0] === 0 ? Infinity : g.cell / Math.abs(d[0]),
      dZ = d[2] === 0 ? Infinity : g.cell / Math.abs(d[2]);
    let nX = d[0] === 0 ? Infinity : (g.x0 + (x + (d[0] > 0 ? 1 : 0)) * g.cell - o[0]) / d[0],
      nZ = d[2] === 0 ? Infinity : (g.z0 + (z + (d[2] > 0 ? 1 : 0)) * g.cell - o[2]) / d[2];
    const q = ++this.#query;
    if (q === 0xffffffff) {
      this.#stamp.fill(0);
      this.#query = 1;
    }
    const stamp = this.#query;
    let best = Infinity;
    for (;;) {
      const c = z * g.nx + x;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const i = g.items[k];
        if (this.#stamp[i] === stamp) continue;
        this.#stamp[i] = stamp;
        best = Math.min(best, visit(i));
      }
      const exit = Math.min(nX, nZ);
      if (best <= exit || exit > t1) return;
      if (nX < nZ) {
        x += stepX;
        nX += dX;
        if (x < 0 || x >= g.nx) return;
      } else {
        z += stepZ;
        nZ += dZ;
        if (z < 0 || z >= g.nz) return;
      }
    }
  }

  /** The nearest instance the ray hits within `maxDistance`, or null. `direction` need not be unit length. */
  pick(origin: ArrayLike<number>, direction: ArrayLike<number>, maxDistance = Infinity): InstanceHit | null {
    const d = this.#ray(origin, direction, maxDistance);
    let best = Infinity,
      index = -1;
    this.#walk(origin, d, maxDistance, (i) => {
      const t = this.#hit(i, origin, d, Math.min(maxDistance, best));
      if (t < best || (t === best && i < index)) {
        best = t;
        index = i;
      }
      return best;
    });
    if (index < 0) return null;
    return { index, distance: best, point: [origin[0] + d[0] * best, origin[1] + d[1] * best, origin[2] + d[2] * best] };
  }

  /** Every instance the ray hits within `maxDistance`, nearest first. */
  pickAll(origin: ArrayLike<number>, direction: ArrayLike<number>, maxDistance = Infinity): InstanceHit[] {
    const d = this.#ray(origin, direction, maxDistance),
      out: InstanceHit[] = [];
    this.#walk(origin, d, maxDistance, (i) => {
      const t = this.#hit(i, origin, d, maxDistance);
      if (t <= maxDistance)
        out.push({ index: i, distance: t, point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t] });
      return Infinity;
    });
    return out.sort((a, b) => a.distance - b.distance || a.index - b.index);
  }

  /** Instances whose world box comes within `radius` of `center` (a harvesting swing, a blast), nearest box first. */
  near(center: ArrayLike<number>, radius: number): number[] {
    if (!vec(center) || !finite3(center)) throw rangeError('A pick centre is a finite [x, y, z]', 'scatter');
    if (!(Number.isFinite(radius) && radius > 0)) throw rangeError('A pick radius is a number above 0', 'scatter');
    if (this.#dirty) this.#build();
    const g = this.#grid,
      w = this.#world,
      found: [number, number][] = [];
    const cx = (v: number) => Math.floor((v - g.x0) / g.cell),
      cz = (v: number) => Math.floor((v - g.z0) / g.cell);
    const ax = Math.max(0, cx(center[0] - radius)),
      bx = Math.min(g.nx - 1, cx(center[0] + radius)),
      az = Math.max(0, cz(center[2] - radius)),
      bz = Math.min(g.nz - 1, cz(center[2] + radius));
    if (++this.#query === 0xffffffff) {
      this.#stamp.fill(0);
      this.#query = 1;
    }
    const stamp = this.#query;
    for (let z = az; z <= bz; z++)
      for (let x = ax; x <= bx; x++) {
        const c = z * g.nx + x;
        for (let k = g.start[c]; k < g.start[c + 1]; k++) {
          const i = g.items[k];
          if (this.#stamp[i] === stamp) continue;
          this.#stamp[i] = stamp;
          let s = 0;
          for (let r = 0; r < 3; r++) {
            const v = center[r],
              e = v < w[i * 6 + r] ? w[i * 6 + r] - v : v > w[i * 6 + 3 + r] ? v - w[i * 6 + 3 + r] : 0;
            s += e * e;
          }
          if (s <= radius * radius) found.push([s, i]);
        }
      }
    return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((f) => f[1]);
  }

  /** Takes instance `index` out of every later pick. Returns false when it was out already. */
  remove(index: number): boolean {
    this.#index(index);
    if (this.#gone[index]) return false;
    this.#gone[index] = 1;
    this.#removed++;
    this.#dirty = true;
    return true;
  }

  /** Puts a removed instance back (a plant grown again). Returns false when it was not removed. */
  restore(index: number): boolean {
    this.#index(index);
    if (!this.#gone[index]) return false;
    this.#gone[index] = 0;
    this.#removed--;
    this.#dirty = true;
    return true;
  }

  /** Whether `remove` took instance `index` out. */
  removed(index: number): boolean {
    this.#index(index);
    return this.#gone[index] === 1;
  }

  /** Moves instance `index` to a new column-major matrix (16 floats from `offset`). The grid rebuilds on the next pick. */
  setTransform(index: number, matrix: ArrayLike<number>, offset = 0): void {
    this.#index(index);
    if (!vec(matrix) || !Number.isInteger(offset) || offset < 0 || matrix.length < offset + 16)
      throw typeError('setTransform takes 16 floats of a column-major matrix', 'scatter');
    for (let k = 0; k < 16; k++) this.#m[index * 16 + k] = matrix[offset + k];
    this.#place(index);
  }

  /** The transforms of the instances not removed, in order, and the instance number of each. */
  kept(): { transforms: Float32Array; indices: Uint32Array } {
    const indices = new Uint32Array(this.active),
      transforms = new Float32Array(this.active * 16);
    for (let i = 0, k = 0; i < this.count; i++)
      if (!this.#gone[i]) {
        indices[k] = i;
        transforms.set(this.#m.subarray(i * 16, i * 16 + 16), k++ * 16);
      }
    return { transforms, indices };
  }
}
