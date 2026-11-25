// The copy of a headless frame into CPU memory, shared by readPixels and the frame reader of ./frames. Written from the
// WebGPU specification (copyTextureToBuffer and its 256-byte row alignment, mapAsync, unmap). Not an entry.
import type { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';

const RENDER_ATTACHMENT = 16,
  TEXTURE_COPY_SRC = 1,
  BUFFER_COPY_DST = 8,
  ROW_ALIGNMENT = 256;
export const MAP_READ = 1;

/** A readback buffer lent by a context, with the canvas configuration it belongs to. */
export interface TakenBuffer {
  buffer: GPUBuffer;
  size: number;
  generation: number;
}

/** A new buffer a texture can be copied into and the CPU can map. */
export function createReadback(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({ label: 'headless readback', size, usage: MAP_READ | BUFFER_COPY_DST });
}

/** Stands in for a canvas's WebGPU context: the frame goes to one texture this package owns, which stays readable after
 * the frame because nothing presents it. It also keeps one readback buffer between reads. */
export class HeadlessContext {
  #configuration: GPUCanvasConfiguration | null = null;
  #texture: GPUTexture | null = null;
  #spare: TakenBuffer | null = null;
  #generation = 0;
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
  /** Lends a readback buffer of `size` bytes: the kept one when it fits, else a new one. */
  take(device: GPUDevice, size: number): TakenBuffer {
    const spare = this.#spare;
    this.#spare = null;
    if (spare?.size === size) return spare;
    spare?.buffer.destroy();
    return { buffer: createReadback(device, size), size, generation: this.#generation };
  }
  /** Takes an unmapped buffer back. One is kept; a second, or one from before a resize or reconfigure, is destroyed. */
  give(taken: TakenBuffer): void {
    if (this.#spare || taken.generation !== this.#generation) taken.buffer.destroy();
    else this.#spare = taken;
  }
  #drop(): void {
    this.#generation++;
    this.#spare?.buffer.destroy();
    this.#spare = null;
    this.#texture?.destroy();
    this.#texture = null;
  }
}

/** What it takes to turn a mapped copy into pixels. */
export interface FrameCopy {
  width: number;
  height: number;
  bytesPerRow: number;
  swap: boolean;
  premultiplied: boolean;
}

/** The last frame of a headless engine, ready to copy. */
export interface HeadlessFrame extends FrameCopy {
  context: HeadlessContext;
  device: GPUDevice;
  texture: GPUTexture;
  /** Bytes a readback buffer of this frame holds. */
  size: number;
}

/** The engine's last frame, or a coded error that names `caller`. */
export function headlessFrame(engine: Engine, caller: string): HeadlessFrame {
  const runtime = engineRuntime(engine),
    context = runtime.canvas.getContext('webgpu') as unknown as HeadlessContext | null,
    device = runtime.gpu;
  if (!(context instanceof HeadlessContext))
    throw fault('unsupported', `${caller} needs an engine on createHeadlessCanvas`, 'headless');
  if (!device) throw fault('unsupported', `${caller} needs the WebGPU backend`, 'headless');
  const texture = context.frame,
    configuration = context.getConfiguration();
  if (!texture || !configuration) throw fault('state', 'No frame to read: call engine.render() first', 'headless');
  const format = texture.format;
  if (format !== 'rgba8unorm' && format !== 'bgra8unorm')
    throw fault('unsupported', `${caller} reads rgba8unorm or bgra8unorm only`, 'headless');
  const { width, height } = texture,
    bytesPerRow = Math.ceil((width * 4) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
  return {
    context,
    device,
    texture,
    width,
    height,
    bytesPerRow,
    size: bytesPerRow * height,
    swap: format === 'bgra8unorm',
    premultiplied: configuration.alphaMode === 'premultiplied',
  };
}

/** Submits the copy of `frame` into `buffer`. It is queued before any later frame the caller draws. */
export function copyFrame(frame: HeadlessFrame, buffer: GPUBuffer): FrameCopy {
  const { device, texture, width, height, bytesPerRow, swap, premultiplied } = frame,
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
  device.queue.submit([encoder.finish()]);
  return { width, height, bytesPerRow, swap, premultiplied };
}

/** RGBA, straight alpha, no row padding, from a mapped copy. */
export function unpack(range: ArrayBuffer, { width, height, bytesPerRow, swap, premultiplied }: FrameCopy) {
  const stride = width * 4,
    mapped = new Uint8Array(range),
    data = new Uint8Array(stride * height);
  if (bytesPerRow === stride) data.set(mapped.subarray(0, data.length));
  else
    for (let y = 0; y < height; y++) data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + stride), y * stride);
  finishPixels(new Uint32Array(data.buffer), swap, premultiplied);
  return data;
}

/** Swaps blue and red for a BGRA texture, then gives straight alpha: 255 when opaque, else divided out. One word per
 * pixel, red in the low byte: every platform with WebGPU is little-endian. */
function finishPixels(words: Uint32Array, swap: boolean, premultiplied: boolean): void {
  const count = words.length;
  if (!premultiplied) {
    if (!swap) for (let i = 0; i < count; i++) words[i] |= 0xff000000;
    else
      for (let i = 0; i < count; i++) {
        const v = words[i];
        words[i] = 0xff000000 | (v & 0xff00) | ((v >>> 16) & 0xff) | ((v & 0xff) << 16);
      }
    return;
  }
  for (let i = 0; i < count; i++) {
    let v = words[i];
    if (swap) v = (v & 0xff00ff00) | ((v >>> 16) & 0xff) | ((v & 0xff) << 16);
    const alpha = v >>> 24;
    if (alpha > 0 && alpha < 255) {
      const scale = 255 / alpha,
        red = Math.min(255, Math.round((v & 0xff) * scale)),
        green = Math.min(255, Math.round(((v >>> 8) & 0xff) * scale)),
        blue = Math.min(255, Math.round(((v >>> 16) & 0xff) * scale));
      v = (alpha << 24) | (blue << 16) | (green << 8) | red;
    }
    words[i] = v;
  }
}
