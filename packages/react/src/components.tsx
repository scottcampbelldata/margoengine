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
  type Vec3,
  type Geometry,
} from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle, FrameCallback } from '@margoengine/core';
import { Stage as StageFacade } from '@margoengine/stage';
import { optionalPeer } from './optional.js';
import { preparePicking, releasePicking } from './picking.js';
import type { PBRModel, LightingEffect } from '@margoengine/gltf-pro';
import type { Shadows } from '@margoengine/shadows';
import type { Environment as IBLEnvironment, EnvironmentBackground } from '@margoengine/environment';
import { createAssetCache, activateAssetCache, disposeAssetCache, environmentAsset, retainAsset } from './assets.js';
import { MargoError } from '@margoengine/math/errors';
export { preload } from './assets.js';
import { MeshShadows } from './shadows.js';
export { Shadows, type ShadowsProps } from './shadows.js';

import {
  Context,
  useScene,
  useMesh,
  live,
  setGeometry,
  zero,
  one,
  useCommit,
  useResourceEffect,
  createViews,
  type Scene,
  type Registry,
  type Resources,
  type Frames,
  type PointerHandlers,
} from './internal.js';
export type { MargoPointerEvent, PointerHandlers } from './internal.js';

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
  shadows?: boolean;
  onCreated?: (stage: StageFacade) => void;
  onError?: (error: unknown) => void;
  frameloop?: 'always' | 'demand';
}
/** Props of the MargoCanvas component; every prop is optional unless noted. */
export type MargoCanvasProps = CanvasProps;
/** The margo canvas component. */
export function MargoCanvas({
  children,
  style,
  className,
  label = 'Interactive 3D scene',
  capacity = 1024,
  backend = 'auto',
  camera,
  fallback,
  shadows = false,
  frameloop = 'always',
  onCreated,
  onError,
}: CanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null),
    queue = useRef<Promise<void>>(Promise.resolve()),
    created = useRef(onCreated),
    errorHandler = useRef(onError);
  const [stage, setStage] = useState<StageFacade | null>(null),
    [error, setError] = useState<unknown>(null),
    [shadow, setShadow] = useState<Shadows | null>(null);
  const [shadowRequests, setShadowRequests] = useState(0),
    enableShadows = shadows || shadowRequests > 0;
  const requestShadows = useMemo(
    () => () => {
      setShadowRequests((count) => count + 1);
      return () => setShadowRequests((count) => count - 1);
    },
    [],
  );
  const engine = stage?.engine as unknown as Engine | null;
  const cameraOverrides = useMemo(() => new Set<() => void>(), [engine]);
  const pointerHandlers = useMemo(() => new Map<number, PointerHandlers>(), [engine]);
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
    frameloopOptions = useRef(frameloop),
    engineMode = useRef(frameloop);
  created.current = onCreated;
  errorHandler.current = onError;
  cameraOptions.current = camera;
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
        delta = frames.last === null ? 0 : Math.max(0, Math.min((now - frames.last) / 1000, 0.1));
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
  useEffect(() => {
    const element = canvas.current!;
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
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (cancelled) return;
        const instance = await Engine.create(element, { capacity, backend, camera: cameraOptions.current, fallback });
        if (cancelled) {
          instance.dispose();
          return;
        }
        current = instance;
        instance.onError = report;
        try {
          const resize = () => {
            const bounds = element.getBoundingClientRect(),
              ratio = element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
            element.width = Math.max(1, Math.round(bounds.width * ratio));
            element.height = Math.max(1, Math.round(bounds.height * ratio));
          };
          resize();
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(resize);
            observer.observe(element);
          }
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
      observer?.disconnect();
      current?.dispose();
    };
  }, [capacity, backend, fallback]);
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
      if (engine.backend === 'webgl2') return false;
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
          if (resources.models.size) await preparePicking(engine, resources, frames);
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
      releasePicking(engine);
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
    optionalPeer('@margoengine/shadows', () => import('@margoengine/shadows'))
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
      {error !== null && <p role="alert">{String(error)}</p>}
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
  shadows?: boolean;
  children?: ReactNode;
}
/** The stage component. */
export function Stage({ camera, shadows = false, children }: StageProps) {
  const { stage, ready } = useMargo(),
    scene = useContext(Context);
  const requestShadows = scene?.requestShadows,
    cameraOverrides = scene?.cameraOverrides;
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
  useEffect(() => {
    if (active && shadows) return requestShadows?.();
  }, [active, stage, shadows, requestShadows]);
  return active ? <>{children}</> : null;
}

/** A ref to a Mesh component: the engine mesh it creates. */
export type MeshRef = MeshHandle;
/** Props of the Mesh component; every prop is optional unless noted. */
export interface MeshProps extends PointerHandlers {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  /** Draw into the Canvas shadow map (turns shadows on; needs WebGPU and `@margoengine/shadows`). Default false. */
  castShadow?: boolean;
  /** Darken where shadows fall. Default true. */
  receiveShadow?: boolean;
  /**
   * Render-layer mask (`layerMask(...)` from `@margoengine/cameras/layers`): a `<RenderView layers>` draws only meshes
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
  // Layers load @margoengine/cameras/layers only when a mesh uses them. Removing the prop sets layer 1, the default
  // of a mesh with no ancestor mask (the layers registry has no "unset").
  const layered = useRef(false);
  useEffect(() => {
    const mesh = registry.current;
    if (!mesh || (layers === undefined && !layered.current)) return;
    let active = true;
    optionalPeer('@margoengine/cameras', () => import('@margoengine/cameras/layers'))
      .then(({ setRenderLayers }) => {
        if (!active || live(registry) !== mesh) return;
        setRenderLayers(mesh as unknown as MeshHandle, layers ?? 1);
        layered.current = layers !== undefined;
      })
      .catch((error) => {
        if (active && !engine.disposed) engine.onError(error);
      });
    return () => {
      active = false;
    };
  }, [registry, node, layers, engine]);
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

export { Model } from './model.js';
export type { ModelProps, MaterialOverride } from './model.js';
interface Loading {
  src: string;
  pending: boolean;
  promise: Promise<void>;
}
function values(value: readonly number[], size: number, label: string, min = 0, max = 1): void {
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < min || v > max)
  )
    throw new RangeError(`Invalid ${label}: pass an array of ${size} finite number(s) between ${min} and ${max}.`);
}

/** Props of the Environment component; every prop is optional unless noted. */
export interface EnvironmentProps {
  src?: string;
  exposure?: number;
  background?: boolean;
  /** Turn the environment about +Y, in radians: its lighting and background together. Default 0. */
  rotation?: number;
  /** Background blur: 0 sharp to 1 the roughest prefiltered level. Default 0. */
  blur?: number;
  onError?: (error: unknown) => void;
}
/** The environment component. */
export function Environment({
  src,
  exposure = 1,
  background = true,
  rotation = 0,
  blur = 0,
  onError,
}: EnvironmentProps) {
  const { engine, resources, assetCache } = useScene(),
    [environment, setEnvironment] = useState<IBLEnvironment | null>(null);
  const [loading, setLoading] = useState<Loading | null>(null),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [module, setModule] = useState<typeof import('@margoengine/environment') | null>(null);
  const previous = useRef<{ direction: Float32Array; radiance: Float32Array } | null>(null);
  const backdrop = useRef<EnvironmentBackground | null>(null);
  useCommit(() => {
    const saved = { direction: engine.lighting.direction.slice(), radiance: engine.lighting.radiance.slice() };
    previous.current = saved;
    return () => {
      engine.lighting.direction.set(saved.direction);
      engine.lighting.radiance.set(saved.radiance);
    };
  }, [engine]);
  useCommit(() => {
    values([exposure], 1, 'exposure', 0, Infinity);
    if (!src) {
      engine.lighting.direction.set([3, 5, 4, 3]);
      engine.lighting.radiance.set([exposure, exposure, exposure, 0.15 * exposure]);
    } else if (previous.current) {
      engine.lighting.direction.set(previous.current.direction);
      engine.lighting.radiance.set(previous.current.radiance);
      for (let i = 0; i < 4; i++) engine.lighting.radiance[i] *= exposure;
    }
    if (environment && !environment.disposed) environment.intensity = exposure;
  }, [engine, src, exposure, environment]);
  useResourceEffect(
    (lease) => {
      setEnvironment(null);
      setModule(null);
      if (!src) return;
      let current: IBLEnvironment | undefined;
      const asset = environmentAsset(assetCache, src),
        releaseAsset = retainAsset(assetCache, src, asset, assetCache.environments);
      const release = () => {
        if (current) {
          engine.removePlugin(current.name);
          current.dispose();
          current = undefined;
        }
      };
      const request: Loading = { src, pending: asset.status === 'pending', promise: Promise.resolve() };
      request.promise = (async () => {
        await asset.promise;
        if (!lease.active || engine.disposed) return;
        if (asset.status === 'rejected') throw asset.error;
        const { api, image } = asset.value!;
        const loaded = await api.Environment.create(engine as unknown as EngineKernel, image);
        if (!lease.active || engine.disposed) {
          loaded.dispose();
          return;
        }
        current = loaded;
        engine.use(loaded as unknown as import('@margoengine/core/extension').EnginePlugin);
        setModule(api);
        setEnvironment(loaded);
      })()
        .catch((error) => {
          release();
          if (lease.active && !engine.disposed) {
            try {
              errorHandler.current?.(error);
            } finally {
              engine.onError(error);
            }
          }
        })
        .finally(() => {
          request.pending = false;
        });
      setLoading(request);
      return () => {
        releaseAsset();
        release();
      };
    },
    [engine, src, assetCache],
  );
  useCommit(() => {
    if (!environment || environment.disposed || !module) return;
    // The environment package's own lighting: it lights core meshes as a plugin and every PBR model it is added to,
    // with the bindings and WGSL that package keeps current (a copy here went stale when its BRDF table moved to a
    // storage buffer and `<Environment>` stopped compiling on gltf-pro models).
    const lighting = new module.EnvironmentLighting(environment),
      effect = lighting as unknown as LightingEffect;
    engine.use(lighting);
    const models = new Map<PBRModel, () => void>();
    resources.lighting.set(effect, models);
    const release = () => {
      resources.lighting.delete(effect);
      for (const remove of models.values()) remove();
      models.clear();
      if (!engine.disposed && engine.hasPlugin(lighting.name)) engine.removePlugin(lighting.name);
      lighting.dispose();
    };
    try {
      for (const model of resources.models) models.set(model, model.addLighting(effect));
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }, [engine, resources, environment, module]);
  useCommit(() => {
    if (!environment || environment.disposed || !module || !background) return;
    const effect = new module.EnvironmentBackground(environment);
    engine.use(effect as unknown as import('@margoengine/core/extension').EnginePlugin);
    backdrop.current = effect;
    return () => {
      backdrop.current = null;
      engine.removePlugin(effect.name);
      effect.dispose();
    };
  }, [engine, environment, module, background]);
  useCommit(() => {
    if (backdrop.current) {
      backdrop.current.exposure = exposure;
      backdrop.current.blur = blur;
    }
  }, [environment, module, background, exposure, blur]);
  useCommit(() => {
    if (environment && !environment.disposed) environment.rotation = rotation;
  }, [environment, rotation]);
  if (loading && loading.src === src && loading.pending) throw loading.promise;
  return null;
}

type HTMLOverlay = import('@margoengine/html').HTML;
interface OverlayEntry {
  users: number;
  promise: Promise<HTMLOverlay>;
}
const overlays = new WeakMap<Engine, OverlayEntry>();
function acquireOverlay(engine: Engine): OverlayEntry {
  let entry = overlays.get(engine);
  if (!entry) {
    entry = {
      users: 0,
      promise: optionalPeer('@margoengine/html', () => import('@margoengine/html')).then(({ HTML }) => {
        if (engine.disposed)
          throw new MargoError('disposed', 'Canvas is disposed; render the component inside a live <Canvas>.');
        return HTML.attach(engine as unknown as EngineKernel);
      }),
    };
    overlays.set(engine, entry);
  }
  entry.users++;
  return entry;
}
function releaseOverlay(engine: Engine, entry: OverlayEntry): void {
  if (--entry.users) return;
  queueMicrotask(() => {
    if (entry.users || overlays.get(engine) !== entry) return;
    overlays.delete(engine);
    void entry.promise.then(
      (overlay) => overlay.dispose(),
      () => {},
    );
  });
}
/** Props of the Html component; every prop is optional unless noted. */
export interface HtmlProps {
  children?: ReactNode;
  /** World position, or the offset from the enclosing `<Mesh>`. Default [0, 0, 0]. */
  position?: Vec3;
  className?: string;
  style?: CSSProperties;
  /** Hide the label when scene geometry is in front of it (WebGPU depth). Default true. */
  occlude?: boolean;
  /** Point of the label placed on the anchor, in fractions of its size: [0.5, 0.5] centres it. Default [0.5, 0.5]. */
  anchor?: readonly [number, number];
  /** Scale with distance: a reference distance in world units (or `{ reference, min, max }`) at which scale is 1. */
  distanceScale?: number | { reference: number; min?: number; max?: number };
  /** Stack nearer labels above farther ones. Default false. */
  sort?: boolean;
  /** Hide the label when its anchor is outside the view. Default true. */
  frustumCulling?: boolean;
  /** Hide with an invisible enclosing mesh. Default true. */
  followVisibility?: boolean;
  /** Default true. */
  visible?: boolean;
  /** `'auto'` lets the label take clicks; default `'none'` lets them through to the canvas. */
  pointerEvents?: 'none' | 'auto';
  onError?: (error: unknown) => void;
}
/** Optional projected React DOM content, sharing one HTML plugin per canvas. */
export function Html({
  children,
  position = zero,
  className,
  style,
  occlude = true,
  anchor = [0.5, 0.5],
  distanceScale,
  sort = false,
  frustumCulling = true,
  followVisibility = true,
  visible = true,
  pointerEvents = 'none',
  onError,
}: HtmlProps) {
  const { engine, registry } = useScene();
  const [portal, setPortal] = useState<{
    element: HTMLElement;
    create: typeof import('react-dom').createPortal;
  } | null>(null);
  const label = useRef<import('@margoengine/html').Label | null>(null),
    latest = useRef({ position, occlude, onError });
  latest.current = { position, occlude, onError };
  const occlusion = useRef<import('@margoengine/html').Label['occlude']>(null);
  useEffect(() => {
    let active = true,
      current: HTMLOverlay | undefined,
      item: import('@margoengine/html').Label | undefined;
    const entry = acquireOverlay(engine),
      element = engine.canvas.ownerDocument.createElement('div');
    const attach = (mesh: EngineMesh) => {
      item?.setMesh(mesh as unknown as MeshHandle);
      item?.setOffset(latest.current.position);
    };
    Promise.all([entry.promise, optionalPeer('react-dom', () => import('react-dom'))])
      .then(([overlay, dom]) => {
        if (!active || engine.disposed) return;
        current = overlay;
        const mesh = registry?.current,
          p = latest.current.position;
        item = overlay.add(element, {
          mesh: mesh as unknown as MeshHandle | null,
          position: p,
          offset: mesh ? p : zero,
        });
        label.current = item;
        occlusion.current = item.occlude;
        if (!latest.current.occlude) item.occlude = () => false;
        registry?.attachments.add(attach);
        setPortal({ element, create: dom.createPortal });
      })
      .catch((error) => {
        if (active && !engine.disposed) {
          try {
            latest.current.onError?.(error);
          } finally {
            engine.onError(error);
          }
        }
      });
    return () => {
      active = false;
      registry?.attachments.delete(attach);
      if (item) current?.remove(item);
      label.current = null;
      element.remove();
      releaseOverlay(engine, entry);
    };
  }, [engine, registry]);
  useCommit(() => {
    const item = label.current;
    if (item) {
      if (registry?.current) item.setMesh(registry.current as unknown as MeshHandle).setOffset(position);
      else item.setPosition(position);
      item.occlude = occlude ? occlusion.current : () => false;
      // The label's live fields; pointer events are a style on the element this component owns.
      item.anchor = [anchor[0], anchor[1]];
      item.distanceScale = distanceScale ?? null;
      item.sort = sort;
      item.frustumCulling = frustumCulling;
      item.followVisibility = followVisibility;
      item.visible = visible;
      if (portal) portal.element.style.pointerEvents = pointerEvents;
    }
  }, [
    registry,
    portal,
    position[0],
    position[1],
    position[2],
    occlude,
    anchor[0],
    anchor[1],
    typeof distanceScale === 'object' ? JSON.stringify(distanceScale) : distanceScale,
    sort,
    frustumCulling,
    followVisibility,
    visible,
    pointerEvents,
  ]);
  return portal
    ? portal.create(
        <div className={className} style={style}>
          {children}
        </div>,
        portal.element,
      )
    : null;
}

export { OrbitControls, MapControls, CadControls, ArcballControls } from './controls.js';
export type { OrbitControlsProps, ArcballControlsProps, ControlEventProps, ProfileName } from './controls.js';
