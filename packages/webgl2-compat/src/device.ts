// @margoengine/webgl2-compat/device: the WebGPU-shaped device on WebGL2 (roadmap milestone M2), and install() behind
// the root entry's install(). Written clean room from the W3C WebGPU and WGSL specifications and the Khronos WebGL 2.0,
// OpenGL ES 3.0 and GLSL ES 3.00 specifications. Nothing runs at import time: globals change only in installCompat().
import { fault } from '../../shared/errors.js';
import { waitFor, probeWebGL2, type InstallOptions, type InstallResult } from './index.js';
import { CompatCanvasContext } from './device/canvas.js';
import {
  COMPAT_VENDOR,
  CompatAdapter,
  CompatDevice,
  CompatGPU,
  type CompatGPUOptions,
  CompatInternalError,
  CompatQueue,
  CompatValidationError,
} from './device/device.js';
import { CompatComputePassEncoder, CompatComputePipeline } from './device/compute.js';
import {
  CompatBindGroup,
  CompatBindGroupLayout,
  CompatBuffer,
  CompatExternalTexture,
  CompatPipelineLayout,
  CompatSampler,
  CompatShaderModule,
  CompatTexture,
  CompatTextureView,
} from './device/resources.js';
import {
  CompatCommandBuffer,
  CompatCommandEncoder,
  CompatQuerySet,
  CompatRenderBundle,
  CompatRenderBundleEncoder,
  CompatRenderPassEncoder,
  CompatRenderPipeline,
} from './device/render.js';

/** The WGSL front end's types, under the names its own entry gives them (the IR this entry's types refer to). */
export type * from './wgsl.js';
export { COMPAT_VENDOR, CompatAdapter, CompatCanvasContext, CompatDevice, CompatGPU, type CompatGPUOptions };
export { CompatInternalError, CompatValidationError, CompatQueue, CPU_WORK_BUDGET } from './device/device.js';
/** @internal The layer's external-texture storage, exported for its tests. */
export { ExternalCopies, SPARE_EXTERNALS } from './device/externals.js';
export {
  CompatBindGroup,
  CompatBindGroupLayout,
  CompatBuffer,
  CompatExternalTexture,
  CompatPipelineLayout,
  CompatSampler,
  CompatShaderModule,
  CompatTexture,
  CompatTextureView,
} from './device/resources.js';
export {
  CompatCommandBuffer,
  CompatCommandEncoder,
  CompatQuerySet,
  CompatRenderBundle,
  CompatRenderBundleEncoder,
  CompatRenderPassEncoder,
  CompatRenderPipeline,
} from './device/render.js';

/**
 * True when a GPUDevice-like object is a device of the compatibility layer (WebGL2 underneath), so a package can pick
 * its compatibility path without sniffing the browser.
 * @param device Any value; typically `engine.gpu`.
 */
export function isCompatDevice(device: unknown): device is CompatDevice {
  return device instanceof CompatDevice;
}

/**
 * A `navigator.gpu` replacement on WebGL2, without installing it anywhere: pass its adapters' devices to code that
 * takes a device, or install it with the root entry's `install()`.
 * @param options How each device makes its WebGL2 context; see {@link CompatGPUOptions}.
 */
export function createCompatGPU(options: CompatGPUOptions = {}): CompatGPU {
  return new CompatGPU(options);
}

const FLAGS: Record<string, Record<string, number>> = {
  GPUBufferUsage: {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
};

/**
 * The WebGPU interface each layer class stands for. install() names them so, while it is installed: WebGPU code tells
 * its objects apart with `instanceof GPUBuffer` and the like (the compute package's bindings do), and a browser
 * without an adapter may still define the native interfaces, which the layer's objects are not instances of.
 */
const INTERFACES: Record<string, unknown> = {
  GPU: CompatGPU,
  GPUAdapter: CompatAdapter,
  GPUDevice: CompatDevice,
  GPUQueue: CompatQueue,
  GPUBuffer: CompatBuffer,
  GPUTexture: CompatTexture,
  GPUTextureView: CompatTextureView,
  GPUExternalTexture: CompatExternalTexture,
  GPUSampler: CompatSampler,
  GPUShaderModule: CompatShaderModule,
  GPUBindGroupLayout: CompatBindGroupLayout,
  GPUPipelineLayout: CompatPipelineLayout,
  GPUBindGroup: CompatBindGroup,
  GPURenderPipeline: CompatRenderPipeline,
  GPUComputePipeline: CompatComputePipeline,
  GPUCommandEncoder: CompatCommandEncoder,
  GPUCommandBuffer: CompatCommandBuffer,
  GPURenderPassEncoder: CompatRenderPassEncoder,
  GPUComputePassEncoder: CompatComputePassEncoder,
  GPURenderBundleEncoder: CompatRenderBundleEncoder,
  GPURenderBundle: CompatRenderBundle,
  GPUQuerySet: CompatQuerySet,
  GPUCanvasContext: CompatCanvasContext,
  GPUValidationError: CompatValidationError,
  GPUInternalError: CompatInternalError,
};

type Restore = () => void;
let installed: { gpu: CompatGPU; restore: Restore[] } | null = null;

function alreadyInstalled(): InstallResult | null {
  return installed ? { installed: true, reason: 'already', gpu: installed.gpu } : null;
}

/** @internal The root entry's install(): see its documentation. */
export async function installCompat(options: InstallOptions = {}): Promise<InstallResult> {
  options.signal?.throwIfAborted();
  const ranks = { ldr: 0, 'half-float': 1, full: 2 };
  const minimum = options.minimumTier ?? 'full';
  if (!Object.hasOwn(ranks, minimum)) throw new TypeError('minimumTier must be full, half-float or ldr');
  const initial = alreadyInstalled();
  if (initial) return initial;
  const nav = (globalThis as { navigator?: Navigator & { gpu?: GPU } }).navigator;
  if (!nav) throw new TypeError('install() needs navigator');
  if (!options.force && nav.gpu) {
    const adapter = await waitFor(
      nav.gpu.requestAdapter().catch(() => null),
      options.signal,
    );
    options.signal?.throwIfAborted();
    // Another installation can finish while this caller awaits the native adapter.
    const concurrent = alreadyInstalled();
    if (concurrent) return concurrent;
    if (adapter) {
      console.warn(fault('state', "WebGPU kept; use force: true, backend 'webgpu'", 'compatibility-layer'));
      return { installed: false, reason: 'webgpu' };
    }
  }
  const caps = probeWebGL2(
    options.createContext
      ? { canvas: { getContext: (_type, attributes) => options.createContext?.(attributes ?? {}) } }
      : {},
  );
  options.signal?.throwIfAborted();
  if (!caps) throw fault('unsupported', 'This browser has neither WebGPU nor WebGL2', 'compatibility-layer');
  if (!caps.highpFragment || ranks[caps.tier] < ranks[minimum]) {
    const missing: string[] = [];
    if (!caps.highpFragment) missing.push('highp-fragment');
    if (minimum === 'full' && !caps.extensions.EXT_color_buffer_float) missing.push('EXT_color_buffer_float');
    if (
      minimum === 'half-float' &&
      !caps.extensions.EXT_color_buffer_float &&
      !caps.extensions.EXT_color_buffer_half_float
    )
      missing.push('EXT_color_buffer_half_float');
    throw fault(
      'unsupported',
      `This browser's WebGL2 is below the ${minimum} compatibility minimum: missing ${missing.join(', ')}`,
      'compatibility-layer',
    );
  }
  const gpu = new CompatGPU(options);
  const restore: Restore[] = [];
  const own = Object.getOwnPropertyDescriptor(nav, 'gpu');
  Object.defineProperty(nav, 'gpu', { value: gpu, configurable: true, enumerable: true, writable: false });
  restore.push(() => {
    if (own) Object.defineProperty(nav, 'gpu', own);
    else delete (nav as { gpu?: unknown }).gpu;
  });
  const contexts = new WeakMap<object, CompatCanvasContext>();
  for (const name of ['HTMLCanvasElement', 'OffscreenCanvas']) {
    const proto = (
      globalThis as unknown as Record<string, { prototype?: { getContext?: (...a: unknown[]) => unknown } } | undefined>
    )[name]?.prototype;
    const original = proto?.getContext;
    if (!proto || !original) continue;
    proto.getContext = function (this: HTMLCanvasElement, type: unknown, ...rest: unknown[]) {
      if (type !== 'webgpu') return original.call(this, type, ...rest);
      let context = contexts.get(this);
      if (!context) contexts.set(this, (context = new CompatCanvasContext(this, original as never)));
      return context;
    };
    restore.push(() => (proto.getContext = original));
  }
  // toDataURL and toBlob read a canvas the layer shows through a 2D copy (CompatCanvasContext.uprightCopy).
  const page = (globalThis as { HTMLCanvasElement?: { prototype: HTMLCanvasElement } }).HTMLCanvasElement?.prototype;
  if (page)
    for (const name of ['toDataURL', 'toBlob'] as const) {
      const original = page[name] as (...a: unknown[]) => unknown;
      (page as unknown as Record<string, unknown>)[name] = function (this: HTMLCanvasElement, ...rest: unknown[]) {
        return original.apply(contexts.get(this)?.uprightCopy() ?? this, rest);
      };
      restore.push(() => ((page as unknown as Record<string, unknown>)[name] = original));
    }
  for (const [name, value] of Object.entries(FLAGS))
    if (!(name in globalThis)) {
      Object.defineProperty(globalThis, name, {
        value: Object.freeze({ ...value }),
        configurable: true,
        writable: false,
      });
      restore.push(() => delete (globalThis as unknown as Record<string, unknown>)[name]);
    }
  for (const [name, value] of Object.entries(INTERFACES)) {
    const own = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
    restore.push(() => {
      if (own) Object.defineProperty(globalThis, name, own);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    });
  }
  installed = { gpu, restore };
  return { installed: true, reason: 'installed', gpu };
}

/** @internal The root entry's uninstall(). */
export function uninstallCompat(): boolean {
  if (!installed) return false;
  for (const r of installed.restore.reverse()) r();
  installed = null;
  return true;
}
