import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine as RuntimeEngine, Mesh as RuntimeMesh, GeometryBuffers } from '@margoengine/core/extension';
import { meshTriangles } from '../../shared/mesh-source.js';

/** Root, meshes, and dispose. `loadedModel` reads only these fields. */
export interface StageModel {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

type RawBuffers = Omit<GeometryBuffers, 'instance'> & Partial<Pick<GeometryBuffers, 'instance'>>;

export interface LoadedModel extends Pick<Mesh, 'position' | 'rotation' | 'scale'> {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  visible: boolean;
  readonly bounds: Float32Array;
  readonly raw: readonly RawBuffers[] | null;
  destroy(): void;
}

export function worldBounds(
  instance: EngineKernel,
  meshes: Iterable<Mesh>,
  output: Float32Array,
  visibleOnly = false,
): Float32Array {
  const engine = instance as unknown as RuntimeEngine;
  if (engine.disposed) throw new Error('Engine disposed');
  engine.store.tick(false);
  output.fill(Infinity, 0, 3);
  output.fill(-Infinity, 3);
  // PBR positions are the CPU bind pose; reading bounds never encodes deformation.
  const include = (vertices: Float32Array, stride: number, m: Float32Array): void => {
    for (let offset = 0; offset < vertices.length; offset += stride) {
      const x = vertices[offset],
        y = vertices[offset + 1],
        z = vertices[offset + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = m[axis] * x + m[4 + axis] * y + m[8 + axis] * z + m[12 + axis];
        output[axis] = Math.min(output[axis], value);
        output[axis + 3] = Math.max(output[axis + 3], value);
      }
    }
  };
  for (const handle of meshes) {
    const mesh = handle as unknown as RuntimeMesh;
    mesh.check();
    if (mesh.engine !== engine) throw new TypeError('Foreign mesh');
    if (visibleOnly && !engine.store.visible[mesh.id]) continue;
    const triangles = meshTriangles(handle);
    if (triangles?.kind === 'core') include(triangles.geometry.vertices, 6, mesh.matrix);
    else if (triangles?.kind === 'pbr')
      for (const primitive of triangles.source.primitives) include(primitive.vertices, 20, primitive.node.matrix);
  }
  if (!Number.isFinite(output[0])) throw new Error('No geometry');
  return output;
}

export function loadedModel(engine: EngineKernel, model: StageModel): LoadedModel {
  const bounds = new Float32Array(6);
  return {
    root: model.root,
    meshes: model.meshes,
    position: model.root.position,
    rotation: model.root.rotation,
    scale: model.root.scale,
    get visible() {
      return model.root.visible;
    },
    set visible(value: boolean) {
      model.root.visible = value;
    },
    get bounds() {
      model.root.check();
      return worldBounds(engine, model.meshes, bounds);
    },
    get raw() {
      model.root.check();
      if (engine.backend !== 'webgpu') return null;
      const runtime = engine as unknown as RuntimeEngine;
      const buffers = new Set<GeometryBuffers>(),
        draws: RawBuffers[] = [],
        seen = new Set<Mesh>();
      for (const mesh of model.meshes) {
        mesh.check();
        if ((mesh as unknown as RuntimeMesh).engine !== runtime) throw new TypeError('Foreign mesh');
        if (seen.has(mesh)) continue;
        seen.add(mesh);
        const triangles = meshTriangles(mesh);
        if (triangles?.kind === 'core') buffers.add(runtime.geometryBuffers(triangles.geometry)!);
        else if (triangles?.kind === 'pbr') for (const draw of triangles.source.draws) draws.push(draw);
      }
      return [...buffers, ...draws];
    },
    destroy() {
      model.dispose();
    },
  };
}
