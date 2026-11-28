/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, EngineOptions, Mesh as MeshHandle } from '@margoengine/core';
import type { StartEngineOptions } from '@margoengine/webgl2-compat/auto';
import type { Shadows, ShadowOptions } from '@margoengine/shadows';
import type { EnvironmentLighting } from '@margoengine/environment';
import type { OrbitControls } from '@margoengine/controls/orbit';
import type { Tonemap, TonemapOptions } from '@margoengine/tonemap';
import type { GTAO, GTAOOptions } from '@margoengine/post/gtao';
import { ContactShadows, type ContactShadowOptions, type ContactSource } from './index.js';
import { Backdrop, stagingLighting, type BackdropOptions, type StagingPreset } from './backdrop.js';
import { rangeError, typeError } from '../../shared/errors.js';

type Vec3 = readonly [number, number, number];

/** The sun of the rig: the key light that casts the shadow map. */
export interface BenchLight {
  /** Direction towards the light, any nonzero vector. Default [-0.55, 1, 0.7] (high and to the camera's left). */
  direction?: Vec3;
  /** Linear colour. Default [1, 0.95, 0.88] (warm studio key). */
  color?: Vec3;
  /** Strength. Default 2.6. */
  intensity?: number;
  /** Ambient strength (core's flat ambient, used only when `environment` is false). Default 0.25. */
  ambient?: number;
  /** Ambient colour multipliers. Default [0.9, 0.95, 1.05]. */
  ambientColor?: Vec3;
}

/** Image-based fill and rim: a procedural softbox studio from environment/studio. */
export interface BenchEnvironment {
  /** Softbox rig, as studio/backdrop `stagingLights`. Default 'soft'. */
  preset?: StagingPreset;
  /** Radiance multiplier. Default 0.55, a fill under the sun key. */
  intensity?: number;
  /** Equirect width, a power of two 16..4096. Default 256. */
  width?: number;
}

/** Options of {@link openBench}. Every option has a default; `openBench(canvas)` gives a lit, shadowed studio. */
export interface BenchOptions {
  /** Engine camera. Default a 35 degree view from [3.2, 2.1, 4.4] at [0, 0.6, 0]. */
  camera?: EngineOptions['camera'];
  /** Mesh capacity. Default the engine's. */
  capacity?: number;
  /** Clear colour, `#rgb` or `#rrggbb`. Default '#77736d', the cyclorama's lit tone, so its edge never shows. */
  background?: string;
  /** Largest device pixel ratio of the backbuffer. Default 2. */
  pixelRatio?: number;
  /** Largest backbuffer width in pixels. Default 2560. */
  maxWidth?: number;
  /** MSAA. Default true. */
  antialias?: boolean;
  /** Engine start-up timeout in ms before the WebGL2 layer is tried. Default 8000. */
  startupTimeout?: number;
  /** Other `Engine.create` options, passed through. */
  engine?: Omit<
    StartEngineOptions,
    'loadCompat' | 'forceCompat' | 'signal' | 'camera' | 'capacity' | 'exactSize' | 'antialias' | 'startupTimeout'
  >;
  /** Loads the WebGL2 compatibility layer. Default `() => import('@margoengine/webgl2-compat')`. */
  loadCompat?: StartEngineOptions['loadCompat'];
  /** Options for the layer's `install`, such as `{ minimumTier: 'half-float' }`. Default none. */
  compat?: Record<string, unknown>;
  /** `'webgl2'` forces the compatibility layer. Default: `'webgl2'` when the page URL has `?backend=webgl2`, else 'auto'. */
  backend?: 'auto' | 'webgl2';
  /** Aborting disposes the bench. */
  signal?: AbortSignal;
  /** Element that carries `data-ready`, `data-error` and `data-renderer`. Default the canvas. */
  exhibit?: HTMLElement;
  /** The sun key; false leaves core's lighting alone. Default {@link BenchLight} defaults. */
  light?: BenchLight | false;
  /** Fill and rim from a softbox environment; false keeps core's flat ambient. Default 'soft' at 0.55. */
  environment?: BenchEnvironment | StagingPreset | false;
  /** Cascaded PCSS shadows from the sun; false for none. Default `{ lightSize: 0.02 }`. */
  shadows?: ShadowOptions | false;
  /** Soft ground contact shadows; false for none. Default a 6 x 6 plane at y 0, height 0.6, opacity 0.55. */
  contact?: ContactShadowOptions | false;
  /** A cyclorama; false for none. Default 40 wide, 24 deep, 14 high, radius 4, warm grey matte. */
  backdrop?: BackdropOptions | false;
  /** A display transform after the frame (exposure, curve, contrast). Default none: core's Khronos PBR Neutral at 0 EV. */
  tonemap?: TonemapOptions | false;
  /** Ground truth ambient occlusion (Jimenez et al. 2016). Default false. */
  ao?: GTAOOptions | boolean;
  /** Pointer orbit (controls/orbit); false for none. Default false. */
  orbit?: { target?: Vec3; minDistance?: number; maxDistance?: number; damping?: boolean } | boolean;
  /** Called after the backbuffer changed size, before the next frame. */
  onResize?: (bench: Bench) => void;
  /** Called once with the first failure (engine error, frame error, start-up error). */
  onError?: (reason: unknown) => void;
}

/** Per-mesh choice for {@link Bench.add}. */
export interface BenchAddOptions {
  /** Cast into the shadow map. Default true. */
  shadow?: boolean;
  /** Cast a contact shadow. Default true. */
  contact?: boolean;
  /** The shadow map treats it as still. Default false. */
  static?: boolean;
}

/** What {@link openBench} opened. */
export interface Bench {
  readonly engine: EngineKernel;
  /** The canvas the engine draws (the same element). */
  readonly canvas: HTMLCanvasElement;
  /** `'webgpu'` or `'compatibility'` (the WebGL2 layer). */
  readonly renderer: 'webgpu' | 'compatibility';
  readonly shadows?: Shadows;
  readonly contact?: ContactShadows;
  readonly backdrop?: Backdrop;
  readonly lighting?: EnvironmentLighting;
  readonly tonemap?: Tonemap;
  readonly ao?: GTAO;
  readonly orbit?: OrbitControls;
  /** Aborts when the bench is disposed. */
  readonly signal: AbortSignal;
  /** True while the viewer asks for reduced motion (live). */
  readonly reducedMotion: boolean;
  /** True once the bench failed; it never becomes ready after that. */
  readonly failed: boolean;
  /** Registers casters with the shadow map and the contact shadow; returns a remover. */
  add(mesh: MeshHandle | ContactSource, options?: BenchAddOptions): () => void;
  /** Calls `callback(delta, time)` before every frame and keeps frames coming until the returned remover runs. */
  frame(callback: (delta: number, time: number) => void): () => void;
  /** Draws one frame on the next animation frame (merged with any other request). */
  request(): void;
  /** Draws now and resolves once the GPU finished it. */
  render(delta?: number): Promise<void>;
  /** Draws the first frame, waits for it, marks `data-ready` and `data-renderer`; false when already failed. */
  ready(): Promise<boolean>;
  /** Marks `data-error`, calls `onError` once, stops frames. */
  fail(reason: unknown): void;
  /** Releases everything the bench made and the engine. Safe to repeat. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const normalize = (v: Vec3) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 0) || !Number.isFinite(l))
    throw rangeError('Invalid light direction; pass a finite nonzero vector', 'arguments');
  return [v[0] / l, v[1] / l, v[2] / l];
};
const forcedCompat = () => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('backend') === 'webgl2';
  } catch {
    return false;
  }
};

/**
 * Opens a studio bench on `canvas`: the engine on WebGPU or the WebGL2 compatibility layer, a cyclorama, a sun key with
 * cascaded PCSS shadows, a softbox fill and rim from environment/studio, ground contact shadows, resize, reduced
 * motion, the `data-ready` / `data-error` signals and disposal on `pagehide` or `signal`.
 * @throws What `startEngine` throws (with `data-error` set); TypeError or RangeError for invalid options.
 */
export async function openBench(canvas: HTMLCanvasElement, options: BenchOptions = {}): Promise<Bench> {
  if (!canvas || typeof (canvas as { getContext?: unknown }).getContext !== 'function')
    throw typeError('openBench needs a canvas element', 'arguments');
  if (!options || typeof options !== 'object')
    throw typeError('Invalid bench options; pass an options object', 'arguments');
  const exhibit = options.exhibit ?? canvas,
    pixelRatio = options.pixelRatio ?? 2,
    maxWidth = options.maxWidth ?? 2560;
  if (!(pixelRatio > 0 && pixelRatio <= 8) || !(maxWidth >= 16 && maxWidth <= 16384))
    throw rangeError('Invalid bench size; pixelRatio 0..8 and maxWidth 16..16384', 'arguments');
  const lifetime = new AbortController(),
    { signal } = lifetime,
    cleanups: (() => void)[] = [];
  let failed = false,
    error: ((reason: unknown) => void) | undefined = options.onError;
  const mark = (reason: unknown) => {
    if (failed) return;
    failed = true;
    delete exhibit.dataset.ready;
    exhibit.dataset.error ??= reason instanceof Error ? reason.message : String(reason);
    const report = error;
    error = undefined;
    report?.(reason);
  };
  const size = () => {
    const width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height,
      ratio = Math.min(globalThis.devicePixelRatio || 1, pixelRatio, maxWidth / Math.max(1, width)),
      w = Math.max(1, Math.round(width * ratio)),
      h = Math.max(1, Math.round(height * ratio));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  };
  size();
  const outer = options.signal;
  const loadCompat =
    options.loadCompat ??
    (() => import('@margoengine/webgl2-compat') as unknown as Promise<{ install(o?: object): Promise<unknown> }>);
  const compat = options.compat;
  let started;
  try {
    outer?.throwIfAborted();
    started = await (await import('@margoengine/webgl2-compat/auto')).startEngine(canvas, {
      ...options.engine,
      camera: options.camera ?? { position: [3.2, 2.1, 4.4], target: [0, 0.6, 0], fov: 35, near: 0.05, far: 200 },
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      exactSize: true,
      antialias: options.antialias ?? true,
      startupTimeout: options.startupTimeout ?? 8000,
      signal: outer,
      forceCompat: options.backend === 'webgl2' || (options.backend !== 'auto' && forcedCompat()),
      loadCompat: compat
        ? async () => {
            const layer = await loadCompat();
            return { install: (o?: object) => layer.install({ ...o, ...compat }) };
          }
        : loadCompat,
    });
  } catch (reason) {
    mark(reason);
    throw reason;
  }
  const { engine, renderer } = started;
  exhibit.dataset.renderer = renderer;
  engine.scene.background = options.background ?? '#77736d';
  let raf = 0,
    requested = false,
    last = 0,
    time = 0;
  const callbacks = new Set<(delta: number, time: number) => void>();
  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),
    damping = typeof options.orbit === 'object' ? (options.orbit.damping ?? true) : true;
  const fail = (reason: unknown) => {
    if (signal.aborted) return;
    mark(reason);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  engine.onError = fail;
  const tick = (now: number) => {
    raf = 0;
    if (signal.aborted || failed) return;
    const delta = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = callbacks.size ? now : 0;
    time += delta;
    requested = false;
    try {
      for (const callback of callbacks) callback(delta, time);
      engine.render({ delta });
    } catch (reason) {
      fail(reason);
      return;
    }
    if (!raf && (callbacks.size || requested)) raf = requestAnimationFrame(tick);
  };
  const request = () => {
    if (signal.aborted || failed) return;
    requested = true;
    if (!raf) raf = requestAnimationFrame(tick);
  };
  let shadows: Shadows | undefined,
    contact: ContactShadows | undefined,
    backdrop: Backdrop | undefined,
    lighting: EnvironmentLighting | undefined,
    tonemap: Tonemap | undefined,
    ao: GTAO | undefined,
    orbit: OrbitControls | undefined;
  try {
    const light = options.light === false ? undefined : (options.light ?? {});
    if (light) {
      const [x, y, z] = normalize(light.direction ?? [-0.55, 1, 0.7]),
        color = light.color ?? [1, 0.95, 0.88],
        ambient = light.ambientColor ?? [0.9, 0.95, 1.05];
      engine.lighting.direction.set([x, y, z, light.intensity ?? 2.6]);
      engine.lighting.radiance.set([color[0], color[1], color[2], light.ambient ?? 0.25]);
      engine.lighting.ambient.set([ambient[0], ambient[1], ambient[2]]);
    }
    if (options.backdrop !== false)
      backdrop = Backdrop.attach(engine, {
        width: 40,
        depth: 24,
        height: 14,
        radius: 4,
        ...options.backdrop,
        material: { color: '#a9a49c', roughness: 0.92, metalness: 0, ...options.backdrop?.material },
      });
    if (options.contact !== false)
      contact = ContactShadows.attach(engine, { size: 6, height: 0.6, opacity: 0.55, blur: 0.06, ...options.contact });
    const loads: Promise<unknown>[] = [];
    if (options.shadows !== false)
      loads.push(
        import('@margoengine/shadows').then(({ Shadows }) => {
          signal.throwIfAborted();
          shadows = Shadows.attach(engine, { lightSize: 0.02, ...(options.shadows || {}) });
          if (backdrop) shadows.add(backdrop.mesh, { static: true });
        }),
      );
    const env = options.environment;
    if (env !== false) {
      const settings = typeof env === 'string' ? { preset: env } : (env ?? {});
      loads.push(
        stagingLighting(engine, settings.preset ?? 'soft', { width: settings.width ?? 256, signal: outer }).then(
          (value) => {
            lighting = value;
            lighting.environment.intensity = settings.intensity ?? 0.55;
          },
        ),
      );
    }
    if (options.tonemap)
      loads.push(
        import('@margoengine/tonemap').then(({ Tonemap }) => {
          tonemap = Tonemap.attach(engine, options.tonemap || {});
        }),
      );
    if (options.ao)
      loads.push(
        import('@margoengine/post/gtao').then(({ GTAO }) => {
          ao = GTAO.attach(engine, options.ao === true ? {} : (options.ao as GTAOOptions));
        }),
      );
    if (options.orbit) {
      const settings = options.orbit === true ? {} : options.orbit;
      loads.push(
        import('@margoengine/controls/orbit').then(({ OrbitControls }) => {
          const controls = new OrbitControls(engine, canvas);
          if (settings.target) controls.target = [settings.target[0], settings.target[1], settings.target[2]];
          if (settings.minDistance !== undefined) controls.minDistance = settings.minDistance;
          if (settings.maxDistance !== undefined) controls.maxDistance = settings.maxDistance;
          controls.enableDamping = damping && !motion?.matches;
          // Damped motion lands in update(), so frames run from 'start' to 'end' and the settling 'change' events after it.
          const keep = () => {};
          controls.addEventListener('change', () => request());
          controls.addEventListener('start', () => {
            callbacks.add(keep);
            request();
          });
          controls.addEventListener('end', () => {
            callbacks.delete(keep);
            request();
          });
          orbit = controls;
        }),
      );
    }
    await Promise.all(loads);
    outer?.throwIfAborted();
  } catch (reason) {
    mark(reason);
    for (const item of [orbit, ao, tonemap, lighting, shadows, contact, backdrop]) item?.dispose();
    engine.dispose();
    throw reason;
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    callbacks.clear();
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const item of [orbit, ao, tonemap, lighting, shadows, contact, backdrop]) item?.dispose();
    engine.dispose();
  };
  if (outer) {
    const abort = () => dispose();
    outer.addEventListener('abort', abort, { once: true });
    cleanups.push(() => outer.removeEventListener('abort', abort));
  }
  const pagehide = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) dispose();
  };
  globalThis.addEventListener?.('pagehide', pagehide);
  cleanups.push(() => globalThis.removeEventListener?.('pagehide', pagehide));
  if (motion) {
    const change = () => {
      if (orbit) orbit.enableDamping = damping && !motion.matches;
      exhibit.dataset.reducedMotion = String(motion.matches);
      request();
    };
    motion.addEventListener?.('change', change);
    cleanups.push(() => motion.removeEventListener?.('change', change));
    exhibit.dataset.reducedMotion = String(motion.matches);
  }
  const bench: Bench = {
    engine,
    canvas,
    renderer,
    shadows,
    contact,
    backdrop,
    lighting,
    tonemap,
    ao,
    orbit,
    signal,
    get reducedMotion() {
      return !!motion?.matches;
    },
    get failed() {
      return failed;
    },
    add(mesh, { shadow = true, contact: casts = true, static: still = false } = {}) {
      const removers: (() => void)[] = [];
      if (shadow && shadows && 'id' in (mesh as object))
        removers.push(shadows.add(mesh as MeshHandle, { static: still }));
      if (casts && contact) removers.push(contact.add(mesh));
      return () => {
        for (const remove of removers.splice(0)) remove();
      };
    },
    frame(callback) {
      if (typeof callback !== 'function') throw typeError('frame needs a function', 'arguments');
      callbacks.add(callback);
      request();
      return () => {
        callbacks.delete(callback);
      };
    },
    request,
    async render(delta = 0) {
      if (signal.aborted || failed) return;
      try {
        engine.render({ delta });
        await engine.gpu?.queue.onSubmittedWorkDone();
      } catch (reason) {
        fail(reason);
        throw reason;
      }
    },
    async ready() {
      await bench.render(0);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (failed || signal.aborted) return false;
      exhibit.dataset.ready = 'true';
      return true;
    },
    fail,
    dispose,
    [Symbol.dispose]: dispose,
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      if (signal.aborted || !size()) return;
      options.onResize?.(bench);
      request();
    });
    observer.observe(canvas);
    cleanups.push(() => observer.disconnect());
  }
  return bench;
}
