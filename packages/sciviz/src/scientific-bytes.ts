import { rangeError } from '../../shared/errors.js';
import { whole } from './engineering-common.js';
import { byteLimit, type FileInput, type FileOptions } from './file-source.js';

/** Bounded gzip envelope shared by scientific image readers. */
export async function scientificBytes(input: FileInput, options: FileOptions): Promise<Uint8Array> {
  const max = byteLimit(options.maxBytes);
  const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > max)
          throw rangeError('Scientific image output exceeds maxBytes; raise the bound for a trusted file', 'sciviz');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    options.signal?.throwIfAborted();
    const result = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      result.set(chunk, at);
      at += chunk.length;
    }
    return result;
  };
  let bytes: Uint8Array;
  if (typeof input === 'string' || input instanceof URL) {
    // Full-file formats use a full response. HTTP Content-Encoding is decoded by fetch;
    // its compressed byte ranges do not address the decoded representation.
    const response = await fetch(input, { signal: options.signal });
    if (!response.ok || !response.body)
      throw rangeError(`Scientific image fetch answered ${response.status}; check the source URL`, 'sciviz');
    bytes = await collect(response.body.getReader());
  } else bytes = await whole(input, options);
  if (bytes[0] !== 31 || bytes[1] !== 139) return bytes;
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
    reader = stream.getReader();
  return collect(reader);
}
