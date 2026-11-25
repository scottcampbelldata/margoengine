// Rendering with no page: written from the WebGPU specification (GPUCanvasContext, copyTextureToBuffer's 256-byte row
// alignment, the GPU*Usage flag values) and the W3C PNG specification. Runs wherever a WebGPU implementation can be
// passed in: Node with a binding, a browser, a worker. No node: imports and no side effects on import.
import type { Engine } from '@margoengine/core';
import { pngParts } from '../../shared/png.js';
import { rangeError, typeError } from '../../shared/errors.js';
import { HeadlessContext, MAP_READ, copyFrame, headlessFrame, unpack } from './readback.js';

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
 * nothing itself. A context configured `opaque` (the default) reads alpha 255, as a page would show it. The readback
 * buffer stays on the canvas for the next read of the same size. To read every frame of a film without waiting for the
 * GPU after each one, use `createFrameReader` from `@margoengine/headless/frames`.
 */
export async function readPixels(engine: Engine, { signal }: HeadlessReadOptions = {}): Promise<HeadlessPixels> {
  signal?.throwIfAborted();
  const frame = headlessFrame(engine, 'readPixels'),
    taken = frame.context.take(frame.device, frame.size),
    { buffer } = taken,
    stop = () => buffer.destroy();
  signal?.addEventListener('abort', stop, { once: true });
  let read = false;
  try {
    const copy = copyFrame(frame, buffer);
    await buffer.mapAsync(MAP_READ).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    });
    // An abort that came after the map finished has destroyed the buffer.
    signal?.throwIfAborted();
    const data = unpack(buffer.getMappedRange(), copy);
    buffer.unmap();
    read = true;
    return { width: copy.width, height: copy.height, data };
  } finally {
    signal?.removeEventListener('abort', stop);
    if (read) frame.context.give(taken);
    else buffer.destroy();
  }
}

/** Encodes RGBA pixels as an 8-bit PNG file (each row filtered against the one above). */
export async function encodePNG({ width, height, data }: HeadlessPixels): Promise<Uint8Array> {
  // IHDR sizes are 1 to 2^31 - 1 (W3C PNG 11.2.2); short data would be written as zeros.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw rangeError('Invalid image size', 'headless');
  if (data?.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
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
