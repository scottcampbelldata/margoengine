// Native WebGPU at compatibility level, for devices without the full feature level: written from the WebGPU specification
// (GPURequestAdapterOptions.featureLevel, the core-features-and-limits feature). Core asks `navigator.gpu` for its adapter
// at creation and on device restore, so answering there covers both, the same way the root entry's `install` does.
import { fault } from '../../shared/errors.js';

/** Options of {@link allowCompatibilityAdapters}. */
export interface CompatibilityAdapterOptions {
  /**
   * Ask for compatibility level first, even where the full level exists. A device then has the validation of an older
   * GPU, with this GPU's limits, so this tries a scene against the level on any machine. Default false.
   */
  force?: boolean;
}

/** Undoes {@link allowCompatibilityAdapters}. */
export interface CompatibilityAdapters {
  /** Puts back the browser's `requestAdapter`. Adapters and devices already made keep working. */
  dispose(): void;
  [Symbol.dispose](): void;
}

let active: CompatibilityAdapters | undefined;

/**
 * Gives a compatibility adapter's devices what Margo's code expects of a device. A device starts at the level's low
 * defaults (workgroups of 128, 4 colour attachments) whatever the adapter can do, and core and the packages ask for no
 * limits, so it takes all the adapter has. WGSL's plain `@interpolate(flat)` means `first`, which the level refuses, while
 * `either` is the same value for everything Margo passes flat, one per primitive. Core's pick and two dozen packages
 * write it, so it is answered here, the one place all their shaders pass through. A device that asked for
 * `core-features-and-limits` is at the full level and keeps its shaders.
 */
const prepare = (adapter: GPUAdapter | null): GPUAdapter | null => {
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice,
    limits: Record<string, number> = {};
  for (const name in adapter.limits) limits[name] = adapter.limits[name as keyof GPUSupportedLimits] as number;
  adapter.requestDevice = async (descriptor) => {
    const device = await requestDevice.call(adapter, {
        ...descriptor,
        requiredLimits: { ...limits, ...descriptor?.requiredLimits },
      }),
      createShaderModule = device.createShaderModule;
    if (!device.features.has('core-features-and-limits'))
      device.createShaderModule = (module) =>
        createShaderModule.call(device, {
          ...module,
          code: module.code.replace(/@interpolate\(\s*flat\s*\)/g, '@interpolate(flat, either)'),
        });
    return device;
  };
  return adapter;
};

/**
 * Lets `navigator.gpu.requestAdapter` fall back to `featureLevel: 'compatibility'` when the full level finds no adapter,
 * so OpenGL ES and Direct3D 11 class devices run native WebGPU instead of the WebGL2 layer. Call it before
 * `Engine.create` and before the root entry's `install`. Every other option passes through. A browser that does not
 * know `featureLevel` ignores it and answers as before. Rejects a second call until the first is disposed: `state`.
 * Throws `unsupported` where there is no `navigator.gpu`.
 */
export function allowCompatibilityAdapters({ force = false }: CompatibilityAdapterOptions = {}): CompatibilityAdapters {
  const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (!gpu) throw fault('unsupported', 'allowCompatibilityAdapters needs navigator.gpu; check for WebGPU first', 'compatibility-layer');
  if (active) throw fault('state', 'Compatibility adapters are already allowed; dispose the first call', 'compatibility-layer');
  const native = gpu.requestAdapter,
    compatibility = async (options?: GPURequestAdapterOptions) =>
      prepare(await native.call(gpu, { ...options, featureLevel: 'compatibility' } as GPURequestAdapterOptions));
  gpu.requestAdapter = force
    ? compatibility
    : async (options) => (await native.call(gpu, options)) ?? compatibility(options);
  const dispose = () => {
    if (active !== handle) return;
    active = undefined;
    // The patch is an own property: removing it shows the prototype's method again.
    delete (gpu as { requestAdapter?: unknown }).requestAdapter;
  };
  const handle: CompatibilityAdapters = { dispose, [Symbol.dispose]: dispose };
  active = handle;
  return handle;
}
