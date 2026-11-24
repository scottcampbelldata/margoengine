// COLLADA of a GLB's bytes: the GLB read into a scene (PNG and JPEG images kept), then written by exportDAE. Its own entry, so
// `@margoengine/exporters/dae` stays the serializer alone and only code that writes from a GLB loads the GLB reader.
import { exportDAE, type DAEOptions, type DAEResult } from './dae.js';
import { sceneOfGLB, type GLBSceneSkip } from './glb-scene.js';

export type { DAEOptions, DAEResult } from './dae.js';
export type { GLBSceneSkip } from './glb-scene.js';

/** The result of {@link exportDAEOfGLB}: the document and its images, and what the GLB held that the scene reader left out. */
export interface DAEOfGLBResult extends DAEResult {
  skipped: GLBSceneSkip[];
}

/**
 * `exportDAE` of a GLB's bytes, PNG and JPEG textures included. This is the route for a loaded, textured model, whose live
 * engine form `exportDAE` refuses: `exportModel(model, { binary: true })` then this. A primitive that is not triangles or
 * lines, a texture not PNG or JPEG and vertex colours under a base colour texture are named in `skipped`.
 *
 * @example
 * ```ts
 * import { exportDAEOfGLB } from '@margoengine/exporters/dae-glb';
 * import { exportModel } from '@margoengine/exporters/model';
 *
 * declare const model: Parameters<typeof exportModel>[0];
 * const { dae, textures, skipped } = exportDAEOfGLB(await exportModel(model, { binary: true }));
 * ```
 * @throws TypeError for bytes that are not a GLB, or one that needs Draco or meshopt decoded first; what `exportDAE` throws.
 */
export function exportDAEOfGLB(glb: Uint8Array, options: DAEOptions = {}): DAEOfGLBResult {
  if (!(glb instanceof Uint8Array))
    throw new TypeError('exportDAEOfGLB takes GLB bytes; pass exportModel(model, { binary: true }) or a .glb file');
  const { scene, skipped } = sceneOfGLB(glb);
  return { ...exportDAE(scene, options), skipped };
}
