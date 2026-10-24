// Binary glTF (GLB) container, from the glTF 2.0 specification section 4.4: the gltf and gltf-pro loaders, gltf-pro's
// streamed loader and the exporters writer, splitter and joiner share these constants and one chunk walker.

/** 'glTF' magic, JSON chunk type and BIN chunk type, little-endian. */
export const GLB_MAGIC = 0x46546c67,
  GLB_JSON = 0x4e4f534a,
  GLB_BIN = 0x004e4942;

const bad = (problem) => new TypeError(`GLB ${problem}; pass a whole glTF 2.0 GLB file`);

/** True when `bytes` start with the GLB magic. */
export const isGLB = (bytes) =>
  bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC;

/**
 * The chunks of a whole GLB file, `[{ type, data }]`, JSON first: checks the 12-byte header (magic, version 2, total
 * length), chunk bounds and 4-byte alignment, and that the BIN chunk, when present, is the only one and comes second.
 * Chunk `data` are views of `bytes`. Later chunks of other types are kept.
 */
export function glbChunks(bytes) {
  if (bytes.length < 20) throw bad('is shorter than its header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== GLB_MAGIC ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length
  )
    throw bad('header is wrong');
  const chunks = [];
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) throw bad('ends inside a chunk');
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true),
      end = at + 8 + length;
    if (length % 4 || end > bytes.length) throw bad('chunk is misaligned or too long');
    if ((chunks.length === 0) !== (type === GLB_JSON) || (type === GLB_BIN && chunks.length !== 1))
      throw bad('chunks are not JSON then BIN');
    chunks.push({ type, data: bytes.subarray(at + 8, end) });
    at = end;
  }
  return chunks;
}
