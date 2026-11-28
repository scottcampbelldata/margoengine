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
  /** Strength. Default 3, a key about 2.4 times the softbox fill on a level floor, so shadows read. */
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
  /** Radiance multiplier. Default 0.25, a fill under the sun key that keeps shadows readable. */
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
  /** Fill and rim from a softbox environment; false keeps core's flat ambient. Default 'soft' at 0.25. */
  environment?: BenchEnvironment | StagingPreset | false;
  /** Cascaded PCSS shadows from the sun; false for none. Default `{ lightSize: 0.0047 }`, the sun's angular radius, so thin casters keep a crisp shadow. */
  shadows?: ShadowOptions | false;
  /** Soft ground contact shadows; false for none. Default a 6 x 6 plane at y 0, height 0.6, opacity 0.55. */
  contact?: ContactShadowOptions | false;
  /** A cyclorama; false for none. Default 80 wide, 24 deep, 14 high, radius 4, warm grey matte: wide enough that a view
   * across the floor at up to 70 degrees off the wall never sees past its side edge. */
  backdrop?: BackdropOptions | false;
  /** A display transform after the frame (exposure, curve, contrast). Default none: core's Khronos PBR Neutral at 0 EV. */
  tonemap?: TonemapOptions | false;
  /** Ground truth ambient occlusion (Jimenez et al. 2016). Default false. */
  ao?: GTAOOptions | boolean;
  /**
   * Frames the subject (every mesh passed to {@link Bench.add}) on {@link Bench.ready}: the camera keeps its view
   * direction and moves so the subject's world box fills `fill` of the narrower half of the view. Default true when
   * `camera` is not passed, false when it is (that camera is kept as given).
   */
  fit?: boolean | BenchFitOptions;
  /** Pointer orbit (controls/orbit); false for none. Default false. */
  orbit?: { target?: Vec3; minDistance?: number; maxDistance?: number; damping?: boolean } | boolean;
  /** Called after the backbuffer changed size, before the next frame. */
  onResize?: (bench: Bench) => void;
  /** Called once with the first failure (engine error, frame error, start-up error). */
  onError?: (reason: unknown) => void;
}

/** How {@link Bench.fit} frames the subject. */
export interface BenchFitOptions {
  /** World box to frame. Default the world box of every mesh passed to {@link Bench.add}. */
  bounds?: { min: Vec3; max: Vec3 };
  /** Share of the view's narrower half-extent the box reaches, 0.1..1. Default 0.8. */
  fill?: number;
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
  /**
   * Moves the camera (and the orbit target) so the subject fills the view, keeping the view direction; raises
   * `camera.far` when the subject reaches past it. Resolves false when there is nothing to frame or the camera has a
   * custom projection. Throws RangeError for an invalid `fill` or box.
   */
  fit(options?: BenchFitOptions): Promise<boolean>;
  /** Draws the first frame (framing the subject first when `fit` is on), waits for it, marks `data-ready` and `data-renderer`; false when already failed. */
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
/** A perspective view as {@link frameView} reads it: vertical `fov` in degrees, eye, look-at point and screen up. */
export interface FrameViewCamera {
  fov: number;
  position: Vec3;
  target: Vec3;
  up?: Vec3;
}

/**
 * Where a perspective camera goes to frame a world box: the target moves to the box centre and the eye backs along the
 * current view direction until every corner of the box lies inside `fill` of each half of the view (vertical `fov`,
 * horizontal from `aspect`). Tighter than a bounding-sphere fit, so a flat or long subject fills the frame. `far` is
 * the distance to the farthest corner.
 * @throws RangeError for a degenerate view, a non-finite box, `fill` outside 0.1..1 or `aspect` not positive.
 */
export function frameView(
  camera: FrameViewCamera,
  box: { min: Vec3; max: Vec3 },
  fill = 0.8,
  aspect = 1,
): { position: [number, number, number]; target: [number, number, number]; far: number } {
  const up = camera.up ?? [0, 1, 0],
    back = [0, 1, 2].map((a) => camera.position[a] - camera.target[a]),
    length = Math.hypot(back[0], back[1], back[2]),
    tanV = Math.tan((camera.fov * Math.PI) / 360) * fill,
    tanH = tanV * aspect;
  if (!(length > 0) || !(tanV > 0) || !Number.isFinite(tanH) || !(aspect > 0) || !(fill >= 0.1 && fill <= 1))
    throw rangeError('Invalid framing; pass a camera with a view direction, fov 0..180, aspect > 0, fill 0.1..1', 'arguments');
  const w = back.map((v) => v / length),
    cross = (a: readonly number[], b: readonly number[]) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    r0 = cross(up, w),
    rl = Math.hypot(r0[0], r0[1], r0[2]);
  if (!(rl > 1e-9)) throw rangeError('Invalid framing; the view is parallel to camera.up', 'arguments');
  const r = r0.map((v) => v / rl),
    u = cross(w, r),
    dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    centre = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2) as [number, number, number];
  let distance = 0,
    reach = 0;
  for (let i = 0; i < 8; i++) {
    const q = [0, 1, 2].map((a) => ((i >> a) & 1 ? box.max[a] : box.min[a]) - centre[a]),
      z = dot(q, w);
    distance = Math.max(distance, z + Math.abs(dot(q, r)) / tanH, z + Math.abs(dot(q, u)) / tanV);
    reach = Math.max(reach, Math.hypot(q[0], q[1], q[2]));
  }
  if (!Number.isFinite(distance)) throw rangeError('Invalid framing; the box must be finite', 'arguments');
  distance = Math.max(distance, reach * 1e-3, 1e-3);
  return {
    target: centre,
    position: centre.map((v, a) => v + w[a] * distance) as [number, number, number],
    far: distance + reach,
  };
}

const frameBox = (
  engine: EngineKernel,
  box: { min: Vec3; max: Vec3 },
  fill: number,
  aspect: number,
  orbit: OrbitControls | undefined,
) => {
  const camera = engine.camera;
  if (camera.project) return false;
  const view = frameView(camera, box, fill, aspect);
  camera.target = view.target;
  camera.position = view.position;
  if (view.far * 1.05 > camera.far) camera.far = view.far * 1.05;
  if (orbit) orbit.target = view.target;
  return true;
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
      engine.lighting.direction.set([x, y, z, light.intensity ?? 3]);
      engine.lighting.radiance.set([color[0], color[1], color[2], light.ambient ?? 0.25]);
      engine.lighting.ambient.set([ambient[0], ambient[1], ambient[2]]);
    }
    if (options.backdrop !== false)
      backdrop = Backdrop.attach(engine, {
        width: 80,
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
          shadows = Shadows.attach(engine, { lightSize: 0.0047, ...(options.shadows || {}) });
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
            lighting.environment.intensity = settings.intensity ?? 0.25;
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
  const subjects = new Set<MeshHandle>(),
    autoFit = options.fit ?? options.camera === undefined;
  let fitted = false;
  const fit = async (settings: BenchFitOptions = {}) => {
    const fill = settings.fill ?? 0.8;
    if (!(fill >= 0.1 && fill <= 1)) throw rangeError('Invalid fit; fill must be 0.1..1', 'arguments');
    let box = settings.bounds;
    if (!box) {
      if (!subjects.size) return false;
      const { worldBounds } = await import('@margoengine/scene/helpers');
      const min: [number, number, number] = [Infinity, Infinity, Infinity],
        max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const mesh of subjects) {
        const part = worldBounds(mesh);
        if (part)
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], part.min[a]);
            max[a] = Math.max(max[a], part.max[a]);
          }
      }
      if (!Number.isFinite(min[0])) return false;
      box = { min, max };
    }
    if (![...box.min, ...box.max].every(Number.isFinite) || box.min.some((v, i) => v > box.max[i]))
      throw rangeError('Invalid fit; bounds need finite min <= max', 'arguments');
    return frameBox(engine, box, fill, canvas.width / Math.max(1, canvas.height), orbit);
  };
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
      if ('id' in (mesh as object)) {
        subjects.add(mesh as MeshHandle);
        removers.push(() => subjects.delete(mesh as MeshHandle));
      }
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
    fit,
    async ready() {
      if (autoFit && !fitted && !failed && !signal.aborted) {
        fitted = true;
        await fit(typeof autoFit === 'object' ? autoFit : {});
      }
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
