// @margoengine/webgl2-compat/device: the WebGPU-shaped device on WebGL2 (roadmap milestone M2), and install() behind
// the root entry's install(). Written clean room from the W3C WebGPU and WGSL specifications and the Khronos WebGL 2.0,
// OpenGL ES 3.0 and GLSL ES 3.00 specifications. Nothing runs at import time: globals change only in installCompat().
import { fault } from '../../shared/errors.js';
import { probeWebGL2, type InstallOptions, type InstallResult } from './index.js';
import { CompatCanvasContext } from './device/canvas.js';
import { COMPAT_VENDOR, CompatAdapter, CompatDevice, CompatGPU, type CompatGPUOptions } from './device/device.js';

/** The WGSL front end's types, under the names its own entry gives them (the IR this entry's types refer to). */
export type * from './wgsl.js';
export { COMPAT_VENDOR, CompatAdapter, CompatCanvasContext, CompatDevice, CompatGPU, type CompatGPUOptions };
export { CompatValidationError, CompatQueue } from './device/device.js';
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

type Restore = () => void;
let installed: { gpu: CompatGPU; restore: Restore[] } | null = null;

/** @internal The root entry's install(): see its documentation. */
export async function installCompat(options: InstallOptions = {}): Promise<InstallResult> {
  if (installed) return { installed: true, reason: 'already', gpu: installed.gpu };
  const nav = (globalThis as { navigator?: Navigator & { gpu?: GPU } }).navigator;
  if (!nav) throw new TypeError('install() runs in a browser page: there is no navigator here');
  if (!options.force && nav.gpu) {
    const adapter = await nav.gpu.requestAdapter().catch(() => null);
    if (adapter) return { installed: false, reason: 'webgpu' };
  }
  const caps = probeWebGL2();
  if (!caps) throw fault('unsupported', 'This browser has neither WebGPU nor WebGL2', 'compatibility-layer');
  if (!caps.supported)
    throw fault(
      'unsupported',
      `This browser's WebGL2 is below the compatibility minimum: missing ${caps.missing.join(', ')}`,
      'compatibility-layer',
    );
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
  for (const [name, value] of Object.entries(FLAGS))
    if (!(name in globalThis)) {
      Object.defineProperty(globalThis, name, {
        value: Object.freeze({ ...value }),
        configurable: true,
        writable: false,
      });
      restore.push(() => delete (globalThis as unknown as Record<string, unknown>)[name]);
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
