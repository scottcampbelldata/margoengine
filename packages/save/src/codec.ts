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

/**
 * Bytes written by {@link encodeSave} (gzipped or not) back to a JSON value. Validate it with `parseSave` before use.
 * @throws TypeError when the bytes are not a save (damaged gzip, not UTF-8 JSON), naming the fix.
 */
export async function decodeSave(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Save bytes must be a Uint8Array; read the file as bytes');
  let data = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function')
      throw new MargoError(
        'unsupported',
        'DecompressionStream is not available here; load gzipped saves in a current browser or Node 18+',
      );
    try {
      data = await pipe(new Uint8Array(bytes), new DecompressionStream('gzip'), options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
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
