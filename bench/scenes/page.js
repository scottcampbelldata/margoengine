// The scene page: ?engine=<name>&scene=<scene>&<scene params>&frames=..&warmup=.. (harness.js lists the options).
// The harness is imported first so its WebGPU wrappers are in place before any engine code runs. Margo's
// implementation is bundled with the page; any other engine is an ES module the CLI built from engine-bench and serves
// under /ext/<engine>/engine.js (docs/benchmarking.md "Comparing engines").
import { options, params, run } from './harness.js';

const engine =
  options.engine === 'margo'
    ? await import('./margo.js')
    : await import(/* @vite-ignore */ `/ext/${encodeURIComponent(options.engine)}/engine.js`);

// An engine lists its scenes, and may say per case whether it has the variant (`supports(scene, params)`).
if ((engine.scenes && !engine.scenes.includes(options.scene)) || engine.supports?.(options.scene, params) === false) {
  window.result = { engine: options.engine, scene: options.scene, unsupported: true, errors: [] };
  if (parent !== window) parent.postMessage({ type: 'margo-bench-result', result: window.result }, location.origin);
} else await run(engine.create);
