// Layer filtering for captures, without a dependency on @margoengine/cameras: masks come from the registry that
// @margoengine/cameras/layers keeps on globalThis (same key and shape as packages/cameras/src/layers.ts). Without that
// module every mesh is on layer 0 (mask 1).
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';

interface LayerRegistry {
  source: unknown;
  used: boolean;
  depth: number;
  maskOf(mesh: Mesh): number;
}
const KEY = Symbol.for('margoengine.layers');

/** @internal Checks a 32-bit layer mask; `subject` names the option in the message. */
export function layerMask(mask: number, subject: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)
    throw new RangeError(`${subject} ${mask} is not a 32-bit layer mask; pass an integer from 0 to 0xffffffff`);
  return mask >>> 0;
}

/**
 * @internal Runs `run` with the meshes outside `mask` and the `exclude` meshes hidden, then shows them again. Inside,
 * @margoengine/cameras' CameraLayers leaves the primary camera's mask off.
 */
export function withCaptureLayers(
  engine: EngineKernel,
  mask: number,
  exclude: Iterable<Mesh> | undefined,
  run: () => void,
): void {
  const runtime = engineRuntime(engine),
    registry = (globalThis as Record<symbol, LayerRegistry | undefined>)[KEY],
    hidden: Mesh[] = [];
  // Every mesh is on layer 0 until a mask is set or a source installed.
  if (mask !== 0xffffffff && (registry?.used || registry?.source || !(mask & 1)))
    for (const mesh of runtime.meshes.values())
      if (!runtime.store.hidden[mesh.id] && !((registry ? registry.maskOf(mesh) : 1) & mask)) {
        mesh.visible = false;
        hidden.push(mesh);
      }
  if (exclude)
    for (const mesh of exclude) {
      const id = meshRuntime(mesh).id;
      if (runtime.meshes.get(id) === meshRuntime(mesh) && !runtime.store.hidden[id]) {
        mesh.visible = false;
        hidden.push(mesh);
      }
    }
  if (registry) registry.depth++;
  try {
    run();
  } finally {
    if (registry) registry.depth--;
    if (!runtime.disposed)
      for (const mesh of hidden)
        if (runtime.meshes.get(meshRuntime(mesh).id) === meshRuntime(mesh)) mesh.visible = true;
  }
}
