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

const floatTypes: Record<string, string> = {
  texture_depth_2d: 'texture_2d<f32>',
  texture_depth_2d_array: 'texture_2d_array<f32>',
  texture_depth_multisampled_2d: 'texture_multisampled_2d<f32>',
};

/**
 * WGSL for the compatibility level, which forbids `textureLoad` of a depth texture type: a depth texture that is only
 * loaded becomes the float texture type that holds the same value, and each load takes its `.x`. A default layout
 * makes such a binding `unfilterable-float`, which a depth texture may bind to. One that a sampler also reads stays.
 */
function floatDepthLoads(code: string): string {
  for (const [declaration, name, type] of code.matchAll(/var\s+(\w+)\s*:\s*(texture_depth_(?:multisampled_2d|2d_array|2d))\b/g)) {
    const load = new RegExp(`\\btextureLoad\\s*\\(\\s*${name}\\s*,`, 'g'),
      starts = [...code.matchAll(load)].map((m) => m.index + m[0].length);
    if (!starts.length || new RegExp(`\\btexture(?:Sample|Gather)\\w*\\s*\\(\\s*${name}\\s*,`).test(code)) continue;
    // From the last call back, so earlier positions stay right.
    for (const start of starts.reverse()) {
      let depth = 1,
        at = start;
      while (depth) depth += code[at] === '(' ? 1 : code[at] === ')' ? -1 : 0, at++;
      code = code.slice(0, at) + '.x' + code.slice(at);
    }
    code = code.replace(declaration, declaration.replace(type, floatTypes[type]));
  }
  return code;
}

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
        // PostStack's HDR capture at this level: the one float format it can multisample.
        requiredFeatures: [
          ...(descriptor?.requiredFeatures ?? []),
          ...(adapter.features.has('rg11b10ufloat-renderable') ? (['rg11b10ufloat-renderable'] as const) : []),
        ],
      }),
      createShaderModule = device.createShaderModule;
    if (!device.features.has('core-features-and-limits'))
      device.createShaderModule = (module) =>
        createShaderModule.call(device, {
          ...module,
          code: floatDepthLoads(module.code).replace(/@interpolate\(\s*flat\s*\)/g, '@interpolate(flat, either)'),
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
