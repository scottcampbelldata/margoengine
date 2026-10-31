import type { EngineKernel } from '@margoengine/core';
import { sceneSamples as samples } from '../../shared/quality.js';
import type { DeviceLike, QueueLike } from './reading.js';
declare global {
  var margoLow: number | undefined;
  var margoPreset: QualityPreset | undefined;
}
declare const GPUQueue: { prototype: QueueLike } | undefined;
declare const GPUDevice: { prototype: DeviceLike } | undefined;
declare const GPUAdapter: { prototype: AdapterLike } | undefined;
/** The part of `GPUAdapter` the tier uses. */
export interface AdapterLike {
  features: { has(name: string): boolean };
  requestDevice(descriptor?: { requiredFeatures?: Iterable<string> }): unknown;
}
/** 'phone' is 1x at DPR 1; 'light' is 1x at a capped DPR; 'high' is core's 4x desktop path. */
export type QualityTier = 'phone' | 'light' | 'high';

/**
 * Feature defaults for a tier. `applyQualityTier()` publishes the tier's preset as `globalThis.margoPreset`; each feature
 * package reads its key when an effect is constructed and uses a value only where the app left that option undefined
 * (explicit options always win). Packages never import this one; without it they keep their own defaults. Value names
 * are the packages' option names.
 */
export interface QualityPreset {
  /** `Shadows` (@margoengine/shadows): texels per cascade (default 2048), edge filter (default 'soft', PCSS) and
   * cascades (default 4). */
  shadows?: { resolution?: number; filter?: 'soft' | 'pcf' | 'hard'; cascades?: number };
  /** `Scatter` (@margoengine/scatter): LOD cross-fade width (default 2); 0 compiles out the fade's `discard`. */
  scatter?: { lodFade?: number };
  /** `SSAO` (@margoengine/post/ssao): on/off (default on) and kernel samples, 1-32 (default 32). */
  ssao?: { enabled?: boolean; samples?: number };
  /** `SSR` (@margoengine/post/ssr): on/off (default on) and Hi-Z march steps (default 64). */
  ssr?: { enabled?: boolean; steps?: number };
  /** `VolumetricFog` (@margoengine/environment/volumetric): on/off (default on) and froxel grid (default [160, 90, 64]). */
  volumetric?: { enabled?: boolean; grid?: readonly [number, number, number] };
  /** `LocalShadows` (@margoengine/clustered/shadows): shadowed lights (default 4) and layer size (default 512). */
  localShadows?: { maxLights?: number; resolution?: number };
  /** `VFX` (@margoengine/vfx): particle capacity (default 1,000,000). */
  vfx?: { capacity?: number };
}
// Light and phone shadows: four hardware comparison taps instead of PCSS's 16 blocker reads and 32 taps per lit pixel.
const light: QualityPreset = {
  shadows: { resolution: 1024, filter: 'pcf' },
  ssao: { samples: 16 },
  ssr: { enabled: false, steps: 32 },
  volumetric: { grid: [80, 45, 32] },
  localShadows: { resolution: 256 },
  vfx: { capacity: 100_000 },
};
/** The preset per tier. The full tier keeps package defaults; phones use light defaults with SSAO and volumetric fog
 * off, two shadow cascades instead of four, and no scatter LOD fade (a fragment `discard` turns off early depth
 * rejection on tile-based phone GPUs). */
export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualityPreset>> = {
  high: {},
  light,
  phone: {
    ...light,
    shadows: { ...light.shadows, cascades: 2 },
    ssao: { enabled: false },
    volumetric: { enabled: false },
    scatter: { lodFade: 0 },
  },
};
/** This page's preset (calls `applyQualityTier()` first if nothing has). */
export const qualityPreset = (): QualityPreset => QUALITY_PRESETS[(state ?? (applyQualityTier(), state!)).tier];
/** Inputs of `applyQualityTier`; each defaults to the browser's own, so tests can inject them. */
export interface QualityOptions {
  /** URL query to read `?quality=high|low` (forces a tier, never remembered) and `?scale=1..2` (light-tier DPR). */
  search?: string;
  /** Page the measured result belongs to, because it says what this page's scene costs. Default `location.pathname`. */
  page?: string;
  /** Persistent storage for the measured result; defaults to localStorage. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** User agent string; 'Mobi', 'Android' or 'iPhone' selects the phone tier. Default `navigator.userAgent`. */
  userAgent?: string;
}

/** Below this many frames per second, a one-second window on the full tier counts as slow. */
export const SLOW_FPS = 55;
/** Light-tier GPU milliseconds per frame (90th percentile, timestamp queries: the sum of a frame's passes) below which
 * this page's next load gets the full tier. Chosen from Plaza in real play at spawn, with the sun moving and shadows
 * redrawing: an RTX A6000 on a busy machine read 3.2 to 7.25 ms from 720p to 4K, an Intel UHD (Alder Lake-N) 60 ms at 720p,
 * and an Arc 140V 9 to 16.4 ms by the same queries, copies included, in `measure.mjs`. A limit for that scene, on those
 * GPUs; other scenes read their own cost against it. */
export const FAST_GPU_MS = 8;
const KEY = 'margoQuality',
  // Written when the full tier ran slow on this browser. Unlike a slow light-tier reading it stays: measuring headroom
  // again on the light tier would send the page back to the full tier, slow, and back here, on every other load.
  HELD = 'held';

const TIMESTAMPS = 'timestamp-query';
/** Add the feature to every device this page asks for until the returned function runs. A device needs it from creation,
 * and only core creates the engine's device, so the ask happens here; it costs nothing without queries. */
function askForTimestamps(adapter: Pick<AdapterLike, 'requestDevice'>): () => void {
  const ask = adapter.requestDevice;
  function asked(this: AdapterLike, descriptor: { requiredFeatures?: Iterable<string> } = {}): unknown {
    return ask.call(
      this,
      this.features.has(TIMESTAMPS)
        ? { ...descriptor, requiredFeatures: new Set([...(descriptor.requiredFeatures ?? []), TIMESTAMPS]) }
        : descriptor,
    );
  }
  adapter.requestDevice = asked;
  return () => {
    if (adapter.requestDevice === asked) adapter.requestDevice = ask;
  };
}

let state:
    | { tier: QualityTier; stored?: string; forced?: string; storage?: QualityOptions['storage']; key: string }
    | undefined,
  // Set while this page's next device is to carry the timestamp feature.
  stopAsking: (() => void) | undefined;
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
  page = globalThis.location?.pathname,
  storage = local(),
  userAgent = globalThis.navigator?.userAgent ?? '',
}: QualityOptions = {}): QualityTier {
  const params = new URLSearchParams(search),
    forced = params.get('quality') ?? undefined,
    key = page ? `${KEY}:${page}` : KEY;
  let stored: string | undefined;
  try {
    stored = storage?.getItem(key) ?? undefined;
  } catch {}
  const choice = forced === 'high' || forced === 'low' ? forced : stored;
  const tier: QualityTier = /Mobi|Android|iPhone/.test(userAgent) ? 'phone' : choice === 'high' ? 'high' : 'light';
  if (tier === 'high') delete globalThis.margoLow;
  else globalThis.margoLow = tier === 'phone' ? 1 : Math.min(2, Math.max(1, Number(params.get('scale')) || 1));
  globalThis.margoPreset = QUALITY_PRESETS[tier];
  const held = forced === 'high' || forced === 'low' ? forced : undefined;
  state = { tier, stored: choice, forced: held, storage, key };
  stopAsking?.();
  stopAsking =
    tier === 'light' && !held && stored !== HELD && typeof GPUAdapter !== 'undefined'
      ? askForTimestamps(GPUAdapter.prototype)
      : undefined;
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
  /** Queue whose `submit` is wrapped during the reading. Default `GPUQueue.prototype` when WebGPU exists. */
  queue?: QueueLike;
  /** Device whose `createCommandEncoder` is wrapped during the reading. Default `GPUDevice.prototype` when WebGPU exists. */
  device?: Pick<DeviceLike, 'createCommandEncoder'>;
  /** Told the light-tier reading when it ends: GPU milliseconds per frame (90th percentile), or undefined when there is
   * none (no `timestamp-query`, too few frames). */
  onReading?: (milliseconds: number | undefined) => void;
  /** Remembers the result. Default writes it to the storage `applyQualityTier` used. */
  store?: (value: 'high' | 'low') => void;
  /** Called after remembering 'low' on the full tier. Default `location.reload`. */
  reload?: () => void;
}

/** Call once the scene is running. On the light tier, reads the real GPU time of this page's frames by timestamp queries
 * and remembers 'high' for this page's next load when it is under `FAST_GPU_MS`. The queries exist only during the
 * reading (about 4 s at 60 FPS, 10 s at most); everything wrapped for it is then put back and its GPU objects destroyed.
 * Without `timestamp-query` the page stays light and nothing is stored. A slow reading remembers nothing, so one bad
 * session (a remote desktop, a busy machine, a slow first window) cannot hold a browser on the light tier for good: the
 * next load measures again. On the full tier, five consecutive slow seconds remember that for good and reload once;
 * `localStorage.removeItem('margoQuality:' + location.pathname)` measures again. Phones do nothing. */
export function watchQuality({
  request = globalThis.requestAnimationFrame?.bind(globalThis),
  queue = typeof GPUQueue === 'undefined' ? undefined : GPUQueue.prototype,
  device = typeof GPUDevice === 'undefined' ? undefined : GPUDevice.prototype,
  onReading,
  store,
  reload = () => location.reload(),
}: WatchOptions = {}): void {
  const current = state ?? (applyQualityTier(), state!);
  const remember = store ?? ((value) => current.storage?.setItem(current.key, value === 'low' ? HELD : value));
  stopAsking?.();
  stopAsking = undefined;
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
  // Anything else stored ('low' from a light-tier reading before it stopped being remembered) is measured again.
  if (current.stored === HELD || !queue || !device) return;
  // Its own chunk: a page with nothing to read never downloads it. If it cannot load there is no reading and no change.
  void import('./reading.js').then(
    ({ readGpuTime }) =>
      readGpuTime(queue, device, request, (milliseconds) => {
        if (milliseconds !== undefined && milliseconds < FAST_GPU_MS)
          try {
            remember('high');
          } catch {}
        onReading?.(milliseconds);
      }),
    () => onReading?.(undefined),
  );
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

export {
  ResolutionScaler,
  watchResolution,
  type ResolutionOptions,
  type ResolutionWatch,
  type WatchResolutionOptions,
} from './resolution.js';
export type { DeviceLike, QueueLike } from './reading.js';
