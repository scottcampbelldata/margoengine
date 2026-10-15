import { Cleanup } from './cleanup.js';

export async function readBytes(stream, { maxBytes, signal, label = 'Asset', output = null }) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    (output !== null && (!(output instanceof Uint8Array) || output.length !== maxBytes))
  )
    throw new RangeError('Invalid asset byte budget');
  signal?.throwIfAborted();
  if (!stream) throw new TypeError(`Empty ${label} response`);
  const reader = stream.getReader(),
    chunks = [];
  let size = 0,
    cleanup = new Cleanup();
  const cancel = (reason) => {
    try {
      Promise.resolve(reader.cancel(reason)).catch(() => {});
    } catch {}
  };
  const aborted = () => cancel(signal.reason);
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError(`${label} stream requires byte chunks`);
      if (value.byteLength > maxBytes - size) throw new RangeError(`${label} byte budget exceeded`);
      if (output) output.set(value, size);
      else chunks.push(new Uint8Array(value));
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
    if (!response.ok) throw new Error(`${options.label ?? 'Asset'} request failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes)
      throw new RangeError(`${options.label ?? 'Asset'} byte budget exceeded`);
  } catch (error) {
    try {
      Promise.resolve(response.body?.cancel(error)).catch(() => {});
    } catch {}
    throw error;
  }
  return readBytes(response.body, options);
}
