/// <reference lib="esnext.disposable" preserve="true" />
import { Camera, type EngineKernel, type Mesh, type Scene } from '@margoengine/core';
import { engineRuntime, meshRuntime, type RenderView, type Scene as RuntimeScene } from '@margoengine/core/extension';
import type { ModelLike } from '@margoengine/bvh';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError } from '../../shared/errors.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { ownLayers } from '../../shared/view-rect.js';
import { isModel } from '../../shared/model.js';
import type { Picking, PickHit } from './picking.js';

/** A world-space contact on an actual triangle, including nonuniformly scaled geometry. */
export interface SpatialContact extends PickHit {
  position: readonly [number, number, number];
  distance: number;
  faceIndex: number;
}
/** The scene and layer mask used by both ray and proximity selection. */
export interface SpatialPickingOptions {
  /** Default engine.scene. */
  scene?: Scene;
  /** Default every render layer. */
  layers?: number;
}
const finite = (v: ArrayLike<number>) => v.length === 3 && [v[0], v[1], v[2]].every(Number.isFinite);

/** GPU rays through Picking, and exact world-triangle sphere contacts for XR grab/touch pointers. */
export class SpatialPicking {
  private disposed = false;
  /** Creates a helper around a caller-owned picker; neither object is registered or disposed for the other. */
  static attach(engine: EngineKernel, picking: Picking, options: SpatialPickingOptions = {}): SpatialPicking {
    return new SpatialPicking(engine, picking, options);
  }
  /** The supplied Picking remains caller-owned. Both helpers must use the same engine. */
  constructor(
    private readonly engine: EngineKernel,
    private readonly picking: Picking,
    readonly options: SpatialPickingOptions = {},
  ) {}
  /** Cast along a normalized or unnormalized world direction. Default range 0.0001 to 1000 metres. */
  async ray(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    near = 0.0001,
    far = 1000,
    signal?: AbortSignal,
  ): Promise<PickHit | null> {
    this.ready();
    signal?.throwIfAborted();
    if (
      !finite(origin) ||
      !finite(direction) ||
      !(Math.hypot(...Array.from(direction)) > 0) ||
      !Number.isFinite(near) ||
      !Number.isFinite(far) ||
      !(near > 0 && far > near)
    )
      throw rangeError(
        'Spatial ray needs finite xyz, a nonzero direction and 0 < near < far; pass valid world coordinates',
        'arguments',
      );
    const n = Math.hypot(direction[0], direction[1], direction[2]);
    // Each pending pick owns its camera: engine.pick serializes asynchronous GPU readbacks.
    const camera = new Camera({
      position: [origin[0], origin[1], origin[2]],
      target: [origin[0] + direction[0] / n, origin[1] + direction[1] / n, origin[2] + direction[2] / n],
      near,
      far,
    });
    camera.up = Math.abs(direction[1] / n) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const runtime = engineRuntime(this.engine),
      canvas = runtime.canvas;
    const owner = runtime.sceneOf(this.picking);
    if (owner && owner !== (this.options.scene ?? runtime.scene))
      throw fault('attached', 'Spatial ray picker belongs to another scene; attach Picking to the selected scene', 'arguments');
    const view: RenderView = { camera, viewport: [0, 0, 1, 1], scene: this.options.scene as RuntimeScene | undefined, layers: this.options.layers };
    const hit = await abortable(this.picking.pick(canvas.clientWidth / 2, canvas.clientHeight / 2, view), signal);
    return this.disposed || runtime.disposed ? null : hit;
  }
  /** Nearest triangle at or inside radius metres. A sphere tests surfaces on either side, independent of camera clipping. */
  async sphere(center: ArrayLike<number>, radius: number, signal?: AbortSignal): Promise<SpatialContact | null> {
    this.ready();
    signal?.throwIfAborted();
    if (!finite(center) || !Number.isFinite(radius) || radius < 0)
      throw rangeError(
        'Spatial sphere needs finite xyz and a nonnegative radius in metres; pass valid world coordinates',
        'arguments',
      );
    const point = [center[0], center[1], center[2]];
    const { MeshBVH, worldTriangles } = await import('@margoengine/bvh');
    this.ready();
    signal?.throwIfAborted();
    const runtime = engineRuntime(this.engine);
    const scene = (this.options.scene ?? runtime.scene) as RuntimeScene,
      mask = this.options.layers ?? 0xffffffff;
    runtime.store.tick(false);
    const live = (mesh: Mesh, model?: ModelLike) => {
      const actual = meshRuntime(mesh);
      return (
        scene.meshes.get(actual.id) === actual &&
        !hiddenInTree(runtime.store, actual.id) &&
        ((ownLayers(mesh) ?? (model && ownLayers(model.root)) ?? 1) & mask) !== 0
      );
    };
    let best: SpatialContact | null = null;
    const test = (
      mesh: Mesh,
      vertices: ArrayLike<number>,
      indices: ArrayLike<number>,
      extra: Partial<PickHit> = {},
    ) => {
      if (!live(mesh, extra.model) || !indices.length) return;
      const bvh = MeshBVH.build({ positions: vertices, indices, precision: 'float64' });
      const contact = bvh.closestPointToPoint(point, { maxDistance: best?.distance ?? radius });
      if (contact && (!best || contact.distance < best.distance))
        best = {
          mesh: meshRuntime(mesh),
          ...extra,
          position: contact.point,
          distance: contact.distance,
          faceIndex: contact.faceIndex,
        };
    };
    const models = [...scene.plugins.values()].filter(isModel) as unknown as ModelLike[];
    const nodes = new Set(models.flatMap((model) => model.primitives.map((p) => p.node)));
    for (const mesh of scene.meshes.values()) {
      if (!live(mesh) || nodes.has(mesh) || !mesh.geometry) continue;
      const data = worldTriangles(this.engine, [mesh], { refresh: false });
      test(mesh, data.vertices, data.indices);
    }
    for (const model of models) {
      const source = model as ModelLike & {
        readPickingGeometry?(): Promise<
          readonly {
            primitiveIndex?: number;
            vertices: Float32Array;
            indices: Uint32Array;
            matrix: Float32Array;
          }[]
        >;
      };
      const deformed = model.primitives.some((p) => p.deformed);
      const snapshots = deformed
        ? await abortable(source.readPickingGeometry?.() ?? Promise.resolve(undefined), signal)
        : undefined;
      signal?.throwIfAborted();
      if (this.disposed || runtime.disposed) return null;
      if (model.disposed) continue;
      if (deformed && !snapshots)
        throw fault('unsupported', 'Deformed proximity selection needs model.readPickingGeometry');
      for (const [primitiveIndex, primitive] of model.primitives.entries()) {
        if (!live(primitive.node, model)) continue;
        const snapshot = snapshots?.find((p) => p.primitiveIndex === primitiveIndex);
        if (primitive.deformed && !snapshot) continue;
        const vertices = snapshot?.vertices ?? primitive.vertices,
          indices = snapshot?.indices ?? primitive.indices;
        const base = snapshot?.matrix ?? primitive.node.matrix;
        const instances = primitive.instances;
        for (let instance = 0; instance < (instances?.count ?? 1); instance++) {
          const matrix = instances
            ? multiplyMatrices(base, instances.data.subarray(instance * 24, instance * 24 + 16), new Float32Array(16))
            : base;
          const world = new Float64Array((vertices.length / 20) * 3);
          for (let i = 0, j = 0; i < vertices.length; i += 20, j += 3) {
            const x = vertices[i],
              y = vertices[i + 1],
              z = vertices[i + 2];
            world[j] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
            world[j + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
            world[j + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
          }
          test(primitive.node, world, indices, {
            model,
            primitive,
            primitiveIndex,
            ...(instances ? { instanceId: instance } : {}),
          });
        }
      }
    }
    const result = best as SpatialContact | null;
    return result && live(result.mesh, result.model) ? result : null;
  }
  /** Ends this query helper; never disposes the supplied picker or meshes. */
  dispose(): void {
    this.disposed = true;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  private ready(): void {
    if (this.disposed || this.engine.disposed)
      throw fault('disposed', 'SpatialPicking is disposed; create a new helper');
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
