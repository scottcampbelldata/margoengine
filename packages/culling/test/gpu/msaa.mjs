// Node side of msaa-samples.js: the culling pixel checks compare the two engines' multisample colour samples, which
// are what the draws wrote, instead of the resolved canvases (the Radeon 680M resolve rounds a .5 average by draw
// history; docs/work-lists/amd-gpu-hunt.md). On the WebGL2 compatibility layer there are no samples to read, so the
// resolved canvases are compared as before.
import { compatRun } from '../../../../scripts/support/compat-shim.js';

/**
 * Frame difference between canvases `a` and `b`: { differing, at, mode } where mode is 'samples' (every sample of
 * every pixel equal) or 'resolved' (the screenshots, compatibility runs only). `shot(id)` decodes a canvas screenshot.
 */
export async function frameDiff(page, shot, a = 'a', b = 'b') {
  const samples = await page.evaluate(([x, y]) => window.msaaDiff(x, y), [a, b]);
  if (samples) return { ...samples, mode: 'samples' };
  // On WebGPU the samples must be there: a silent fall back to the resolved frame would hide a broken hook.
  if (!compatRun()) throw new Error('no multisampled colour was seen for the canvases: msaa-samples.js did not hook the engines');
  const [x, y] = [await shot(a), await shot(b)],
    at = [];
  let differing = 0;
  for (let k = 0; k < x.data.length; k += 4) {
    if (x.data[k] === y.data[k] && x.data[k + 1] === y.data[k + 1] && x.data[k + 2] === y.data[k + 2]) continue;
    differing++;
    if (at.length < 6) at.push([(k / 4) % x.width, Math.floor(k / 4 / x.width), [...x.data.subarray(k, k + 3)], [...y.data.subarray(k, k + 3)]]);
  }
  return { differing, at, pixels: x.data.length / 4, mode: 'resolved' };
}
