import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Engine, Mesh as EngineMesh, Vec3, Geometry } from '@margoengine/core/extension';
import type { FrameCallback, Mesh as MeshHandle } from '@margoengine/core';
import type { PBRModel, LightingEffect } from '@margoengine/gltf-pro';
import type { Shadows } from '@margoengine/shadows';
import type { AssetCache } from './assets.js';

export interface Registry {
  current: EngineMesh | null;
  children: Set<EngineMesh>;
  attachments: Set<(mesh: EngineMesh) => void>;
  register(mesh: EngineMesh): void;
  unregister(mesh: EngineMesh): void;
  geometry?: Geometry | null;
  geometryOverride?: (mesh: EngineMesh, geometry: Geometry | null) => void;
}
export interface Resources {
  models: Set<PBRModel>;
  lighting: Map<LightingEffect, Map<PBRModel, () => void>>;
}
export interface MargoPointerEvent {
  nativeEvent: PointerEvent;
  object: MeshHandle;
  mesh: MeshHandle;
  target: MeshHandle;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
}
export interface PointerHandlers {
  onClick?: (event: MargoPointerEvent) => void;
  onPointerOver?: (event: MargoPointerEvent) => void;
  onPointerOut?: (event: MargoPointerEvent) => void;
}
export interface Frames {
  elapsed: number;
  last: number | null;
  mode: 'always' | 'demand';
  callbacks: Set<FrameCallback>;
}
export interface Scene {
  engine: Engine;
  registry: Registry | null;
  resources: Resources;
  shadows: Shadows | null;
  requestShadows: () => () => void;
  cameraOverrides: Set<() => void>;
  pointerHandlers: Map<number, PointerHandlers>;
  frames: Frames;
  assetCache: AssetCache;
  /** The engine scene meshes are created in: a `<Scene>`'s, or null for the default scene. */
  world: World | null;
  /** The Canvas's `<RenderView>`s and named `<Scene>`s. */
  views: Views;
}
/** Core's scene (meshes, lighting, plugins drawn together); `engine.scene` is the default one. */
export type World = Engine['scene'];
type View = NonNullable<Engine['views']>[number];
/** The `<RenderView>`s of one Canvas, written to `engine.views` in `order`, then mount order. */
export interface Views {
  /** A null view is waiting for the <Scene> it names. */
  entries: Map<object, { order: number; serial: number; view: View | null }>;
  scenes: Map<string, World>;
  serial: number;
  /** Writes the current views to the engine (none: the engine's full-canvas camera view). */
  update(): void;
  /** Bumps when a named scene appears or goes, so views naming it look it up again. */
  revision: number;
  listeners: Set<() => void>;
}
export function createViews(engine: Engine): Views {
  const views: Views = {
    entries: new Map(),
    scenes: new Map(),
    serial: 0,
    revision: 0,
    listeners: new Set(),
    update() {
      if (engine.disposed) return;
      const list = [...views.entries.values()]
        .filter((entry) => entry.view)
        .sort((a, b) => a.order - b.order || a.serial - b.serial);
      engine.views = list.length ? list.map((entry) => entry.view!) : undefined;
    },
  };
  return views;
}
export const Context = createContext<Scene | null>(null);
export function useScene(): Scene {
  const scene = useContext(Context);
  if (!scene) throw new Error('Engine components require <Canvas>');
  return scene;
}
export function useMesh(): Registry {
  const { registry } = useScene();
  if (!registry) throw new Error('Geometry and material require <Mesh>');
  return registry;
}
export function live(registry: Registry): EngineMesh | null {
  const mesh = registry.current;
  return mesh && !mesh.engine.disposed && mesh.engine.meshes.get(mesh.id) === mesh ? mesh : null;
}
export function setGeometry(registry: Registry, mesh: EngineMesh, geometry: Geometry | null): void {
  registry.geometry = geometry;
  if (registry.geometryOverride) registry.geometryOverride(mesh, geometry);
  else mesh.setGeometry(geometry);
}
export const zero: Vec3 = [0, 0, 0],
  one: Vec3 = [1, 1, 1];
export const useCommit = typeof window === 'undefined' ? useEffect : useLayoutEffect;
export interface ResourceLease {
  active: boolean;
  closed: boolean;
  generation: number;
  keys: readonly unknown[];
  release: () => void;
}
// Retain a committed resource through StrictMode's Suspense reveal replay.
export function useResourceEffect(
  setup: (lease: ResourceLease) => (() => void) | undefined,
  keys: readonly unknown[],
): void {
  const saved = useRef<ResourceLease | null>(null);
  useEffect(() => {
    let lease = saved.current;
    if (!lease || lease.closed || keys.some((key, index) => key !== lease!.keys[index])) {
      if (lease && !lease.closed) {
        lease.closed = true;
        lease.release();
      }
      lease = { active: true, closed: false, generation: 0, keys, release: () => {} };
      saved.current = lease;
      lease.release = setup(lease) ?? (() => {});
    } else {
      lease.active = true;
      lease.generation++;
    }
    const current = lease;
    return () => {
      current.active = false;
      const generation = ++current.generation;
      queueMicrotask(() => {
        if (!current.active && !current.closed && current.generation === generation) {
          current.closed = true;
          current.release();
        }
      });
    };
  }, keys);
}

/** Sends `error` to the component's `onError`, then to the engine's (the Canvas `onError` and alert). */
export function report(scene: Scene, error: unknown, onError?: (error: unknown) => void): void {
  try {
    onError?.(error);
  } finally {
    scene.engine.onError(error);
  }
}
/** Points a ref (callback or object) at `value`. */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}
/**
 * Keeps `ref` on the live object of an async-created binding. The creating effect assigns it the moment the object
 * exists and its cleanup clears it before the object is disposed, so a ref never holds a disposed object between an
 * effect replay (StrictMode, a Suspense reveal) and the next render. This hook only re-points the ref when its identity
 * changes.
 */
export function useLiveRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  useCommit(() => {
    if (!ref || value === null) return;
    assignRef(ref, value);
    return () => assignRef(ref, null);
  }, [ref, value]);
}
export interface Created<A, T> {
  /** Imports the optional package (wrap it in `optionalPeer`). */
  load: () => Promise<A>;
  /** Builds and attaches the object once the package and the engine are ready. */
  create: (api: A) => T;
  /** Detaches and frees it. */
  dispose: (value: T) => void;
  ref?: Ref<T>;
  onError?: (error: unknown) => void;
}
/**
 * One object from an optional package for the life of a component: loaded after the first commit, created once the
 * package arrives, disposed when `keys` change or the component unmounts, and kept through StrictMode's effect
 * replay. Returns it once created, else null. `ref` follows it directly, so it never holds a disposed object.
 */
export function useCreated<A, T>(scene: Scene, options: Created<A, T>, keys: readonly unknown[]): T | null {
  const [value, setValue] = useState<T | null>(null),
    latest = useRef(options);
  latest.current = options;
  useResourceEffect(() => {
    let current: T | undefined,
      closed = false;
    latest.current
      .load()
      .then((api) => {
        if (closed || scene.engine.disposed) return;
        const made = latest.current.create(api);
        current = made;
        assignRef(latest.current.ref, made);
        setValue(made);
      })
      .catch((error) => {
        if (!closed && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      closed = true;
      if (current === undefined) return;
      const made = current;
      current = undefined;
      assignRef(latest.current.ref, null);
      setValue((state) => (state === made ? null : state));
      latest.current.dispose(made);
    };
  }, [scene.engine, ...keys]);
  const { ref } = options;
  useCommit(() => {
    if (!ref || value === null) return;
    assignRef(ref, value);
    return () => assignRef(ref, null);
  }, [ref, value]);
  return value;
}

type Model = Scene['resources']['models'] extends Set<infer T> ? T : never;
// Keeps `effect` given every live PBR model of the Canvas, now and as they load or unmount (the SSAO pattern).
export function useModelSources(scene: Scene, effect: { add(model: never): () => void } | null): void {
  useCommit(() => {
    if (!effect) return;
    const added = new Map<Model, () => void>();
    const sync = () => {
      for (const [model, remove] of added)
        if (!scene.resources.models.has(model) || model.disposed) {
          remove();
          added.delete(model);
        }
      for (const model of scene.resources.models)
        if (!model.disposed && !added.has(model)) added.set(model, effect.add(model as never));
    };
    sync();
    scene.frames.callbacks.add(sync);
    return () => {
      scene.frames.callbacks.delete(sync);
      for (const remove of added.values()) remove();
    };
  }, [scene, effect]);
}
