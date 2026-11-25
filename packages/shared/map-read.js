// Maps a GPU buffer for reading, rejecting with the signal's reason when it aborts first. Shared by the readbacks
// (TerrainQuery.read in terrain/query, readScatter in scatter/read) so each waits and cleans up its listener the same way.
/** @param {GPUBuffer} buffer @param {AbortSignal} [signal] @returns {Promise<void>} */
export function mapRead(buffer, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
