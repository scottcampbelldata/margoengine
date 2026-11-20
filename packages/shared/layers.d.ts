/** The render-layer registry on `globalThis` that core, @margoengine/cameras and @margoengine/environment read. */
export interface LayerRegistry {
  readonly masks: WeakMap<object, number>;
  readonly cameras: WeakMap<object, number>;
  source: ((mesh: never) => number) | null;
  used: boolean;
  maskOf(mesh: object): number;
}
/** The registry, created on first use. */
export function renderLayers(): LayerRegistry;
/** Sets the layer mask of `mesh` (32-bit, default 1). @throws RangeError for a mask outside 0..0xffffffff. */
export function setRenderLayers(mesh: object, mask: number): void;
/** Layer of VRM `firstPersonOnly` meshes: 29. */
export const FIRST_PERSON_ONLY_LAYER: 29;
/** Layer of VRM `thirdPersonOnly` meshes: 30. */
export const THIRD_PERSON_ONLY_LAYER: 30;
