import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
  type CSSProperties,
} from 'react';
import {
  Engine,
  type Mesh as EngineMesh,
  box,
  PbrMaterial as Material,
  type EngineOptions,
  type EnginePlugin,
  type Vec3,
  type Geometry,
} from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle, FrameCallback } from '@margoengine/core';
import { Stage as StageFacade } from '@margoengine/stage';
import type { Shadows } from '@margoengine/shadows';
import { createAssetCache, activateAssetCache, disposeAssetCache } from './assets.js';
import { MargoError } from '@margoengine/math/errors';
import { MeshShadows } from './mesh-shadows.js';
import { setRenderLayers } from '../../shared/layers.js';

import {
  Context,
  useScene,
  useMesh,
  live,
  setGeometry,
  zero,
  one,
  useCommit,
  createViews,
  type Scene,
  type Registry,
  type Resources,
  type Frames,
  type PointerHandlers,
  type ShadowsLoader,
} from './internal.js';
export type { MargoPointerEvent, PointerHandlers } from './internal.js';
import { warnLowercaseTags, warnPickingWithoutWebGPU } from './dev-warnings.js';
import { ownerHook } from './dev-names.js';
import { capPixelRatio } from './pixel-ratio.js';
import { envReadable } from './dev-mode.js';
// Bundlers replace process.env.NODE_ENV, usually with no global `process` on the page: see dev-mode.ts.
declare const process: { env: { NODE_ENV?: string } };

/** What {@link useMargo} returns: the stage, canvas, camera, size and engine, plus `invalidate()`. */
export interface MargoContextValue {
  stage: StageFacade | null;
  ready: boolean;
  canvas: HTMLCanvasElement | null;
  camera: EngineKernel['camera'] | null;
  size: { width: number; height: number };
  gl: EngineKernel | null;
  readonly clock: number;
  invalidate(): void;
}
/** React context holding the engine; read it with {@link useMargo}. */
export const MargoContext = createContext<MargoContextValue | null>(null);
/** Returns the context (stage, canvas, camera, size) of the nearest MargoCanvas; throws a MargoError (`state`) outside one. */
export function useMargo(): MargoContextValue {
  const value = useContext(MargoContext);
  if (!value) throw new MargoError('state', 'useMargo requires <MargoCanvas>; call it inside one.');
  return value;
}
/** Props of the Canvas component; every prop is optional unless noted. */
export interface CanvasProps extends EngineOptions {
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  label?: string;
  /**
   * Which GPU the engine asks the browser for on a PC with two: `'high-performance'` (the discrete GPU) or
   * `'low-power'` (the integrated one, which saves battery). Passed to `Engine.create` and asked again when the device
   * is restored. Chrome and Edge on Windows ignore a set value and log a warning; choose the GPU in Windows graphics
   * settings there. Read when the engine is created, so a new value applies to the next engine (a change of
   * `capacity`, `backend` or `fallback` creates one). Default: unset, which asks for `'high-performance'`, and for
   * nothing on Windows.
   */
  powerPreference?: EngineOptions['powerPreference'];
  onCreated?: (stage: StageFacade) => void;
  onError?: (error: unknown) => void;
  frameloop?: 'always' | 'demand';
  /**
   * Caps the canvas pixel ratio below the engine's own limit of 2, for example `1` on a laptop that struggles at
   * retina size. Core has no per-canvas option for this, so the Canvas uses the engine's light tier (the
   * `globalThis.margoLow` pixel-ratio cap), which also turns off MSAA and applies to every canvas on the page while one
   * with `maxDpr` is mounted (the lowest value wins; the previous setting returns when the last one unmounts). A value
   * of 2 or more changes nothing, because the engine never goes above 2. A `margoLow` you set yourself still counts.
   * Changing it recreates the engine. A value that is not a number above 0 reaches `onError` as a `RangeError`.
   * Default: none (engine limit of 2, MSAA on desktop).
   */
  maxDpr?: number;
  /**
   * Loads the renderer factory for browsers without WebGPU, for example `() => import('margoengine/webgl')`. The Canvas
   * checks for WebGPU itself (`navigator.gpu` and a successful `requestAdapter()`) before it creates the engine and
   * calls this only when WebGPU is missing (or `backend` is `'webgl2'`), so WebGPU visitors download none of the
   * fallback package. It resolves to the factory (`webglRenderer`) or to a module exporting it as `webglRenderer`. A
   * module that also exports `webglPicking` (`margoengine/webgl/pick`) gives the preview working pointer handlers.
   * `signal` aborts when the Canvas unmounts or recreates its engine while the load is still pending. A rejection
   * becomes a `MargoError` with code `unsupported`, sent to `onError` and shown as `fallbackContent` or the plain
   * message. Ignored when `fallback` is given or `backend` is `'webgpu'`; read when the engine is created, so a new
   * function does not recreate the engine. Default: none.
   */
  loadFallback?: (
    signal: AbortSignal,
  ) => Promise<RendererFactory | { webglRenderer: RendererFactory; webglPicking?: () => EnginePlugin }>;
  /**
   * Shown in place of the default text when the browser has no WebGPU and no usable renderer fallback: an SVG, a
   * skeleton or a pre-rendered image. `onError` still receives the coded `unsupported` error. Default: the plain
   * message "This 3D scene needs a browser with WebGPU, such as a current Chrome, Edge or Safari."
   */
  fallbackContent?: ReactNode;
}
/** A renderer factory for `fallback`, such as `webglRenderer` from `@margoengine/webgl`. */
export type RendererFactory = NonNullable<EngineOptions['fallback']>;
/** Props of the MargoCanvas component; every prop is optional unless noted. */
export type MargoCanvasProps = CanvasProps;
// Shown in place of the scene when the browser has no WebGPU (and no `fallback`); `onError` still gets the coded error.
const unsupportedMessage = 'This 3D scene needs a browser with WebGPU, such as a current Chrome, Edge or Safari.';
// True when the browser exposes WebGPU and an adapter answers; the same test the engine's own WebGPU start makes.
async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
    return gpu !== undefined && (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}
async function resolveFallback(load: NonNullable<CanvasProps['loadFallback']>, signal: AbortSignal) {
  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load(signal);
  } catch (cause) {
    throw Object.assign(
      new MargoError('unsupported', `loadFallback failed (${String(cause)}); check the import path or the network.`),
      { cause },
    );
  }
  const factory = typeof loaded === 'function' ? loaded : loaded?.webglRenderer;
  if (typeof factory !== 'function')
    throw new MargoError('unsupported', 'loadFallback must resolve to a renderer factory or { webglRenderer }.');
  return { factory, picking: typeof loaded === 'function' ? undefined : loaded.webglPicking };
}
/** Core's pick answers on every backend but the preview, where `webglPicking` covers it. */
const hasPick = (engine: Engine) => engine.backend !== 'webgl2' || engine.plugins.has('webgl-pick');
/** The margo canvas component. */
export function MargoCanvas({
  children,
  style,
  className,
  label = 'Interactive 3D scene',
  capacity = 1024,
  backend = 'auto',
  camera,
  powerPreference,
  fallback,
  loadFallback,
  fallbackContent,
  frameloop = 'always',
  maxDpr,
  onCreated,
  onError,
}: CanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null),
    queue = useRef<Promise<void>>(Promise.resolve()),
    created = useRef(onCreated),
    errorHandler = useRef(onError),
    fallbackLoader = useRef(loadFallback);
  const [stage, setStage] = useState<StageFacade | null>(null),
    [error, setError] = useState<unknown>(null),
    [shadow, setShadow] = useState<Shadows | null>(null);
  // `<Shadows>` (and `<ContactShadows>`) from @margoengine/react/shadows turn the shadows on and bring the loader, so the
  // Canvas itself imports no optional package.
  const [shadowRequests, setShadowRequests] = useState(0),
    shadowLoader = useRef<ShadowsLoader | null>(null),
    enableShadows = shadowRequests > 0;
  const requestShadows = useMemo(
    () => (load: ShadowsLoader) => {
      shadowLoader.current ??= load;
      setShadowRequests((count) => count + 1);
      return () => setShadowRequests((count) => count - 1);
    },
    [],
  );
  const engine = stage?.engine as unknown as Engine | null;
  const cameraOverrides = useMemo(() => new Set<() => void>(), [engine]);
  const pointerHandlers = useMemo(() => {
    const handlers = new Map<number, PointerHandlers>();
    if (envReadable && process.env.NODE_ENV !== 'production' && engine?.backend === 'webgl2') {
      const set = handlers.set.bind(handlers);
      handlers.set = (id, value) => {
        if ((value.onClick || value.onPointerOver || value.onPointerOut) && !hasPick(engine)) warnPickingWithoutWebGPU();
        return set(id, value);
      };
    }
    return handlers;
  }, [engine]);
  useEffect(() => {
    const parent = canvas.current?.parentElement;
    if (!engine || !parent || !envReadable || process.env.NODE_ENV === 'production') return;
    if (warnLowercaseTags(parent) || typeof MutationObserver === 'undefined') return;
    const watch = new MutationObserver(() => warnLowercaseTags(parent) && watch.disconnect());
    watch.observe(parent, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [engine]);
  const frames = useMemo<Frames>(() => ({ elapsed: 0, last: null, mode: frameloop, callbacks: new Set() }), [engine]);
  frames.mode = frameloop;
  const assetCache = useMemo(() => createAssetCache(engine as unknown as EngineKernel | null), [engine]);
  const resources = useMemo<Resources>(() => ({ models: new Set(), lighting: new Map() }), [engine]);
  const views = useMemo(() => (engine ? createViews(engine) : null), [engine]);
  useEffect(() => {
    if (engine) activateAssetCache(assetCache);
    return () => disposeAssetCache(assetCache);
  }, [engine, assetCache]);
  const cameraOptions = useRef(camera),
    powerOption = useRef(powerPreference),
    frameloopOptions = useRef(frameloop),
    engineMode = useRef(frameloop);
  created.current = onCreated;
  errorHandler.current = onError;
  fallbackLoader.current = loadFallback;
  cameraOptions.current = camera;
  powerOption.current = powerPreference;
  frameloopOptions.current = frameloop;
  const advance = useMemo(
    () => (delta: number) => {
      frames.elapsed += delta;
      for (const callback of frames.callbacks) callback(engine as unknown as EngineKernel, delta);
    },
    [engine, frames],
  );
  const invalidate = useMemo(
    () => () => {
      if (!engine || engine.disposed || frameloopOptions.current !== 'demand') return;
      const now = performance.now(),
        delta = frames.last === null ? 0 : Math.max(0, Math.min((now - frames.last) / 1000, engine.maxDelta));
      frames.last = now;
      try {
        advance(delta);
        if (!engine.disposed) engine.render({ delta });
      } catch (error) {
        engine.onError(error);
      }
    },
    [engine, frames, advance],
  );
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;
  // On demand, a page back from a background tab restarts the clock too (the engine's own loop does so for 'always').
  useEffect(() => {
    const page = engine?.canvas.ownerDocument;
    if (!page) return;
    const wake = () => {
      frames.last = null;
    };
    page.addEventListener('visibilitychange', wake);
    return () => page.removeEventListener('visibilitychange', wake);
  }, [engine, frames]);
  useEffect(() => {
    const element = canvas.current!;
    const abort = new AbortController();
    let cancelled = false,
      current: Engine | undefined,
      observer: ResizeObserver | undefined;
    setStage(null);
    setError(null);
    const report = (error: unknown) => {
      if (!cancelled) {
        setError(error);
        errorHandler.current?.(error);
      }
    };
    let releasePixelRatio = () => {};
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (cancelled) return;
        if (maxDpr !== undefined) releasePixelRatio = capPixelRatio(maxDpr);
        let renderer = fallback,
          picking: (() => EnginePlugin) | undefined;
        const load = fallbackLoader.current;
        if (!renderer && load && backend !== 'webgpu' && (backend === 'webgl2' || !(await hasWebGPU()))) {
          if (cancelled) return;
          const loaded = await resolveFallback(load, abort.signal);
          if (cancelled) return;
          renderer = loaded.factory;
          picking = loaded.picking;
        }
        const instance = await Engine.create(element, {
          capacity,
          backend,
          camera: cameraOptions.current,
          fallback: renderer,
          powerPreference: powerOption.current,
        });
        if (cancelled) {
          instance.dispose();
          return;
        }
        current = instance;
        instance.onError = report;
        try {
          // The engine sizes the canvas itself on every render (whole device pixels, its own pixel-ratio cap). Sizing
          // it here too fought that size and, on demand, left a cleared canvas until the next frame: a resize redraws.
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => invalidateRef.current());
            observer.observe(element);
          }
          if (picking && instance.backend === 'webgl2') instance.use(picking());
          const next = new StageFacade(instance as unknown as EngineKernel);
          if (cameraOptions.current) Object.assign(instance.camera, cameraOptions.current);
          created.current?.(next);
          if (!cancelled && !instance.disposed) {
            setStage(next);
            engineMode.current = frameloopOptions.current;
            if (engineMode.current === 'always') instance.start();
          }
        } catch (error) {
          observer?.disconnect();
          instance.dispose();
          setStage(null);
          throw error;
        }
      })
      .catch(report);
    return () => {
      cancelled = true;
      abort.abort();
      observer?.disconnect();
      current?.dispose();
      releasePixelRatio();
    };
  }, [capacity, backend, fallback, maxDpr]);
  useCommit(() => {
    if (engine) return engine.onFrame((_, delta) => advance(delta));
  }, [engine, advance]);
  useCommit(() => {
    if (!engine || engine.disposed || engineMode.current === frameloop) return;
    frames.last = null;
    engineMode.current = frameloop;
    if (frameloop === 'demand') engine.stop();
    else engine.start();
  }, [engine, frameloop, frames]);
  useEffect(() => {
    if (!engine || engine.disposed) return;
    const element = engine.canvas;
    let active = true,
      hover: EngineMesh | null = null,
      hoverRequest = 0;
    let down: { id: number; x: number; y: number; movement: number } | null = null;
    type PickRequest = { x: number; y: number; receive: (mesh: EngineMesh | null) => void };
    let picking = false,
      pendingHover: PickRequest | null = null;
    const clicks: PickRequest[] = [];
    const coordinates = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const dispatch = (kind: keyof PointerHandlers, mesh: EngineMesh, event: PointerEvent) => {
      if (engine.disposed || engine.meshes.get(mesh.id) !== mesh) return;
      const object = mesh as unknown as MeshHandle;
      pointerHandlers.get(mesh.id)?.[kind]?.({
        nativeEvent: event,
        object,
        mesh: object,
        target: object,
        clientX: event.clientX,
        clientY: event.clientY,
        ...coordinates(event),
      });
    };
    const move = (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId) return;
      down.movement += Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down.x = event.clientX;
      down.y = event.clientY;
    };
    const canPick = () => {
      if (!hasPick(engine)) return false;
      for (const handlers of pointerHandlers.values())
        if (handlers.onClick || handlers.onPointerOver || handlers.onPointerOut) return true;
      return false;
    };
    const nextPick = () => {
      if (picking || !active || engine.disposed) return;
      const request = clicks.shift() ?? pendingHover;
      if (!request) return;
      if (request === pendingHover) pendingHover = null;
      picking = true;
      // One request at a time: clicks keep their order and a burst of hovers collapses to the latest.
      void Promise.resolve()
        .then(async () => {
          if (!active || engine.disposed || !canPick()) return null;
          if (resources.models.size) await resources.picking?.prepare(engine, resources, frames);
          return active && !engine.disposed ? engine.pick(request.x, request.y) : null;
        })
        .then((mesh) => {
          if (active && !engine.disposed) request.receive(mesh);
        })
        .catch((error) => {
          if (active && !engine.disposed) engine.onError(error);
        })
        .finally(() => {
          picking = false;
          nextPick();
        });
    };
    const pick = (kind: 'click' | 'hover', event: PointerEvent, receive: (mesh: EngineMesh | null) => void) => {
      if (!canPick()) {
        receive(null);
        return;
      }
      const request = { ...coordinates(event), receive };
      if (kind === 'click') clicks.push(request);
      else pendingHover = request;
      nextPick();
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY, movement: 0 };
    };
    const pointerup = (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId) return;
      move(event);
      const clicked = down.movement <= 3;
      down = null;
      if (clicked)
        pick('click', event, (mesh) => {
          if (mesh) dispatch('onClick', mesh, event);
        });
    };
    const pointermove = (event: PointerEvent) => {
      move(event);
      const request = ++hoverRequest;
      pick('hover', event, (mesh) => {
        if (request !== hoverRequest || hover === mesh) return;
        const previous = hover;
        hover = mesh;
        if (previous) dispatch('onPointerOut', previous, event);
        if (mesh) dispatch('onPointerOver', mesh, event);
      });
    };
    const pointerleave = (event: PointerEvent) => {
      ++hoverRequest;
      pendingHover = null;
      down = null;
      const previous = hover;
      hover = null;
      if (previous) dispatch('onPointerOut', previous, event);
    };
    const pointercancel = (event: PointerEvent) => {
      if (down?.id === event.pointerId) down = null;
      pointerleave(event);
    };
    element.addEventListener('pointerdown', pointerdown);
    element.addEventListener('pointerup', pointerup);
    element.addEventListener('pointermove', pointermove);
    element.addEventListener('pointerleave', pointerleave);
    element.addEventListener('pointercancel', pointercancel);
    return () => {
      active = false;
      ++hoverRequest;
      down = null;
      hover = null;
      pendingHover = null;
      clicks.length = 0;
      resources.picking?.release(engine);
      element.removeEventListener('pointerdown', pointerdown);
      element.removeEventListener('pointerup', pointerup);
      element.removeEventListener('pointermove', pointermove);
      element.removeEventListener('pointerleave', pointerleave);
      element.removeEventListener('pointercancel', pointercancel);
    };
  }, [engine, pointerHandlers, resources, frames]);
  useCommit(() => {
    if (engine && camera) {
      Object.assign(engine.camera, camera);
      for (const apply of cameraOverrides) apply();
    }
  }, [
    engine,
    cameraOverrides,
    camera?.position?.[0],
    camera?.position?.[1],
    camera?.position?.[2],
    camera?.target?.[0],
    camera?.target?.[1],
    camera?.target?.[2],
    camera?.fov,
    camera?.near,
    camera?.far,
  ]);
  useEffect(() => {
    setShadow(null);
    if (!engine || !enableShadows) return;
    let cancelled = false,
      effect: Shadows | undefined;
    shadowLoader.current!()
      .then(({ Shadows }) => {
        if (cancelled || engine.disposed) return;
        effect = Shadows.attach(engine as unknown as EngineKernel);
        setShadow(effect);
      })
      .catch((error) => {
        if (!cancelled) engine.onError(error);
      });
    return () => {
      cancelled = true;
      effect?.dispose();
    };
  }, [engine, enableShadows]);
  const scene = useMemo<Scene | null>(
    () =>
      engine
        ? {
            engine,
            registry: null,
            resources,
            shadows: enableShadows && shadow?.owner === engine ? shadow : null,
            requestShadows,
            cameraOverrides,
            pointerHandlers,
            frames,
            assetCache,
            world: null,
            views: views!,
          }
        : null,
    [
      engine,
      resources,
      enableShadows,
      shadow,
      requestShadows,
      cameraOverrides,
      pointerHandlers,
      frames,
      assetCache,
      views,
    ],
  );
  const value = useMemo<MargoContextValue>(
    () => ({
      stage,
      ready: !!stage && !stage.engine.disposed,
      canvas: canvas.current,
      camera: stage?.engine.camera ?? null,
      gl: stage?.engine ?? null,
      get size() {
        return { width: canvas.current?.clientWidth ?? 0, height: canvas.current?.clientHeight ?? 0 };
      },
      get clock() {
        return frames.elapsed;
      },
      invalidate,
    }),
    [stage, frames, invalidate],
  );
  return (
    <MargoContext.Provider value={value}>
      <canvas
        ref={canvas}
        className={className}
        style={{ display: 'block', width: '100%', height: '100%', ...style }}
        role="img"
        aria-label={label}
      />
      {error !== null &&
        ((error as { code?: string } | undefined)?.code === 'unsupported' && fallbackContent != null ? (
          <div role="alert">{fallbackContent}</div>
        ) : (
          <p role="alert">
            {(error as { code?: string } | undefined)?.code === 'unsupported' ? unsupportedMessage : String(error)}
          </p>
        ))}
      {scene && !engine?.disposed && <Context.Provider value={scene}>{children}</Context.Provider>}
    </MargoContext.Provider>
  );
}
/** The canvas component. */
export const Canvas = MargoCanvas;
/** Returns the engine of the nearest Stage or Canvas. */
export function useMargoStage(): EngineKernel {
  return useScene().engine as unknown as EngineKernel;
}

/** Props of the Stage component; every prop is optional unless noted. */
export interface StageProps {
  camera?: EngineOptions['camera'];
  children?: ReactNode;
}
/** The stage component. */
export function Stage({ camera, children }: StageProps) {
  const { stage, ready } = useMargo(),
    scene = useContext(Context);
  const cameraOverrides = scene?.cameraOverrides;
  const active = ready && !!stage && !stage.engine.disposed;
  useCommit(() => {
    if (!active || !camera) return;
    // Reapply wrapper settings when Canvas updates its camera defaults.
    const apply = () => {
      Object.assign(stage.engine.camera, camera);
    };
    cameraOverrides?.add(apply);
    apply();
    return () => {
      cameraOverrides?.delete(apply);
    };
  }, [
    stage,
    active,
    cameraOverrides,
    camera?.position?.[0],
    camera?.position?.[1],
    camera?.position?.[2],
    camera?.target?.[0],
    camera?.target?.[1],
    camera?.target?.[2],
    camera?.fov,
    camera?.near,
    camera?.far,
  ]);
  return active ? <>{children}</> : null;
}

/** A ref to a Mesh component: the engine mesh it creates. */
export type MeshRef = MeshHandle;
/** Props of the Mesh component; every prop is optional unless noted. */
export interface MeshProps extends PointerHandlers {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  /** Draw into the Canvas shadow map, once a `<Shadows>` (`@margoengine/react/shadows`) turns it on. Default false. */
  castShadow?: boolean;
  /** Darken where shadows fall. Default true. */
  receiveShadow?: boolean;
  /**
   * Render-layer mask (`layerMask(...)` from `@margoengine/cameras/layers`, or the number): a `<RenderView layers>` draws only meshes
   * sharing a bit with it. Default: the parent mesh's, else layer 1.
   */
  layers?: number;
  children?: ReactNode;
}
/** The mesh component. */
export const Mesh = forwardRef<MeshRef, MeshProps>(function Mesh(
  {
    position = zero,
    rotation = zero,
    scale = one,
    castShadow = false,
    receiveShadow = true,
    layers,
    children,
    onClick,
    onPointerOver,
    onPointerOut,
  },
  ref,
) {
  const parentScene = useScene(),
    { engine, registry: parent, pointerHandlers, world } = parentScene;
  const [node, setNode] = useState<EngineMesh | null>(null);
  // Once per mount, while rendering, the only time React gives the owner stack.
  const [owner] = useState(() => ownerHook.capture?.());
  const registry = useMemo<Registry>(
    () => ({
      current: null,
      children: new Set(),
      attachments: new Set(),
      geometry: null,
      register(mesh) {
        this.children.add(mesh);
        if (this.current) mesh.setParent(this.current);
      },
      unregister(mesh) {
        this.children.delete(mesh);
        if (engine.meshes.get(mesh.id) === mesh && !engine.disposed) mesh.setParent(null);
      },
    }),
    [engine],
  );
  useCommit(() => {
    // In the enclosing <Scene>'s engine scene, else the default one.
    const mesh = (world ?? engine).createMesh() as EngineMesh;
    registry.current = mesh;
    ownerHook.remember?.(mesh, owner);
    try {
      parent?.register(mesh);
      for (const child of registry.children) if (engine.meshes.get(child.id) === child) child.setParent(mesh);
      for (const attach of registry.attachments) attach(mesh);
      setNode(mesh);
    } catch (error) {
      parent?.unregister(mesh);
      registry.current = null;
      mesh.dispose();
      throw error;
    }
    return () => {
      parent?.unregister(mesh);
      registry.current = null;
      mesh.dispose();
    };
  }, [engine, world, parent, registry]);
  useCommit(() => {
    const mesh = registry.current;
    if (!mesh || !(onClick || onPointerOver || onPointerOut)) return;
    const handlers = { onClick, onPointerOver, onPointerOut };
    pointerHandlers.set(mesh.id, handlers);
    return () => {
      if (pointerHandlers.get(mesh.id) === handlers) pointerHandlers.delete(mesh.id);
    };
  }, [registry, node, pointerHandlers, onClick, onPointerOver, onPointerOut]);
  useCommit(() => {
    const mesh = registry.current;
    if (mesh) {
      mesh.setPosition(position);
      mesh.setRotation(rotation);
      mesh.setScale(scale);
    }
  }, [
    registry,
    node,
    position[0],
    position[1],
    position[2],
    rotation[0],
    rotation[1],
    rotation[2],
    scale[0],
    scale[1],
    scale[2],
  ]);
  // The layer registry core reads (shared with @margoengine/cameras/layers), so `layers` needs no package. Removing the
  // prop sets layer 1, the default of a mesh with no ancestor mask (the layers registry has no "unset").
  const layered = useRef(false);
  useCommit(() => {
    const mesh = live(registry);
    if (!mesh || (layers === undefined && !layered.current)) return;
    setRenderLayers(mesh as unknown as MeshHandle, layers ?? 1);
    layered.current = layers !== undefined;
  }, [registry, node, layers]);
  // The live mesh, not the `node` state: effects that recreate the mesh without a render (StrictMode's replay, a
  // Suspense boundary revealing again) would otherwise hand the ref the disposed one until the next render, and a
  // useFrame callback writing to it throws "Mesh disposed". This runs after the creation effect above.
  useImperativeHandle(ref, () => registry.current!, [registry, node]);
  const scene = useMemo(() => ({ ...parentScene, registry }), [parentScene, registry]);
  // The shadow helper gets a provider of its own, so `children` keep their exact structure (an element stays an
  // element, an array an array) and never remount when shadows are switched.
  return (
    <>
      {(castShadow || !receiveShadow) && (
        <Context.Provider value={scene}>
          <MeshShadows castShadow={castShadow} receiveShadow={receiveShadow} />
        </Context.Provider>
      )}
      <Context.Provider value={scene}>{children}</Context.Provider>
    </>
  );
});

/** Declarative box geometry; place it inside a Mesh. */
export function BoxGeometry({ args = one }: { args?: Vec3 }) {
  const registry = useMesh();
  useCommit(() => {
    const geometry = box(...args),
      attach = (mesh: EngineMesh) => {
        setGeometry(registry, mesh, geometry);
      };
    registry.attachments.add(attach);
    try {
      if (registry.current) attach(registry.current);
    } catch (error) {
      registry.attachments.delete(attach);
      throw error;
    }
    return () => {
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [registry, args[0], args[1], args[2]]);
  return null;
}
/** A geometry a component created and disposes on unmount. */
export function GeometryResource({ geometry }: { geometry: Geometry }) {
  const registry = useMesh();
  useCommit(() => {
    const attach = (mesh: EngineMesh) => {
      setGeometry(registry, mesh, geometry);
    };
    registry.attachments.add(attach);
    try {
      if (registry.current) attach(registry.current);
    } catch (error) {
      registry.attachments.delete(attach);
      throw error;
    }
    return () => {
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh && registry.geometry === geometry) setGeometry(registry, mesh, null);
    };
  }, [registry, geometry]);
  return null;
}
/** Props of the PbrMaterial component; every prop is optional unless noted. */
export interface PbrMaterialProps {
  color?: string | readonly number[];
  roughness?: number;
  metalness?: number;
}
/** The pbr material component. */
export function PbrMaterial({ color = '#4f46e5', roughness = 0.5, metalness = 0 }: PbrMaterialProps) {
  const registry = useMesh();
  useCommit(() => {
    const material = new Material({ color, roughness, metalness }),
      attach = (mesh: EngineMesh) => {
        mesh.setMaterial(material);
      };
    registry.attachments.add(attach);
    if (registry.current) attach(registry.current);
    return () => {
      registry.attachments.delete(attach);
      const mesh = live(registry);
      if (mesh?.material === material) mesh.setMaterial(new Material());
    };
  }, [registry, color, roughness, metalness]);
  return null;
}
/** Props of the Group component; every prop is optional unless noted. */
export type GroupProps = MeshProps;
export { Mesh as mesh, Mesh as Group, Mesh as group, BoxGeometry as boxGeometry, PbrMaterial as meshStandardMaterial };
/** Calls `callback` every frame with the frame time; unsubscribes on unmount. */
export function useFrame(callback: FrameCallback): void {
  const { frames } = useScene(),
    latest = useRef(callback);
  useCommit(() => {
    latest.current = callback;
  });
  useCommit(() => {
    const frame: FrameCallback = (state, delta) => latest.current(state, delta);
    frames.callbacks.add(frame);
    return () => {
      frames.callbacks.delete(frame);
    };
  }, [frames]);
}
