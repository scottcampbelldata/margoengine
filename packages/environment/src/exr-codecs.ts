import type { FloatImage } from './hdr.js';
import { MargoError } from '@margoengine/math/errors';

declare const process: { versions?: { node?: string } };
interface HostWorker {
  postMessage(value: unknown, transfer: ArrayBuffer[]): void;
  terminate(): unknown;
  on?: (event: string, callback: (value: unknown) => void) => unknown;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
}
const nodeModule = <T>(name: string): Promise<T> => import(/* @vite-ignore */ name) as Promise<T>;

/** Bounds, selection and cancellation for the optional complete EXR decoder. */
export interface EXRCodecOptions {
  /** Cancels fetch and ends an in-flight decoding worker. */
  signal?: AbortSignal;
  /** Largest input file. Default 256 MiB. */
  maxBytes?: number;
  /** Largest selected data window in pixels. Default 2^26. */
  maxPixels?: number;
  /** Hard worker lifetime in milliseconds. Default 30000. */
  timeout?: number;
  /** Part to decode in a multipart file. Default 0. */
  part?: number;
  /** RGB/Y channel prefix, without the final dot. Default: unprefixed color, or the first color layer. */
  layer?: string;
}

/** Selected EXR data window as linear RGBA, row zero at its minimum Y. Native lossy codec precision is retained. */
export interface CodecEXRImage extends FloatImage {
  /** Codec name from the file. */
  compression: string;
  /** Selected storage kind. Tiled files decode their full-resolution level (0,0). */
  storage: string;
  /** Inclusive minimum and maximum pixel coordinates in the file. */
  dataWindow: { min: [number, number]; max: [number, number] };
  /** Inclusive display bounds, which need not equal the data window. */
  displayWindow: { min: [number, number]; max: [number, number] };
  /** Names of the decoded R/G/B or Y and optional A channels. */
  channelNames: string[];
}

const whole = (n: number, label: string, min: number) => {
  if (!Number.isSafeInteger(n) || n < min)
    throw new RangeError(`EXR ${label} must be a whole number of at least ${min}; adjust the decode options`);
  return n;
};

/**
 * Decode EXR files including PXR24, B44/B44A and DWAA/DWAB, and full-resolution tiled images.
 * The standard prebuilt OpenEXR decoder loads only inside this call's worker, which is terminated on completion,
 * error, timeout or cancellation. The package root and engines never load it implicitly.
 */
export async function decodeEXR(
  input: ArrayBuffer | ArrayBufferView,
  options: EXRCodecOptions = {},
): Promise<CodecEXRImage> {
  options.signal?.throwIfAborted();
  const maxBytes = whole(options.maxBytes ?? 256 * 1024 ** 2, 'maxBytes', 1);
  const maxPixels = whole(options.maxPixels ?? 2 ** 26, 'maxPixels', 1);
  const timeout = whole(options.timeout ?? 30000, 'timeout', 1);
  if (timeout > 2147483647) throw new RangeError('EXR timeout must fit a timer; use at most 2147483647 milliseconds');
  const part = whole(options.part ?? 0, 'part', 0);
  if (options.layer !== undefined && typeof options.layer !== 'string')
    throw new TypeError('EXR layer must be a string; pass a channel prefix without its final dot');
  const source =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (source.byteLength > maxBytes) throw new RangeError('EXR exceeds maxBytes; raise the limit or use a smaller file');
  if (
    source.length < 8 ||
    new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(0, true) !== 20000630
  )
    throw new MargoError('failed', 'EXR signature is missing; provide an OpenEXR file');
  const data = Uint8Array.from(source);
  const workerURL = new URL(/* @vite-ignore */ './workers/exr-codecs.js?no-inline', import.meta.url);
  const node = typeof process !== 'undefined' && !!process.versions?.node;
  const worker: HostWorker = node
    ? new (await nodeModule<{ Worker: new (url: URL) => HostWorker }>('node:worker_threads')).Worker(workerURL)
    : new Worker(workerURL, { type: 'module' });
  if (options.signal?.aborted) {
    void worker.terminate();
    options.signal.throwIfAborted();
  }
  return new Promise<CodecEXRImage>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: CodecEXRImage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (value === undefined) reject(error);
      else resolve(value);
    };
    const abort = () => finish(options.signal!.reason);
    const timer = setTimeout(
      () => finish(new MargoError('timeout', 'EXR decode exceeded its timeout; raise timeout for a larger image')),
      timeout,
    );
    const message = (reply: { image?: CodecEXRImage; error?: { kind: string; message: string } }) => {
      if (reply.error)
        finish(
          reply.error.kind === 'range'
            ? new RangeError(reply.error.message)
            : new MargoError(reply.error.kind === 'unsupported' ? 'unsupported' : 'failed', reply.error.message),
        );
      else finish(undefined, reply.image);
    };
    if (worker.on) {
      worker.on('message', (value) => message(value as Parameters<typeof message>[0]));
      worker.on('error', finish);
      worker.on('exit', (code) => {
        if (!settled) finish(new MargoError('failed', `EXR worker exited (${code}); check the file and memory limits`));
      });
    } else {
      worker.onmessage = (event) => message(event.data);
      worker.onerror = () =>
        finish(new MargoError('failed', 'EXR worker failed; check worker, decoder and Wasm URLs and CSP'));
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(
      {
        data,
        maxPixels,
        part,
        layer: options.layer,
        module: new URL(/* @vite-ignore */ './vendor/exr-codecs/exrview.mjs?no-inline', import.meta.url).href,
        commonjs: new URL(/* @vite-ignore */ './vendor/exr-codecs/exrview.cjs?no-inline', import.meta.url).href,
        wasm: new URL(/* @vite-ignore */ './vendor/exr-codecs/exrview.wasm?no-inline', import.meta.url).href,
      },
      [data.buffer],
    );
  });
}

/** Fetch and decode an EXR URL with the same codec coverage, bounds and worker cancellation as decodeEXR. */
export async function loadEXR(url: string | URL, options: EXRCodecOptions = {}): Promise<CodecEXRImage> {
  options.signal?.throwIfAborted();
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new MargoError('failed', `EXR fetch returned ${response.status}; check the file URL`);
  const max = whole(options.maxBytes ?? 256 * 1024 ** 2, 'maxBytes', 1);
  const length = Number(response.headers.get('content-length'));
  if (length > max) {
    await response.body?.cancel();
    throw new RangeError('EXR exceeds maxBytes; raise the limit or use a smaller file');
  }
  const reader = response.body?.getReader();
  if (!reader) return decodeEXR(await response.arrayBuffer(), options);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new RangeError('EXR exceeds maxBytes; raise the limit or use a smaller file');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) {
    data.set(chunk, p);
    p += chunk.length;
  }
  return decodeEXR(data, options);
}
