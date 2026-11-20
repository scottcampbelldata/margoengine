import { margoError } from './errors.js';
import { Cleanup } from './cleanup.js';

// Each chunk is held once, as it arrived, and the result is built with one copy (KB-LOADBYTES1). With `expected`
// (a declared length within the budget) the bytes go straight into one buffer of that size, returned as is when the
// stream delivers exactly that many: no copy, and never more than the file plus one chunk held.
export async function readBytes(stream, { maxBytes, signal, label = 'Asset', output = null, expected = 0 }) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    (output !== null && (!(output instanceof Uint8Array) || output.length !== maxBytes))
  )
    throw new RangeError('Invalid asset byte budget; pass maxBytes as an integer');
  signal?.throwIfAborted();
  if (!stream) throw new TypeError(`Empty ${label} response; check the URL`);
  const reader = stream.getReader(),
    chunks = [];
  let size = 0,
    filled = output,
    cleanup = new Cleanup();
  const cancel = (reason) => {
    try {
      Promise.resolve(reader.cancel(reason)).catch(() => {});
    } catch {}
  };
  const aborted = () => cancel(signal.reason);
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    if (!output && Number.isSafeInteger(expected) && expected > 0 && expected <= maxBytes)
      filled = new Uint8Array(expected);
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError(`${label} stream requires byte chunks`);
      if (value.byteLength > maxBytes - size) throw new RangeError(`${label} byte budget exceeded; raise maxBytes`);
      if (filled && value.length <= filled.length - size) filled.set(value, size);
      else {
        // More than the declared length (a decoded body, say): keep what is filled and go on in chunks.
        if (filled) chunks.push(filled.subarray(0, size));
        filled = null;
        // A view into a larger or shared buffer is copied, so a held chunk never keeps more than its own bytes.
        chunks.push(
          value.length < value.buffer.byteLength || !(value.buffer instanceof ArrayBuffer) ? value.slice() : value,
        );
      }
      size += value.byteLength;
    }
  } catch (error) {
    cancel(error);
    cleanup = new Cleanup(error);
  }
  cleanup
    .run(() => signal?.removeEventListener('abort', aborted))
    .run(() => reader.releaseLock())
    .finish();
  if (output) return output.subarray(0, size);
  if (filled) return size < filled.length ? filled.slice(0, size) : filled;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function readResponse(response, options) {
  try {
    options.signal?.throwIfAborted();
    if (!response.ok)
      throw margoError(
        'failed',
        `${options.label ?? 'Asset'} request failed: HTTP ${response.status}; check the URL and that the server serves it`,
      );
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes)
      throw new RangeError(`${options.label ?? 'Asset'} byte budget exceeded; raise maxBytes`);
    // A declared length counts the decoded body only when the body is not content-coded.
    const coding = response.headers.get('content-encoding');
    if (!coding || coding === 'identity') options = { ...options, expected: declared };
  } catch (error) {
    try {
      Promise.resolve(response.body?.cancel(error)).catch(() => {});
    } catch {}
    throw error;
  }
  return readBytes(response.body, options);
}
