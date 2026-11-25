// Waiting for a GPU page to be ready instead of for a number of frames or milliseconds. Pipelines compile in the
// background (createRenderPipelineAsync, createComputePipelineAsync), and how long that takes depends on the driver:
// an Intel Arc 140V took several times as long as this PC's RTX A6000, and five checks that waited "20 frames" or
// "300 ms" failed there (docs/known-bugs.md). scripts/check-fixed-waits.mjs keeps new fixed waits out of the checks.

/**
 * Page init script, installed by scripts/browser.js's openBrowser after any pipeline delay: counts the asynchronous
 * pipeline creations in flight in `globalThis.__margoPipelines` ({ pending, created, names }), `names` holding the
 * label of each one still compiling (scripts/support/compat-shim.js counts the WebGL2 layer's the same way).
 */
export function trackPipelines() {
  if (typeof GPUDevice === 'undefined' || globalThis.__margoPipelines) return;
  const state = { pending: 0, created: 0, names: [] };
  globalThis.__margoPipelines = state;
  for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (...args) {
      const promise = original.apply(this, args),
        label = args[0]?.label || `unlabelled ${name}`;
      state.pending++;
      state.created++;
      state.names.push(label);
      const settle = () => {
        state.pending--;
        state.names.splice(state.names.indexOf(label), 1);
      };
      promise.then(settle, settle);
      return promise;
    };
  }
}

/**
 * Calls `frame()` (render a frame and wait for the GPU) until two frames in a row started no pipeline, left none
 * compiling and saw `ready()` hold; the last of them was drawn with every pipeline in place. Resolves the milliseconds
 * it took. Throws once `timeoutMs` (default 20 s) has passed and the last frame still left something outstanding: a
 * pipeline compiling (named by its label), one started during that frame, or `ready()` false (`describe()` adds the
 * page's own). A frame that left nothing outstanding never throws, however long it took: the wait then draws the one
 * confirming frame. The time limit bounds the wait for pipelines and `ready()`, not the frames themselves (one frame on
 * the WebGL2 layer drew for 25 to 29 s under load with nothing pending, docs/known-bugs.md KB-GPUREADY-CALM); a frame
 * that never returns is the caller's own hard time limit to catch.
 * @param {() => void | Promise<void>} frame
 * @param {{ ready?: () => boolean, timeoutMs?: number, describe?: () => string }} [options]
 */
export async function waitForPipelines(frame, { ready = () => true, timeoutMs = 20000, describe = () => '' } = {}) {
  trackPipelines();
  const state = globalThis.__margoPipelines,
    t0 = performance.now();
  for (let calm = 0, frames = 0; calm < 2; frames++) {
    const before = state.created;
    await frame();
    const started = state.created - before,
      quiet = state.pending === 0 && started === 0,
      held = quiet && ready();
    calm = held ? calm + 1 : 0;
    if (calm === 0 && performance.now() - t0 > timeoutMs)
      throw new Error(
        `not ready after ${Math.round(performance.now() - t0)} ms and ${frames + 1} frames: ${state.pending} pipelines ` +
          `compiling${state.names?.length ? ` (${state.names.join(', ')})` : ''}, ${started} started in the last ` +
          `frame${quiet ? ', ready() false' : ''} ${describe()}`,
      );
  }
  return performance.now() - t0;
}
