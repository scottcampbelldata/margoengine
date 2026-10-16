import type {Camera, Engine, Geometry, Mesh} from '@margoengine/core';
import {buildAsync, type AsyncBuildOptions} from './async.js';
import type {BVHBuildOptions} from './build.js';
import {MeshBVH, type GeometryLike, type Vec3} from './bvh.js';
import {invert, transformPoint, type Side} from './math.js';
import {meshTriangles} from '../../shared/mesh-source.js';

// Structural views of the engine internals that `engineRuntime(engine)` exposes. Types only: this module never
// imports core at runtime, so it stays usable from workers and Node.
interface RuntimeStore {matrices: Float32Array; parents: Float32Array; hidden: Uint8Array; tick(culling?: boolean): void}
interface RuntimeMesh {id: number; geometry: Geometry | null; material: {data: Float32Array}}
interface RuntimeEngine {store: RuntimeStore; meshes: Map<number, RuntimeMesh>; camera: Camera; canvas: HTMLCanvasElement; backend: 'webgpu' | 'webgl2'; disposed: boolean}

const bvhCache = new WeakMap<GeometryLike, MeshBVH>();

/** The cached BVH of a geometry, built synchronously on first use with `options`. */
export function getGeometryBVH(geometry: Geometry | GeometryLike, options?: BVHBuildOptions): MeshBVH {
  let bvh = bvhCache.get(geometry);
  if (!bvh) { bvh = MeshBVH.fromGeometry(geometry, options); bvhCache.set(geometry, bvh); }
  return bvh;
}
/** Installs (or with null removes) the BVH the Raycaster uses for a geometry, for example one from `deserialize`. */
export function setGeometryBVH(geometry: Geometry | GeometryLike, bvh: MeshBVH | null): void {
  if (bvh === null) { bvhCache.delete(geometry); return; }
  if (!(bvh instanceof MeshBVH) || bvh.positions !== geometry.vertices) throw new TypeError('BVH was not built over this geometry');
  bvhCache.set(geometry, bvh);
}
export const hasGeometryBVH = (geometry: Geometry | GeometryLike): boolean => bvhCache.has(geometry);
/** Builds a geometry's BVH in the worker and caches it. Call before raycasting to keep large builds off the main thread. */
export async function computeGeometryBVHAsync(geometry: Geometry | GeometryLike, options: Omit<AsyncBuildOptions, 'transfer'> = {}): Promise<MeshBVH> {
  const bvh = await buildAsync(geometry, options);
  bvhCache.set(geometry, bvh);
  return bvh;
}

const layerMasks = new WeakMap<object, number>();
/** Layer bit mask of a mesh (default 1). A Raycaster only tests meshes whose mask shares a bit with `raycaster.layers`. */
export function setMeshLayers(mesh: Mesh, mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff) throw new RangeError('Layer mask must be a 32-bit unsigned integer');
  layerMasks.set(mesh, mask >>> 0);
}
export const getMeshLayers = (mesh: Mesh): number => layerMasks.get(mesh) ?? 1;

export type RaycasterSide = Side | 'material';
export interface RaycasterHit {
  mesh: Mesh;
  /** World-space distance from the ray origin. */
  distance: number;
  point: Vec3;
  /** Interpolated vertex normal in world space (inverse-transpose of the world matrix), normalized. Not flipped for back faces. */
  normal: Vec3;
  /** Geometric normal of the triangle in world space, normalized. */
  faceNormal: Vec3;
  faceIndex: number;
  barycoord: Vec3;
  /**
   * True when the ray hit the front side as the renderer defines it: counter-clockwise in the mesh's local space, so a
   * mirrored (negative determinant) world matrix keeps the same front side. `faceNormal` always points to the front side.
   */
  frontFace: boolean;
  /** Hit point in the mesh's local space. */
  localPoint: Vec3;
}
export interface IntersectOptions {
  /** Run the transform kernel first so world matrices reflect transform edits made since the last render. Default true. */
  refresh?: boolean;
}
/** Snapshot of one PBR primitive in its current deformed pose. No core Geometry is created or assigned. */
export interface PickingGeometry {
  readonly node: Mesh;
  /** PBR vertex layout: 20 floats per vertex, position xyz at 0 and normal xyz at 4. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly doubleSided: boolean;
  /** Local-to-world matrix captured with the vertex snapshot, before any asynchronous GPU readback. */
  readonly matrix: Float32Array;
}
/** Structural interface implemented by gltf-pro's PBRModel, without a runtime or package dependency on gltf-pro. */
export interface DeformedPickingSource {
  readonly root: Mesh;
  readonly disposed: boolean;
  readPickingGeometry(): Promise<readonly PickingGeometry[]>;
}
interface PoseBVH {node: Mesh; vertices: Float32Array; indices: Uint32Array; bvh: MeshBVH}
const poseCache = new WeakMap<DeformedPickingSource, PoseBVH[]>();
interface StaticPrimitive {vertices: Float32Array; indices: Uint32Array; material: {settings: number[]}}
interface StaticGeometry extends GeometryLike {bounds: Float64Array}
const staticCache = new WeakMap<object, {source: Float32Array; indices: Uint32Array; geometry: StaticGeometry}>();
function staticGeometry(primitive: StaticPrimitive): StaticGeometry {
  let cached = staticCache.get(primitive);
  if (cached?.source === primitive.vertices && cached.indices === primitive.indices) return cached.geometry;
  const vertices = new Float32Array(primitive.vertices.length / 20 * 6);
  packPose(primitive.vertices, vertices);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < vertices.length; at += 6) for (let axis = 0; axis < 3; axis++) {min[axis] = Math.min(min[axis], vertices[at + axis]); max[axis] = Math.max(max[axis], vertices[at + axis]);}
  const bounds = new Float64Array([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2, 0]);
  for (let at = 0; at < vertices.length; at += 6) bounds[3] = Math.max(bounds[3], Math.hypot(vertices[at] - bounds[0], vertices[at + 1] - bounds[1], vertices[at + 2] - bounds[2]));
  const geometry = {vertices, indices: primitive.indices, bounds};
  staticCache.set(primitive, {source: primitive.vertices, indices: primitive.indices, geometry});
  return geometry;
}

/**
 * CPU picking against engine meshes, the Margo Engine counterpart of THREE.Raycaster. Each geometry gets a cached MeshBVH,
 * meshes are rejected by their world bounding sphere, and the ray is tested in each mesh's local space.
 */
export class Raycaster {
  readonly origin = new Float64Array(3);
  /** Normalized world direction. */
  readonly direction = new Float64Array([0, 0, -1]);
  near = 0;
  far = Infinity;
  /** 'material' (default) follows each material's doubleSided flag like the renderer does; or force 'front', 'back' or 'double'. */
  side: RaycasterSide = 'material';
  /** Return only the nearest hit. Much faster with many overlapping meshes. */
  firstHitOnly = false;
  /** Bit mask tested against `getMeshLayers(mesh)`. Default: every layer. */
  layers = 0xffffffff;
  /** Extra per-mesh predicate. Return false to skip a mesh. */
  filter: ((mesh: Mesh) => boolean) | null = null;
  /** Options for BVHs this Raycaster builds on demand. */
  bvhOptions: BVHBuildOptions = {};

  constructor(origin?: ArrayLike<number>, direction?: ArrayLike<number>, near = 0, far = Infinity) {
    if (origin && direction) this.set(origin, direction);
    this.near = near; this.far = far;
  }

  set(origin: ArrayLike<number>, direction: ArrayLike<number>): this {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (![origin[0], origin[1], origin[2]].every(Number.isFinite) || !(length > 0) || !Number.isFinite(length)) throw new RangeError('Ray needs a finite origin and nonzero direction');
    this.origin[0] = origin[0]; this.origin[1] = origin[1]; this.origin[2] = origin[2];
    this.direction[0] = direction[0] / length; this.direction[1] = direction[1] / length; this.direction[2] = direction[2] / length;
    return this;
  }

  /**
   * Ray through normalized device coordinates (x right, y up, both -1..1) by inverting `camera.matrix`, which must be
   * current (the engine updates it every render; `setFromEngine` updates it for you). `webgpu` selects WebGPU's reversed-Z
   * clip depth (near 1, far 0) instead of WebGL's -1..1. The origin is the camera position.
   */
  setFromCamera(coords: ArrayLike<number>, camera: Camera, webgpu = true): this {
    const inverse = invert(camera.matrix);
    if (!inverse) throw new RangeError('Camera matrix is singular');
    const x = coords[0], y = coords[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid device coordinates');
    const near = unproject(inverse, x, y, webgpu ? 1 : -1), far = unproject(inverse, x, y, webgpu ? 0 : 1);
    return this.set(camera.position, [far[0] - near[0], far[1] - near[1], far[2] - near[2]]);
  }

  /** Ray through a canvas point in CSS pixels (as `engine.pick` takes), using the engine camera and backend. */
  setFromEngine(engine: Engine, x: number, y: number): this {
    const runtime = engine as unknown as RuntimeEngine, canvas = runtime.canvas;
    const width = canvas.clientWidth || canvas.width, height = canvas.clientHeight || canvas.height, webgpu = runtime.backend === 'webgpu';
    runtime.camera.update(canvas.width / canvas.height, webgpu);
    return this.setFromCamera([x / width * 2 - 1, 1 - y / height * 2], runtime.camera, webgpu);
  }

  /** Tests every visible mesh with geometry. Hits are sorted by distance. */
  intersectEngine(engine: Engine, options?: IntersectOptions): RaycasterHit[] {
    return this.intersectMeshes(engine, (engine as unknown as RuntimeEngine).meshes.values() as Iterable<unknown> as Iterable<Mesh>, options);
  }

  /**
   * Picks a PBR source's current skin/morph pose, including deformations outside its bind-pose bounds. This explicit
   * asynchronous query reads GPU vertex data; use it for pointer events rather than every frame. Unchanged topology
   * reuses and refits a cached BVH. Ray settings and each primitive's world transform are captured for this query.
   * Ordinary intersectEngine/intersectMeshes queries stay synchronous and never trigger GPU work.
   */
  async intersectModel(source: DeformedPickingSource, {refresh = true}: IntersectOptions = {}): Promise<RaycasterHit[]> {
    if (!source || typeof source.readPickingGeometry !== 'function' || !source.root) throw new TypeError('Expected a deformed picking source');
    const root = source.root as unknown as RuntimeMesh & {engine: RuntimeEngine}, runtime = root.engine;
    if (!runtime || !runtime.meshes || !runtime.store) throw new TypeError('Picking source root has no engine');
    if (source.disposed || runtime.disposed) throw new Error('Picking source or engine is disposed');
    if (runtime.meshes.get(root.id) !== root) throw new Error('Picking source root is disposed');
    const {near, far, side, firstHitOnly, layers, filter} = this, bvhOptions = {...this.bvhOptions};
    if (!(near >= 0) || !(far >= near)) throw new RangeError('Expected 0 <= near <= far');
    if (!['material', 'front', 'back', 'double'].includes(side)) throw new TypeError('Invalid raycaster side');
    const origin = this.origin.slice(), direction = this.direction.slice(), store = runtime.store;
    if (refresh) store.tick(false);
    const geometry = await source.readPickingGeometry();
    // A removed object can have its numeric id reused while mapAsync is pending. Never let that replacement receive a hit.
    if (source.disposed || runtime.disposed || source.root !== (root as unknown as Mesh) || runtime.meshes.get(root.id) !== root) return [];
    if (!Array.isArray(geometry)) throw new TypeError('Expected picking geometry snapshots');
    const previous = poseCache.get(source) ?? [], next: PoseBVH[] = [], hits: RaycasterHit[] = [];
    const inverse = new Float64Array(16);
    let best = far;
    for (let i = 0; i < geometry.length; i++) {
      const snapshot = geometry[i];
      if (!snapshot || !snapshot.node) throw new TypeError('Invalid picking geometry snapshot');
      const handle = snapshot.node, mesh = handle as unknown as RuntimeMesh & {engine: RuntimeEngine};
      if (mesh.engine !== runtime) throw new TypeError('Picking geometry belongs to another engine');
      if (runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(store, mesh.id)) continue;
      if (!(getMeshLayers(handle) & layers) || filter && !filter(handle)) continue;
      // User predicates can dispose or reparent scene objects synchronously as well.
      if (source.disposed || runtime.disposed || runtime.meshes.get(root.id) !== root) return [];
      if (runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(store, mesh.id)) continue;
      const {vertices, indices, matrix, doubleSided} = snapshot, count = vertices?.length / 20;
      if (!(vertices instanceof Float32Array) || !Number.isInteger(count) || count < 3 || !(indices instanceof Uint32Array) || !indices.length || indices.length % 3) throw new RangeError('Invalid stride-20 picking geometry');
      if (typeof doubleSided !== 'boolean' || !(matrix instanceof Float32Array) || matrix.length !== 16) throw new TypeError('Invalid picking material or world matrix');
      if (vertices.some(v => !Number.isFinite(v)) || matrix.some(v => !Number.isFinite(v))) throw new RangeError('Picking geometry must be finite');
      if (matrix[3] || matrix[7] || matrix[11] || matrix[15] !== 1) throw new RangeError('Picking matrix must be affine');
      if (indices.some(index => index >= count)) throw new RangeError('Picking index exceeds vertex count');
      let cached = previous[i];
      if (!cached || cached.node !== handle || cached.vertices.length !== count * 6 || cached.indices.length !== indices.length || indices.some((index, at) => index !== cached.indices[at])) {
        const packed = new Float32Array(count * 6), copiedIndices = indices.slice();
        packPose(vertices, packed);
        cached = {node: handle, vertices: packed, indices: copiedIndices, bvh: MeshBVH.fromGeometry({vertices: packed, indices: copiedIndices}, bvhOptions)};
      } else {
        packPose(vertices, cached.vertices);
        cached.bvh.refit();
      }
      next[i] = cached;
      if (!invert(matrix, inverse)) continue;
      const local = new Float64Array(3), [ox, oy, oz] = origin, [dx, dy, dz] = direction;
      transformPoint(inverse, ox, oy, oz, local);
      const lx = inverse[0] * dx + inverse[4] * dy + inverse[8] * dz, ly = inverse[1] * dx + inverse[5] * dy + inverse[9] * dz, lz = inverse[2] * dx + inverse[6] * dy + inverse[10] * dz;
      const length = Math.hypot(lx, ly, lz);
      const ray = {origin: local, direction: [lx, ly, lz]}, options = {near: near * length, far: (firstHitOnly ? best : far) * length, side: side === 'material' ? doubleSided ? 'double' as const : 'front' as const : side};
      const found = firstHitOnly ? [cached.bvh.raycastFirst(ray, options)] : cached.bvh.raycast(ray, options);
      for (const hit of found) {
        if (!hit) continue;
        const point: Vec3 = [0, 0, 0];
        transformPoint(matrix, hit.point[0], hit.point[1], hit.point[2], point);
        const distance = hit.distance / length;
        if (firstHitOnly) {if (distance > best) continue; best = distance; hits.length = 0;}
        hits.push({mesh: handle, distance, point, normal: normalTransform(inverse, hit.normal), faceNormal: normalTransform(inverse, hit.faceNormal), faceIndex: hit.faceIndex, barycoord: hit.barycoord, frontFace: hit.frontFace, localPoint: hit.point});
      }
    }
    poseCache.set(source, next);
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /** Tests the given meshes of an engine (hidden ones and those under hidden parents are skipped). */
  intersectMeshes(engine: Engine, meshes: Iterable<Mesh>, {refresh = true}: IntersectOptions = {}): RaycasterHit[] {
    const runtime = engine as unknown as RuntimeEngine;
    if (runtime.disposed) throw new Error('Engine is disposed');
    if (!(this.near >= 0) || !(this.far >= this.near)) throw new RangeError('Expected 0 <= near <= far');
    const store = runtime.store;
    if (refresh) store.tick(false);
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2], dx = this.direction[0], dy = this.direction[1], dz = this.direction[2];
    const candidates: Array<{mesh: RuntimeMesh; geometry: GeometryLike; doubleSided: boolean; entry: number}> = [];
    for (const handle of meshes) {
      const mesh = handle as unknown as RuntimeMesh;
      if (runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(store, mesh.id)) continue;
      if (!(getMeshLayers(handle) & this.layers)) continue;
      if (this.filter && !this.filter(handle)) continue;
      if (runtime.disposed) throw new Error('Engine is disposed');
      if (runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(store, mesh.id)) continue;
      const triangles = meshTriangles(handle);
      if (!triangles) continue;
      if (triangles.kind === 'pbr' && triangles.source.primitives.some(primitive => primitive.deformed)) throw new Error('Deformed PBR mesh requires async Raycaster.intersectModel(model)');
      const records = triangles.kind === 'core' ? [{geometry: triangles.geometry, doubleSided: mesh.material.data[6] >= 0.5}] : triangles.source.primitives.map(primitive => ({geometry: staticGeometry(primitive), doubleSided: primitive.material.settings[2] >= 0.5}));
      for (const {geometry, doubleSided} of records) {
      const m = store.matrices, o = mesh.id * 16, b = geometry.bounds;
      // World bounding sphere: the absolute row-sum bound of M^T M also covers hierarchy shear.
      const cx = m[o] * b[0] + m[o + 4] * b[1] + m[o + 8] * b[2] + m[o + 12] - ox;
      const cy = m[o + 1] * b[0] + m[o + 5] * b[1] + m[o + 9] * b[2] + m[o + 13] - oy;
      const cz = m[o + 2] * b[0] + m[o + 6] * b[1] + m[o + 10] * b[2] + m[o + 14] - oz;
      const xy = Math.abs(m[o] * m[o + 4] + m[o + 1] * m[o + 5] + m[o + 2] * m[o + 6]);
      const xz = Math.abs(m[o] * m[o + 8] + m[o + 1] * m[o + 9] + m[o + 2] * m[o + 10]);
      const yz = Math.abs(m[o + 4] * m[o + 8] + m[o + 5] * m[o + 9] + m[o + 6] * m[o + 10]);
      const scale = Math.sqrt(Math.max(m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2 + xy + xz, m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2 + xy + yz, m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2 + xz + yz));
      const radius = b[3] * scale * (1 + 1e-5) + 1e-6, along = cx * dx + cy * dy + cz * dz, offAxis = cx * cx + cy * cy + cz * cz - along * along;
      if (offAxis > radius * radius) continue;
      const half = Math.sqrt(radius * radius - Math.max(0, offAxis));
      if (along + half < this.near || along - half > this.far) continue;
      candidates.push({mesh, geometry, doubleSided, entry: Math.max(0, along - half)});
      }
    }
    if (this.firstHitOnly) candidates.sort((a, b) => a.entry - b.entry);
    const hits: RaycasterHit[] = [], inverse = new Float64Array(16), matrix = new Float64Array(16);
    let best = this.far;
    for (const {mesh, geometry, doubleSided, entry} of candidates) {
      if (this.firstHitOnly && entry > best) break;
      matrix.set(store.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16));
      if (!invert(matrix, inverse)) continue;
      const local = new Float64Array(3);
      transformPoint(inverse, ox, oy, oz, local);
      const lx = inverse[0] * dx + inverse[4] * dy + inverse[8] * dz, ly = inverse[1] * dx + inverse[5] * dy + inverse[9] * dz, lz = inverse[2] * dx + inverse[6] * dy + inverse[10] * dz;
      // Sides follow the local winding, as the renderer does: a mirrored world matrix keeps the mesh's front side.
      const length = Math.hypot(lx, ly, lz);
      const side: Side = this.side === 'material' ? doubleSided ? 'double' : 'front' : this.side;
      const bvh = getGeometryBVH(geometry, this.bvhOptions), ray = {origin: local, direction: [lx, ly, lz]};
      const options = {near: this.near * length, far: (this.firstHitOnly ? best : this.far) * length, side};
      const found = this.firstHitOnly ? [bvh.raycastFirst(ray, options)] : bvh.raycast(ray, options);
      for (const hit of found) {
        if (!hit) continue;
        const point: Vec3 = [0, 0, 0];
        transformPoint(matrix, hit.point[0], hit.point[1], hit.point[2], point);
        const distance = hit.distance / length;
        if (this.firstHitOnly) { if (distance > best) continue; best = distance; hits.length = 0; }
        hits.push({
          mesh: mesh as unknown as Mesh, distance, point, normal: normalTransform(inverse, hit.normal), faceNormal: normalTransform(inverse, hit.faceNormal),
          faceIndex: hit.faceIndex, barycoord: hit.barycoord, frontFace: hit.frontFace, localPoint: hit.point,
        });
      }
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }
}

function packPose(source: Float32Array, target: Float32Array): void {
  for (let i = 0, j = 0; i < source.length; i += 20, j += 6) {
    target[j] = source[i]; target[j + 1] = source[i + 1]; target[j + 2] = source[i + 2];
    target[j + 3] = source[i + 4]; target[j + 4] = source[i + 5]; target[j + 5] = source[i + 6];
  }
}

function hiddenInHierarchy(store: RuntimeStore, id: number): boolean {
  for (let node = id, depth = 0; node >= 0 && depth <= 64; node = store.parents[node], depth++) if (store.hidden[node]) return true;
  return false;
}

function unproject(inverse: Float64Array, x: number, y: number, z: number): Vec3 {
  const w = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
  return [(inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12]) / w, (inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13]) / w, (inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14]) / w];
}

/** Inverse-transpose of the upper 3x3 applied to a normal, normalized. */
function normalTransform(inverse: Float64Array, n: Vec3): Vec3 {
  const x = inverse[0] * n[0] + inverse[1] * n[1] + inverse[2] * n[2], y = inverse[4] * n[0] + inverse[5] * n[1] + inverse[6] * n[2], z = inverse[8] * n[0] + inverse[9] * n[1] + inverse[10] * n[2];
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
}
