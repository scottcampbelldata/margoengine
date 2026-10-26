// Minimal ZIP reader (stored and deflated entries) and stream helpers, written from the public ZIP file format
// description (PKWARE APPNOTE). Inflate uses the platform's DecompressionStream.
import { MargoError } from '@margoengine/math/errors';

/** Inflates `bytes` with the platform decompressor (`'gzip'` or raw `'deflate-raw'`). */
export async function inflate(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw',
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (typeof DecompressionStream === 'undefined')
    throw new MargoError('unsupported', 'This runtime has no DecompressionStream; use a current browser or Node 18+.');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw new RangeError(
      `The compressed data is damaged (${(cause as Error).message}); check that the file is complete.`,
    );
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Reads every file of a ZIP archive into a name to bytes map. */
export async function readZip(bytes: Uint8Array, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bad = (why: string): never => {
      throw new RangeError(`Not a readable ZIP archive: ${why}; check that the file is complete.`);
    };
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--)
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  if (eocd < 0) bad('no end-of-directory record');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff)
    throw new MargoError('unsupported', 'ZIP64 archives are not supported; re-export the SOG.');
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) bad('a damaged central directory');
    const method = view.getUint16(at + 10, true),
      compressed = view.getUint32(at + 20, true),
      size = view.getUint32(at + 24, true),
      nameLength = view.getUint16(at + 28, true),
      extraLength = view.getUint16(at + 30, true),
      commentLength = view.getUint16(at + 32, true),
      local = view.getUint32(at + 42, true),
      name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) bad('a damaged local header');
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataAt + compressed > bytes.length) bad('an entry that runs past the end of the file');
    const raw = bytes.subarray(dataAt, dataAt + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw, 'deflate-raw', signal);
    else
      throw new MargoError(
        'unsupported',
        `ZIP entry ${name} uses compression method ${method}; only stored and deflate are supported.`,
      );
    if (data.length !== size) bad(`entry ${name} has the wrong size`);
    files.set(name, data);
  }
  return files;
}
