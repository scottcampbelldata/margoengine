/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { meshRuntime } from '@margoengine/core/extension';
import type { Mesh, Vec3 } from '@margoengine/core';
import { meshTriangles } from '../../shared/mesh-source.js';
import { machineryMemory } from './runtime.js';
import { holeAnchor, snapFeature, vertexAnchor, edgeAnchor } from './metrology.js';
import { worldAnchor, type Anchor } from './anchors.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { posedVertices } from '../../shared/pose-source.js';
/** A raycast hit: the mesh, its triangle index, the distance along the ray and the world-space point. */
export interface RayHit {
  node: Mesh;
  triangle: number;
  distance: number;
  point: Vec3;
}
/**
 * The triangles of one distinct geometry: packed vertices with their `stride` (6 for core meshes, 20 for PBR primitives)
 * and indices. A primitive deformed on the GPU gives the CPU pose its deformer evaluates (packages/shared/pose-source.js)
 * with that pose's `revision`, which changes whenever the pose is rewritten in place.
 */
interface TriangleRecord {
  vertices: Float32Array;
  indices: Uint32Array;
  stride: 6 | 20;
  revision?: number;
}
function records(node: Mesh): TriangleRecord[] {
  const triangles = meshTriangles(node);
  if (!triangles) return [];
  if (triangles.kind === 'core')
    return [{ vertices: triangles.geometry.vertices, indices: triangles.geometry.indices, stride: 6 }];
  return triangles.source.primitives.map((primitive) => {
    if (!primitive.deformed) return { vertices: primitive.vertices, indices: primitive.indices, stride: 20 };
    // The pose that is drawn (an Animation's skin or morph, a BatchedMesh's items), never the bind pose.
    const pose = posedVertices(primitive);
    if (!pose)
      throw new MargoError(
        'unsupported',
        'This mesh is deformed on the GPU by a deformer that has no CPU pose, so AssemblyBVH cannot hold its triangles; await Raycaster.intersectModel(model) for its current pose.',
      );
    return { vertices: pose.vertices, indices: primitive.indices, stride: 20, revision: pose.revision };
  });
}
/** Copies `record`'s triangles into the Wasm memory at `at` and builds their BVH there; returns their local box. */
function buildShape(memory: Awaited<ReturnType<typeof machineryMemory>>, at: number, record: TriangleRecord): number[] {
  const count = record.indices.length / 3,
    triangles = new Float32Array(memory.buffer, at, count * 9),
    v = record.vertices,
    f = record.indices,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < f.length; i++) {
    const p = f[i] * record.stride;
    for (let axis = 0; axis < 3; axis++) {
      const value = v[p + axis];
      triangles[i * 3 + axis] = value;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  if (!memory.api.bvh_build(at, count))
    throw new RangeError('BVH coordinates must be finite; fix the NaN or Infinity in the geometry or node transform.');
  return [...min, ...max];
}
/** Writes node `n`'s local bounding sphere (centre, radius) into `bounds` from the local boxes of its shapes. */
function shapeSphere(bounds: Float64Array, n: number, parts: readonly number[], boxes: readonly number[][]): void {
  if (!parts.length) return;
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (const id of parts)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], boxes[id][a]);
      high[a] = Math.max(high[a], boxes[id][a + 3]);
    }
  for (let a = 0; a < 3; a++) bounds[n * 4 + a] = (low[a] + high[a]) / 2;
  bounds[n * 4 + 3] = Math.hypot(...high.map((v, a) => (v - low[a]) / 2));
}

/**
 * Two-level picking for assemblies: one local-space Wasm triangle BVH per distinct geometry, shared by all its instances, under a per-part
 * bounding-sphere pass over world transforms. `rebuild()` is O(parts) and memory follows distinct triangles, so assemblies with millions of
 * instanced triangles fit. Create it with `await AssemblyBVH.create(nodes)`, call `rebuild()` after parts move, then `raycast(origin, direction)`.
 * A part deformed on the GPU (an Animation, a BatchedMesh) is held at the CPU pose its deformer gives. A new pose is a
 * move: `rebuild()` builds that geometry's BVH again, and a raycast or snap before it throws 'state'.
 */
export class AssemblyBVH {
  private disposed = false;
  private valid = false;
  private readonly triangles: Float32Array;
  private readonly result: Float64Array;
  private readonly bounds: Float64Array;
  private readonly shape: number[][];
  private readonly inverses: Float64Array;
  private readonly spheres: Float64Array;
  private readonly order: Int32Array;
  private readonly entry: Float64Array;
  private constructor(
    readonly nodes: readonly Mesh[],
    private readonly shapes: { ptr: number; count: number }[],
    private readonly memory: Awaited<ReturnType<typeof machineryMemory>>,
    shape: number[][],
    total: number,
    private readonly sources: readonly TriangleRecord[][],
    bounds: Float64Array,
    private readonly unique: readonly TriangleRecord[],
    private readonly boxes: number[][],
  ) {
    const n = nodes.length;
    this.triangles = new Float32Array(memory.buffer, memory.ptr, total * 26);
    this.result = new Float64Array(memory.buffer, memory.ptr + total * 104, 2);
    this.bounds = bounds;
    this.shape = shape;
    this.inverses = new Float64Array(n * 12);
    this.spheres = new Float64Array(n * 4);
    this.order = new Int32Array(n);
    this.entry = new Float64Array(n);
  }
  static async create(nodes: Iterable<Mesh>): Promise<AssemblyBVH> {
    const list = [...nodes],
      sources = list.map((node) => {
        node.check();
        return records(node);
      }),
      unique: TriangleRecord[] = [],
      shape: number[][] = [],
      bounds = new Float64Array(list.length * 4);
    const identities = new Map<Float32Array, number[]>();
    let total = 0;
    for (let n = 0; n < list.length; n++) {
      const parts: number[] = [];
      for (const record of sources[n]) {
        const candidates = identities.get(record.vertices) ?? [];
        let id = candidates.find((id) => unique[id].indices === record.indices && unique[id].stride === record.stride);
        if (id === undefined) {
          id = unique.length;
          unique.push(record);
          candidates.push(id);
          identities.set(record.vertices, candidates);
          total += record.indices.length / 3;
        }
        parts.push(id);
      }
      shape.push(parts);
    }
    if (!total || total > 1_000_000) throw new RangeError('BVH requires 1..1000000 triangles');
    const memory = await machineryMemory(total * 104 + 16),
      shapes: { ptr: number; count: number }[] = [],
      boxes: number[][] = [];
    let at = memory.ptr;
    for (const geometry of unique) {
      const count = geometry.indices.length / 3;
      boxes.push(buildShape(memory, at, geometry));
      shapes.push({ ptr: at, count });
      at += count * 104;
    }
    for (let n = 0; n < list.length; n++) shapeSphere(bounds, n, shape[n], boxes);
    const index = new AssemblyBVH(list, shapes, memory, shape, total, sources, bounds, unique, boxes);
    index.rebuild();
    return index;
  }
  /**
   * Throws 'state' when node `index`'s geometry is not the one the BVH was built from, and returns its current records:
   * a posed record whose `revision` differs from its shape's has moved since the last rebuild.
   */
  private checkSource(index: number): TriangleRecord[] {
    const node = this.nodes[index];
    node.check();
    const current = records(node),
      previous = this.sources[index];
    if (
      current.length !== previous.length ||
      current.some(
        (value, at) =>
          value.vertices !== previous[at].vertices ||
          value.indices !== previous[at].indices ||
          value.stride !== previous[at].stride,
      )
    )
      throw new MargoError('state', 'Geometry changed since the BVH was built; create a new AssemblyBVH.');
    return current;
  }
  /** checkSource, and 'state' when a part's pose changed since the last rebuild: a query never tests an old pose. */
  private checkPose(index: number): void {
    const parts = this.shape[index];
    if (this.checkSource(index).some((value, at) => value.revision !== this.unique[parts[at]].revision))
      throw new MargoError('state', 'BVH is stale; call rebuild() before raycasting.');
  }
  rebuild(): void {
    if (this.disposed) throw new MargoError('disposed', 'BVH is disposed; create a new AssemblyBVH.');
    this.valid = false;
    const s = this.spheres,
      moved = new Set<number>();
    // A posed part whose pose changed: its shape's BVH is built again in place (the same triangles at new positions).
    for (let n = 0; n < this.nodes.length; n++) {
      const current = this.checkSource(n);
      for (let at = 0; at < current.length; at++) {
        const id = this.shape[n][at],
          record = this.unique[id];
        if (current[at].revision === record.revision || moved.has(id)) continue;
        this.boxes[id] = buildShape(this.memory, this.shapes[id].ptr, record);
        record.revision = current[at].revision;
        moved.add(id);
      }
    }
    if (moved.size)
      for (let n = 0; n < this.nodes.length; n++)
        if (this.shape[n].some((id) => moved.has(id))) shapeSphere(this.bounds, n, this.shape[n], this.boxes);
    for (let n = 0; n < this.nodes.length; n++) {
      const node = this.nodes[n],
        runtime = meshRuntime(node);
      s[n * 4 + 3] = -1;
      if (!this.shape[n].length) continue;
      if (hiddenInTree(runtime.engine.store, runtime.id)) continue;
      const m = runtime.matrix,
        b = this.bounds.subarray(n * 4, n * 4 + 4);
      if (!m.every(Number.isFinite))
        throw new RangeError(
          'BVH coordinates must be finite; fix the NaN or Infinity in the geometry or node transform.',
        ); // Affine inverse: rows of the 3x3 inverse are the cross products of the columns over the determinant.
      const k = n * 12,
        v = this.inverses,
        x0 = m[0],
        x1 = m[1],
        x2 = m[2],
        y0 = m[4],
        y1 = m[5],
        y2 = m[6],
        z0 = m[8],
        z1 = m[9],
        z2 = m[10],
        r0 = y1 * z2 - y2 * z1,
        r1 = y2 * z0 - y0 * z2,
        r2 = y0 * z1 - y1 * z0,
        det = x0 * r0 + x1 * r1 + x2 * r2;
      if (!det || !Number.isFinite(1 / det)) continue;
      const rows = [
        r0,
        r1,
        r2,
        z1 * x2 - z2 * x1,
        z2 * x0 - z0 * x2,
        z0 * x1 - z1 * x0,
        x1 * y2 - x2 * y1,
        x2 * y0 - x0 * y2,
        x0 * y1 - x1 * y0,
      ];
      for (let a = 0; a < 3; a++) {
        for (let c = 0; c < 3; c++) v[k + c * 3 + a] = rows[a * 3 + c] / det;
        v[k + 9 + a] = -(v[k + a] * m[12] + v[k + 3 + a] * m[13] + v[k + 6 + a] * m[14]);
      }
      // Frobenius norm bounds the largest singular value, so the sphere also covers sheared and mirrored parts.
      let norm = 0;
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) norm += m[c * 4 + r] * m[c * 4 + r];
      for (let a = 0; a < 3; a++) s[n * 4 + a] = m[a] * b[0] + m[4 + a] * b[1] + m[8 + a] * b[2] + m[12 + a];
      s[n * 4 + 3] = b[3] * Math.sqrt(norm) * (1 + 1e-6) + 1e-9;
    }
    this.valid = true;
  }
  raycast(origin: Vec3, direction: Vec3, maxDistance = Infinity): RayHit | null {
    if (this.disposed) throw new MargoError('disposed', 'BVH is disposed; create a new AssemblyBVH.');
    if (!this.valid) throw new MargoError('state', 'BVH is stale; call rebuild() before raycasting.');
    if (
      origin.length !== 3 ||
      direction.length !== 3 ||
      !origin.every(Number.isFinite) ||
      !direction.every(Number.isFinite) ||
      !(maxDistance >= 0)
    )
      throw new RangeError(
        'Ray origin and direction must be three finite numbers each and maxDistance 0 or more; check the ray.',
      );
    const length = Math.hypot(...direction);
    if (!length || !Number.isFinite(length)) throw new RangeError('Ray direction must be finite and nonzero');
    const [ox, oy, oz] = origin,
      ux = direction[0] / length,
      uy = direction[1] / length,
      uz = direction[2] / length,
      s = this.spheres,
      order = this.order,
      entry = this.entry;
    let candidates = 0;
    // ponytail: linear sphere pass, about 0.5 ms per ray at 100k parts; add a top-level BVH over spheres if hover picking needs more.
    for (let n = 0; n < this.nodes.length; n++) {
      this.checkPose(n);
      const r = s[n * 4 + 3];
      if (r < 0) continue;
      const cx = s[n * 4] - ox,
        cy = s[n * 4 + 1] - oy,
        cz = s[n * 4 + 2] - oz,
        along = cx * ux + cy * uy + cz * uz,
        d2 = cx * cx + cy * cy + cz * cz - along * along;
      if (d2 > r * r) continue;
      const half = Math.sqrt(r * r - d2);
      if (along + half < 0) continue;
      const t = Math.max(0, along - half);
      if (t > maxDistance) continue;
      entry[n] = t;
      order[candidates++] = n;
    }
    const sorted = order.subarray(0, candidates).sort((a, b) => entry[a] - entry[b]);
    let best = maxDistance,
      node = -1,
      triangle = -1;
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      if (entry[n] > best) break;
      const m = this.inverses,
        k = n * 12;
      let offset = 0;
      for (const shapeId of this.shape[n]) {
        const shape = this.shapes[shapeId];
        this.memory.api.bvh_ray(
          shape.ptr,
          shape.count,
          m[k] * ox + m[k + 3] * oy + m[k + 6] * oz + m[k + 9],
          m[k + 1] * ox + m[k + 4] * oy + m[k + 7] * oz + m[k + 10],
          m[k + 2] * ox + m[k + 5] * oy + m[k + 8] * oz + m[k + 11],
          m[k] * ux + m[k + 3] * uy + m[k + 6] * uz,
          m[k + 1] * ux + m[k + 4] * uy + m[k + 7] * uz,
          m[k + 2] * ux + m[k + 5] * uy + m[k + 8] * uz,
          best,
          this.result.byteOffset,
        );
        if (this.result[0] >= 0 && this.result[1] <= best) {
          best = this.result[1];
          node = n;
          triangle = offset + this.result[0];
        }
        offset += shape.count;
      }
    }
    if (node < 0) return null;
    const hit = this.nodes[node];
    this.checkPose(node);
    return { node: hit, triangle, distance: best, point: [ox + ux * best, oy + uy * best, oz + uz * best] };
  }
  /**
   * Snaps a hit to the hit part's CAD features within `maxDistance` world units of the hit point: 'vertex' the nearest corner
   * where feature edges meet, 'edge' the closest point on a feature edge (faces meeting above 30 degrees or open boundaries;
   * never a triangulation diagonal), 'centerline' the nearest centre of the given vertex-index `rings`. Null when none is that close.
   */
  snap(
    hit: RayHit,
    {
      kind = 'vertex',
      rings = [],
      maxDistance = Infinity,
    }: { kind?: 'vertex' | 'edge' | 'centerline'; rings?: readonly (readonly number[])[]; maxDistance?: number } = {},
  ): Anchor | null {
    if (
      this.disposed ||
      !this.nodes.includes(hit.node) ||
      !['vertex', 'edge', 'centerline'].includes(kind) ||
      !(maxDistance >= 0) ||
      !Number.isSafeInteger(hit.triangle) ||
      hit.triangle < 0
    )
      throw new RangeError(
        'Snap needs a live hit from this BVH, kind vertex, edge or centerline, and a maxDistance of 0 or more; pass a hit from raycast().',
      );
    const nodeIndex = this.nodes.indexOf(hit.node);
    this.checkPose(nodeIndex);
    let face = hit.triangle,
      geometry: TriangleRecord | undefined;
    for (const part of this.sources[nodeIndex]) {
      if (face < part.indices.length / 3) {
        geometry = part;
        break;
      }
      face -= part.indices.length / 3;
    }
    if (!geometry)
      throw new RangeError(
        'Hit triangle is outside the hit node geometry; pass a hit returned by raycast() on the current geometry.',
      );
    worldAnchor({ point: hit.point });
    let best: Anchor | null = null,
      distance = maxDistance;
    if (geometry.stride === 6 && kind !== 'centerline') return snapFeature(hit.node, hit.point, kind, maxDistance);
    const ids = geometry.indices.subarray(face * 3, face * 3 + 3),
      count = kind === 'centerline' ? rings.length : 3;
    if (geometry.stride === 20 && kind === 'centerline')
      throw new MargoError(
        'unsupported',
        'PBR centerline snapping requires an explicit local anchor; pass rings for a core mesh or use kind vertex or edge.',
      );
    const local = (id: number): Vec3 =>
      Array.from(geometry!.vertices.subarray(id * geometry!.stride, id * geometry!.stride + 3)) as unknown as Vec3;
    for (let i = 0; i < count; i++) {
      const point = local(ids[i]),
        next = local(ids[(i + 1) % 3]),
        anchor: Anchor =
          geometry.stride === 6
            ? kind === 'vertex'
              ? vertexAnchor(hit.node, ids[i])
              : kind === 'edge'
                ? edgeAnchor(hit.node, ids[i], ids[(i + 1) % 3])
                : holeAnchor(hit.node, rings[i])
            : {
                node: hit.node,
                point:
                  kind === 'vertex'
                    ? point
                    : [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2, (point[2] + next[2]) / 2],
              },
        p = worldAnchor(anchor),
        d = Math.hypot(p[0] - hit.point[0], p[1] - hit.point[1], p[2] - hit.point[2]);
      if (d <= distance) {
        best = anchor;
        distance = d;
      }
    }
    return best;
  }
  dispose(): void {
    this.disposed = true;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
