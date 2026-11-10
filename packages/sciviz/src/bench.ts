/// <reference lib="esnext.disposable" preserve="true" />
// Optional comparison helpers. No renderer, rival, clock or global work on import.
import { rangeError, typeError } from '../../shared/errors.js';

/** Copied RGBA8 pixels after a renderer has completed a frame. */
export interface ComparisonFrame {
  /** Positive pixel width. */
  readonly width: number;
  /** Positive pixel height. */
  readonly height: number;
  /** Width times height times four RGBA bytes. */
  readonly rgba: Uint8Array | Uint8ClampedArray;
  /** Optional public API work counts for this frame, measured outside timed samples. */
  readonly work?: Readonly<Record<string, number>>;
}

/** A caller-owned black-box renderer. The harness owns its setup and disposal. */
export interface ComparisonRenderer {
  /** Render, await completion and return copied pixels; honor cancellation. */
  frame(signal?: AbortSignal): Promise<ComparisonFrame>;
}

/** Settings for alternating same-page frame/read pairs. */
export interface ComparisonOptions {
  /** Number of pairs, 1..100. Default 1. */
  readonly runs?: number;
  /** Warmup pairs before collecting samples, 0..20. Default 2. */
  readonly warmup?: number;
  /** Collect elapsed frame/read times. Default false; smoke never reads a clock. */
  readonly timing?: boolean;
  /** Cancellation before and after every awaited renderer operation. */
  readonly signal?: AbortSignal;
}

/** RGB error in byte units; alpha is excluded from color metrics. */
export interface ImageDifference {
  /** Number of compared pixels. */
  readonly pixels: number;
  /** Mean absolute RGB channel error. */
  readonly mean: number;
  /** Maximum absolute channel error. */
  readonly maximum: number;
  /** Fraction of pixels whose mean RGB error exceeds eight byte levels. */
  readonly far8: number;
  /** Exact RGBA equality, including alpha. */
  readonly identical: boolean;
}

/** Alternating samples and the last copied images. No winner is inferred. */
export interface PairedComparison {
  /** Last frame of the first renderer. */
  readonly a: ComparisonFrame;
  /** Last frame of the second renderer. */
  readonly b: ComparisonFrame;
  /** RGB difference and exact RGBA equality of those frames. */
  readonly difference: ImageDifference;
  /** Raw frame/read samples, present only when timing was explicitly enabled. */
  readonly timing?: {
    readonly a: readonly number[];
    readonly b: readonly number[];
    readonly minimumA: number;
    readonly minimumB: number;
  };
}

function frameSize(frame: ComparisonFrame): void {
  if (!frame || typeof frame !== 'object')
    throw typeError('Comparison frame must contain dimensions and RGBA8 pixels; await the complete readback', 'sciviz');
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1)
    throw rangeError('Comparison dimensions must be positive safe integers; pass copied RGBA8 pixels', 'sciviz');
  const size = frame.width * frame.height * 4;
  if (!Number.isSafeInteger(size) || frame.rgba?.length !== size)
    throw rangeError('Comparison pixels must contain width * height * 4 bytes; copy the complete frame', 'sciviz');
  if (!(frame.rgba instanceof Uint8Array || frame.rgba instanceof Uint8ClampedArray))
    throw typeError(
      'Comparison pixels must be Uint8Array or Uint8ClampedArray; convert the readback to RGBA8',
      'sciviz',
    );
}

function abortableFrame(frame: Promise<ComparisonFrame>, signal?: AbortSignal): Promise<ComparisonFrame> {
  if (!signal) return frame;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    frame.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Compare full copied frames without resizing, alignment changes, masks or tolerance-based acceptance. */
export function imageDifference(a: ComparisonFrame, b: ComparisonFrame): ImageDifference {
  frameSize(a);
  frameSize(b);
  if (a.width !== b.width || a.height !== b.height)
    throw rangeError('Comparison frame dimensions differ; use the same pixel dimensions on both renderers', 'sciviz');
  let sum = 0,
    maximum = 0,
    far = 0,
    identical = true;
  for (let i = 0; i < a.rgba.length; i += 4) {
    let rgb = 0;
    for (let k = 0; k < 4; k++) {
      const delta = Math.abs(a.rgba[i + k] - b.rgba[i + k]);
      identical &&= delta === 0;
      if (k < 3) {
        rgb += delta;
        maximum = Math.max(maximum, delta);
      }
    }
    sum += rgb;
    if (rgb > 24) far++;
  }
  const pixels = a.width * a.height;
  return { pixels, mean: sum / (pixels * 3), maximum, far8: far / pixels, identical };
}

/** Alternate which renderer runs first; clocks are untouched unless timing is explicitly true. */
export async function pairedFrames(
  a: ComparisonRenderer,
  b: ComparisonRenderer,
  options: ComparisonOptions = {},
): Promise<PairedComparison> {
  const runs = options.runs ?? 1,
    warmup = options.warmup ?? 2,
    signal = options.signal;
  if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !Number.isInteger(warmup) || warmup < 0 || warmup > 20)
    throw rangeError('Comparison runs must be 1..100 and warmup 0..20; pass bounded pair counts', 'sciviz');
  if (typeof a?.frame !== 'function' || typeof b?.frame !== 'function')
    throw typeError('Comparison renderers need an async frame method; return copied RGBA8 pixels', 'sciviz');
  if (options.timing !== undefined && typeof options.timing !== 'boolean')
    throw typeError('Comparison timing must be boolean; omit it for a clock-free smoke', 'sciviz');
  const samplesA: number[] = [],
    samplesB: number[] = [];
  const read = async (renderer: ComparisonRenderer, samples?: number[]) => {
    signal?.throwIfAborted();
    const start = samples ? performance.now() : 0;
    const frame = await abortableFrame(renderer.frame(signal), signal);
    if (samples) samples.push(performance.now() - start);
    signal?.throwIfAborted();
    frameSize(frame);
    return frame;
  };
  for (let i = 0; i < warmup; i++) {
    await read(a);
    await read(b);
  }
  let lastA!: ComparisonFrame, lastB!: ComparisonFrame;
  for (let i = 0; i < runs; i++) {
    if (i % 2 === 0) {
      lastA = await read(a, options.timing ? samplesA : undefined);
      lastB = await read(b, options.timing ? samplesB : undefined);
    } else {
      lastB = await read(b, options.timing ? samplesB : undefined);
      lastA = await read(a, options.timing ? samplesA : undefined);
    }
  }
  return {
    a: lastA,
    b: lastB,
    difference: imageDifference(lastA, lastB),
    ...(options.timing
      ? { timing: { a: samplesA, b: samplesB, minimumA: Math.min(...samplesA), minimumB: Math.min(...samplesB) } }
      : {}),
  };
}
