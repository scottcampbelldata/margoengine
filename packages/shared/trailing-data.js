// Data after the end of a compressed stream (bug 39, measured 2026-10-28). The Compression Streams standard makes
// DecompressionStream reject it, and current browsers and Node 24 do; Node 22.12 accepts it for 'deflate' and
// 'deflate-raw' (and a trailing zero byte after 'gzip'), and Node 22.22 for 'deflate-raw', so a parser on those
// runtimes would take a malformed file that the
// same parser rejects everywhere else. hasTrailingData tells, for bytes that already decoded, whether they hold data
// after the stream's end: on a runtime that rejects trailing data (probed once per format) the decode itself already
// failed, so it answers false; on one that accepts it, it decodes the bytes without their last byte, which succeeds
// exactly when the stream ended before that byte. The fbx readers use it.

/** The smallest valid stream of each format (an empty payload). */
const EMPTY = {
  deflate: [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01],
  'deflate-raw': [0x03, 0x00],
  gzip: [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const lenient = new Map();

async function decodes(bytes, format) {
  try {
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Whether this runtime's DecompressionStream accepts data after the end of a `format` stream (cached). */
export function acceptsTrailingData(format) {
  if (!(format in EMPTY)) throw new TypeError(`format must be deflate, deflate-raw or gzip (got ${format})`);
  let probe = lenient.get(format);
  if (!probe) {
    probe = decodes(new Uint8Array([...EMPTY[format], 0]), format);
    lenient.set(format, probe);
  }
  return probe;
}

/** For `bytes` that decoded as `format`: whether data follows the end of the compressed stream. */
export async function hasTrailingData(bytes, format) {
  if (!(await acceptsTrailingData(format)) || bytes.byteLength === 0) return false;
  return decodes(bytes.subarray(0, bytes.byteLength - 1), format);
}
