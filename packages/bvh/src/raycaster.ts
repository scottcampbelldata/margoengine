import type {Camera, Engine, Geometry, Mesh} from '@margoengine/core';
import {buildAsync, type AsyncBuildOptions} from './async.js';
import type {BVHBuildOptions} from './build.js';
import {MeshBVH, type GeometryLike, type Vec3} from './bvh.js';
import {invert, transformPoint, type Side} from './math.js';

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

  /** Tests the given meshes of an engine (hidden ones and those under hidden parents are skipped). */
  intersectMeshes(engine: Engine, meshes: Iterable<Mesh>, {refresh = true}: IntersectOptions = {}): RaycasterHit[] {
    const runtime = engine as unknown as RuntimeEngine;
    if (runtime.disposed) throw new Error('Engine is disposed');
    if (!(this.near >= 0) || !(this.far >= this.near)) throw new RangeError('Expected 0 <= near <= far');
    const store = runtime.store;
    if (refresh) store.tick(false);
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2], dx = this.direction[0], dy = this.direction[1], dz = this.direction[2];
    const candidates: Array<{mesh: RuntimeMesh; entry: number}> = [];
    for (const handle of meshes) {
      const mesh = handle as unknown as RuntimeMesh, geometry = mesh.geometry;
      if (!geometry || runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(store, mesh.id)) continue;
      if (!(getMeshLayers(handle) & this.layers)) continue;
      if (this.filter && !this.filter(handle)) continue;
      const m = store.matrices, o = mesh.id * 16, b = geometry.bounds;
      // World bounding sphere: transformed center, radius scaled by the longest basis vector.
      const cx = m[o] * b[0] + m[o + 4] * b[1] + m[o + 8] * b[2] + m[o + 12] - ox;
      const cy = m[o + 1] * b[0] + m[o + 5] * b[1] + m[o + 9] * b[2] + m[o + 13] - oy;
      const cz = m[o + 2] * b[0] + m[o + 6] * b[1] + m[o + 10] * b[2] + m[o + 14] - oz;
      const scale = Math.sqrt(Math.max(m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2, m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2, m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2));
      const radius = b[3] * scale * (1 + 1e-5) + 1e-6, along = cx * dx + cy * dy + cz * dz, offAxis = cx * cx + cy * cy + cz * cz - along * along;
      if (offAxis > radius * radius) continue;
      const half = Math.sqrt(radius * radius - Math.max(0, offAxis));
      if (along + half < this.near || along - half > this.far) continue;
      candidates.push({mesh, entry: Math.max(0, along - half)});
    }
    if (this.firstHitOnly) candidates.sort((a, b) => a.entry - b.entry);
    const hits: RaycasterHit[] = [], inverse = new Float64Array(16), matrix = new Float64Array(16);
    let best = this.far;
    for (const {mesh, entry} of candidates) {
      if (this.firstHitOnly && entry > best) break;
      matrix.set(store.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16));
      if (!invert(matrix, inverse)) continue;
      const local = new Float64Array(3);
      transformPoint(inverse, ox, oy, oz, local);
      const lx = inverse[0] * dx + inverse[4] * dy + inverse[8] * dz, ly = inverse[1] * dx + inverse[5] * dy + inverse[9] * dz, lz = inverse[2] * dx + inverse[6] * dy + inverse[10] * dz;
      // Sides follow the local winding, as the renderer does: a mirrored world matrix keeps the mesh's front side.
      const length = Math.hypot(lx, ly, lz);
      const side: Side = this.side === 'material' ? mesh.material.data[6] >= 0.5 ? 'double' : 'front' : this.side;
      const bvh = getGeometryBVH(mesh.geometry!, this.bvhOptions), ray = {origin: local, direction: [lx, ly, lz]};
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
