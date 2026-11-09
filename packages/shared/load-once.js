import { wasmError } from './errors.js';

// One asynchronous load shared by every caller: an app-wide solver or decoder that must be ready before synchronous
// constructors run. Calls during a load share it, a loaded value is kept, and a failed load is tried again by the next
// call. A signal stops one caller's wait; the load carries on for the others.
export class LoadOnce {
  /** The loaded value; null until a load has finished. */
  value = null;
  #load;
  #pending = null;
  constructor(load) {
    this.#load = load;
  }
  async load(signal) {
    signal?.throwIfAborted();
    if (this.value !== null) return this.value;
    const pending = (this.#pending ??= this.#start());
    if (!signal) return pending;
    let stop;
    const aborted = new Promise((_, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  async #start() {
    try {
      return (this.value = await this.#load());
    } catch (error) {
      throw wasmError(error);
    } finally {
      this.#pending = null;
    }
  }
}
