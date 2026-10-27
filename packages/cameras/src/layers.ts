// Render layers: a 32-bit mask per mesh (default 1, layer 0) and per camera or engine view; a view draws a mesh when
// the two masks share a bit. Core reads the masks from one registry on `globalThis` (every copy of this module shares
// it, and @margoengine/environment's captures read it too), so engine views filter without hiding meshes.
import type { EngineKernel, Mesh } from '@margoengine/core';
import type { Camera } from '@margoengine/core/extension';
import { checkLayers, withHidden } from '../../shared/view-rect.js';
import { renderLayers, setRenderLayers as setLayers } from '../../shared/layers.js';

/** Every layer: the mask that filters nothing. */
export const ALL_LAYERS = 0xffffffff;

// Read by core (`maskOf`, `cameras`, `source`) and @margoengine/environment (`maskOf`); created in shared/layers.js,
// which the React bindings' `<Mesh layers>` use too.
const registry = renderLayers() as unknown as LayerRegistry;
interface LayerRegistry {
  readonly masks: WeakMap<object, number>;
  readonly cameras: WeakMap<object, number>;
  source: ((mesh: Mesh) => number) | null;
  used: boolean;
  maskOf(mesh: Mesh): number;
}

/** Mask with the given layers (0-31) enabled: `layerMask(0, 2)` is 0b101. */
export function layerMask(...layers: number[]): number {
  let mask = 0;
  for (const layer of layers) {
    if (!Number.isInteger(layer) || layer < 0 || layer > 31)
      throw new RangeError(`Layer ${layer} is outside 0..31; pass a layer index from 0 to 31`);
    mask |= 1 << layer;
  }
  return mask >>> 0;
}

/**
 * Sets the layer mask of `mesh` (32-bit, default 1 = layer 0), the one mask drawing and @margoengine/bvh raycasts read.
 * For drawing, its descendants without a mask of their own follow it, so `setRenderLayers(model.root, mask)` layers a
 * whole model; a Raycaster tests a mesh's own mask (a model primitive: its node's, else `model.root`'s).
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function setRenderLayers(mesh: Mesh, mask: number): void {
  setLayers(mesh, mask);
}
/** Render layer mask of `mesh`: its own, else its nearest ancestor's, else 1; or the `useLayerSource` reader's value. */
export function getRenderLayers(mesh: Mesh): number {
  return registry.maskOf(mesh);
}
/**
 * Reads every mesh mask for drawing through `source` instead of `setRenderLayers`, or restores the default with null.
 * @throws TypeError when `source` is neither a function nor null.
 */
export function useLayerSource(source: ((mesh: Mesh) => number) | null): void {
  if (source !== null && typeof source !== 'function')
    throw new TypeError('Layer source must be a function (mesh) => mask or null; pass such a function or null');
  registry.source = source;
}
/**
 * Sets the layer mask a camera draws (default every layer): the engine draws its frame, `render({camera})` and every
 * view through that camera with it, unless a view sets its own `layers`.
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function setCameraLayers(camera: Camera, mask: number): void {
  registry.cameras.set(camera, checkLayers(mask, 'Camera layer mask'));
}
/** Layer mask `camera` draws: the one set with `setCameraLayers`, else every layer. */
export function getCameraLayers(camera: Camera): number {
  return registry.cameras.get(camera) ?? ALL_LAYERS;
}

/**
 * Runs `run` with only the meshes in `mask` (and not in `exclude`) visible, then makes the hidden ones visible again,
 * also when `run` throws: for a capture that also leaves out given meshes (a mirror leaving out itself). To filter
 * what a view draws by layers alone, give the view `layers` or its camera `setCameraLayers` instead; that hides
 * nothing. A hidden parent hides its children.
 * @throws RangeError for a mask that is not an integer from 0 to 0xffffffff.
 */
export function withLayers<T>(engine: EngineKernel, mask: number, run: () => T, exclude?: Iterable<Mesh>): T {
  return withHidden(engine, checkLayers(mask, 'Layer mask'), exclude, run);
}
