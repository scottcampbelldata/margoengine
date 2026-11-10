import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Random access to an immutable file. Reads may be shorter only at EOF. */
export interface FileSource {
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** A URL, owned in-memory snapshot, or caller supplied random-access file. */
export type FileInput = string | URL | ArrayBuffer | ArrayBufferView | FileSource;

/** File loading bounds, independent of the size of a remote file. */
export interface FileOptions {
  /** Lifetime cancellation, including subsequent lazy reads. */
  signal?: AbortSignal;
  /** Largest header or individual read, in bytes. Default 64 MiB. */
  maxBytes?: number;
}

export function byteLimit(value = 64 * 1024 * 1024): number {
  if (!Number.isSafeInteger(value) || value < 32)
    throw rangeError('maxBytes must be an integer of at least 32', 'sciviz');
  return value;
}

/** Validated HTTP byte ranges. A server ignoring Range is accepted only within the read bound. */
export function fileSource(input: FileInput, maxBytes: number): FileSource {
  if (typeof input === 'string' || input instanceof URL)
    return {
      async read(offset, length, signal) {
        signal?.throwIfAborted();
        if (!length) return new Uint8Array();
        const response = await fetch(input, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal });
        if (!response.ok) throw fault('failed', `File fetch failed: HTTP ${response.status}`, 'sciviz');
        let declared: number | undefined;
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '');
          if (!match || Number(match[1]) !== offset || Number(match[2]) >= offset + length)
            throw rangeError('File response has an incorrect Content-Range', 'sciviz');
          declared = Number(match[2]) - offset + 1;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw rangeError('File response has no body', 'sciviz');
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > (response.status === 206 ? length : maxBytes))
              throw rangeError('File response exceeds the bounded read', 'sciviz');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        if (declared !== undefined && declared !== size)
          throw rangeError('File response length differs from Content-Range', 'sciviz');
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        return response.status === 206 ? bytes : bytes.slice(offset, offset + length);
      },
    };
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input).slice()
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
    return {
      async read(offset, length, signal) {
        signal?.throwIfAborted();
        return bytes.slice(offset, offset + length);
      },
    };
  }
  if (input && typeof input.read === 'function') return input;
  throw typeError('A file needs a URL, bytes or a FileSource', 'sciviz');
}

export async function readBytes(
  source: FileSource,
  offset: number,
  length: number,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > max ||
    !Number.isSafeInteger(offset + length)
  )
    throw rangeError('File read is outside the safe byte bound', 'sciviz');
  const bytes = await source.read(offset, length, signal);
  signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.length > length)
    throw rangeError('FileSource returned an invalid byte range', 'sciviz');
  return bytes;
}
