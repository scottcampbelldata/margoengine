import type { EngineKernel, Geometry, Mesh } from '@margoengine/core';
import { margoError } from '../../shared/errors.js';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type GeometryBuffers,
  type Mesh as RuntimeMesh,
} from '@margoengine/core/extension';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';

/** Options of scene queries: whether hidden meshes are excluded (default true). */
export interface SceneQueryOptions {
  /** Exclude meshes hidden by themselves or any ancestor. Defaults to true; ignores frustum culling. */
  visibleOnly?: boolean;
}
/** Options of fitting the camera to a scene: query options plus aspect ratio, duration and padding. */
export interface SceneFitOptions extends SceneQueryOptions {
  /** Defaults to the canvas's displayed aspect ratio. */
  aspect?: number;
  duration?: number;
  padding?: number;
}
interface SceneBufferBase extends Pick<GeometryBuffers, 'vertex' | 'index'> {
  readonly node: Mesh;
  /** Borrowed world matrix, updated with the owning mesh. */
  readonly matrix: Float32Array;
  /** Number of indices, not instances. */
  readonly count: number;
  readonly indexFormat: 'uint32';
}
/** The GPU buffers of a core mesh node, for custom passes. */
export interface CoreSceneBuffers extends SceneBufferBase {
  readonly kind: 'core';
  readonly stride: 24;
  readonly geometry: Geometry;
  /** Shared batch storage from the last render; does not identify this node's instance offset. */
  readonly instance: GeometryBuffers['instance'];
}
/** The GPU buffers of a PBR model node, with its alpha texture and cutoff, for custom passes. */
export interface PBRSceneBuffers extends SceneBufferBase {
  readonly kind: 'pbr';
  readonly stride: 80;
  readonly primitive?: object;
  readonly alphaTexture?: GPUTextureView;
  readonly alphaSampler?: GPUSampler;
  readonly alpha?: number;
  readonly cutoff?: number;
  readonly texCoord?: 0 | 1;
  readonly alphaTransform?: Float32Array;
  readonly doubleSided?: boolean;
}
/** The GPU buffers of a scene node: a core mesh's or a PBR model's. */
export type SceneBuffers = CoreSceneBuffers | PBRSceneBuffers;

/** Validate all selected roots before touching transforms, camera state or GPU resources. */
function selectedMeshes(
  instance: EngineKernel,
  roots: Iterable<Mesh>,
  { visibleOnly = true }: SceneQueryOptions,
): { engine: Engine; meshes: RuntimeMesh[] } {
  if (instance.disposed) throw margoError('disposed', 'Engine disposed; create a new engine');
  if (typeof visibleOnly !== 'boolean') throw new TypeError('Invalid visibleOnly; pass true or false');
  const engine = engineRuntime(instance),
    selected = new Set<number>();
  for (const handle of Array.from(roots)) {
    handle.check();
    const mesh = meshRuntime(handle);
    if (mesh.engine !== engine) throw new TypeError('Foreign mesh; pass meshes created by the same engine');
    selected.add(mesh.id);
  }
  engine.store.tick(false);
  const meshes: RuntimeMesh[] = [];
  for (const mesh of engine.meshes.values()) {
    let included = false,
      depth = 0;
    for (let id = mesh.id; id !== -1; id = engine.store.parents[id]) {
      if (++depth > 64) throw new RangeError('Parent depth: 64; flatten the mesh hierarchy');
      if (selected.has(id)) included = true;
    }
    if (included && (!visibleOnly || !hiddenInTree(engine.store, mesh.id))) meshes.push(mesh);
  }
  return { engine, meshes };
}

/**
 * World bounds of selected meshes and their descendants. PBR positions are the
 * CPU bind pose under current node transforms; this never reads back GPU deformation.
 */
export function getSceneBounds(
  instance: EngineKernel,
  roots: Iterable<Mesh>,
  options: SceneQueryOptions = {},
): Float32Array {
  const { meshes } = selectedMeshes(instance, roots, options);
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const include = (vertices: Float32Array, stride: number, matrix: Float32Array): void => {
    for (let offset = 0; offset < vertices.length; offset += stride) {
      const x = vertices[offset],
        y = vertices[offset + 1],
        z = vertices[offset + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12];
        if (!Number.isFinite(Math.fround(value))) throw new RangeError('Scene positions must be finite');
        bounds[axis] = Math.min(bounds[axis], value);
        bounds[axis + 3] = Math.max(bounds[axis + 3], value);
      }
    }
  };
  for (const mesh of meshes) {
    const triangles = meshTriangles(mesh);
    if (triangles?.kind === 'core') include(triangles.geometry.vertices, 6, mesh.matrix);
    else if (triangles?.kind === 'pbr')
      for (const primitive of triangles.source.primitives) include(primitive.vertices, 20, mesh.matrix);
  }
  if (!Number.isFinite(bounds[0]))
    throw margoError('state', 'No geometry; select meshes with triangles');
  return Float32Array.from(bounds);
}

/** Fit the existing camera to mixed core/PBR roots; returns the bounds used. */
export function fitScene(instance: EngineKernel, roots: Iterable<Mesh>, options: SceneFitOptions = {}): Float32Array {
  const bounds = getSceneBounds(instance, roots, options),
    canvas = instance.canvas;
  const aspect =
    options.aspect ??
    Math.max(1, canvas.clientWidth || canvas.width) / Math.max(1, canvas.clientHeight || canvas.height);
  instance.camera.fitToBoundingBox([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]], {
    aspect,
    duration: options.duration,
    padding: options.padding,
  });
  return bounds;
}

/**
 * Borrow existing GPU records, one per core node or PBR primitive. Requery after
 * animation or device restoration; this does not encode deformation or own any
 * buffer. Hidden roots are filtered by default. WebGL2 returns null.
 */
export function gatherSceneBuffers(
  instance: EngineKernel,
  roots: Iterable<Mesh>,
  options: SceneQueryOptions = {},
): SceneBuffers[] | null {
  const { engine, meshes } = selectedMeshes(instance, roots, options);
  if (instance.backend !== 'webgpu') return null;
  const records: SceneBuffers[] = [];
  for (const mesh of meshes) {
    const triangles = meshTriangles(mesh);
    if (triangles?.kind === 'core') {
      const buffers = engine.geometryBuffers(triangles.geometry);
      if (!buffers) throw margoError('state', 'Geometry unavailable; render one frame first');
      records.push({
        kind: 'core',
        node: mesh,
        matrix: mesh.matrix,
        geometry: triangles.geometry,
        vertex: buffers.vertex,
        index: buffers.index,
        instance: buffers.instance,
        count: triangles.geometry.indices.length,
        stride: 24,
        indexFormat: 'uint32',
      });
    } else if (triangles?.kind === 'pbr') {
      const draws = triangles.source.draws;
      if (triangles.source.primitives.length && !draws.length)
        throw margoError('state', 'PBR geometry unavailable; render one frame first');
      for (const draw of draws)
        records.push({ ...draw, kind: 'pbr', matrix: mesh.matrix, stride: 80, indexFormat: 'uint32' });
    }
  }
  return records;
}
