// Waiting for a GPU page to be ready instead of for a number of frames or milliseconds. Pipelines compile in the
// background (createRenderPipelineAsync, createComputePipelineAsync), and how long that takes depends on the driver:
// an Intel Arc 140V took several times as long as this PC's RTX A6000, and five checks that waited "20 frames" or
// "300 ms" failed there (docs/known-bugs.md). scripts/check-fixed-waits.mjs keeps new fixed waits out of the checks.

/**
 * Page init script, installed by scripts/browser.js's openBrowser after any pipeline delay: counts the asynchronous
 * pipeline creations in flight in `globalThis.__margoPipelines` ({ pending, created }).
 */
export function trackPipelines() {
  if (typeof GPUDevice === 'undefined' || globalThis.__margoPipelines) return;
  const state = { pending: 0, created: 0 };
  globalThis.__margoPipelines = state;
  for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (...args) {
      const promise = original.apply(this, args);
      state.pending++;
      state.created++;
      const settle = () => {
        state.pending--;
      };
      promise.then(settle, settle);
      return promise;
    };
  }
}

/**
 * Calls `frame()` (render a frame and wait for the GPU) until two frames in a row started no pipeline, left none
 * compiling and saw `ready()` hold; the last of them was drawn with every pipeline in place. Resolves the milliseconds
 * it took. Throws after `timeoutMs` (default 20 s) naming what was still pending (`describe()` adds the page's own).
 * @param {() => void | Promise<void>} frame
 * @param {{ ready?: () => boolean, timeoutMs?: number, describe?: () => string }} [options]
 */
export async function waitForPipelines(frame, { ready = () => true, timeoutMs = 20000, describe = () => '' } = {}) {
  trackPipelines();
  const state = globalThis.__margoPipelines,
    t0 = performance.now();
  for (let calm = 0; calm < 2; ) {
    const before = state.created;
    await frame();
    calm = state.pending === 0 && state.created === before && ready() ? calm + 1 : 0;
    if (calm < 2 && performance.now() - t0 > timeoutMs)
      throw new Error(
        `not ready after ${Math.round(performance.now() - t0)} ms: ${state.pending} pipelines compiling ${describe()}`,
      );
  }
  return performance.now() - t0;
}
