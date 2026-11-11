// Kept apart from rapier-wasm.js: an entry imports this at start-up, the lazy solver chunk imports that.
import { wasmError } from './errors.js';

const noop = () => {};

/**
 * One app-wide load that waiting calls share. `value` is kept once loaded; a failed load is tried again by the next
 * call. A load is cancelled when every call waiting on it has been aborted; one call without a signal keeps it going.
 */
export class SharedLoad {
  value = null;
  #start;
  #loading = null;
  constructor(start) {
    this.#start = start;
  }
  #begin(options) {
    const controller = new AbortController(),
      promise = this.#start(options, controller.signal)
        .then(
          (value) => (this.value = value),
          (error) => {
            throw wasmError(error);
          },
        )
        .finally(() => {
          if (this.#loading?.promise === promise) this.#loading = null;
        });
    promise.catch(noop); // a cancelled load nobody waits on must not surface as an unhandled rejection
    return { promise, controller, waiting: 0 };
  }
  async load(options, signal) {
    signal?.throwIfAborted();
    if (this.value !== null) return this.value;
    const load = (this.#loading ??= this.#begin(options));
    if (!signal) {
      load.waiting = Infinity;
      return load.promise;
    }
    load.waiting++;
    let stop;
    const aborted = new Promise((_, reject) => {
      stop = () => {
        if (--load.waiting === 0) load.controller.abort(signal.reason);
        reject(signal.reason);
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([load.promise, aborted]);
    } finally {
      if (!signal.aborted) load.waiting--;
      signal.removeEventListener('abort', stop);
    }
  }
}
