import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';

/**
 * World matrix (column-major, 16 floats, a live view: copy it to keep it) of a core mesh after the latest transform
 * tick, or null when the mesh was removed, its engine is disposed, or it or any ancestor is hidden. Overlays that
 * follow meshes (lines, points, text) read it once per frame; it allocates nothing.
 */
export function meshWorldMatrix(engine: EngineKernel, mesh: Mesh): Float32Array | null {
  const runtime = engineRuntime(engine),
    object = meshRuntime(mesh),
    id = object.id;
  if (runtime.disposed || runtime.meshes.get(id) !== (mesh as unknown)) return null;
  for (
    let current = id, depth = 0;
    current >= 0 && depth < 64;
    current = runtime.store.parents?.[current] ?? -1, depth++
  )
    if (runtime.store.hidden[current]) return null;
  return object.matrix ?? runtime.store.matrices.subarray(id * 16, id * 16 + 16);
}
