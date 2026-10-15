import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Engine as RuntimeEngine, Mesh as RuntimeMesh, GeometryBuffers } from '@margoengine/core/extension';
import type { Model } from '@margoengine/gltf';
import type { CADModel } from '@margoengine/machinery';

export interface LoadedModel extends Pick<Mesh, 'position' | 'rotation' | 'scale'> {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  visible: boolean;
  readonly bounds: Float32Array;
  readonly raw: readonly GeometryBuffers[] | null;
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
  // shortcut: bounds scan vertices on access, cache local bounds if queried every frame.
  for (const handle of meshes) {
    const mesh = handle as unknown as RuntimeMesh;
    mesh.check();
    if (mesh.engine !== engine) throw new TypeError('Foreign mesh');
    if (!mesh.geometry || (visibleOnly && !engine.store.visible[mesh.id])) continue;
    const vertices = mesh.geometry.vertices,
      m = mesh.matrix;
    for (let offset = 0; offset < vertices.length; offset += 6) {
      const x = vertices[offset],
        y = vertices[offset + 1],
        z = vertices[offset + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = m[axis] * x + m[4 + axis] * y + m[8 + axis] * z + m[12 + axis];
        output[axis] = Math.min(output[axis], value);
        output[axis + 3] = Math.max(output[axis + 3], value);
      }
    }
  }
  if (!Number.isFinite(output[0])) throw new Error('No geometry');
  return output;
}

export function loadedModel(engine: EngineKernel, model: Model | CADModel): LoadedModel {
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
      const buffers = new Set<GeometryBuffers>();
      for (const mesh of model.meshes) {
        mesh.check();
        if (mesh.geometry) buffers.add((engine as unknown as RuntimeEngine).geometryBuffers(mesh.geometry)!);
      }
      return [...buffers];
    },
    destroy() {
      model.dispose();
    },
  };
}
