/**
 * Maps `buffer` for reading (`GPUMapMode.READ`); rejects with `signal.reason` when the signal aborts first, or with the
 * map's own error. The abort listener is removed once the map settles.
 */
export declare function mapRead(buffer: GPUBuffer, signal?: AbortSignal): Promise<void>;
