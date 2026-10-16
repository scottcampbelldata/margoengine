import type { EngineKernel } from '@margoengine/core';
import { sceneSamples as samples } from '../../shared/quality.js';
declare global {
  var margoLow: number | undefined;
  var margoPreset: QualityPreset | undefined;
}
declare const GPUQueue: { prototype: QueueLike } | undefined;
interface QueueLike {
  submit(buffers: unknown): unknown;
  onSubmittedWorkDone(): Promise<unknown>;
}
/** 'phone' keeps core's phone path (1x, DPR up to 2); 'light' is 1x at a capped DPR; 'high' is core's 4x desktop path. */
export type QualityTier = 'phone' | 'light' | 'high';

/**
 * Feature defaults for a tier. `applyQualityTier()` publishes the tier's preset as `globalThis.margoPreset`; each feature
 * package reads its key when an effect is constructed and uses a value only where the app left that option undefined
 * (explicit options always win). Packages never import this one; without it they keep their own defaults. Value names
 * are the packages' option names.
 */
export interface QualityPreset {
  /** `Shadows` (@margoengine/shadows): texels per cascade (default 2048). */
  shadows?: { resolution?: number };
  /** `SSAO` (@margoengine/post/ssao): kernel samples, 1-32 (default 32). */
  ssao?: { samples?: number };
  /** `SSR` (@margoengine/post/ssr): on/off (default on) and Hi-Z march steps (default 64). */
  ssr?: { enabled?: boolean; steps?: number };
  /** `VolumetricFog` (@margoengine/environment/volumetric): froxel grid (default [160, 90, 64]). */
  volumetric?: { grid?: readonly [number, number, number] };
  /** `LocalShadows` (@margoengine/clustered/shadows): shadowed lights (default 4) and layer size (default 512). */
  localShadows?: { maxLights?: number; resolution?: number };
  /** `VFX` (@margoengine/vfx): particle capacity (default 1,000,000). */
  vfx?: { capacity?: number };
}
const light: QualityPreset = {
  shadows: { resolution: 1024 },
  ssao: { samples: 16 },
  ssr: { enabled: false, steps: 32 },
  volumetric: { grid: [80, 45, 32] },
  localShadows: { resolution: 256 },
  vfx: { capacity: 100_000 },
};
/** The preset per tier. The full tier is empty: every package keeps its own defaults. Phones share the light preset. */
export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualityPreset>> = { high: {}, light, phone: light };
/** This page's preset (calls `applyQualityTier()` first if nothing has). */
export const qualityPreset = (): QualityPreset => QUALITY_PRESETS[(state ?? (applyQualityTier(), state!)).tier];
/** Inputs of `applyQualityTier`; each defaults to the browser's own, so tests can inject them. */
export interface QualityOptions {
  /** URL query to read `?quality=high|low` (forces a tier, never remembered) and `?scale=1..2` (light-tier DPR). */
  search?: string;
  /** Persistent storage for the measured result; defaults to localStorage. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** User agent string; a mobile one ('Mobi' or 'Android') selects the phone tier. Default `navigator.userAgent`. */
  userAgent?: string;
}

/** Below this many frames per second, a one-second window on the full tier counts as slow. */
export const SLOW_FPS = 55;
/** Light-tier GPU milliseconds per submission (90th percentile) below which the next page load gets the full tier.
 * 4x MSAA with desktop detail measured about 2-3x the light tier's GPU work on an Intel Arc 140V. */
export const FAST_GPU_MS = 5;
const KEY = 'margoQuality';

let state: { tier: QualityTier; stored?: string; forced?: string; storage?: QualityOptions['storage'] } | undefined;
const local = (): QualityOptions['storage'] => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Choose this page's tier. Call once, before creating any engine: core reads `globalThis.margoLow` when it builds
 * pipelines and sizes the canvas, and feature packages read `globalThis.margoPreset` (this tier's `QualityPreset`) when
 * an effect is constructed. Desktops start light unless this browser already measured headroom for 4x, so a slow
 * PC never shows a slow phase or a reload; `paceEngine` then holds light-tier engines to ~60 FPS. */
export function applyQualityTier({
  search = globalThis.location?.search,
  storage = local(),
  userAgent = globalThis.navigator?.userAgent ?? '',
}: QualityOptions = {}): QualityTier {
  const params = new URLSearchParams(search),
    forced = params.get('quality') ?? undefined;
  let stored: string | undefined;
  try {
    stored = storage?.getItem(KEY) ?? (storage?.getItem('margoLow') ? 'low' : undefined);
  } catch {}
  const choice = forced === 'high' || forced === 'low' ? forced : stored;
  const tier: QualityTier = /Mobi|Android/.test(userAgent) ? 'phone' : choice === 'high' ? 'high' : 'light';
  if (tier !== 'light') delete globalThis.margoLow;
  else globalThis.margoLow = Math.min(2, Math.max(1, Number(params.get('scale')) || 1));
  globalThis.margoPreset = QUALITY_PRESETS[tier];
  state = { tier, stored: choice, forced: forced === 'high' || forced === 'low' ? forced : undefined, storage };
  return tier;
}

/** An engine from `Engine.create` / `createStage` (EngineKernel) or the runtime `Engine` from core's extension API. */
export type Paced = EngineKernel | { pace?: (time: number) => boolean };

/** Set `engine.pace` so the engine renders about `rate` frames per second (60 on 60/120/240 Hz, 72 on 144 Hz): it skips
 * a display refresh that comes sooner than 4 ms before the next frame is due. */
export function capFrameRate(engine: Paced, rate = 60): void {
  const gap = 1000 / rate - 4;
  let last = -Infinity;
  (engine as { pace?: (time: number) => boolean }).pace = (time) => (time - last < gap ? false : ((last = time), true));
}

/** Apply the chosen tier's frame cap to an engine; call right after creating it. On the light tier a slow GPU on a
 * 120 Hz panel otherwise swings between 120 and 40 FPS, so it is held to ~60 FPS; other tiers are left uncapped. */
export function paceEngine(engine: Paced): void {
  if ((state ?? (applyQualityTier(), state!)).tier === 'light') capFrameRate(engine);
}

/** Hooks of `watchQuality`; each defaults to the browser's own, so tests can inject them. */
export interface WatchOptions {
  /** Frame scheduler, called with a time in milliseconds. Default `requestAnimationFrame`. */
  request?: (callback: (time: number) => void) => unknown;
  /** Queue whose `submit` is wrapped to time GPU work. Default `GPUQueue.prototype` when WebGPU exists. */
  queue?: QueueLike;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
  /** Remembers the result. Default writes it to the storage `applyQualityTier` used. */
  store?: (value: 'high' | 'low') => void;
  /** Called after remembering 'low' on the full tier. Default `location.reload`. */
  reload?: () => void;
}

/** Call once the scene is running. On the light tier, times how long the GPU takes to finish each submitted frame
 * (submit to onSubmittedWorkDone: any refresh rate, no timestamp queries) and remembers 'high' or 'low' for the next
 * page load. On the full tier, five consecutive slow seconds remember 'low' and reload once. Phones do nothing.
 * ponytail: the result has no expiry; `localStorage.removeItem('margoQuality')` measures again. */
export function watchQuality({
  request = globalThis.requestAnimationFrame?.bind(globalThis),
  queue = typeof GPUQueue === 'undefined' ? undefined : GPUQueue.prototype,
  now = () => performance.now(),
  store,
  reload = () => location.reload(),
}: WatchOptions = {}): void {
  const current = state ?? (applyQualityTier(), state!);
  const remember = store ?? ((value) => current.storage?.setItem(KEY, value));
  if (current.tier === 'phone' || current.forced || !request) return;
  if (current.tier === 'high') {
    let start = 0,
      last = 0,
      frames = 0,
      slow = 0,
      seconds = 0;
    const tick = (time: number) => {
      // A long gap is a hidden tab or a startup compile, not steady GPU load: start over.
      if (time - last > 250) {
        start = time;
        frames = slow = 0;
      } else if ((++frames, time - start >= 1000)) {
        slow = (frames * 1000) / (time - start) < SLOW_FPS ? slow + 1 : 0;
        start = time;
        frames = 0;
        if (slow === 5) {
          try {
            remember('low');
          } catch {
            return;
          }
          reload();
          return;
        }
        if (++seconds === 30) return;
      }
      last = time;
      request(tick);
    };
    request(tick);
    return;
  }
  if (current.stored || !queue?.submit) return;
  const submit = queue.submit,
    times: number[] = [];
  let first = -1,
    elapsed = 0,
    done = false;
  const finish = () => {
    done = true;
    if (queue.submit === measured) queue.submit = submit;
    if (times.length < 120) return;
    times.sort((a, b) => a - b);
    try {
      remember(times[Math.floor(times.length * 0.9)] < FAST_GPU_MS ? 'high' : 'low');
    } catch {}
  };
  function measured(this: QueueLike, buffers: unknown): unknown {
    const start = now(),
      result = submit.call(this, buffers);
    // Skip two seconds of startup (shader compiles, uploads); then sample 120 submissions.
    if (elapsed > 2000 && !done)
      void this.onSubmittedWorkDone().then(() => {
        if (!done && times.push(now() - start) === 120) finish();
      });
    return result;
  }
  queue.submit = measured;
  const count = (time: number) => {
    if (done) return;
    if (first < 0) first = time;
    if ((elapsed = time - first) > 10000) finish();
    else request(count);
  };
  request(count);
}
let restorers = 0;
/** An app that renders on demand (a paused scene, a stopped loop) shows an empty canvas after core restores a lost GPU
 * device, until something renders again. Call once: `render` then runs on the next two animation frames after every
 * restoration (effects that read the previous frame, such as water refraction and sky reflections, settle on the
 * second). Returns a function that stops it. */
export function redrawAfterRestore(
  engine: EngineKernel,
  render: () => void,
  request: (callback: () => void) => unknown = globalThis.requestAnimationFrame?.bind(globalThis),
): () => void {
  const name = `redraw-after-restore-${++restorers}`;
  // Core runs onDeviceRestored before its recovery settles; a frame rendered then would be skipped.
  engine.use({
    name,
    setup() {},
    onDeviceRestored: () => {
      request(() => {
        render();
        request(render);
      });
    },
  });
  return () => engine.removePlugin(name);
}
export { frameDue, frameStatus } from './pacing.js';
/** 1 on phones and the light tier, 4 on the desktop full tier: the scene sample count core uses (call after applyQualityTier). */
export const sceneSamples: () => 1 | 4 = samples; // typed here so the published .d.ts never points into ../../shared
