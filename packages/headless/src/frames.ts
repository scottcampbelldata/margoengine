// Reads every frame of a headless render with several copies in flight, so the CPU does not wait for the GPU to finish a
// frame before it records the next. Written from the WebGPU specification: queue operations run in submission order, so
// a copy submitted before the next render holds this frame, and mapAsync resolves once that copy has run. Several
// buffers in flight, read oldest first: Hrabcak and Masserann, "Asynchronous Buffer Transfers", OpenGL Insights, 2012.
import type { Engine } from '@margoengine/core';
import { fault, rangeError } from '../../shared/errors.js';
import type { HeadlessPixels } from './index.js';
import { MAP_READ, copyFrame, createReadback, headlessFrame, unpack, type FrameCopy } from './readback.js';

/** Options of {@link createFrameReader}. */
export interface FrameReaderOptions {
  /** Frames held at once, a whole number from 1 to 16. 1 waits for each frame. Default 3. */
  depth?: number;
  /** Disposes the reader; waiting reads reject with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/** Reads the frames of one headless engine in the order they were drawn. See {@link createFrameReader}. */
export interface FrameReader {
  /** Frames held at once. */
  readonly depth: number;
  /** Frames copied and not yet handed out. */
  readonly pending: number;
  /**
   * Copies the frame just rendered, at the moment of the call. Resolves to the oldest held frame once `depth` frames are
   * held, else to `undefined`. Call it once after each `engine.render()`.
   */
  push(): Promise<HeadlessPixels | undefined>;
  /** The frames still held, oldest first. */
  drain(): AsyncGenerator<HeadlessPixels, void, void>;
  /** Frees the buffers. Held frames are lost. Safe to call twice. */
  dispose(): void;
  /** `dispose()`, for `using`. */
  [Symbol.dispose](): void;
}

interface Slot {
  buffer: GPUBuffer;
  device: GPUDevice;
  size: number;
}
interface Held extends Slot {
  copy: FrameCopy;
  mapped: Promise<void>;
}

/**
 * A reader for rendering many frames of an engine on a `createHeadlessCanvas` canvas. It gives the same pixels as
 * `readPixels` after each frame, `depth - 1` frames later, and reuses `depth` readback buffers instead of waiting for
 * the GPU after each frame. Dispose it when done, before the engine.
 */
export function createFrameReader(engine: Engine, { depth = 3, signal }: FrameReaderOptions = {}): FrameReader {
  if (!Number.isInteger(depth) || depth < 1 || depth > 16)
    throw rangeError('createFrameReader depth is a whole number from 1 to 16', 'headless');
  signal?.throwIfAborted();
  const queue: Held[] = [],
    free: Slot[] = [],
    buffers = new Set<GPUBuffer>();
  let disposed = false;
  const alive = () => {
    signal?.throwIfAborted();
    if (disposed) throw fault('state', 'The frame reader is disposed', 'headless');
  };
  const destroy = (buffer: GPUBuffer) => {
    buffers.delete(buffer);
    buffer.destroy();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    for (const buffer of buffers) buffer.destroy();
    buffers.clear();
    queue.length = free.length = 0;
  };
  signal?.addEventListener('abort', dispose, { once: true });

  const acquire = (device: GPUDevice, size: number): Slot => {
    // A resize or a restored device leaves buffers that no longer fit: they go.
    for (let slot = free.pop(); slot; slot = free.pop()) {
      if (slot.device === device && slot.size === size) return slot;
      destroy(slot.buffer);
    }
    const buffer = createReadback(device, size);
    buffers.add(buffer);
    return { buffer, device, size };
  };
  const finish = async ({ buffer, device, size, copy, mapped }: Held): Promise<HeadlessPixels> => {
    try {
      await mapped;
      alive();
      const data = unpack(buffer.getMappedRange(), copy);
      buffer.unmap();
      free.push({ buffer, device, size });
      return { width: copy.width, height: copy.height, data };
    } catch (error) {
      destroy(buffer);
      // A map that fails because the reader was disposed says so.
      alive();
      throw error;
    }
  };

  return {
    depth,
    get pending() {
      return queue.length;
    },
    async push() {
      alive();
      const frame = headlessFrame(engine, 'createFrameReader'),
        slot = acquire(frame.device, frame.size),
        copy = copyFrame(frame, slot.buffer),
        mapped = slot.buffer.mapAsync(MAP_READ);
      // Awaited when the frame is handed out; until then a rejection counts as handled.
      mapped.catch(() => {});
      queue.push({ ...slot, copy, mapped });
      return queue.length >= depth ? finish(queue.shift()!) : undefined;
    },
    async *drain() {
      alive();
      for (let held = queue.shift(); held; held = queue.shift()) yield await finish(held);
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
