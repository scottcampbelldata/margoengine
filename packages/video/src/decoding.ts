/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';
import type { Movie } from './mp4.js';
/** Loading and lifetime cancellation. */
export interface VideoDecodingOptions {
  /** Cancels fetch, pending decoding and the opened video. Default none. */
  signal?: AbortSignal;
}

/** A fully buffered AVC MP4 with presentation-order frame access. Audio is ignored. */
export interface DecodedVideo extends Disposable {
  /** Number of frames visible through the supported edit list. */
  readonly frameCount: number;
  /** Presentation duration in seconds. */
  readonly duration: number;
  /** Last successfully returned presentation index, initially -1. */
  readonly currentFrame: number;
  /** Timestamp on the edited movie timeline, in seconds. */
  timestamp(index: number): number;
  /** Decode a presentation index. Caller closes the returned VideoFrame. Concurrent requests reject. */
  frame(index: number, options?: VideoDecodingOptions): Promise<VideoFrame>;
  /** Last frame at or before seconds; clamps to the first/last frame. Finite seconds required. */
  seek(seconds: number, options?: VideoDecodingOptions): Promise<VideoFrame>;
  /** Move by an integer presentation count (default 1), clamped to the ends. First step(1) returns frame 0. */
  step(delta?: number, options?: VideoDecodingOptions): Promise<VideoFrame>;
  /** Cancels pending decoding and releases compressed bytes. Already returned frames remain caller-owned. */
  dispose(): void;
}

/** Package-local indexed decoder shared by container entries. */
export async function openIndexedVideo(
  source: string | URL | Blob | ArrayBuffer,
  options: VideoDecodingOptions,
  read: (bytes: Uint8Array) => Movie,
): Promise<DecodedVideo> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function')
    throw fault('unsupported', 'Frame decoding requires WebCodecs VideoDecoder in a secure browser');
  let data: ArrayBuffer;
  if (source instanceof ArrayBuffer) data = source.slice(0);
  else if (typeof Blob !== 'undefined' && source instanceof Blob) data = await source.arrayBuffer();
  else {
    const response = await fetch(source as string | URL, { signal });
    if (!response.ok) throw fault('failed', `Video fetch failed (${response.status}); check the URL and origin access`);
    data = await response.arrayBuffer();
  }
  signal?.throwIfAborted();
  let bytes: Uint8Array | undefined = new Uint8Array(data),
    movie: Movie | undefined = read(bytes);
  const support = await VideoDecoder.isConfigSupported(movie.config);
  signal?.throwIfAborted();
  if (!support.supported)
    throw fault('unsupported', 'This browser cannot decode this codec configuration; use a supported video codec');
  const { times, duration } = movie;
  let current = -1,
    disposed = false,
    cancel: ((reason: unknown) => void) | undefined;
  const alive = (): void => {
    signal?.throwIfAborted();
    if (disposed) throw fault('disposed', 'Decoded video is disposed; open the video again');
  };
  const checked = (index: number): number => {
    if (!Number.isInteger(index) || index < 0 || index >= times.length)
      throw rangeError('Frame index is out of range; use an integer below frameCount', 'arguments');
    return index;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancel?.(signal?.aborted ? signal.reason : fault('disposed', 'Decoded video was disposed during decoding'));
    signal?.removeEventListener('abort', dispose);
    bytes = undefined;
    movie = undefined;
  };
  const frame = async (index: number, request: VideoDecodingOptions = {}): Promise<VideoFrame> => {
    alive();
    checked(index);
    request.signal?.throwIfAborted();
    if (cancel) throw fault('state', 'A frame request is already decoding; await it before seeking or stepping');
    const active = movie!,
      input = bytes!,
      target = active.order[index]!,
      wanted = active.samples[target]!;
    let start = target,
      end = target + 1;
    while (!active.samples[start]!.key) start--;
    while (end < active.samples.length && !active.samples[end]!.key) end++;
    return new Promise<VideoFrame>((resolve, reject) => {
      let selected: VideoFrame | undefined,
        decoder: VideoDecoder | undefined,
        settled = false;
      const abort = (): void => finish(request.signal!.reason);
      const failed = (error: unknown): void =>
        finish(fault('failed', `Video decoding failed: ${String(error)}; check the video file`));
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (decoder && decoder.state !== 'closed') decoder.close();
        request.signal?.removeEventListener('abort', abort);
        cancel = undefined;
        if (error !== undefined || !selected) {
          selected?.close();
          reject(error ?? fault('failed', 'Decoder produced no matching frame; check the container sample timestamps'));
        } else {
          current = index;
          resolve(selected);
        }
      };
      cancel = finish;
      request.signal?.addEventListener('abort', abort, { once: true });
      try {
        decoder = new VideoDecoder({
          output(output) {
            if (!settled && output.timestamp === wanted.pts && !selected) selected = output;
            else output.close();
          },
          error: (error) => finish(fault('failed', `Video decoder failed: ${error.message}; check the video file`)),
        });
        decoder.configure(active.config);
        for (let i = start; i < end; i++) {
          const sample = active.samples[i]!;
          decoder.decode(
            new EncodedVideoChunk({
              type: sample.key ? 'key' : 'delta',
              timestamp: sample.pts,
              duration: sample.duration,
              data: input.subarray(sample.offset, sample.offset + sample.size),
            }),
          );
        }
        void decoder.flush().then(() => finish(), failed);
      } catch (error) {
        failed(error);
      }
    });
  };
  signal?.addEventListener('abort', dispose, { once: true });
  return {
    frameCount: times.length,
    duration,
    get currentFrame() {
      return current;
    },
    timestamp(index) {
      alive();
      return times[checked(index)]!;
    },
    frame,
    async seek(seconds, request) {
      alive();
      if (!Number.isFinite(seconds)) throw rangeError('Seek time must be finite; pass seconds', 'arguments');
      let low = 0,
        high = times.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (times[mid]! <= seconds) low = mid + 1;
        else high = mid;
      }
      return frame(Math.max(0, low - 1), request);
    },
    async step(delta = 1, request) {
      alive();
      if (!Number.isSafeInteger(delta))
        throw rangeError('Frame step must be an integer; pass a frame count', 'arguments');
      return frame(Math.max(0, Math.min(times.length - 1, current + delta)), request);
    },
    dispose,
    [Symbol.dispose ?? Symbol()]: dispose,
  } as DecodedVideo;
}
