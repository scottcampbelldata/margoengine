/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf-pro/model';
import { MargoError } from '@margoengine/math/errors';
import type { CompositionOptions } from './compose.js';
import type { USDAsset, USDOptions } from './index.js';
import { valueClips, type ValueClipsOptions } from './clips.js';

/** Reads an anchored clip/layer/image, optionally cancelling an in-flight read. Undefined means absent. */
export type ClipReader = (id: string, signal?: AbortSignal) => Promise<Uint8Array | undefined> | Uint8Array | undefined;
/** Limits and optional USD features for frame-by-frame cache playback. */
export interface ValueClipPlayerOptions extends USDOptions, CompositionOptions, Omit<ValueClipsOptions, 'layers'> {
  /** Byte-bounded LRU cache of encoded files. Default 64 MiB. */
  cacheBytes?: number;
}
/** Inclusive sequence of requested stage times. */
export interface ClipFrameOptions extends ValueClipPlayerOptions {
  /** First time code. */
  startTimeCode: number;
  /** Last time code, inclusive. */
  endTimeCode: number;
  /** Nonzero step with the direction of the range. Default 1. */
  step?: number;
}
/** A resolved frame; its asset can create a model on any supported backend. */
export interface ClipFrame {
  timeCode: number;
  asset: USDAsset;
}
function cached(read: ClipReader, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('cacheBytes must be positive; fix clip player options');
  const cache = new Map<string, Uint8Array>();
  let bytes = 0;
  return async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const known = cache.get(id);
    if (known) {
      cache.delete(id);
      cache.set(id, known);
      return known;
    }
    const data = await read(id, signal);
    signal?.throwIfAborted();
    if (data && data.byteLength <= limit) {
      while (bytes + data.byteLength > limit) {
        const key = cache.keys().next().value!;
        bytes -= cache.get(key)!.byteLength;
        cache.delete(key);
      }
      cache.set(id, data);
      bytes += data.byteLength;
    }
    return data;
  };
}
const frame = (
  root: string,
  read: ClipReader,
  timeCode: number,
  options: ValueClipPlayerOptions,
  signal?: AbortSignal,
) =>
  import('./compose.js').then(({ parseUSDFiles }) =>
    parseUSDFiles(
      root,
      (id) => {
        const layer =
          options.layers instanceof Map
            ? options.layers.get(id)
            : options.layers && Object.hasOwn(options.layers, id)
              ? options.layers[id]
              : undefined;
        return typeof layer === 'string' ? new TextEncoder().encode(layer) : (layer ?? read(id, signal));
      },
      {
        ...options,
        signal,
        extensions: [
          ...(options.extensions ?? []).filter((e) => e.name !== 'clips'),
          valueClips({ timeCode, maxClips: options.maxClips }),
        ],
      },
    ),
  );

/** Lazily resolve a cancellable sequence; cache residency stays byte bounded across arbitrarily long sequences. */
export async function* valueClipFrames(
  root: string,
  read: ClipReader,
  options: ClipFrameOptions,
): AsyncGenerator<ClipFrame> {
  const start = options.startTimeCode,
    end = options.endTimeCode,
    step = options.step ?? 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || !step || (end - start) * step < 0)
    throw new RangeError('Invalid frame range; use finite endpoints and a step in the range direction');
  const reader = cached(read, options.cacheBytes ?? 64 * 1024 * 1024),
    count = Math.floor((end - start) / step) + 1;
  if (!Number.isSafeInteger(count)) throw new RangeError('Frame range is too large; request a smaller interval');
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted();
    const timeCode = start + i * step;
    yield { timeCode, asset: await frame(root, reader, timeCode, options, options.signal) };
  }
}

/** Owns the current cache frame, including changing topology; await setTimeCode before requesting the next frame. */
export class ValueClipPlayer {
  private current?: PBRModel;
  private pending?: AbortController;
  private disposed = false;
  private readonly read: ClipReader;
  private currentTime?: number;
  /** Time code of the current model, or undefined before the first frame. */
  get timeCode(): number | undefined {
    return this.currentTime;
  }
  constructor(
    private readonly engine: EngineKernel,
    private readonly root: string,
    read: ClipReader,
    private readonly options: ValueClipPlayerOptions = {},
  ) {
    this.read = cached(read, options.cacheBytes ?? 64 * 1024 * 1024);
  }
  /** Current frame model, or undefined before the first successful request. */
  get model(): PBRModel | undefined {
    return this.current;
  }
  /** Load and atomically replace the current frame. A failed or aborted request keeps the previous frame. */
  async setTimeCode(
    timeCode: number,
    { signal = this.options.signal }: { signal?: AbortSignal } = {},
  ): Promise<PBRModel> {
    if (this.disposed) throw new MargoError('disposed', 'Clip player is disposed; create a new player');
    if (this.pending)
      throw new MargoError('state', 'A clip frame is loading; await setTimeCode before requesting another');
    if (!Number.isFinite(timeCode)) throw new RangeError('timeCode must be finite; fix the frame request');
    const controller = (this.pending = new AbortController()),
      abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let next: PBRModel | undefined;
    try {
      const asset = await frame(this.root, this.read, timeCode, this.options, controller.signal);
      next = await asset.create(this.engine, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const old = this.current;
      this.current = next;
      this.currentTime = timeCode;
      old?.destroy();
      return next;
    } catch (error) {
      next?.destroy();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.pending = undefined;
    }
  }
  /** Abort a pending request and dispose the current frame. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.pending?.abort();
    this.current?.destroy();
    this.current = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Create a clip player and load options.timeCode (default 0) as its first frame. */
export async function loadValueClips(
  engine: EngineKernel,
  root: string,
  read: ClipReader,
  options: ValueClipPlayerOptions = {},
): Promise<ValueClipPlayer> {
  const player = new ValueClipPlayer(engine, root, read, options);
  try {
    await player.setTimeCode(options.timeCode ?? 0);
    return player;
  } catch (error) {
    player.dispose();
    throw error;
  }
}
