// Binary glTF (GLB) container, from the glTF 2.0 specification section 4.4: the gltf and gltf-pro loaders, gltf-pro's
// streamed loader and the exporters writer, splitter and joiner share these constants and one chunk walker.
import { fault, typeError } from './errors.js';

/** 'glTF' magic, JSON chunk type and BIN chunk type, little-endian. */
export const GLB_MAGIC = 0x46546c67,
  GLB_JSON = 0x4e4f534a,
  GLB_BIN = 0x004e4942;

const bad = (problem) => typeError(`GLB ${problem}; pass a whole glTF 2.0 GLB file`, 'failed');

/**
 * Rejects a BIN chunk of `chunkLength` bytes that is more than 3 bytes longer than buffer 0's `byteLength`: glTF 2.0
 * section 4.4.3.3 allows only the padding to a 4-byte boundary, and the Khronos glTF Validator flags anything longer.
 * A `byteLength` that is not a safe integer is left to the caller's own buffer checks.
 */
export function checkBinChunk(chunkLength, byteLength) {
  if (Number.isSafeInteger(byteLength) && chunkLength > byteLength + 3)
    throw fault(
      'failed',
      `GLB BIN chunk holds ${chunkLength} bytes, more than buffer 0's byteLength ${byteLength} plus 3 padding bytes; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
    );
}

/** True when `bytes` start with the GLB magic. */
export const isGLB = (bytes) =>
  bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC;

/**
 * The chunks of a whole GLB file, `[{ type, data }]`, JSON first: checks the 12-byte header (magic, version 2, total
 * length), chunk bounds and 4-byte alignment, and that the BIN chunk, when present, is the only one and comes second.
 * Chunk `data` are views of `bytes`. Later chunks of other types are kept.
 */
export function glbChunks(bytes) {
  if (bytes.length < 20)
    throw bad(
      `needs at least 20 bytes for its 12-byte file header and 8-byte JSON chunk header; received ${bytes.length}`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true),
    version = view.getUint32(4, true),
    totalLength = view.getUint32(8, true);
  if (magic !== GLB_MAGIC) throw bad(`header magic 0x${magic.toString(16)} is not glTF (0x46546c67)`);
  if (version !== 2) throw bad(`header version ${version} is unsupported; use version 2`);
  if (totalLength !== bytes.length)
    throw bad(`header total length ${totalLength} bytes differs from the received ${bytes.length} bytes`);
  const chunks = [];
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) throw bad(`ends inside the 8-byte chunk header at byte ${at}`);
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true),
      end = at + 8 + length;
    if (length % 4) throw bad(`chunk length ${length} at byte ${at} must have 4-byte alignment`);
    if (end > bytes.length)
      throw bad(`chunk length ${length} at byte ${at} extends past the ${bytes.length}-byte file`);
    if ((chunks.length === 0) !== (type === GLB_JSON) || (type === GLB_BIN && chunks.length !== 1))
      throw bad('chunks must be JSON first, then at most one BIN second; export the file again');
    chunks.push({ type, data: bytes.subarray(at + 8, end) });
    at = end;
  }
  return chunks;
}
