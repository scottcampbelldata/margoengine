// Rendering with no page: written from the WebGPU specification (GPUCanvasContext, copyTextureToBuffer's 256-byte row
// alignment, the GPU*Usage flag values) and the W3C PNG specification. Runs wherever a WebGPU implementation can be
// passed in: Node with a binding, a browser, a worker. No node: imports and no side effects on import.
import type { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { pngParts } from '../../shared/png.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** The flag tables core and the GPU packages read as globals. Values from the WebGPU specification. */
const CONSTANTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
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
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
};
const RENDER_ATTACHMENT = 16,
  TEXTURE_COPY_SRC = 1,
  MAP_READ = 1,
  BUFFER_COPY_DST = 8,
  ROW_ALIGNMENT = 256;

/** The part of a WebGPU implementation {@link installGPU} needs. `getPreferredCanvasFormat` is optional because Node
 * bindings have no canvas to prefer a format for. */
export interface GPUBinding {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat?(): GPUTextureFormat;
  readonly wgslLanguageFeatures?: unknown;
}

/** Options of {@link installGPU}. */
export interface InstallGPUOptions {
  /** The WebGPU implementation to render with: `create([])` from a Node binding, or `navigator.gpu` in a browser. */
  gpu: GPUBinding;
  /** Globals the binding exports (`GPUBufferUsage` and so on). A name already on `globalThis` stays as it is; a flag
   * table neither has gets the specification's values. Default none. */
  globals?: Readonly<Record<string, unknown>>;
}

/** What {@link installGPU} returns. `dispose()` (or `using`) restores `navigator.gpu` and removes the added globals. */
export interface InstalledGPU {
  /** The object now at `navigator.gpu`. */
  readonly gpu: GPU;
  /** Restores what was there before. Safe to call twice. */
  dispose(): void;
  /** `dispose()`, for `using`. */
  [Symbol.dispose](): void;
}

/**
 * Makes `gpu` the WebGPU implementation core sees: sets `navigator.gpu` and the `GPU*` flag globals a runtime without
 * WebGPU lacks, and supplies `getPreferredCanvasFormat` (`'rgba8unorm'`) when the binding has none. Call it before
 * `Engine.create`; nothing happens on import.
 */
export function installGPU({ gpu, globals = {} }: InstallGPUOptions): InstalledGPU {
  if (typeof gpu?.requestAdapter !== 'function')
    throw typeError('installGPU needs a gpu with requestAdapter', 'headless');
  const scope = globalThis as unknown as Record<string, unknown>,
    added: string[] = [];
  const add = (name: string, value: unknown) => {
    if (name in scope) return;
    Object.defineProperty(scope, name, { value, configurable: true, writable: true });
    added.push(name);
  };
  add('navigator', {});
  const target = scope.navigator as object,
    before = Object.getOwnPropertyDescriptor(target, 'gpu'),
    // A wrapper, not a change to the caller's object: a native binding's methods keep their own `this`.
    installed = (
      typeof gpu.getPreferredCanvasFormat === 'function'
        ? gpu
        : {
            requestAdapter: (options?: GPURequestAdapterOptions) => gpu.requestAdapter(options),
            getPreferredCanvasFormat: () => 'rgba8unorm',
            get wgslLanguageFeatures() {
              return gpu.wgslLanguageFeatures;
            },
          }
    ) as GPU;
  Object.defineProperty(target, 'gpu', { value: installed, configurable: true, writable: true });
  for (const name of Object.keys(globals)) add(name, globals[name]);
  for (const name of Object.keys(CONSTANTS)) add(name, Object.freeze({ ...CONSTANTS[name] }));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (before) Object.defineProperty(target, 'gpu', before);
    else delete (target as { gpu?: unknown }).gpu;
    for (const name of added) delete scope[name];
  };
  return { gpu: installed, dispose, [Symbol.dispose]: dispose };
}

/** Stands in for a canvas's WebGPU context: the frame goes to one texture this package owns, which stays readable after
 * the frame because nothing presents it. */
class HeadlessContext {
  #configuration: GPUCanvasConfiguration | null = null;
  #texture: GPUTexture | null = null;
  constructor(readonly canvas: { width: number; height: number }) {}
  configure(configuration: GPUCanvasConfiguration): void {
    this.#drop();
    this.#configuration = { ...configuration };
  }
  unconfigure(): void {
    this.#drop();
    this.#configuration = null;
  }
  getConfiguration(): GPUCanvasConfiguration | null {
    return this.#configuration && { ...this.#configuration };
  }
  getCurrentTexture(): GPUTexture {
    const configuration = this.#configuration;
    if (!configuration) throw fault('state', 'Headless canvas is not configured', 'headless');
    const { width, height } = this.canvas;
    if (this.#texture?.width !== width || this.#texture.height !== height) {
      this.#drop();
      this.#texture = configuration.device.createTexture({
        label: 'headless canvas',
        size: [width, height],
        format: configuration.format,
        // Readback needs COPY_SRC whatever the caller configured (a package may add usages, as on a real canvas).
        usage: (configuration.usage ?? RENDER_ATTACHMENT) | RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
        viewFormats: configuration.viewFormats,
      });
    }
    return this.#texture;
  }
  /** The last frame's texture, if a frame has asked for one. */
  get frame(): GPUTexture | null {
    return this.#texture;
  }
  #drop(): void {
    this.#texture?.destroy();
    this.#texture = null;
  }
}

/** Options of {@link createHeadlessCanvas}. */
export interface HeadlessCanvasOptions {
  /** Width of the image in pixels, a whole number from 1. Required. */
  width: number;
  /** Height of the image in pixels, a whole number from 1. Required. */
  height: number;
}

/**
 * A stand-in for `Engine.create`'s canvas: `width`, `height`, `clientWidth` and `clientHeight` (0, so core keeps
 * `width` and `height` as the image size) and `getContext('webgpu')`. It has no other element members, so use it with
 * `Engine` and packages that take an engine, not with `createStage`, which needs a page.
 */
export function createHeadlessCanvas({ width, height }: HeadlessCanvasOptions): HTMLCanvasElement {
  for (const size of [width, height])
    if (!Number.isInteger(size) || size < 1) throw rangeError('Invalid headless canvas size', 'headless');
  let context: HeadlessContext | undefined;
  const canvas = {
    width,
    height,
    clientWidth: 0,
    clientHeight: 0,
    getContext(type: string) {
      return type === 'webgpu' ? (context ??= new HeadlessContext(canvas)) : null;
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** RGBA pixels from {@link readPixels}: 8 bits per channel, straight alpha, top row first, no padding. */
export interface HeadlessPixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Options of {@link readPixels} and {@link toPNG}. */
export interface HeadlessReadOptions {
  /** Stops waiting for the GPU; the promise rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/**
 * Reads the last frame of an engine on a {@link createHeadlessCanvas} canvas. Call `engine.render()` first; this draws
 * nothing itself. A context configured `opaque` (the default) reads alpha 255, as a page would show it.
 */
export async function readPixels(engine: Engine, { signal }: HeadlessReadOptions = {}): Promise<HeadlessPixels> {
  signal?.throwIfAborted();
  const runtime = engineRuntime(engine),
    context = runtime.canvas.getContext('webgpu') as unknown as HeadlessContext | null,
    device = runtime.gpu;
  if (!(context instanceof HeadlessContext))
    throw fault('unsupported', 'readPixels needs an engine on createHeadlessCanvas', 'headless');
  if (!device) throw fault('unsupported', 'readPixels needs the WebGPU backend', 'headless');
  const texture = context.frame,
    configuration = context.getConfiguration();
  if (!texture || !configuration) throw fault('state', 'No frame to read: call engine.render() first', 'headless');
  const format = texture.format;
  if (format !== 'rgba8unorm' && format !== 'bgra8unorm')
    throw fault('unsupported', 'readPixels reads rgba8unorm or bgra8unorm only', 'headless');
  const { width, height } = texture,
    stride = width * 4,
    bytesPerRow = Math.ceil(stride / ROW_ALIGNMENT) * ROW_ALIGNMENT,
    buffer = device.createBuffer({
      label: 'headless readback',
      size: bytesPerRow * height,
      usage: MAP_READ | BUFFER_COPY_DST,
    }),
    stop = () => buffer.destroy();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    });
    const mapped = new Uint8Array(buffer.getMappedRange()),
      data = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + stride), y * stride);
    finishPixels(data, format === 'bgra8unorm', configuration.alphaMode === 'premultiplied');
    return { width, height, data };
  } finally {
    signal?.removeEventListener('abort', stop);
    buffer.destroy();
  }
}

/** Swaps blue and red for a BGRA texture, then gives straight alpha: 255 when opaque, else divided out. */
function finishPixels(data: Uint8Array, swap: boolean, premultiplied: boolean): void {
  for (let i = 0; i < data.length; i += 4) {
    if (swap) {
      const blue = data[i];
      data[i] = data[i + 2];
      data[i + 2] = blue;
    }
    if (!premultiplied) data[i + 3] = 255;
    else if (data[i + 3] > 0 && data[i + 3] < 255) {
      const scale = 255 / data[i + 3];
      for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.round(data[i + c] * scale));
    }
  }
}

/** Encodes RGBA pixels as an 8-bit PNG file (each row filtered against the one above). */
async function encodePNG({ width, height, data }: HeadlessPixels): Promise<Uint8Array> {
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    rows[at] = 2; // Up
    for (let x = 0; x < stride; x++) rows[at + 1 + x] = data[y * stride + x] - (y > 0 ? data[(y - 1) * stride + x] : 0);
  }
  const zlib = new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))),
    parts = pngParts(width, height, 6, new Uint8Array(await zlib.arrayBuffer())) as Uint8Array[],
    out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The last frame of an engine on a {@link createHeadlessCanvas} canvas as PNG file bytes. See {@link readPixels}. */
export async function toPNG(engine: Engine, options?: HeadlessReadOptions): Promise<Uint8Array> {
  return encodePNG(await readPixels(engine, options));
}
