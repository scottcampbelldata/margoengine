// A document the tab has navigated away from runs no more of its WebGPU continuations (KB-L4-W1, found 2026-11-11).
//
// Playwright's WebKit keeps resolving the WebGPU promises of a document after the tab has navigated away from it, so
// a page whose start-up was still waiting on the GPU carries on in the background, with no page: hidden, innerWidth 0,
// devicePixelRatio 0, its canvas at the default 300 x 150. Every document of a tab shares one `window` object (the
// WindowProxy), so what that script then writes through `window` (`window.ready = true`, `window.check = {...}`) lands
// on the document the tab now shows. The sky browser check met it on the Mac: openBrowser loads the start page, the
// check navigates to it again at once, and in about 1 run in 10 from a fresh folder (first-load module transforms keep
// the first document starting up for longer) its first `check.run` was the old document's, rendering at 300 x 150.
// Chromium and Firefox stop a document's script when the tab leaves it.
//
// Install `holdStaleDocumentGpu` as an init script (scripts/browser.js does, in every page it opens). Once the
// document's `pagehide` has fired, each WebGPU promise it settles is held instead of resolved, so the document's
// script stops at its next GPU wait. A document the back/forward cache shows again (`pageshow` with `persisted`) gets
// every held result, in order, and carries on.

/** Init script: holds the WebGPU promises of a document once the tab has left it; see the file comment. */
export function holdStaleDocumentGpu() {
  if (typeof GPU === 'undefined' || GPU.prototype.requestAdapter.margoStaleDocument) return;
  let gone = false;
  const held = [];
  addEventListener('pagehide', () => {
    gone = true;
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    gone = false;
    for (const release of held.splice(0)) release();
  });
  const hold = (promise) =>
    promise.then(
      (value) => (gone ? new Promise((resolve) => held.push(() => resolve(value))) : value),
      (error) => (gone ? new Promise((_, reject) => held.push(() => reject(error))) : Promise.reject(error)),
    );
  const wrap = (prototype, name) => {
    const original = prototype?.[name];
    if (typeof original !== 'function') return;
    const guarded = function (...args) {
      return hold(original.apply(this, args));
    };
    guarded.margoStaleDocument = true;
    prototype[name] = guarded;
  };
  wrap(GPU.prototype, 'requestAdapter');
  wrap(globalThis.GPUAdapter?.prototype, 'requestDevice');
  wrap(globalThis.GPUQueue?.prototype, 'onSubmittedWorkDone');
  wrap(globalThis.GPUBuffer?.prototype, 'mapAsync');
  wrap(globalThis.GPUDevice?.prototype, 'createRenderPipelineAsync');
  wrap(globalThis.GPUDevice?.prototype, 'createComputePipelineAsync');
  wrap(globalThis.GPUDevice?.prototype, 'popErrorScope');
  wrap(globalThis.GPUShaderModule?.prototype, 'getCompilationInfo');
  // `device.lost` is one promise per device: the held one is kept so that every read returns the same promise.
  const lost = Object.getOwnPropertyDescriptor(globalThis.GPUDevice?.prototype ?? {}, 'lost');
  if (lost?.get) {
    const perDevice = new WeakMap();
    Object.defineProperty(GPUDevice.prototype, 'lost', {
      ...lost,
      get() {
        if (!perDevice.has(this)) perDevice.set(this, hold(lost.get.call(this)));
        return perDevice.get(this);
      },
    });
  }
}
