// Forced-compatibility runs of the GPU checks (docs/webgl2-compat-roadmap.md, "Testing"): with `--compat` (or
// MARGO_COMPAT=1) scripts/browser.js's openBrowser installs `compatShim` as an init script, so every page it opens runs
// its usual WebGPU code on the WebGL2 compatibility layer, with no edit to the page. The first `requestAdapter()` loads
// `@margoengine/webgl2-compat/device` from the dev server and installs it with `force: true` (the page's later
// `navigator.gpu` and `getContext('webgpu')` are the layer's); pipeline creations are counted for waitForPipelines as
// they are on WebGPU. Pages read `globalThis.__margoCompat` to know they run in compatibility mode.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when this run is a forced-compatibility run (`--compat` on the command line, or MARGO_COMPAT=1). */
export const compatRun = () => process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat');

/**
 * The URL a page served by a package's own Vite server (rooted in the package, with the repository in `fs.allow`)
 * loads the layer from: pass it to `page.addInitScript(compatShim, compatUrl())`.
 */
export const compatUrl = () =>
  `/@fs/${join(dirname(fileURLToPath(import.meta.url)), '../../packages/webgl2-compat/dist/device.js').replaceAll('\\', '/').replace(/^\//, '')}`;

/**
 * Page init script: `navigator.gpu` becomes a stub that installs the WebGL2 compatibility layer on first use, loaded
 * from `url` (default: the repository-root dev server's path).
 */
export function compatShim(url = '/packages/webgl2-compat/dist/device.js') {
  if (globalThis.__margoCompat) return;
  globalThis.__margoCompat = true;
  let loading;
  const load = () =>
    // WebKit resolves an import in an init script against no page at all, so the URL goes in whole.
    (loading ??= import(new URL(url, location.href).href).then(async (m) => {
      const result = await m.installCompat({ force: true });
      if (!result.installed) throw new Error(`the WebGL2 compatibility layer did not install: ${result.reason}`);
      // Asynchronous pipeline creations in flight, as scripts/support/gpu-ready.js counts them on WebGPU.
      const proto = m.CompatDevice.prototype;
      const original = proto.createRenderPipelineAsync;
      proto.createRenderPipelineAsync = function (...args) {
        const state = (globalThis.__margoPipelines ??= { pending: 0, created: 0 });
        const promise = original.apply(this, args);
        state.pending++;
        state.created++;
        const settle = () => state.pending--;
        promise.then(settle, settle);
        return promise;
      };
      return navigator.gpu;
    }));
  const stub = {
    requestAdapter: (options) => load().then((gpu) => gpu.requestAdapter(options)),
    getPreferredCanvasFormat: () => 'rgba8unorm',
    wgslLanguageFeatures: new Set(),
  };
  Object.defineProperty(navigator, 'gpu', { value: stub, configurable: true, enumerable: true });
}
