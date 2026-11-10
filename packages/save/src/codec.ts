// Bytes for storage: UTF-8 JSON, optionally gzip through the platform's CompressionStream (browsers and Node 18+), so
// the package ships no compressor. decodeSave recognises gzip by its magic bytes (RFC 1952), whichever way a save
// was written.
import { MargoError } from '@margoengine/math/errors';

/** Options of {@link encodeSave}. */
export interface EncodeOptions {
  /** Gzip the JSON (default false). Saves of repetitive worlds shrink several times. */
  compress?: boolean;
  /** Stops the work; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

const pipe = async (
  bytes: Uint8Array<ArrayBuffer>,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  // Aborting errors the stream, so the write and the output below reject with the reason; that is where it surfaces.
  const abort = (): void => void writer.abort(signal!.reason).then(undefined, () => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const writing = (async () => {
      await writer.write(bytes);
      await writer.close();
    })();
    // Wait for both, so a failure of either is handled once.
    const [, buffer] = await Promise.all([writing, output]);
    signal?.throwIfAborted();
    return new Uint8Array(buffer);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};

const compression = (): typeof CompressionStream => {
  if (typeof CompressionStream !== 'function')
    throw new MargoError(
      'unsupported',
      'CompressionStream is not available here; save with compress: false or use a current browser or Node 18+',
    );
  return CompressionStream;
};

/** A save document (or any JSON value) as bytes: UTF-8 JSON, gzipped with `compress: true`. */
export async function encodeSave(document: unknown, options: EncodeOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  if (!options.compress) return bytes;
  return pipe(bytes, new (compression())('gzip'), options.signal);
}

/** Options of {@link decodeSave}. */
export interface DecodeOptions {
  /** Stops the work; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Largest decompressed size accepted, in bytes. Default 268435456 (256 MiB). A gzip member can expand about a
   * thousand times, so a small hostile file would otherwise fill memory before the JSON is ever read.
   */
  maxBytes?: number;
}

/** Gunzips `bytes`, stopping as soon as the output passes `max` bytes. */
async function inflate(bytes: Uint8Array<ArrayBuffer>, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip'),
    writer = stream.writable.getWriter(),
    reader = stream.readable.getReader(),
    chunks: Uint8Array[] = [];
  const stop = (reason: unknown): void => {
    void writer.abort(reason).then(undefined, () => undefined);
    void reader.cancel(reason).then(undefined, () => undefined);
  };
  const abort = (): void => stop(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  // The write settles only as the output is read, so it is not awaited before reading; its failure surfaces below.
  const writing = writer.write(bytes).then(() => writer.close());
  writing.catch(() => undefined);
  try {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        const error = new RangeError(
          `Save decompresses past ${max} bytes; it is not a save of this game, or pass a larger maxBytes to decodeSave`,
        );
        stop(error);
        throw error;
      }
      chunks.push(value);
    }
    await writing;
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Bytes written by {@link encodeSave} (gzipped or not) back to a JSON value. Validate it with `parseSave` before use.
 * @throws TypeError when the bytes are not a save (damaged gzip, not UTF-8 JSON), naming the fix.
 * @throws RangeError when gzip data decompresses past `maxBytes`.
 */
export async function decodeSave(bytes: Uint8Array, options: DecodeOptions = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Save bytes must be a Uint8Array; read the file as bytes');
  const max = options.maxBytes ?? 268_435_456;
  if (!(Number.isSafeInteger(max) && max >= 0))
    throw new RangeError('decodeSave maxBytes must be a whole number of bytes, 0 or more');
  let data = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function')
      throw new MargoError(
        'unsupported',
        'DecompressionStream is not available here; load gzipped saves in a current browser or Node 18+',
      );
    try {
      data = await inflate(new Uint8Array(bytes), max, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof RangeError) throw error;
      throw Object.assign(
        new TypeError('Save is damaged: its gzip data does not decompress; restore the file from a backup'),
        { cause: error },
      );
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch (error) {
    throw Object.assign(new TypeError('Save is not UTF-8 text; the file is damaged or not a save'), { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(
      new TypeError(`Save is not valid JSON (${(error as Error).message}); the file is damaged or not a save`),
      { cause: error },
    );
  }
}
