import { margoError } from './errors.js';
/** Wait for submitted scene work and a browser presentation opportunity.
 * @param {{onSubmittedWorkDone(): Promise<void>}} queue
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export async function afterPresented(queue, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    let frame = 0,
      settled = false;
    const cleanup = () => {
      settled = true;
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    queue.onSubmittedWorkDone().then(
      () => {
        if (settled) return;
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            cleanup();
            resolve();
          });
        });
      },
      (error) => {
        if (!settled) {
          cleanup();
          reject(error);
        }
      },
    );
  });
}

/** Correlate an assembled scene render to its last submission and presentation opportunity. */
export async function submitPrincipalScene(
  render,
  queue,
  { signal, now = () => performance.now(), request = requestAnimationFrame, cancel = cancelAnimationFrame } = {},
) {
  signal?.throwIfAborted();
  const result = {
    principalSceneSubmitted: null,
    principalSceneGpuComplete: null,
    principalScenePresentedOpportunity: null,
    correlation: queue ? 'identified-webgpu-submit' : 'webgl-render-return',
  };
  let completion;
  if (queue) {
    const descriptor = Object.getOwnPropertyDescriptor(queue, 'submit'),
      original = queue.submit;
    function submit(...args) {
      const value = original.apply(this, args);
      result.principalSceneSubmitted = now();
      return value;
    }
    Object.defineProperty(queue, 'submit', {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: submit,
    });
    try {
      render();
    } finally {
      if (queue.submit === submit) {
        if (descriptor) Object.defineProperty(queue, 'submit', descriptor);
        else delete queue.submit;
      }
    }
    if (result.principalSceneSubmitted === null)
      throw margoError(
        'failed',
        'The principal scene render did not submit GPU work; render the scene through the engine before reporting ready',
      );
    completion = queue.onSubmittedWorkDone().then(() => {
      result.principalSceneGpuComplete = now();
    });
  } else {
    render();
    completion = Promise.resolve();
  }
  await new Promise((resolve, reject) => {
    let frame = 0,
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cancel(frame);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException('Page closed', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    completion.then(() => {
      if (settled) return;
      frame = request(() => {
        frame = request(() => {
          result.principalScenePresentedOpportunity = now();
          finish();
        });
      });
    }, finish);
  });
  return result;
}
