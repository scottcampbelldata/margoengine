import type { Camera, Engine, Geometry, Mesh } from '@margoengine/core';
import type { Engine as Runtime } from '@margoengine/core/extension';
import { buildAsync, type AsyncBuildOptions } from './async.js';
import type { BVHBuildOptions } from './build.js';
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MeshBVH, type BVHHit, type GeometryLike } from './bvh.js';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { transformPoint, type Side } from './math.js';
import { meshTriangles } from '../../shared/mesh-source.js';

// Structural views of the engine internals that `engineRuntime(engine)` exposes. Types only: this module never
// imports core at runtime, so it stays usable from workers and Node.
interface RuntimeStore {
  matrices: Float32Array;
  parents: Float32Array;
  hidden: Uint8Array;
  tick(culling?: boolean): void;
}
interface RuntimeMesh {
  id: number;
  geometry: Geometry | null;
  material: { data: Float32Array };
}
interface RuntimeEngine {
  store: RuntimeStore;
  meshes: Map<number, RuntimeMesh>;
  camera: Camera;
  canvas: HTMLCanvasElement;
  backend: 'webgpu' | 'webgl2';
  disposed: boolean;
}

const bvhCache = new WeakMap<GeometryLike, MeshBVH>();

/** The cached BVH of a geometry, built synchronously on first use with `options`. */
export function getGeometryBVH(geometry: Geometry | GeometryLike, options?: BVHBuildOptions): MeshBVH {
  let bvh = bvhCache.get(geometry);
  if (!bvh) {
    bvh = MeshBVH.fromGeometry(geometry, options);
    bvhCache.set(geometry, bvh);
  }
  return bvh;
}
/** Installs (or with null removes) the BVH the Raycaster uses for a geometry, for example one from `deserialize`. */
export function setGeometryBVH(geometry: Geometry | GeometryLike, bvh: MeshBVH | null): void {
  if (bvh === null) {
    bvhCache.delete(geometry);
    return;
  }
  if (!(bvh instanceof MeshBVH) || bvh.positions !== geometry.vertices)
    throw new TypeError('BVH was not built over this geometry');
  bvhCache.set(geometry, bvh);
}
/** Whether a geometry already has a cached (or installed) BVH. */
export const hasGeometryBVH = (geometry: Geometry | GeometryLike): boolean => bvhCache.has(geometry);
/** Builds a geometry's BVH in the worker and caches it. Call before raycasting to keep large builds off the main thread. */
export async function computeGeometryBVHAsync(
  geometry: Geometry | GeometryLike,
  options: Omit<AsyncBuildOptions, 'transfer'> = {},
): Promise<MeshBVH> {
  const bvh = await buildAsync(geometry, options);
  bvhCache.set(geometry, bvh);
  return bvh;
}

const layerMasks = new WeakMap<object, number>();
/**
 * Layer bit mask of a mesh (default 1). A Raycaster only tests meshes whose mask shares a bit with `raycaster.layers`.
 * Model primitives use their node's mask, else the mask of `model.root`.
 */
export function setMeshLayers(mesh: Mesh, mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)
    throw new RangeError('Layer mask must be a 32-bit unsigned integer');
  layerMasks.set(mesh, mask >>> 0);
}
/** Layer bit mask of a mesh set with setMeshLayers (default 1). */
export const getMeshLayers = (mesh: Mesh): number => layerMasks.get(mesh) ?? 1;

/** @internal Captured model masks follow the same node/root inheritance as live queries. */
export function modelMeshLayers(mesh: Mesh, root: Mesh): number {
  return layerMasks.get(mesh) ?? layerMasks.get(root) ?? 1;
}

/**
 * Structural view of a gltf-pro `PBRModel` primitive (also what @margoengine/materials meshes are). `vertices` is gltf-pro's
 * 20-float CPU vertex: position at 0, normal at 4, TEXCOORD_0 at 12. Active GPU deformation requires async intersectModel.
 */
export interface ModelPrimitiveLike {
  readonly node: Mesh;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly material: { readonly settings: ArrayLike<number>; readonly side?: Side };
  readonly nodeIndex?: number;
  /** gltf-pro `PBRInstances`: the primitive is tested once per drawn instance (24 floats each, node-space matrix first). */
  readonly instances?: { readonly count: number; readonly data: Float32Array };
}
/** Structural view of a gltf-pro `PBRModel`: its `root` node and `primitives`. `intersectEngine` finds attached models itself. */
export interface ModelLike {
  readonly root: Mesh;
  readonly primitives: readonly ModelPrimitiveLike[];
  readonly disposed?: boolean;
}
/** gltf-pro shape: a `root` node and `primitives` with 20-float CPU vertices (the first one is checked). */
export const isModel = (value: unknown): value is ModelLike =>
  !!value &&
  typeof value === 'object' &&
  !!(value as ModelLike).root &&
  Array.isArray((value as ModelLike).primitives) &&
  (!(value as ModelLike).primitives.length || (value as ModelLike).primitives[0].vertices instanceof Float32Array);
/** Live gltf-pro models attached to an engine: its plugins that have `root` and `primitives`. */
export function engineModels(engine: Engine): ModelLike[] {
  const out: ModelLike[] = [];
  // Structural engines (tests, tools) may have no plugin map.
  for (const plugin of (engine as Runtime).plugins?.values() ?? [])
    if (isModel(plugin) && !plugin.disposed) out.push(plugin);
  return out;
}

/**
 * Structural view of a pick proxy: an object drawn without triangles (an @margoengine/lod imposter level), hit through its
 * local bounding sphere `sphere` (x, y, z, radius) under `anchor`'s world matrix. `model` is reported with the hit.
 */
export interface PickProxy {
  readonly anchor: Mesh;
  readonly sphere: ArrayLike<number>;
  readonly model?: object | null;
}
/** Proxies from every engine plugin with a `pickProxies()` method (an @margoengine/lod `LODSystem`). A new array. */
export function engineProxies(engine: Engine): PickProxy[] {
  const out: PickProxy[] = [];
  for (const plugin of ((engine as Runtime).plugins?.values() ?? []) as Iterable<{
    pickProxies?(): readonly PickProxy[];
  }>)
    if (typeof plugin.pickProxies === 'function') out.push(...plugin.pickProxies());
  return out;
}

interface PrimitiveEntry {
  vertices: Float32Array;
  sphere: Float64Array;
  bvh: MeshBVH | null;
}
const primitiveCache = new WeakMap<Uint32Array, PrimitiveEntry>();
const primitiveSource = (p: ModelPrimitiveLike) => ({
  positions: p.vertices,
  stride: 20,
  normals: p.vertices.subarray(4),
  indices: p.indices,
});
function primitiveEntry(p: ModelPrimitiveLike): PrimitiveEntry {
  let entry = primitiveCache.get(p.indices);
  if (!entry || entry.vertices !== p.vertices) {
    entry = { vertices: p.vertices, sphere: boundingSphere(p.vertices, 20), bvh: null };
    primitiveCache.set(p.indices, entry);
  }
  return entry;
}

/**
 * @internal Local bounding sphere (x, y, z, radius) of strided positions around their box centre (not the minimal
 * sphere). Shared by live model queries and RaycastSnapshot capture.
 */
export function boundingSphere(v: Float32Array, stride: number): Float64Array {
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < v.length; i += stride) {
    const x = v[i],
      y = v[i + 1],
      z = v[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    cz = (z0 + z1) / 2;
  let r = 0;
  for (let i = 0; i < v.length; i += stride)
    r = Math.max(r, (v[i] - cx) ** 2 + (v[i + 1] - cy) ** 2 + (v[i + 2] - cz) ** 2);
  return new Float64Array([cx, cy, cz, Math.sqrt(r)]);
}

/** @internal Material side of a model primitive: its `side`, else gltf-pro's settings[2] (2 back, >= 0.5 double). */
export const primitiveSide = (material: ModelPrimitiveLike['material']): Side =>
  material.side ?? (material.settings[2] === 2 ? 'back' : material.settings[2] >= 0.5 ? 'double' : 'front');
/** @internal Material side of a core mesh: double-sided when material data[6] >= 0.5. */
export const meshSide = (material: { data: Float32Array }): Side => (material.data[6] >= 0.5 ? 'double' : 'front');
/** The cached BVH of a model primitive (primitives sharing vertex and index arrays share it), built on first use. */
export function getPrimitiveBVH(primitive: ModelPrimitiveLike, options?: BVHBuildOptions): MeshBVH {
  const entry = primitiveEntry(primitive);
  return (entry.bvh ??= MeshBVH.build(primitiveSource(primitive), options));
}
/** Whether a model primitive already has a cached BVH. */
export const hasPrimitiveBVH = (primitive: ModelPrimitiveLike): boolean => !!primitiveCache.get(primitive.indices)?.bvh;
/** Builds a primitive's BVH in the worker (vertices are copied, not moved) and caches it, for example right after `loadGLTF`. */
export async function computePrimitiveBVHAsync(
  primitive: ModelPrimitiveLike,
  options: Omit<AsyncBuildOptions, 'transfer'> = {},
): Promise<MeshBVH> {
  const bvh = await buildAsync(primitiveSource(primitive), options);
  primitiveEntry(primitive).bvh = bvh;
  return bvh;
}

interface Candidate {
  node: RuntimeMesh;
  entry: number;
  model: ModelLike | null;
  primitive: ModelPrimitiveLike | null;
  index: number;
  /** A direct node or a pick proxy: only its own layers count, never its model root's. */
  ownLayers?: true;
  sphere?: ArrayLike<number>;
  matrix?: Float32Array;
  instance?: number;
}
/** Faces a Raycaster tests: a fixed side, or 'material' to follow each material. */
export type RaycasterSide = Side | 'material';
/** One Raycaster hit in world space, with the mesh (and model data) it belongs to. */
export interface RaycasterHit {
  /** The core mesh, or for a model hit the glTF node that owns the primitive. */
  mesh: Mesh;
  /** World-space distance from the ray origin. */
  distance: number;
  point: MutableVec3;
  /** Interpolated vertex normal in world space (inverse-transpose of the world matrix), normalized. Not flipped for back faces. */
  normal: MutableVec3;
  /** Geometric normal of the triangle in world space, normalized. */
  faceNormal: MutableVec3;
  faceIndex: number;
  barycoord: MutableVec3;
  /**
   * True when the ray hit the front side as the renderer defines it: counter-clockwise in the mesh's local space, so a
   * mirrored (negative determinant) world matrix keeps the same front side. `faceNormal` always points to the front side.
   */
  frontFace: boolean;
  /** Hit point in the mesh's local space. */
  localPoint: MutableVec3;
  /**
   * Model hits only: the model, the primitive and its index in `model.primitives`, the glTF node index and TEXCOORD_0 at
   * the hit. `intersectModel` hits carry `uv` from the posed snapshot, and `primitiveIndex` and `nodeIndex` when the
   * snapshot supplies them (gltf-pro's `PBRModel` does); they have no `model` or `primitive` object.
   */
  model?: ModelLike;
  primitive?: ModelPrimitiveLike;
  primitiveIndex?: number;
  nodeIndex?: number;
  uv?: [number, number];
  /** Instanced primitive hits only: the instance index (`PBRInstances` row); `mesh` is the primitive's node. */
  instanceId?: number;
  /**
   * Pick proxy hits only (an @margoengine/lod imposter level, which has no triangles): true. `mesh` is the LOD anchor, `model`
   * the LOD's model if it has one; point and normals are on the bounding sphere (an ellipsoid under nonuniform scale), faceIndex is -1.
   */
  approximate?: boolean;
}
/** Options for Raycaster queries against an engine. */
export interface IntersectOptions {
  /** Run the transform kernel first so world matrices reflect transform edits made since the last render. Default true. */
  refresh?: boolean;
}
/** Snapshot of one PBR primitive in its current deformed pose. No core Geometry is created or assigned. */
export interface PickingGeometry {
  readonly node: Mesh;
  /** PBR vertex layout: 20 floats per vertex, position xyz at 0, normal xyz at 4 and TEXCOORD_0 at 12. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly doubleSided: boolean;
  readonly side?: Side;
  /** Local-to-world matrix captured with the vertex snapshot, before any asynchronous GPU readback. */
  readonly matrix: Float32Array;
  /**
   * Index of the primitive in its model's `primitives`, captured with the snapshot (before any readback), and copied to
   * hits as `primitiveIndex`. Optional: a source that leaves it out gets hits without one.
   */
  readonly primitiveIndex?: number;
  /** glTF node index of the primitive, captured with the snapshot and copied to hits as `nodeIndex`. Optional. */
  readonly nodeIndex?: number;
}
/** Structural interface implemented by gltf-pro's PBRModel, without a runtime or package dependency on gltf-pro. */
export interface DeformedPickingSource {
  readonly root: Mesh;
  readonly disposed: boolean;
  readPickingGeometry(): Promise<readonly PickingGeometry[]>;
}
interface PoseBVH {
  node: Mesh;
  vertices: Float32Array;
  indices: Uint32Array;
  bvh: MeshBVH;
}
const poseCache = new WeakMap<DeformedPickingSource, PoseBVH[]>();
/**
 * CPU picking against engine meshes. Each geometry gets a cached MeshBVH,
 * meshes are rejected by their world bounding sphere, and the ray is tested in each mesh's local space.
 */
export class Raycaster {
  readonly origin = new Float64Array(3);
  /** Normalized world direction. */
  readonly direction = new Float64Array([0, 0, -1]);
  near = 0;
  far = Infinity;
  /** 'material' (default) follows each material's side, falling back to doubleSided; or force 'front', 'back' or 'double'. */
  side: RaycasterSide = 'material';
  /** Return only the nearest hit. Much faster with many overlapping meshes. */
  firstHitOnly = false;
  /** Bit mask tested against `getMeshLayers(mesh)`. Default: every layer. */
  layers = 0xffffffff;
  /** Extra per-mesh predicate (for a model primitive: its node and model). Return false to skip it. */
  filter: ((mesh: Mesh, model?: ModelLike) => boolean) | null = null;
  /** Options for BVHs this Raycaster builds on demand. */
  bvhOptions: BVHBuildOptions = {};

  constructor(origin?: ArrayLike<number>, direction?: ArrayLike<number>, near = 0, far = Infinity) {
    if (origin && direction) this.set(origin, direction);
    this.near = near;
    this.far = far;
  }

  set(origin: ArrayLike<number>, direction: ArrayLike<number>): this {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (![origin[0], origin[1], origin[2]].every(Number.isFinite) || !(length > 0) || !Number.isFinite(length))
      throw new RangeError('Ray needs a finite origin and nonzero direction');
    this.origin[0] = origin[0];
    this.origin[1] = origin[1];
    this.origin[2] = origin[2];
    this.direction[0] = direction[0] / length;
    this.direction[1] = direction[1] / length;
    this.direction[2] = direction[2] / length;
    return this;
  }

  /**
   * Ray through normalized device coordinates (x right, y up, both -1..1) by inverting `camera.matrix`, which must be
   * current (the engine updates it every render; `setFromEngine` updates it for you). `webgpu` selects WebGPU's reversed-Z
   * clip depth (near 1, far 0) instead of WebGL's -1..1. The origin is the camera position, or the near-plane point for
   * an orthographic matrix (e.g. from `@margoengine/cameras`), whose rays are parallel.
   */
  setFromCamera(coords: ArrayLike<number>, camera: Camera, webgpu = true): this {
    const m = camera.matrix,
      inverse = invertMatrix(m, new Float64Array(16));
    if (!inverse) throw new RangeError('Camera matrix is singular');
    const x = coords[0],
      y = coords[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid device coordinates');
    return cameraRay(this, inverse, isOrthographic(m), camera.position, x, y, webgpu);
  }

  /** Ray through a canvas point in CSS pixels (as `engine.pick` takes), using the engine camera and backend. */
  setFromEngine(engine: Engine, x: number, y: number): this {
    const runtime = engine as unknown as RuntimeEngine,
      canvas = runtime.canvas;
    const width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height,
      webgpu = runtime.backend === 'webgpu';
    runtime.camera.update(canvas.width / canvas.height, webgpu);
    return this.setFromCamera([(x / width) * 2 - 1, 1 - (y / height) * 2], runtime.camera, webgpu);
  }

  /** Tests every visible core mesh with geometry, every attached gltf-pro model and every pick proxy (imposter levels). Hits are sorted by distance. */
  intersectEngine(engine: Engine, options?: IntersectOptions): RaycasterHit[] {
    const runtime = engine as unknown as RuntimeEngine;
    return this.intersect(runtime, runtime.meshes.values(), engineModels(engine), engineProxies(engine), options);
  }

  /**
   * Picks a PBR source's current skin/morph pose, including deformations outside its bind-pose bounds. This explicit
   * asynchronous query reads GPU vertex data; use it for pointer events rather than every frame. Unchanged topology
   * reuses and refits a cached BVH. Ray settings and each primitive's world transform are captured for this query.
   * Ordinary intersectEngine/intersectMeshes queries stay synchronous and never trigger GPU work.
   */
  async intersectModel(
    source: DeformedPickingSource,
    { refresh = true }: IntersectOptions = {},
  ): Promise<RaycasterHit[]> {
    if (!source || typeof source.readPickingGeometry !== 'function' || !source.root)
      throw new TypeError('Expected a deformed picking source');
    const root = source.root as unknown as RuntimeMesh & { engine: RuntimeEngine },
      runtime = root.engine;
    if (!runtime || !runtime.meshes || !runtime.store) throw new TypeError('Picking source root has no engine');
    if (source.disposed || runtime.disposed)
      throw new MargoError('disposed', 'Picking source or engine is disposed; pick a live model on a live Engine.');
    if (runtime.meshes.get(root.id) !== root)
      throw new MargoError(
        'disposed',
        'Picking source root is disposed; pick a model whose root is still in the scene.',
      );
    const { near, far, side, firstHitOnly, layers, filter } = this,
      bvhOptions = { ...this.bvhOptions };
    if (!(near >= 0) || !(far >= near)) throw new RangeError('Expected 0 <= near <= far');
    if (!['material', 'front', 'back', 'double'].includes(side)) throw new TypeError('Invalid raycaster side');
    const origin = this.origin.slice(),
      direction = this.direction.slice(),
      store = runtime.store;
    if (refresh) store.tick(false);
    const geometry = await source.readPickingGeometry();
    // A removed object can have its numeric id reused while mapAsync is pending. Never let that replacement receive a hit.
    if (
      source.disposed ||
      runtime.disposed ||
      source.root !== (root as unknown as Mesh) ||
      runtime.meshes.get(root.id) !== root
    )
      return [];
    if (!Array.isArray(geometry)) throw new TypeError('Expected picking geometry snapshots');
    const previous = poseCache.get(source) ?? [],
      next: PoseBVH[] = [],
      hits: RaycasterHit[] = [];
    const inverse = new Float64Array(16);
    let best = far;
    for (let i = 0; i < geometry.length; i++) {
      const snapshot = geometry[i];
      if (!snapshot || !snapshot.node) throw new TypeError('Invalid picking geometry snapshot');
      const handle = snapshot.node,
        mesh = handle as unknown as RuntimeMesh & { engine: RuntimeEngine };
      if (mesh.engine !== runtime) throw new TypeError('Picking geometry belongs to another engine');
      if (runtime.meshes.get(mesh.id) !== mesh || hiddenInHierarchy(runtime.store, mesh.id)) continue;
      if (!(getMeshLayers(handle) & layers) || (filter && !filter(handle))) continue;
      // User predicates can dispose or reparent scene objects synchronously as well.
      if (
        source.disposed ||
        runtime.disposed ||
        source.root !== (root as unknown as Mesh) ||
        runtime.meshes.get(root.id) !== root
      )
        return [];
      if (
        runtime.meshes.get(mesh.id) !== mesh ||
        hiddenInHierarchy(runtime.store, mesh.id) ||
        !(getMeshLayers(handle) & layers)
      )
        continue;
      const { vertices, indices, matrix, doubleSided } = snapshot,
        count = vertices?.length / 20;
      if (
        !(vertices instanceof Float32Array) ||
        !Number.isInteger(count) ||
        count < 3 ||
        !(indices instanceof Uint32Array) ||
        !indices.length ||
        indices.length % 3
      )
        throw new RangeError('Invalid stride-20 picking geometry');
      if (
        typeof doubleSided !== 'boolean' ||
        (snapshot.side !== undefined && !['front', 'back', 'double'].includes(snapshot.side)) ||
        !(matrix instanceof Float32Array) ||
        matrix.length !== 16
      )
        throw new TypeError('Invalid picking material or world matrix');
      if (vertices.some((v) => !Number.isFinite(v)) || matrix.some((v) => !Number.isFinite(v)))
        throw new RangeError('Picking geometry must be finite');
      if (matrix[3] || matrix[7] || matrix[11] || matrix[15] !== 1)
        throw new RangeError('Picking matrix must be affine');
      if (indices.some((index) => index >= count)) throw new RangeError('Picking index exceeds vertex count');
      // Identity is the snapshot's own, captured by the source before its readback; never derived from position or node.
      const { primitiveIndex, nodeIndex } = snapshot;
      for (const [name, value] of [
        ['primitiveIndex', primitiveIndex],
        ['nodeIndex', nodeIndex],
      ] as const) {
        if (value === undefined) continue;
        if (typeof value !== 'number') throw new TypeError(`Picking ${name} must be a number`);
        if (!Number.isSafeInteger(value) || value < 0)
          throw new RangeError(`Picking ${name} must be a non-negative integer`);
      }
      let cached = previous[i];
      if (
        !cached ||
        cached.node !== handle ||
        cached.vertices.length !== count * 6 ||
        cached.indices.length !== indices.length ||
        indices.some((index, at) => index !== cached.indices[at])
      ) {
        const packed = new Float32Array(count * 6),
          copiedIndices = indices.slice();
        packPose(vertices, packed);
        cached = {
          node: handle,
          vertices: packed,
          indices: copiedIndices,
          bvh: MeshBVH.fromGeometry({ vertices: packed, indices: copiedIndices }, bvhOptions),
        };
      } else {
        packPose(vertices, cached.vertices);
        cached.bvh.refit();
      }
      next[i] = cached;
      if (!invertMatrix(matrix, inverse)) continue;
      const local = new Float64Array(3),
        localDirection = [0, 0, 0],
        length = localRay(inverse, origin, direction, local, localDirection),
        ray = { origin: local, direction: localDirection },
        options = {
          near: near * length,
          far: (firstHitOnly ? best : far) * length,
          side:
            side === 'material' ? (snapshot.side ?? (doubleSided ? ('double' as const) : ('front' as const))) : side,
        };
      const found = firstHitOnly ? [cached.bvh.raycastFirst(ray, options)] : cached.bvh.raycast(ray, options);
      for (const hit of found) {
        if (!hit) continue;
        const distance = hit.distance / length;
        if (firstHitOnly) {
          if (distance > best) continue;
          best = distance;
          hits.length = 0;
        }
        // TEXCOORD_0 of the posed snapshot, weighted like the sync model path.
        const result = worldHit(handle, hit, matrix, inverse, length);
        result.uv = hitUV(vertices, hit);
        if (primitiveIndex !== undefined) result.primitiveIndex = primitiveIndex;
        if (nodeIndex !== undefined) result.nodeIndex = nodeIndex;
        hits.push(result);
      }
    }
    poseCache.set(source, next);
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /** Tests the given core meshes of an engine (hidden ones and those under hidden parents are skipped), and pick proxies anchored on them. */
  intersectMeshes(engine: Engine, meshes: Iterable<Mesh>, options?: IntersectOptions): RaycasterHit[] {
    return this.intersectObjects(engine, meshes, options);
  }

  /** Tests the given core meshes and gltf-pro models (`PBRModel`, @margoengine/materials meshes), and pick proxies whose anchor or model is given. */
  intersectObjects(engine: Engine, objects: Iterable<Mesh | ModelLike>, options?: IntersectOptions): RaycasterHit[] {
    const meshes: RuntimeMesh[] = [],
      models: ModelLike[] = [],
      given = new Set<unknown>(objects);
    for (const object of given)
      if (isModel(object)) models.push(object);
      else meshes.push(object as unknown as RuntimeMesh);
    const proxies = engineProxies(engine).filter((p) => given.has(p.anchor) || given.has(p.model));
    return this.intersect(engine as unknown as RuntimeEngine, meshes, models, proxies, options);
  }

  private intersect(
    runtime: RuntimeEngine,
    meshes: Iterable<RuntimeMesh>,
    models: readonly ModelLike[],
    proxies: readonly PickProxy[],
    { refresh = true }: IntersectOptions = {},
  ): RaycasterHit[] {
    if (runtime.disposed) throw new MargoError('disposed', 'Engine is disposed; raycast against a live Engine.');
    if (!(this.near >= 0) || !(this.far >= this.near)) throw new RangeError('Expected 0 <= near <= far');
    const store = runtime.store,
      candidates: Candidate[] = [],
      scratch = new Float32Array(16);
    if (refresh) store.tick(false);
    // Cheap bounding-sphere rejection first; liveness, visibility, layers and the filter only run for spheres the ray crosses.
    for (const mesh of meshes) {
      if (runtime.meshes.get(mesh.id) !== mesh) continue;
      const source = meshTriangles(mesh as unknown as Mesh);
      if (source?.kind === 'pbr') {
        if (!this.usable(runtime, mesh, getMeshLayers(mesh as unknown as Mesh), null)) continue;
        if (source.source.primitives.some((p) => p.deformed)) throw deformedError();
        const owner = source.source.model as unknown as ModelLike;
        if (!models.includes(owner))
          for (const primitive of source.source.primitives) {
            const p = primitive as unknown as ModelPrimitiveLike,
              entry = this.entry(store.matrices, mesh.id * 16, primitiveEntry(p).sphere);
            if (entry >= 0)
              candidates.push({
                node: mesh,
                entry,
                model: owner,
                primitive: p,
                index: owner.primitives.indexOf(p),
                ownLayers: true,
              });
          }
      }
      if (!mesh.geometry) continue;
      const entry = this.entry(store.matrices, mesh.id * 16, mesh.geometry.bounds);
      if (entry >= 0 && this.usable(runtime, mesh, getMeshLayers(mesh as unknown as Mesh), null))
        candidates.push({ node: mesh, entry, model: null, primitive: null, index: -1 });
    }
    // ponytail: a linear scan over primitives (~0.1 µs each); add a top-level BVH over parts if assemblies pass ~10k primitives.
    for (const model of models) {
      if (model.disposed) continue;
      const primitives = model.primitives,
        rootMask = layerMasks.get(model.root);
      for (let index = 0; index < primitives.length; index++) {
        const primitive = primitives[index],
          node = primitive.node as unknown as RuntimeMesh,
          instances = primitive.instances;
        if (deformedNode(primitive.node)) {
          if (this.usable(runtime, node, layerMasks.get(node) ?? rootMask ?? 1, model)) throw deformedError();
          continue;
        }
        // Per ray, not per model: a rewritten primitive (new vertex or index array) gets a fresh sphere.
        const sphere = primitiveEntry(primitive).sphere;
        if (instances) {
          // ponytail: a linear scan over instances (one 4x4 product and sphere test each); add a BVH over instances past ~100k.
          if (
            !instances.count ||
            runtime.meshes.get(node.id) !== node ||
            !this.usable(runtime, node, layerMasks.get(node) ?? rootMask ?? 1, model)
          )
            continue;
          const world = store.matrices.subarray(node.id * 16, node.id * 16 + 16);
          for (let k = 0; k < instances.count; k++) {
            const m = multiplyMatrices(world, instances.data.subarray(k * 24, k * 24 + 16), scratch),
              entry = this.entry(m, 0, sphere);
            if (entry >= 0)
              candidates.push({
                node,
                entry,
                model,
                primitive,
                index,
                matrix: m.slice(),
                instance: k,
              });
          }
          continue;
        }
        const entry = this.entry(store.matrices, node.id * 16, sphere);
        if (entry >= 0 && this.usable(runtime, node, layerMasks.get(node) ?? rootMask ?? 1, model))
          candidates.push({ node, entry, model, primitive, index });
      }
    }
    for (const { anchor, sphere, model } of proxies) {
      const node = anchor as unknown as RuntimeMesh,
        owner = isModel(model) ? model : null;
      if (runtime.meshes.get(node.id) !== node) continue;
      const entry = this.entry(store.matrices, node.id * 16, sphere);
      if (entry >= 0 && this.usable(runtime, node, getMeshLayers(anchor), owner))
        candidates.push({ node, entry, model: owner, primitive: null, index: -1, sphere, ownLayers: true });
    }
    if (this.firstHitOnly) candidates.sort((a, b) => a.entry - b.entry);
    const hits: RaycasterHit[] = [],
      inverse = new Float64Array(16),
      matrix = new Float64Array(16),
      local = new Float64Array(3),
      direction = [0, 0, 0],
      ray = { origin: local, direction };
    let best = this.far;
    for (const { node, entry, model, primitive, index, ownLayers, sphere, matrix: world, instance } of candidates) {
      if (this.firstHitOnly && entry > best) break;
      // The filter of a later candidate may have disposed, hidden or re-layered this one.
      if (
        !this.live(runtime, node, model) ||
        !(
          (layerMasks.get(node) ?? (ownLayers || !model ? undefined : layerMasks.get(model.root)) ?? 1) & this.layers
        ) ||
        (primitive && model?.primitives[index] !== primitive)
      )
        continue;
      matrix.set(world ?? store.matrices.subarray(node.id * 16, node.id * 16 + 16));
      if (!invertMatrix(matrix, inverse)) continue;
      const length = localRay(inverse, this.origin, this.direction, local, direction),
        far = this.firstHitOnly ? best : this.far;
      if (sphere) {
        const hit = proxyHit(node as unknown as Mesh, model, sphere, inverse, local, direction, this, far);
        if (!hit) continue;
        if (this.firstHitOnly) {
          best = hit.distance;
          hits.length = 0;
        }
        hits.push(hit);
        continue;
      }
      // Sides follow the local winding, as the renderers do: a mirrored world matrix keeps the mesh's front side.
      const side: Side =
        this.side !== 'material' ? this.side : primitive ? primitiveSide(primitive.material) : meshSide(node.material);
      const bvh = primitive
        ? getPrimitiveBVH(primitive, this.bvhOptions)
        : getGeometryBVH(node.geometry!, this.bvhOptions);
      const options = { near: this.near * length, far: far * length, side };
      const found = this.firstHitOnly ? [bvh.raycastFirst(ray, options)] : bvh.raycast(ray, options);
      for (const hit of found) {
        if (!hit) continue;
        const distance = hit.distance / length;
        if (this.firstHitOnly) {
          if (distance > best) continue;
          best = distance;
          hits.length = 0;
        }
        const result = worldHit(node as unknown as Mesh, hit, matrix, inverse, length);
        if (primitive) {
          result.model = model!;
          result.primitive = primitive;
          result.primitiveIndex = index;
          result.nodeIndex = primitive.nodeIndex;
          result.uv = hitUV(primitive.vertices, hit);
          if (instance !== undefined) result.instanceId = instance;
        }
        hits.push(result);
      }
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }

  private usable(runtime: RuntimeEngine, mesh: RuntimeMesh, mask: number, model: ModelLike | null): boolean {
    return (
      this.live(runtime, mesh, model) &&
      !!(mask & this.layers) &&
      (!this.filter || this.filter(mesh as unknown as Mesh, model ?? undefined))
    );
  }

  private live(runtime: RuntimeEngine, mesh: RuntimeMesh, model: ModelLike | null): boolean {
    return (
      !runtime.disposed &&
      !model?.disposed &&
      runtime.meshes.get(mesh.id) === mesh &&
      !hiddenInHierarchy(runtime.store, mesh.id)
    );
  }

  /** Distance at which the ray enters the local bounding sphere `b` under the world matrix at `m[o]`, or -1 for a miss. */
  private entry(m: Float32Array, o: number, b: ArrayLike<number>): number {
    return sphereEntry(worldSphere(m, o, b, SPHERE), this.origin, this.direction, this.near, this.far);
  }
}

const SPHERE = new Float64Array(4);

/**
 * @internal Conservative world bounding sphere of local sphere `b` (x, y, z, radius) under the world matrix at `m[o]`:
 * the absolute row-sum bound of M^T M also covers hierarchy shear. Written to `out`.
 */
export function worldSphere(m: ArrayLike<number>, o: number, b: ArrayLike<number>, out: Float64Array): Float64Array {
  const xy = Math.abs(m[o] * m[o + 4] + m[o + 1] * m[o + 5] + m[o + 2] * m[o + 6]);
  const xz = Math.abs(m[o] * m[o + 8] + m[o + 1] * m[o + 9] + m[o + 2] * m[o + 10]);
  const yz = Math.abs(m[o + 4] * m[o + 8] + m[o + 5] * m[o + 9] + m[o + 6] * m[o + 10]);
  const scale = Math.sqrt(
    Math.max(
      m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2 + xy + xz,
      m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2 + xy + yz,
      m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2 + xz + yz,
    ),
  );
  out[0] = m[o] * b[0] + m[o + 4] * b[1] + m[o + 8] * b[2] + m[o + 12];
  out[1] = m[o + 1] * b[0] + m[o + 5] * b[1] + m[o + 9] * b[2] + m[o + 13];
  out[2] = m[o + 2] * b[0] + m[o + 6] * b[1] + m[o + 10] * b[2] + m[o + 14];
  out[3] = b[3] * scale * (1 + 1e-5) + 1e-6;
  return out;
}

/** @internal Distance at which a unit-direction ray enters world sphere `s` within [near, far], or -1 for a miss. */
export function sphereEntry(
  s: ArrayLike<number>,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  near: number,
  far: number,
): number {
  const cx = s[0] - origin[0],
    cy = s[1] - origin[1],
    cz = s[2] - origin[2],
    radius = s[3],
    along = cx * direction[0] + cy * direction[1] + cz * direction[2],
    offAxis = cx * cx + cy * cy + cz * cz - along * along;
  if (offAxis > radius * radius) return -1;
  const half = Math.sqrt(radius * radius - Math.max(0, offAxis));
  return along + half < near || along - half > far ? -1 : Math.max(0, along - half);
}

/**
 * @internal Maps a world ray into local space with `inverse`. The local direction is not normalized, so a local
 * parameter t is the world distance; returns its length (local BVH distances divide by it).
 */
export function localRay(
  inverse: Float64Array,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  local: Float64Array | number[],
  localDirection: Float64Array | number[],
): number {
  const dx = direction[0],
    dy = direction[1],
    dz = direction[2];
  transformPoint(inverse, origin[0], origin[1], origin[2], local);
  localDirection[0] = inverse[0] * dx + inverse[4] * dy + inverse[8] * dz;
  localDirection[1] = inverse[1] * dx + inverse[5] * dy + inverse[9] * dz;
  localDirection[2] = inverse[2] * dx + inverse[6] * dy + inverse[10] * dz;
  return Math.hypot(localDirection[0], localDirection[1], localDirection[2]);
}

/**
 * @internal Double-sided hit on a pick proxy's local sphere for the local ray from {@link localRay}; `ray` holds the
 * world origin, unit direction and near distance. Null when the hit is outside [ray.near, far].
 */
export function proxyHit(
  mesh: Mesh,
  model: ModelLike | null,
  sphere: ArrayLike<number>,
  inverse: Float64Array,
  local: ArrayLike<number>,
  direction: ArrayLike<number>,
  ray: { readonly origin: ArrayLike<number>; readonly direction: ArrayLike<number>; readonly near: number },
  far: number,
): RaycasterHit | null {
  const px = local[0] - sphere[0],
    py = local[1] - sphere[1],
    pz = local[2] - sphere[2],
    a = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2,
    b = px * direction[0] + py * direction[1] + pz * direction[2],
    disc = b * b - a * (px * px + py * py + pz * pz - sphere[3] ** 2);
  if (disc < 0) return null;
  const near = (-b - Math.sqrt(disc)) / a,
    t = near >= ray.near ? near : (-b + Math.sqrt(disc)) / a;
  if (t < ray.near || t > far) return null;
  const localPoint: MutableVec3 = [
    local[0] + t * direction[0],
    local[1] + t * direction[1],
    local[2] + t * direction[2],
  ];
  const normal = normalTransform(inverse, [
      localPoint[0] - sphere[0],
      localPoint[1] - sphere[1],
      localPoint[2] - sphere[2],
    ]),
    o = ray.origin,
    d = ray.direction;
  return {
    mesh,
    distance: t,
    point: [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]],
    normal,
    faceNormal: normal.slice() as MutableVec3,
    faceIndex: -1,
    barycoord: [0, 0, 0],
    frontFace: t === near,
    localPoint,
    ...(model ? { model } : {}),
    approximate: true,
  };
}

/** @internal World-space Raycaster hit for a local BVH hit; `length` is the local direction length from localRay. */
export function worldHit(
  mesh: Mesh,
  hit: BVHHit,
  matrix: ArrayLike<number>,
  inverse: Float64Array,
  length: number,
): RaycasterHit {
  const point: MutableVec3 = [0, 0, 0];
  transformPoint(matrix, hit.point[0], hit.point[1], hit.point[2], point);
  return {
    mesh,
    distance: hit.distance / length,
    point,
    normal: normalTransform(inverse, hit.normal),
    faceNormal: normalTransform(inverse, hit.faceNormal),
    faceIndex: hit.faceIndex,
    barycoord: hit.barycoord,
    frontFace: hit.frontFace,
    localPoint: hit.point,
  };
}

/** @internal TEXCOORD_0 (offset 12 of the 20-float PBR vertex) interpolated at a hit. */
export function hitUV(v: Float32Array, hit: BVHHit): [number, number] {
  const a = hit.face[0] * 20 + 12,
    b = hit.face[1] * 20 + 12,
    c = hit.face[2] * 20 + 12,
    [wa, wb, wc] = hit.barycoord;
  return [wa * v[a] + wb * v[b] + wc * v[c], wa * v[a + 1] + wb * v[b + 1] + wc * v[c + 1]];
}

function packPose(source: Float32Array, target: Float32Array): void {
  for (let i = 0, j = 0; i < source.length; i += 20, j += 6) {
    target[j] = source[i];
    target[j + 1] = source[i + 1];
    target[j + 2] = source[i + 2];
    target[j + 3] = source[i + 4];
    target[j + 4] = source[i + 5];
    target[j + 5] = source[i + 6];
  }
}

/** @internal True when a registered PBR source on `node` has an active GPU deformation (skin or morph). */
export function deformedNode(node: Mesh): boolean {
  const source = meshTriangles(node);
  return source?.kind === 'pbr' && source.source.primitives.some((p) => p.deformed);
}
/** @internal Synchronous queries never test a deformed mesh's bind pose. */
export const deformedError = (): MargoError =>
  new MargoError(
    'unsupported',
    'Deformed PBR mesh cannot be picked synchronously; use await Raycaster.intersectModel(model) for its current pose.',
  );

/** @internal True for a projection or view-projection matrix without perspective (last row 0, 0, 0, w). */
export const isOrthographic = (m: ArrayLike<number>): boolean => !m[3] && !m[7] && !m[11];

/**
 * @internal Sets `ray` through normalized device coordinates (x, y) of a camera whose inverted view-projection is
 * `inverse`: from the eye `position`, or from the near-plane point for an orthographic camera (parallel rays).
 * `webgpu` selects reversed-Z clip depth (near 1, far 0) instead of WebGL's -1..1. Shared by setFromCamera and
 * RaycastProjection.setFromCanvas, so live and captured rays use the same arithmetic.
 */
export function cameraRay<T extends Raycaster>(
  ray: T,
  inverse: Float64Array,
  orthographic: boolean,
  position: ArrayLike<number>,
  x: number,
  y: number,
  webgpu: boolean,
): T {
  const near = unproject(inverse, x, y, webgpu ? 1 : -1),
    far = unproject(inverse, x, y, webgpu ? 0 : 1);
  return ray.set(orthographic ? near : position, [far[0] - near[0], far[1] - near[1], far[2] - near[2]]);
}

/** @internal Shared hierarchy visibility predicate for live and captured queries. */
export function hiddenInHierarchy(store: RuntimeStore, id: number): boolean {
  for (let node = id, depth = 0; node >= 0 && depth <= 64; node = store.parents[node], depth++)
    if (store.hidden[node]) return true;
  return false;
}

function unproject(inverse: Float64Array, x: number, y: number, z: number): MutableVec3 {
  const w = inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15];
  return [
    (inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12]) / w,
    (inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13]) / w,
    (inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14]) / w,
  ];
}

/** Inverse-transpose of the upper 3x3 applied to a normal, normalized. */
function normalTransform(inverse: Float64Array, n: Vec3): MutableVec3 {
  const x = inverse[0] * n[0] + inverse[1] * n[1] + inverse[2] * n[2],
    y = inverse[4] * n[0] + inverse[5] * n[1] + inverse[6] * n[2],
    z = inverse[8] * n[0] + inverse[9] * n[1] + inverse[10] * n[2];
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
}
