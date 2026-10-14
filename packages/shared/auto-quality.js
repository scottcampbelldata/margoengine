const phone = /Mobi|Android/.test(globalThis.navigator?.userAgent ?? ''), params = new URLSearchParams(globalThis.location?.search);
let stored;
try {stored = localStorage.margoQuality ?? (localStorage.margoLow ? 'low' : undefined);} catch {}
// For side-by-side testing: ?quality=high|low forces a tier without remembering it, ?scale=1..2 sets the light tier's pixel ratio.
const forced = params.get('quality'), scale = Math.min(2, Math.max(1, Number(params.get('scale')) || 1));
if (forced === 'high' || forced === 'low') stored = forced;
// Desktops start on the light tier (1x MSAA, DPR `scale`) unless this browser already measured headroom for 4x, so a
// slow PC never shows a slow phase or a reload. Runs at import, before any engine exists. Phones keep their 1x / DPR 2 path.
if (!phone && stored !== 'high') globalThis.margoLow = scale;
// A slow GPU on a 120 Hz panel otherwise swings between 120 and 40 FPS; hold it to a steady ~60.
if (globalThis.margoLow && globalThis.requestAnimationFrame) capFrameRate();

/** Skip display refreshes so callbacks run at about `rate` per second (60 on 60/120/240 Hz, 72 on 144 Hz).
 * Every callback requested for one refresh shares its fate, so paired callbacks stay in step.
 * ponytail: patches the global because the engine's loop is frozen; a skipped request cannot be cancelled by id. */
export function capFrameRate(rate = 60, target = globalThis) {
  const native = target.requestAnimationFrame.bind(target), gap = 1000 / rate - 4;
  let last = -Infinity;
  target.requestAnimationFrame = callback => native(function step(now) {
    if (now !== last && now - last < gap) return native(step);
    last = now; callback(now);
  });
}

/** Below this many frames per second, a one-second window on the full tier counts as slow. */
export const SLOW_FPS = 55;
/** Light-tier GPU milliseconds per submission (90th percentile) below which this browser gets the full tier next
 * time. 4x MSAA with desktop detail measured about 2-3x the light tier's GPU work on an Intel Arc 140V. */
export const FAST_GPU_MS = 5;

/** On the light tier, time how long the GPU takes to finish each submitted frame (submit to onSubmittedWorkDone, so
 * it works on any refresh rate and needs no timestamp queries) and remember 'high' or 'low' for the next page load.
 * On the full tier, five consecutive slow seconds store 'low' and reload once. Phones do nothing.
 * ponytail: the choice is remembered per browser with no expiry; clear `localStorage.margoQuality` to measure again. */
export function watchFrameRate({request = globalThis.requestAnimationFrame, queue = globalThis.GPUQueue?.prototype, now = () => performance.now(),
  store = value => {localStorage.margoQuality = value;}, reload = () => location.reload()} = {}) {
  if (phone) return;
  if (!globalThis.margoLow) {
    if (forced) return; // a forced tier is for testing: never store or reload
    let start = 0, last = 0, frames = 0, slow = 0, seconds = 0;
    const tick = time => {
      // A long gap is a hidden tab or a startup compile, not steady GPU load: start over.
      if (time - last > 250) {start = time; frames = slow = 0;}
      else if (++frames, time - start >= 1000) {
        slow = frames * 1000 / (time - start) < SLOW_FPS ? slow + 1 : 0; start = time; frames = 0;
        if (slow === 5) {try {store('low');} catch {return;} reload(); return;}
        if (++seconds === 30) return;
      }
      last = time; request(tick);
    };
    return void request(tick);
  }
  if (stored || !queue?.submit) return;
  const submit = queue.submit, times = [];
  let frames = 0, done = false;
  const finish = () => {
    done = true; if (queue.submit === measured) queue.submit = submit;
    if (times.length < 120) return;
    times.sort((a, b) => a - b);
    try {store(times[Math.floor(times.length * 0.9)] < FAST_GPU_MS ? 'high' : 'low');} catch {}
  };
  function measured(buffers) {
    const start = now(), result = submit.call(this, buffers);
    // Skip two seconds of startup (shader compiles, uploads); then sample 120 submissions.
    if (frames > 120 && !done) this.onSubmittedWorkDone().then(() => {if (!done && times.push(now() - start) === 120) finish();});
    return result;
  }
  queue.submit = measured;
  const count = () => {if (done) return; if (++frames > 600) finish(); else request(count);};
  request(count);
}
