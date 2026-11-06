import { Engine, type EngineKernel, type EngineOptions } from '@margoengine/core';

/** Everything `Engine.create` takes except `fallback`, plus `loadCompat`. */
export interface AutoEngineOptions extends Omit<EngineOptions, 'fallback'> {
  /**
   * Loads the WebGL2 compatibility layer, for when a package refuses the preview during `setup`: pass the dynamic import
   * of the layer's root entry. The app names the layer, so nothing here costs a page that does not, and a bundler splits
   * it into a chunk only this path fetches. Default none: the refusal rejects `autoEngine`.
   */
  loadCompat?: () => Promise<{ install(): Promise<unknown> }>;
}

const hasWebGPU = async () => {
  const { gpu } = globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } };
  return !!gpu && (await gpu.requestAdapter().catch(() => null)) != null;
};

const run = async (engine: EngineKernel, setup: (engine: EngineKernel) => void | Promise<void>) => {
  try {
    await setup(engine);
    return engine;
  } catch (error) {
    engine.dispose();
    throw error;
  }
};

/**
 * Makes an engine on the best path the page's own packages can draw on: WebGPU when the browser has it, else the small
 * WebGL2 preview, else, when a package in `setup` refuses the preview, the WebGL2 compatibility layer from `loadCompat`.
 * Neither WebGL2 package is downloaded unless it is used. `setup` builds the scene and may run twice, so it must start from nothing
 * and take the engine it is given.
 *
 * The layer cannot draw to a canvas that already holds the preview's context, so escalating replaces `canvas` in the
 * page with a copy of the element: read `engine.canvas` afterwards, and add listeners to it, not to the old element.
 * Only refusals during `setup` escalate. A package added later refuses as usual.
 * @throws What `Engine.create` and `setup` throw, with the engine disposed; MargoError `'unsupported'` from the layer's
 * `install` when the browser's WebGL2 is below what the layer needs.
 */
export const autoEngine = async (
  canvas: HTMLCanvasElement,
  setup: (engine: EngineKernel) => void | Promise<void>,
  { loadCompat, ...options }: AutoEngineOptions = {},
): Promise<EngineKernel> => {
  const preview = options.backend === 'webgl2' || (options.backend !== 'webgpu' && !(await hasWebGPU())),
    fallback = preview ? (await import('./index.js')).webglRenderer : undefined;
  let backend: string | undefined;
  try {
    const engine = await Engine.create(canvas, { ...options, fallback });
    backend = engine.backend;
    return await run(engine, setup);
  } catch (error) {
    if (!loadCompat || backend !== 'webgl2' || (error as { code?: string }).code !== 'unsupported') throw error;
  }
  options.signal?.throwIfAborted();
  await (await loadCompat()).install();
  const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
  canvas.replaceWith(fresh);
  return run(await Engine.create(fresh, { ...options, backend: 'webgpu' }), setup);
};
