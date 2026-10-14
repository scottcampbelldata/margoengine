import {sceneSamples} from './quality.js';

// A browser that measured slow keeps the light tier on later visits. Runs at import, before any engine exists.
try {if (localStorage.margoLow) globalThis.margoLow = 1;} catch {}
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

/** Below this many frames per second, a one-second window counts as slow. */
export const SLOW_FPS = 55;

/** Watch the first 30 measured seconds. Five consecutive slow seconds move this desktop browser to the
 * single-sampled DPR 1 tier, remember that, and reload the page once. Phones and already-light pages do nothing.
 * ponytail: the choice is permanent per browser (a 50 Hz display or remote session also triggers it);
 * clear `localStorage.margoLow` to undo. Add an expiry or a step-up probe if that proves too sticky. */
export function watchFrameRate({request = requestAnimationFrame, store = () => {localStorage.margoLow = 1;}, reload = () => location.reload()} = {}) {
  if (sceneSamples() === 1) return;
  let start = 0, last = 0, frames = 0, slow = 0, seconds = 0;
  const tick = now => {
    // A long gap is a hidden tab or a startup compile, not steady GPU load: start over.
    if (now - last > 250) {start = now; frames = slow = 0;}
    else if (++frames, now - start >= 1000) {
      slow = frames * 1000 / (now - start) < SLOW_FPS ? slow + 1 : 0; start = now; frames = 0;
      if (slow === 5) {try {store();} catch {return;} reload(); return;}
      if (++seconds === 30) return;
    }
    last = now; request(tick);
  };
  request(tick);
}
