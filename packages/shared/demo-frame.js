/** Wait for submitted scene work and a browser presentation opportunity.
 * @param {{onSubmittedWorkDone(): Promise<void>}} queue
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export async function afterPresented(queue, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    let frame = 0, settled = false;
    const cleanup = () => {settled = true;cancelAnimationFrame(frame);signal.removeEventListener('abort', cancel);};
    const cancel = () => {cleanup();reject(signal.reason);};
    signal.addEventListener('abort', cancel, {once: true});
    queue.onSubmittedWorkDone().then(() => {
      if (settled) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {cleanup();resolve();});
      });
    }, error => {if (!settled) {cleanup();reject(error);}});
  });
}
