// One-shot parser workers (gltf-pro, fbx, usdz, loaders): the client posts one job, takes the reply and terminates the
// worker. ArrayBuffers and ImageBitmaps move in both directions without copies.

/** Every ArrayBuffer (behind typed arrays too) and ImageBitmap reachable from value, once each. */
export function transferables(root, out = new Set(), seen = new Set()) {
  // An explicit stack, not recursion: a parsed file's JSON (a glTF's extras) can nest deeper than the call stack.
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) out.add(value.buffer);
    } else if (value instanceof ArrayBuffer) out.add(value);
    else if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) out.add(value);
    else if (value instanceof Map) for (const [k, v] of value) stack.push(k, v);
    else for (const key in value) stack.push(value[key]);
  }
  return out;
}

/** Bytes as an ArrayBuffer to post: a whole ArrayBuffer moves (the caller's copy is detached), anything else is copied. */
export function movable(input) {
  if (input instanceof ArrayBuffer) return input;
  if (
    ArrayBuffer.isView(input) &&
    input.buffer instanceof ArrayBuffer &&
    input.byteOffset === 0 &&
    input.byteLength === input.buffer.byteLength
  )
    return input.buffer;
  if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  if (typeof input === 'string') return input;
  throw new TypeError('Expected an ArrayBuffer, typed array or string');
}

/** True when this context can start a worker (browsers, including inside a worker); false during SSR and in Node. */
export const canUseWorker = () => typeof Worker === 'function' && typeof globalThis.location !== 'undefined';

const errors = { TypeError, RangeError, SyntaxError };
/** A worker's {name, message} as an Error; only the listed names map to their classes (own keys, so not `constructor`). */
const reviveError = ({ name, message }) =>
  new (Object.hasOwn(errors, name) ? errors[name] : Error)(
    typeof message === 'string' ? message : 'Parser worker failed',
  );

/** Post one job to a fresh worker and resolve its result. Aborting terminates the worker. revive rebuilds package error classes. */
export function runWorker(url, message, signal, revive) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { name: 'margoengine-parser' });
    const done = () => {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      done();
      reject(error);
    };
    const abort = () => fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault?.();
      fail(new Error('Parser worker failed: ' + (event.message || 'unknown error')));
    };
    worker.onmessageerror = () => fail(new Error('Parser worker reply could not be deserialized'));
    worker.onmessage = ({ data }) => {
      done();
      if (!data || typeof data !== 'object') reject(new TypeError('Parser worker sent an invalid reply'));
      else if (data.error) reject(revive?.(data.error) ?? reviveError(data.error));
      else resolve(data.result);
    };
    try {
      worker.postMessage(message, [...transferables(message)]);
    } catch (error) {
      fail(error);
    }
  });
}

/** Worker side: answer each message with job(message), transferring the result's buffers and bitmaps. */
export function serve(job) {
  self.onmessage = async ({ data }) => {
    try {
      if (!data || typeof data !== 'object') throw new TypeError('Invalid parser worker job');
      const result = await job(data);
      self.postMessage({ result }, [...transferables(result)]);
    } catch (error) {
      const reply = { name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error) };
      try {
        self.postMessage({ error: { ...error, ...reply } });
      } catch {
        self.postMessage({ error: reply }); // a property that cannot be cloned must not leave the caller waiting
      }
    }
  };
}
