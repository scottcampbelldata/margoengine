import {buildBVH, checkSource, INTERNAL_FLAG, NODE_WORDS, type BVHBuildOptions, type BVHData} from './build.js';
import {closestPointTriangle, invert, rayTriangle, sideCode, transformPoint, triangleBox, triangleOutsidePlanes, triangleTriangle, type Side} from './math.js';

export type Vec3 = [number, number, number];
/** Anything with interleaved stride-6 `vertices` (position xyz, normal xyz) and `indices`, such as the core `Geometry`. */
export interface GeometryLike {readonly vertices: Float32Array; readonly indices: Uint32Array}
/** Raw triangle input. `positions` and `normals` share `stride` (default 3). Without `indices` every three vertices form a triangle. */
export interface TriangleSource {positions: ArrayLike<number>; indices?: ArrayLike<number> | null; normals?: ArrayLike<number> | null; stride?: number}
export interface Ray {origin: ArrayLike<number>; direction: ArrayLike<number>}
export interface RaycastOptions {
  /** Hits closer than this distance are ignored. Distances are t * |direction|. Default 0. */
  near?: number;
  /** Hits farther than this distance are ignored. Default Infinity. */
  far?: number;
  /** Which triangle faces count. Front faces wind counter-clockwise toward the ray origin. Default 'double'. */
  side?: Side;
}
export interface BVHHit {
  /** t * |direction| from the ray origin. */
  distance: number;
  point: Vec3;
  /** Triangle index in the source index buffer (or vertex order / 3 without indices). */
  faceIndex: number;
  /** Vertex indices of the triangle. */
  face: Vec3;
  /** Barycentric weights of the three vertices. */
  barycoord: Vec3;
  /** Interpolated vertex normal, normalized, or the face normal when the source has no normals. Not flipped for back faces. */
  normal: Vec3;
  /** Geometric normal from the counter-clockwise winding, normalized. */
  faceNormal: Vec3;
  frontFace: boolean;
}
export interface ClosestPointOptions {
  /** Only triangles within this distance are considered. Default Infinity. */
  maxDistance?: number;
  /** Stop searching once a triangle at or below this distance is found. Default 0. */
  minDistance?: number;
}
export interface ClosestPointResult {point: Vec3; distance: number; faceIndex: number; barycoord: Vec3}
export interface Box3Like {min: ArrayLike<number>; max: ArrayLike<number>}
/** Reused box handed to shapecast callbacks. Copy it if you need to keep it. */
export interface ShapecastBox {min: Float64Array; max: Float64Array}
/** Reused triangle handed to shapecast callbacks: a, b and c in the BVH's space. */
export interface ShapecastTriangle {a: Float64Array; b: Float64Array; c: Float64Array}
export const NOT_INTERSECTED = 0, INTERSECTED = 1, CONTAINED = 2;
/** Generic traversal callbacks in the style of three-mesh-bvh's shapecast. The query returns true when a callback stops it. */
export interface ShapecastCallbacks {
  /** Return NOT_INTERSECTED (or false) to skip the node, INTERSECTED (or true) to descend, CONTAINED to accept the subtree without more bounds tests. */
  intersectsBounds(box: ShapecastBox, isLeaf: boolean, score: number | undefined, depth: number, nodeIndex: number): number | boolean;
  /** Called for each triangle of an accepted leaf. Return true to stop the whole query. */
  intersectsTriangle?(triangle: ShapecastTriangle, faceIndex: number, contained: boolean, depth: number): boolean | void;
  /** Called for each accepted leaf with its range in leaf order (see `leafTriangles`). Return true to stop. */
  intersectsRange?(offset: number, count: number, contained: boolean, depth: number, nodeIndex: number): boolean | void;
  /** Score for visiting children in ascending order (for example the distance to a query point). */
  boundsTraverseOrder?(box: ShapecastBox): number;
}
export interface SerializedBVH {version: 1; nodes: ArrayBuffer; index: Uint32Array; triangles: Uint32Array}

const STACK = new Int32Array(512);
const ENTRY = new Float64Array(512);
const HIT = new Float64Array(4);
const CP = new Float64Array(6);
const BEST_CP = new Float64Array(6);
const TRI = new Float64Array(9);
const EPS = 1e-7;
const MAGIC = 0x48564256; // 'VBVH'

interface Attributes {positions: Float32Array; stride: number; normals: Float32Array | null; normalStride: number; normalOffset: number}

const isGeometry = (value: unknown): value is GeometryLike =>
  !!value && (value as GeometryLike).vertices instanceof Float32Array && (value as GeometryLike).indices instanceof Uint32Array;

function attributes(source: GeometryLike | TriangleSource): Attributes {
  if (isGeometry(source)) return {positions: source.vertices, stride: 6, normals: source.vertices, normalStride: 6, normalOffset: 3};
  if (!source || !source.positions) throw new TypeError('Expected a Geometry or {positions, indices}');
  const stride = source.stride ?? 3;
  const positions = source.positions instanceof Float32Array ? source.positions : Float32Array.from(source.positions);
  const normals = source.normals ? source.normals instanceof Float32Array ? source.normals : Float32Array.from(source.normals) : null;
  if (normals && positions.length >= 3 && normals.length < Math.floor((positions.length - 3) / stride) * stride + 3) throw new RangeError('normals are shorter than positions');
  return {positions, stride, normals, normalStride: stride, normalOffset: 0};
}

/** Triangle source description handed to the build worker. */
export function sourceArrays(source: GeometryLike | TriangleSource): {positions: Float32Array; stride: number; indices: Uint32Array | null} {
  const a = attributes(source);
  return {positions: a.positions, stride: a.stride, indices: sourceIndices(source)};
}

function sourceIndices(source: GeometryLike | TriangleSource): Uint32Array | null {
  return isGeometry(source) ? source.indices : source.indices ? source.indices instanceof Uint32Array ? source.indices : Uint32Array.from(source.indices) : null;
}

/**
 * Bounding volume hierarchy over triangles (the equivalent of three-mesh-bvh's MeshBVH), stored in flat typed arrays
 * that serialize and transfer to workers without copying.
 */
export class MeshBVH {
  /** Raw node storage, 32 bytes per node. See `BVHData`. */
  readonly nodes: ArrayBuffer;
  readonly nodeBounds: Float32Array;
  readonly nodeData: Uint32Array;
  /** Vertex indices of every triangle in leaf order. */
  readonly index: Uint32Array;
  /** Original face index of every triangle in leaf order. */
  readonly triangles: Uint32Array;
  /** Positions read by queries and `refit` (not copied: edits followed by `refit()` are picked up). */
  readonly positions: Float32Array;
  readonly stride: number;
  readonly normals: Float32Array | null;
  private readonly normalStride: number;
  private readonly normalOffset: number;

  /** Builds a BVH over a core `Geometry` (or any `{vertices, indices}` with stride-6 vertices). */
  static fromGeometry(geometry: GeometryLike, options?: BVHBuildOptions): MeshBVH {
    if (!isGeometry(geometry)) throw new TypeError('Expected Geometry');
    return MeshBVH.build(geometry, options);
  }

  /** Builds a BVH synchronously from a Geometry or raw positions and indices. */
  static build(source: GeometryLike | TriangleSource, options?: BVHBuildOptions): MeshBVH {
    const a = attributes(source), indices = sourceIndices(source);
    // Preserve geometry identity and reuse already converted raw attributes when wrapping the result.
    return new MeshBVH(buildBVH(a.positions, a.stride, indices, options), isGeometry(source) ? source : {positions: a.positions, stride: a.stride, normals: a.normals});
  }

  /** Restores a BVH from `serialize()` output. The source supplies positions (and normals); its indices are not needed. */
  static deserialize(data: SerializedBVH, source: GeometryLike | TriangleSource): MeshBVH {
    if (!data || data.version !== 1) throw new TypeError('Unknown serialized BVH version');
    return new MeshBVH({nodes: data.nodes, index: data.index, triangles: data.triangles}, source);
  }

  /** Restores a BVH from one `toArrayBuffer()` buffer. */
  static fromArrayBuffer(buffer: ArrayBuffer, source: GeometryLike | TriangleSource): MeshBVH {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) throw new TypeError('Expected a BVH ArrayBuffer');
    const [magic, version, nodeCount, triangleCount] = new Uint32Array(buffer, 0, 4);
    if (magic !== MAGIC || version !== 1) throw new TypeError('Not a Margo Engine BVH buffer');
    const nodeBytes = nodeCount * NODE_WORDS * 4;
    if (buffer.byteLength !== 16 + nodeBytes + triangleCount * 16) throw new RangeError('Truncated BVH buffer');
    return new MeshBVH({
      nodes: buffer.slice(16, 16 + nodeBytes),
      index: new Uint32Array(buffer, 16 + nodeBytes, triangleCount * 3),
      triangles: new Uint32Array(buffer, 16 + nodeBytes + triangleCount * 12, triangleCount),
    }, source);
  }

  /** Wraps prebuilt data (from `buildBVH`, the worker or `deserialize`) after validating it against the source. */
  constructor(data: BVHData, source: GeometryLike | TriangleSource) {
    const a = attributes(source);
    this.positions = a.positions; this.stride = a.stride; this.normals = a.normals; this.normalStride = a.normalStride; this.normalOffset = a.normalOffset;
    if (!(data.nodes instanceof ArrayBuffer) || !data.nodes.byteLength || data.nodes.byteLength % (NODE_WORDS * 4)) throw new RangeError('Invalid BVH nodes');
    if (!(data.index instanceof Uint32Array) || !(data.triangles instanceof Uint32Array) || data.index.length !== data.triangles.length * 3 || !data.triangles.length) throw new RangeError('Invalid BVH triangles');
    this.nodes = data.nodes; this.nodeBounds = new Float32Array(data.nodes); this.nodeData = new Uint32Array(data.nodes);
    this.index = data.index; this.triangles = data.triangles;
    checkSource(this.positions, this.stride, this.index);
    // Structural validation: children follow parents and leaves tile the triangle range in order.
    const u = this.nodeData, count = this.nodeCount;
    let covered = 0;
    for (let node = 0, w = 0; node < count; node++, w += NODE_WORDS) {
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) {
        if ((word & 0x7fffffff) > 2 || u[w + 6] <= node + 1 || u[w + 6] >= count) throw new RangeError('Invalid BVH node links');
      } else {
        if (!word || u[w + 6] !== covered) throw new RangeError('Invalid BVH leaf ranges');
        covered += word;
      }
    }
    if (covered !== this.triangleCount) throw new RangeError('BVH leaves do not cover every triangle');
  }

  get nodeCount(): number { return this.nodeData.length / NODE_WORDS; }
  get triangleCount(): number { return this.triangles.length; }

  /** Root bounds as {min, max}. */
  getBoundingBox(): {min: Vec3; max: Vec3} {
    const f = this.nodeBounds;
    return {min: [f[0], f[1], f[2]], max: [f[3], f[4], f[5]]};
  }

  isLeaf(node: number): boolean { return !(this.nodeData[node * NODE_WORDS + 7] & INTERNAL_FLAG); }
  /** Original face indices of a leaf node (a view, do not modify). */
  leafTriangles(node: number): Uint32Array {
    const w = node * NODE_WORDS, word = this.nodeData[w + 7];
    if (word & INTERNAL_FLAG) throw new RangeError('Not a leaf node');
    return this.triangles.subarray(this.nodeData[w + 6], this.nodeData[w + 6] + word);
  }

  /** Copies (default) or exposes the storage. With `{copy: false}` transferring the result detaches this BVH. */
  serialize({copy = true}: {copy?: boolean} = {}): SerializedBVH {
    return copy
      ? {version: 1, nodes: this.nodes.slice(0), index: this.index.slice(), triangles: this.triangles.slice()}
      : {version: 1, nodes: this.nodes, index: this.index, triangles: this.triangles};
  }

  /** Packs nodes, index and triangle ids into one ArrayBuffer with a 16-byte header. */
  toArrayBuffer(): ArrayBuffer {
    const nodeBytes = this.nodes.byteLength, n = this.triangleCount, buffer = new ArrayBuffer(16 + nodeBytes + n * 16);
    new Uint32Array(buffer, 0, 4).set([MAGIC, 1, this.nodeCount, n]);
    new Uint8Array(buffer, 16, nodeBytes).set(new Uint8Array(this.nodes));
    new Uint32Array(buffer, 16 + nodeBytes, n * 3).set(this.index);
    new Uint32Array(buffer, 16 + nodeBytes + n * 12, n).set(this.triangles);
    return buffer;
  }

  /** Recomputes every node bound bottom-up after vertex positions changed. Topology must be unchanged. */
  refit(): void {
    const f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    for (let node = this.nodeCount - 1; node >= 0; node--) {
      const w = node * NODE_WORDS, word = u[w + 7];
      if (word & INTERNAL_FLAG) {
        const l = w + NODE_WORDS, r = u[w + 6] * NODE_WORDS;
        f[w] = Math.min(f[l], f[r]); f[w + 1] = Math.min(f[l + 1], f[r + 1]); f[w + 2] = Math.min(f[l + 2], f[r + 2]);
        f[w + 3] = Math.max(f[l + 3], f[r + 3]); f[w + 4] = Math.max(f[l + 4], f[r + 4]); f[w + 5] = Math.max(f[l + 5], f[r + 5]);
      } else {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = u[w + 6] * 3, end = i + word * 3; i < end; i++) {
          const o = index[i] * s, x = P[o], y = P[o + 1], z = P[o + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        f[w] = x0; f[w + 1] = y0; f[w + 2] = z0; f[w + 3] = x1; f[w + 4] = y1; f[w + 5] = z1;
      }
    }
  }

  /** Nearest hit along the ray, or null. */
  raycastFirst(ray: Ray, options: RaycastOptions = {}): BVHHit | null {
    const {origin: o, direction: d} = ray, [tmin, tmax, length] = rayRange(d, options), side = sideCode(options.side);
    const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
    const f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = tmax, bestSlot = -1, bu = 0, bv = 0, bdet = 0, sp = 0;
    // Front-to-back traversal: children are entered nearest first and skipped once their entry passes the best hit.
    const rootEntry = slab(f, 0, ox, oy, oz, ix, iy, iz, tmin, best);
    if (rootEntry !== Infinity) { STACK[sp] = 0; ENTRY[sp++] = rootEntry; }
    while (sp) {
      const node = STACK[--sp];
      const entry = ENTRY[sp];
      if (entry > best + EPS * (Math.abs(best) + Math.abs(entry) + 1)) continue;
      const w = node * NODE_WORDS, word = u[w + 7];
      if (word & INTERNAL_FLAG) {
        const l = node + 1, r = u[w + 6];
        const tl = slab(f, l * NODE_WORDS, ox, oy, oz, ix, iy, iz, tmin, best), tr = slab(f, r * NODE_WORDS, ox, oy, oz, ix, iy, iz, tmin, best);
        if (tl <= tr) {
          if (tr !== Infinity) { STACK[sp] = r; ENTRY[sp++] = tr; }
          if (tl !== Infinity) { STACK[sp] = l; ENTRY[sp++] = tl; }
        } else {
          if (tl !== Infinity) { STACK[sp] = l; ENTRY[sp++] = tl; }
          STACK[sp] = r; ENTRY[sp++] = tr;
        }
        continue;
      }
      for (let k = u[w + 6], end = k + word; k < end; k++) {
        const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
        if (rayTriangle(ox, oy, oz, dx, dy, dz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], side, tmin, best, HIT)
          && (HIT[0] < best || bestSlot < 0)) { best = HIT[0]; bestSlot = k; bu = HIT[1]; bv = HIT[2]; bdet = HIT[3]; }
      }
    }
    return bestSlot < 0 ? null : this.makeHit(bestSlot, best, bu, bv, bdet, ox, oy, oz, dx, dy, dz, length);
  }

  /** Every hit along the ray, sorted by distance (ties by face index). */
  raycast(ray: Ray, options: RaycastOptions = {}): BVHHit[] {
    const {origin: o, direction: d} = ray, [tmin, tmax, length] = rayRange(d, options), side = sideCode(options.side);
    const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
    const f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz, hits: BVHHit[] = [];
    let sp = 0;
    STACK[sp++] = 0;
    while (sp) {
      const node = STACK[--sp], w = node * NODE_WORDS;
      let lo = tmin, hi = tmax, t1 = (f[w] - ox) * ix, t2 = (f[w + 3] - ox) * ix;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
      t1 = (f[w + 1] - oy) * iy; t2 = (f[w + 4] - oy) * iy;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
      t1 = (f[w + 2] - oz) * iz; t2 = (f[w + 5] - oz) * iz;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
      if (lo > hi + EPS * (Math.abs(hi) + Math.abs(lo) + 1)) continue;
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) { STACK[sp++] = u[w + 6]; STACK[sp++] = node + 1; }
      else {
        for (let k = u[w + 6], end = k + word; k < end; k++) {
          const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
          if (rayTriangle(ox, oy, oz, dx, dy, dz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], side, tmin, tmax, HIT))
            hits.push(this.makeHit(k, HIT[0], HIT[1], HIT[2], HIT[3], ox, oy, oz, dx, dy, dz, length));
        }
      }
    }
    return hits.sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex);
  }

  private makeHit(slot: number, t: number, u: number, v: number, det: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, length: number): BVHHit {
    const ia = this.index[slot * 3], ib = this.index[slot * 3 + 1], ic = this.index[slot * 3 + 2], w = 1 - u - v;
    const faceNormal = this.faceNormal(ia, ib, ic);
    return {
      distance: t * length, point: [ox + dx * t, oy + dy * t, oz + dz * t], faceIndex: this.triangles[slot], face: [ia, ib, ic],
      barycoord: [w, u, v], normal: this.interpolateNormal(ia, ib, ic, w, u, v, faceNormal), faceNormal, frontFace: det > 0,
    };
  }

  private faceNormal(ia: number, ib: number, ic: number): Vec3 {
    const P = this.positions, s = this.stride, a = ia * s, b = ib * s, c = ic * s;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    return normalize(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  }

  private interpolateNormal(ia: number, ib: number, ic: number, wa: number, wb: number, wc: number, fallback: Vec3): Vec3 {
    const N = this.normals;
    if (!N) return [fallback[0], fallback[1], fallback[2]];
    const s = this.normalStride, o = this.normalOffset, a = ia * s + o, b = ib * s + o, c = ic * s + o;
    const n = normalize(N[a] * wa + N[b] * wb + N[c] * wc, N[a + 1] * wa + N[b + 1] * wb + N[c + 1] * wc, N[a + 2] * wa + N[b + 2] * wb + N[c + 2] * wc);
    return n[0] || n[1] || n[2] ? n : [fallback[0], fallback[1], fallback[2]];
  }

  /** Closest point on the mesh surface to `point`, or null when nothing lies within `maxDistance`. */
  closestPointToPoint(point: ArrayLike<number>, {maxDistance = Infinity, minDistance = 0}: ClosestPointOptions = {}): ClosestPointResult | null {
    if (!(maxDistance >= 0) || !(minDistance >= 0)) throw new RangeError('Distances must be >= 0');
    const px = point[0], py = point[1], pz = point[2], f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    const minSq = minDistance * minDistance;
    let best = maxDistance * maxDistance, bestSlot = -1, sp = 0;
    // Each node's box distance is measured once, when its parent orders the children, and kept beside it on the stack.
    STACK[sp] = 0; ENTRY[sp++] = boxDistanceSq(f, 0, px, py, pz);
    search: while (sp) {
      const node = STACK[--sp], w = node * NODE_WORDS;
      if (ENTRY[sp] > best * (1 + EPS) + EPS) continue;
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) {
        const l = node + 1, r = u[w + 6], dl = boxDistanceSq(f, l * NODE_WORDS, px, py, pz), dr = boxDistanceSq(f, r * NODE_WORDS, px, py, pz);
        if (dl < dr) { STACK[sp] = r; ENTRY[sp++] = dr; STACK[sp] = l; ENTRY[sp++] = dl; }
        else { STACK[sp] = l; ENTRY[sp++] = dl; STACK[sp] = r; ENTRY[sp++] = dr; }
      } else {
        for (let k = u[w + 6], end = k + word; k < end; k++) {
          const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
          const dist = closestPointTriangle(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], CP);
          if (dist < best || (bestSlot < 0 && dist <= best)) { best = dist; bestSlot = k; BEST_CP.set(CP); if (best <= minSq) break search; }
        }
      }
    }
    if (bestSlot < 0) return null;
    return {point: [BEST_CP[0], BEST_CP[1], BEST_CP[2]], distance: Math.sqrt(best), faceIndex: this.triangles[bestSlot], barycoord: [BEST_CP[3], BEST_CP[4], BEST_CP[5]]};
  }

  /** True when any triangle touches the sphere. */
  intersectsSphere(center: ArrayLike<number>, radius: number): boolean {
    if (!(radius >= 0)) throw new RangeError('Radius must be >= 0');
    const px = center[0], py = center[1], pz = center[2], r2 = radius * radius, f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    let sp = 0;
    STACK[sp++] = 0;
    while (sp) {
      const node = STACK[--sp], w = node * NODE_WORDS;
      if (boxDistanceSq(f, w, px, py, pz) > r2 * (1 + EPS) + EPS) continue;
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) { STACK[sp++] = u[w + 6]; STACK[sp++] = node + 1; continue; }
      for (let k = u[w + 6], end = k + word; k < end; k++) {
        const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
        if (closestPointTriangle(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], CP) <= r2) return true;
      }
    }
    return false;
  }

  /**
   * True when any triangle touches the box `{min, max}` after `matrix` (column-major, box space to BVH space) places it.
   * Without a matrix the box is axis aligned in BVH space.
   */
  intersectsBox(box: Box3Like, matrix?: ArrayLike<number>): boolean {
    const bx0 = box.min[0], by0 = box.min[1], bz0 = box.min[2], bx1 = box.max[0], by1 = box.max[1], bz1 = box.max[2];
    if (!(bx0 <= bx1 && by0 <= by1 && bz0 <= bz1)) return false;
    const inverse = matrix ? invert(matrix) : null;
    if (matrix && !inverse) throw new RangeError('Box matrix is singular');
    // Conservative BVH-space bounds of the oriented box.
    const bounds = matrix ? transformBox(matrix, bx0, by0, bz0, bx1, by1, bz1) : [bx0, by0, bz0, bx1, by1, bz1];
    const pad = EPS * (Math.abs(bounds[0]) + Math.abs(bounds[3]) + Math.abs(bounds[1]) + Math.abs(bounds[4]) + Math.abs(bounds[2]) + Math.abs(bounds[5]) + 1);
    const f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride;
    let sp = 0;
    STACK[sp++] = 0;
    while (sp) {
      const node = STACK[--sp], w = node * NODE_WORDS;
      if (f[w] > bounds[3] + pad || f[w + 3] < bounds[0] - pad || f[w + 1] > bounds[4] + pad || f[w + 4] < bounds[1] - pad || f[w + 2] > bounds[5] + pad || f[w + 5] < bounds[2] - pad) continue;
      const word = u[w + 7];
      if (word & INTERNAL_FLAG) { STACK[sp++] = u[w + 6]; STACK[sp++] = node + 1; continue; }
      for (let k = u[w + 6], end = k + word; k < end; k++) {
        loadTriangle(P, s, index, k, inverse, TRI);
        if (triangleBox(TRI, bx0, by0, bz0, bx1, by1, bz1)) return true;
      }
    }
    return false;
  }

  shapecast(callbacks: ShapecastCallbacks): boolean {
    const {intersectsBounds, intersectsTriangle, intersectsRange, boundsTraverseOrder} = callbacks;
    if (typeof intersectsBounds !== 'function') throw new TypeError('shapecast needs intersectsBounds');
    const f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride, faces = this.triangles;
    const box: ShapecastBox = {min: new Float64Array(3), max: new Float64Array(3)};
    const triangle: ShapecastTriangle = {a: new Float64Array(3), b: new Float64Array(3), c: new Float64Array(3)};
    const fill = (node: number): ShapecastBox => {
      const w = node * NODE_WORDS;
      box.min[0] = f[w]; box.min[1] = f[w + 1]; box.min[2] = f[w + 2]; box.max[0] = f[w + 3]; box.max[1] = f[w + 4]; box.max[2] = f[w + 5];
      return box;
    };
    const classify = (result: number | boolean): number => result === true ? INTERSECTED : result === false ? NOT_INTERSECTED : result;
    const leaf = (node: number, contained: boolean, depth: number): boolean => {
      const w = node * NODE_WORDS, offset = u[w + 6], count = u[w + 7];
      if (intersectsRange && intersectsRange(offset, count, contained, depth, node) === true) return true;
      if (intersectsTriangle) for (let k = offset; k < offset + count; k++) {
        const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
        triangle.a[0] = P[a]; triangle.a[1] = P[a + 1]; triangle.a[2] = P[a + 2];
        triangle.b[0] = P[b]; triangle.b[1] = P[b + 1]; triangle.b[2] = P[b + 2];
        triangle.c[0] = P[c]; triangle.c[1] = P[c + 1]; triangle.c[2] = P[c + 2];
        if (intersectsTriangle(triangle, faces[k], contained, depth) === true) return true;
      }
      return false;
    };
    const visit = (node: number, contained: boolean, depth: number): boolean => {
      const word = u[node * NODE_WORDS + 7];
      if (!(word & INTERNAL_FLAG)) return leaf(node, contained, depth);
      let first = node + 1, second = u[node * NODE_WORDS + 6], firstScore: number | undefined, secondScore: number | undefined;
      if (boundsTraverseOrder && !contained) {
        firstScore = boundsTraverseOrder(fill(first)); secondScore = boundsTraverseOrder(fill(second));
        if (secondScore < firstScore) { const q = first; first = second; second = q; const t = firstScore; firstScore = secondScore; secondScore = t; }
      }
      for (let i = 0; i < 2; i++) {
        let state = CONTAINED;
        if (!contained) {
          const isLeaf = !(u[first * NODE_WORDS + 7] & INTERNAL_FLAG);
          state = classify(intersectsBounds(fill(first), isLeaf, firstScore, depth + 1, first));
        }
        if (state !== NOT_INTERSECTED && visit(first, state === CONTAINED, depth + 1)) return true;
        first = second; firstScore = secondScore;
      }
      return false;
    };
    const root = classify(intersectsBounds(fill(0), !(u[7] & INTERNAL_FLAG), undefined, 0, 0));
    return root !== NOT_INTERSECTED && visit(0, root === CONTAINED, 0);
  }

  /**
   * Triangle-exact intersection between this BVH and `other`, whose triangles are placed into this BVH's space by
   * `matrix` (column-major; omit for identity). With `onPair`, every intersecting pair (face of this, face of other)
   * is reported until the callback returns true. Returns whether any pair intersects.
   */
  intersectsBVH(other: MeshBVH, matrix?: ArrayLike<number>, onPair?: (faceA: number, faceB: number) => boolean | void): boolean {
    if (!(other instanceof MeshBVH)) throw new TypeError('Expected MeshBVH');
    const m = matrix ?? IDENTITY;
    const fa = this.nodeBounds, ua = this.nodeData, fb = other.nodeBounds, ub = other.nodeData;
    const pa = this.positions, sa = this.stride, ia = this.index, pb = other.positions, sb = other.stride, ib = other.index;
    let stack = new Int32Array(256), sp = 0, found = false, cachedB = -1, bTris = new Float64Array(0);
    const aTri = new Float64Array(9), box = new Float64Array(6);
    stack[sp++] = 0; stack[sp++] = 0;
    while (sp) {
      const b = stack[--sp], a = stack[--sp], wa = a * NODE_WORDS, wb = b * NODE_WORDS;
      transformBoxInto(m, fb[wb], fb[wb + 1], fb[wb + 2], fb[wb + 3], fb[wb + 4], fb[wb + 5], box);
      const pad = EPS * (Math.abs(box[0]) + Math.abs(box[3]) + Math.abs(box[1]) + Math.abs(box[4]) + Math.abs(box[2]) + Math.abs(box[5]) + 1);
      if (fa[wa] > box[3] + pad || fa[wa + 3] < box[0] - pad || fa[wa + 1] > box[4] + pad || fa[wa + 4] < box[1] - pad || fa[wa + 2] > box[5] + pad || fa[wa + 5] < box[2] - pad) continue;
      const wordA = ua[wa + 7], wordB = ub[wb + 7], leafA = !(wordA & INTERNAL_FLAG), leafB = !(wordB & INTERNAL_FLAG);
      if (leafA && leafB) {
        if (cachedB !== b) {
          if (bTris.length < wordB * 9) bTris = new Float64Array(wordB * 9);
          for (let k = 0; k < wordB; k++) loadTriangle(pb, sb, ib, ub[wb + 6] + k, m, bTris, k * 9);
          cachedB = b;
        }
        for (let k = ua[wa + 6], end = k + wordA; k < end; k++) {
          loadTriangle(pa, sa, ia, k, null, aTri);
          for (let j = 0; j < wordB; j++) {
            if (!triangleTriangle(aTri, 0, bTris, j * 9)) continue;
            if (!onPair) return true;
            found = true;
            if (onPair(this.triangles[k], other.triangles[ub[wb + 6] + j]) === true) return true;
          }
        }
        continue;
      }
      if (sp + 4 > stack.length) { const next = new Int32Array(stack.length * 2); next.set(stack); stack = next; }
      const sizeA = fa[wa + 3] - fa[wa] + fa[wa + 4] - fa[wa + 1] + fa[wa + 5] - fa[wa + 2], sizeB = box[3] - box[0] + box[4] - box[1] + box[5] - box[2];
      if (leafB || (!leafA && sizeA >= sizeB)) { stack[sp++] = ua[wa + 6]; stack[sp++] = b; stack[sp++] = a + 1; stack[sp++] = b; }
      else { stack[sp++] = a; stack[sp++] = ub[wb + 6]; stack[sp++] = a; stack[sp++] = b + 1; }
    }
    return found;
  }

  /**
   * Frustum collection. `planes` holds (nx, ny, nz, d) per plane with the inside where n.p + d >= 0, such as
   * `frustumPlanes(viewProjection * world)` or the engine camera's `planes` for an identity-transformed mesh.
   * 'triangles' (default) returns the face indices of triangles not entirely outside a single plane (the usual conservative
   * culling test); 'leaves' returns the indices of leaf nodes whose bounds are not entirely outside a plane.
   */
  collectFrustum(planes: ArrayLike<number>, {mode = 'triangles'}: {mode?: 'triangles' | 'leaves'} = {}): Uint32Array {
    if (planes.length % 4 || !planes.length) throw new RangeError('Planes need 4 values each');
    if (mode !== 'triangles' && mode !== 'leaves') throw new TypeError('mode must be triangles or leaves');
    const planeCount = planes.length / 4, f = this.nodeBounds, u = this.nodeData, index = this.index, P = this.positions, s = this.stride, faces = this.triangles;
    let out = new Uint32Array(64), length = 0, sp = 0;
    const push = (value: number): void => { if (length === out.length) { const next = new Uint32Array(out.length * 2); next.set(out); out = next; } out[length++] = value; };
    STACK[sp++] = 0;
    while (sp) {
      const node = STACK[--sp], w = node * NODE_WORDS;
      let outside = false, contained = true;
      for (let p = 0; p < planeCount * 4; p += 4) {
        const nx = planes[p], ny = planes[p + 1], nz = planes[p + 2], d = planes[p + 3];
        const far = nx * (nx >= 0 ? f[w + 3] : f[w]) + ny * (ny >= 0 ? f[w + 4] : f[w + 1]) + nz * (nz >= 0 ? f[w + 5] : f[w + 2]) + d;
        if (far < 0) { outside = true; break; }
        const near = nx * (nx >= 0 ? f[w] : f[w + 3]) + ny * (ny >= 0 ? f[w + 1] : f[w + 4]) + nz * (nz >= 0 ? f[w + 2] : f[w + 5]) + d;
        if (near < 0) contained = false;
      }
      if (outside) continue;
      const word = u[w + 7];
      if (mode === 'leaves') {
        if (word & INTERNAL_FLAG) { STACK[sp++] = u[w + 6]; STACK[sp++] = node + 1; } else push(node);
        continue;
      }
      if (contained) {
        // A subtree's triangles are contiguous in leaf order: take the range from its first to its last leaf.
        let first = node, last = node;
        while (u[first * NODE_WORDS + 7] & INTERNAL_FLAG) first++;
        while (u[last * NODE_WORDS + 7] & INTERNAL_FLAG) last = u[last * NODE_WORDS + 6];
        for (let k = u[first * NODE_WORDS + 6], end = u[last * NODE_WORDS + 6] + u[last * NODE_WORDS + 7]; k < end; k++) push(faces[k]);
        continue;
      }
      if (word & INTERNAL_FLAG) { STACK[sp++] = u[w + 6]; STACK[sp++] = node + 1; continue; }
      for (let k = u[w + 6], end = k + word; k < end; k++) {
        const a = index[k * 3] * s, b = index[k * 3 + 1] * s, c = index[k * 3 + 2] * s;
        if (!triangleOutsidePlanes(planes, planeCount, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2])) push(faces[k]);
      }
    }
    return out.slice(0, length);
  }
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function rayRange(d: ArrayLike<number>, {near = 0, far = Infinity}: RaycastOptions): [number, number, number] {
  const length = Math.hypot(d[0], d[1], d[2]);
  if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('Ray direction must be finite and nonzero');
  if (!(near >= 0) || !(far >= near)) throw new RangeError('Expected 0 <= near <= far');
  return [near / length, far / length, length];
}

/**
 * Slab test against node bounds at word offset w. Returns the entry parameter, or Infinity on a miss. NaN products
 * (a zero direction component with the origin on a slab plane) are ignored, which keeps the test conservative, and a
 * small relative slack keeps rays that graze a box edge from being culled before the exact triangle test.
 */
function slab(f: Float32Array, w: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, lo: number, hi: number): number {
  let t1 = (f[w] - ox) * ix, t2 = (f[w + 3] - ox) * ix;
  if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
  t1 = (f[w + 1] - oy) * iy; t2 = (f[w + 4] - oy) * iy;
  if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
  t1 = (f[w + 2] - oz) * iz; t2 = (f[w + 5] - oz) * iz;
  if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
  return lo > hi + EPS * (Math.abs(hi) + Math.abs(lo) + 1) ? Infinity : lo;
}

function normalize(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
}

function boxDistanceSq(f: Float32Array, w: number, px: number, py: number, pz: number): number {
  const dx = px < f[w] ? f[w] - px : px > f[w + 3] ? px - f[w + 3] : 0;
  const dy = py < f[w + 1] ? f[w + 1] - py : py > f[w + 4] ? py - f[w + 4] : 0;
  const dz = pz < f[w + 2] ? f[w + 2] - pz : pz > f[w + 5] ? pz - f[w + 5] : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** Loads triangle `slot` (leaf order) into out, optionally transformed by m. */
export function loadTriangle(P: Float32Array, s: number, index: Uint32Array, slot: number, m: ArrayLike<number> | null, out: Float64Array, offset = 0): void {
  for (let v = 0; v < 3; v++) {
    const o = index[slot * 3 + v] * s;
    if (m) transformPoint(m, P[o], P[o + 1], P[o + 2], out, offset + v * 3);
    else { out[offset + v * 3] = P[o]; out[offset + v * 3 + 1] = P[o + 1]; out[offset + v * 3 + 2] = P[o + 2]; }
  }
}

function transformBox(m: ArrayLike<number>, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float64Array {
  return transformBoxInto(m, x0, y0, z0, x1, y1, z1, new Float64Array(6));
}

/** Axis-aligned bounds of a transformed box (Arvo's method). */
function transformBoxInto(m: ArrayLike<number>, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: Float64Array): Float64Array {
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5, ex = (x1 - x0) * 0.5, ey = (y1 - y0) * 0.5, ez = (z1 - z0) * 0.5;
  for (let r = 0; r < 3; r++) {
    const c = m[r] * cx + m[4 + r] * cy + m[8 + r] * cz + m[12 + r];
    const e = Math.abs(m[r]) * ex + Math.abs(m[4 + r]) * ey + Math.abs(m[8 + r]) * ez;
    out[r] = c - e; out[3 + r] = c + e;
  }
  return out;
}
