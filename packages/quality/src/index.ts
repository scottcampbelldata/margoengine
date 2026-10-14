declare global {var margoLow: number | undefined;}
declare const GPUQueue: {prototype: QueueLike} | undefined;
interface QueueLike {submit(buffers: unknown): unknown; onSubmittedWorkDone(): Promise<unknown>}
/** 'phone' keeps core's phone path (1x, DPR up to 2); 'light' is 1x at a capped DPR; 'high' is core's 4x desktop path. */
export type QualityTier = 'phone' | 'light' | 'high';
export interface QualityOptions {
  /** URL query to read `?quality=high|low` (forces a tier, never remembered) and `?scale=1..2` (light-tier DPR). */
  search?: string;
  /** Persistent storage for the measured result; defaults to localStorage. */
  storage?: {getItem(key: string): string | null; setItem(key: string, value: string): void};
  userAgent?: string;
}

/** Below this many frames per second, a one-second window on the full tier counts as slow. */
export const SLOW_FPS = 55;
/** Light-tier GPU milliseconds per submission (90th percentile) below which the next page load gets the full tier.
 * 4x MSAA with desktop detail measured about 2-3x the light tier's GPU work on an Intel Arc 140V. */
export const FAST_GPU_MS = 5;
const KEY = 'margoQuality';

let state: {tier: QualityTier; stored?: string; forced?: string; storage?: QualityOptions['storage']} | undefined;
const local = (): QualityOptions['storage'] => {try {return globalThis.localStorage;} catch {return undefined;}};

/** Choose this page's tier. Call once, before creating any engine: core reads `globalThis.margoLow` when it builds
 * pipelines and sizes the canvas. Desktops start light unless this browser already measured headroom for 4x, so a slow
 * PC never shows a slow phase or a reload; the light tier is also held to ~60 FPS. */
export function applyQualityTier({search = globalThis.location?.search, storage = local(), userAgent = globalThis.navigator?.userAgent ?? ''}: QualityOptions = {}): QualityTier {
  const params = new URLSearchParams(search), forced = params.get('quality') ?? undefined;
  let stored: string | undefined;
  try {stored = storage?.getItem(KEY) ?? (storage?.getItem('margoLow') ? 'low' : undefined);} catch {}
  const choice = forced === 'high' || forced === 'low' ? forced : stored;
  const tier: QualityTier = /Mobi|Android/.test(userAgent) ? 'phone' : choice === 'high' ? 'high' : 'light';
  if (tier !== 'light') delete globalThis.margoLow;
  else {
    globalThis.margoLow = Math.min(2, Math.max(1, Number(params.get('scale')) || 1));
    // A slow GPU on a 120 Hz panel otherwise swings between 120 and 40 FPS.
    if (typeof requestAnimationFrame === 'function') capFrameRate();
  }
  state = {tier, stored: choice, forced: forced === 'high' || forced === 'low' ? forced : undefined, storage};
  return tier;
}

/** Skip display refreshes so callbacks run at about `rate` per second (60 on 60/120/240 Hz, 72 on 144 Hz).
 * Every callback requested for one refresh shares its fate, so paired callbacks stay in step.
 * ponytail: patches the global because core's frame loop is frozen; a skipped request cannot be cancelled by id. */
export function capFrameRate(rate = 60, target: {requestAnimationFrame(callback: (time: number) => void): number} = globalThis): void {
  const native = target.requestAnimationFrame.bind(target), gap = 1000 / rate - 4;
  let last = -Infinity;
  target.requestAnimationFrame = callback => native(function step(time: number): number | void {
    if (time !== last && time - last < gap) return native(step);
    last = time; callback(time);
  });
}

export interface WatchOptions {
  request?: (callback: (time: number) => void) => unknown;
  queue?: QueueLike;
  now?: () => number;
  store?: (value: 'high' | 'low') => void;
  reload?: () => void;
}

/** Call once the scene is running. On the light tier, times how long the GPU takes to finish each submitted frame
 * (submit to onSubmittedWorkDone: any refresh rate, no timestamp queries) and remembers 'high' or 'low' for the next
 * page load. On the full tier, five consecutive slow seconds remember 'low' and reload once. Phones do nothing.
 * ponytail: the result has no expiry; `localStorage.removeItem('margoQuality')` measures again. */
export function watchQuality({request = globalThis.requestAnimationFrame?.bind(globalThis), queue = typeof GPUQueue === 'undefined' ? undefined : GPUQueue.prototype,
  now = () => performance.now(), store, reload = () => location.reload()}: WatchOptions = {}): void {
  const current = state ?? (applyQualityTier(), state!);
  const remember = store ?? (value => current.storage?.setItem(KEY, value));
  if (current.tier === 'phone' || current.forced || !request) return;
  if (current.tier === 'high') {
    let start = 0, last = 0, frames = 0, slow = 0, seconds = 0;
    const tick = (time: number) => {
      // A long gap is a hidden tab or a startup compile, not steady GPU load: start over.
      if (time - last > 250) {start = time; frames = slow = 0;}
      else if (++frames, time - start >= 1000) {
        slow = frames * 1000 / (time - start) < SLOW_FPS ? slow + 1 : 0; start = time; frames = 0;
        if (slow === 5) {try {remember('low');} catch {return;} reload(); return;}
        if (++seconds === 30) return;
      }
      last = time; request(tick);
    };
    request(tick); return;
  }
  if (current.stored || !queue?.submit) return;
  const submit = queue.submit, times: number[] = [];
  let frames = 0, done = false;
  const finish = () => {
    done = true; if (queue.submit === measured) queue.submit = submit;
    if (times.length < 120) return;
    times.sort((a, b) => a - b);
    try {remember(times[Math.floor(times.length * 0.9)] < FAST_GPU_MS ? 'high' : 'low');} catch {}
  };
  function measured(this: QueueLike, buffers: unknown): unknown {
    const start = now(), result = submit.call(this, buffers);
    // Skip two seconds of startup (shader compiles, uploads); then sample 120 submissions.
    if (frames > 120 && !done) void this.onSubmittedWorkDone().then(() => {if (!done && times.push(now() - start) === 120) finish();});
    return result;
  }
  queue.submit = measured;
  const count = () => {if (done) return; if (++frames > 600) finish(); else request(count);};
  request(count);
}
export {frameDue, frameStatus} from './pacing.js';
