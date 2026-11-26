import { forwardRef, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Camera, type CameraOptions, type Mesh as MeshHandle } from '@margoengine/core';
import type { RenderView as View } from '@margoengine/core/extension';
import type { Texture } from '@margoengine/materials';
import {
  Context,
  assignRef,
  useCommit,
  useCreated,
  useResourceEffect,
  useScene,
  sceneContexts,
  type Registry,
  type Scene,
  type Views,
  type World,
} from './internal.js';
import { useSceneShadows } from './scene-shadows.js';
import { useFrame } from './components.js';
import { optionalPeer } from './optional.js';
import { fault, rangeError } from '../../shared/errors.js';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';

let serial = 0;
const mains = new WeakMap<Views, { owners: Set<object>; key: object }>();
function syncMain(scene: Scene): void {
  const hold = mains.get(scene.views);
  if (!hold) return;
  const explicit = [...scene.views.entries].some(
    ([key, entry]) => key !== hold.key && !hold.owners.has(key) && entry.view && !entry.view.target,
  );
  if (explicit && scene.views.entries.delete(hold.key)) scene.views.update();
  if (!explicit && !scene.views.entries.has(hold.key)) {
    scene.views.entries.set(hold.key, {
      order: 0,
      serial: scene.views.serial++,
      view: { camera: scene.engine.camera, viewport: [0, 0, 1, 1] },
    });
    scene.views.update();
  }
}
function mainView(scene: Scene, owner: object): () => void {
  let hold = mains.get(scene.views);
  if (!hold) {
    hold = { owners: new Set(), key: {} };
    mains.set(scene.views, hold);
  }
  hold.owners.add(owner);
  syncMain(scene);
  const current = hold;
  return () => {
    current.owners.delete(owner);
    if (!current.owners.size) {
      scene.views.entries.delete(current.key);
      mains.delete(scene.views);
    }
    scene.views.update();
  };
}
function useWorld(camera?: Camera, options?: CameraOptions, background?: string | null) {
  const parent = useScene(),
    [world, setWorld] = useState<World | null>(null);
  const local = useMemo(() => camera ?? new Camera(options), [camera]);
  useResourceEffect(() => {
    const made = parent.engine.createScene(`react-portal:${++serial}`);
    setWorld(made);
    return () => {
      setWorld((value) => (value === made ? null : value));
      if (!parent.engine.disposed) made.dispose();
    };
  }, [parent.engine]);
  useCommit(() => {
    if (options) Object.assign(local, options);
    if (world) world.background = background;
  }, [local, world, options, background]);
  const value = useMemo(() => {
    if (!world) return null;
    // Hooks and camera bindings see the portal camera; resource ownership stays in the native Scene.
    const engine = new Proxy(parent.engine, {
      get(target, key) {
        if (key === 'camera') return local;
        if (key === 'scene') return world;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...parent, engine, world, registry: null, cameraOverrides: new Set<() => void>() };
  }, [parent, world, local]);
  return { parent, world, camera: local, value };
}
function useView(scene: Scene, view: View | null, order: number): void {
  const key = useMemo(() => ({}), []);
  useCommit(() => {
    const release = mainView(scene, key);
    scene.views.entries.set(key, { order, serial: scene.views.serial++, view });
    scene.views.update();
    return () => {
      scene.views.entries.delete(key);
      release();
    };
  }, [scene.views, scene.engine, key]);
  useCommit(() => {
    const entry = scene.views.entries.get(key);
    if (entry) {
      entry.order = order;
      entry.view = view;
      scene.views.update();
    }
  }, [scene.views, key, order, view]);
  useFrame(() => syncMain(scene), -1000);
}

/** An isolated child Scene stacked over the main camera with fresh depth. */
export interface HudProps {
  children?: ReactNode;
  /** Higher draws later. Default 1; must be positive. */
  renderPriority?: number;
  camera?: Camera;
  cameraOptions?: CameraOptions;
}
/** Render child meshes, models and plugins in a separate overlay Scene, with independent camera bindings. */
export function Hud({ children, renderPriority = 1, camera, cameraOptions }: HudProps) {
  if (!Number.isFinite(renderPriority) || renderPriority <= 0)
    throw rangeError('Hud priority must be positive; pass a value above zero', 'react-arguments');
  const portal = useWorld(camera, cameraOptions, null);
  const view = useMemo<View | null>(
    () =>
      portal.world
        ? {
            camera: portal.camera,
            scene: portal.world as View['scene'],
            viewport: [0, 0, 1, 1],
            clear: { color: false, depth: true },
          }
        : null,
    [portal.world, portal.camera],
  );
  useView(portal.parent, view, renderPriority);
  return portal.value ? <Context.Provider value={portal.value}>{children}</Context.Provider> : null;
}

/** Live render-target ownership; the texture can be supplied to any native material map. */
export interface RenderTextureHandle {
  readonly texture: Texture;
  readonly target: GPUTexture;
  readonly scene: World;
  readonly camera: Camera;
}
/** A child Scene rendered into a sampled texture before the main view. */
export interface RenderTextureProps {
  children?: ReactNode;
  /** Physical texels; omitted dimensions follow the canvas drawing buffer. */
  width?: number;
  height?: number;
  camera?: Camera;
  cameraOptions?: CameraOptions;
  background?: string;
  /** Target views precede the main view. Default -1; must be negative. */
  renderPriority?: number;
  /** Called on creation, resize, device restoration and cleanup (null). */
  onTexture?: (texture: Texture | null) => void;
  onError?: (error: unknown) => void;
}
interface TargetState {
  device: GPUDevice;
  target: GPUTexture;
  texture: Texture;
  view: View;
  width: number;
  height: number;
  disposed: boolean;
  resize(sync: boolean): void;
  dispose(): void;
}
/** Render an independent scene into an owned material texture, retaining the Canvas's main view. */
export const RenderTexture = /* @__PURE__ */ forwardRef<RenderTextureHandle, RenderTextureProps>(function RenderTexture(
  { children, width, height, camera, cameraOptions, background = '#000000', renderPriority = -1, onTexture, onError },
  ref,
) {
  for (const size of [width, height])
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 1))
      throw rangeError(
        'RenderTexture dimensions must be positive integers; pass physical texel sizes',
        'react-arguments',
      );
  if (!Number.isFinite(renderPriority) || renderPriority >= 0)
    throw rangeError('RenderTexture priority must be negative; render targets before the main view', 'react-arguments');
  const portal = useWorld(camera, cameraOptions, background),
    latest = useRef({ width, height, onTexture, ref });
  latest.current = { width, height, onTexture, ref };
  const target = useCreated(
    portal.parent,
    {
      load: () => optionalPeer('@margoengine/materials', () => import('@margoengine/materials')),
      create(api): TargetState | null {
        if (!portal.world) return null;
        const engine = portal.parent.engine,
          world = portal.world,
          name = `react-render-texture:${++serial}`;
        let state!: TargetState;
        const replace = (sync: boolean) => {
          const device = engine.gpu;
          if (!device)
            throw fault(
              'unsupported',
              'RenderTexture requires a WebGPU or compatibility device; use the WebGL2 compatibility device entry',
              'react-usage',
            );
          const w = latest.current.width ?? Math.max(1, engine.canvas.width),
            h = latest.current.height ?? Math.max(1, engine.canvas.height);
          if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D)
            throw rangeError('RenderTexture exceeds device limits; reduce width or height', 'react-arguments');
          if (state && state.device === device && state.width === w && state.height === h) return;
          const previous = state && { target: state.target, texture: state.texture };
          const target = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 21 });
          let texture: Texture;
          try {
            texture = new api.Texture(target, { wrapS: 'clamp', wrapT: 'clamp' });
          } catch (error) {
            target.destroy();
            throw error;
          }
          const view: View = {
            camera: portal.camera,
            scene: world as View['scene'],
            viewport: [0, 0, 1, 1],
            target: { color: target },
          };
          if (state) Object.assign(state, { device, target, texture, view, width: w, height: h });
          else
            state = {
              device,
              target,
              texture,
              view,
              width: w,
              height: h,
              disposed: false,
              resize: replace,
              dispose() {
                if (state.disposed) return;
                state.disposed = true;
                if (!engine.disposed && engine.scenes.has(world)) world.removePlugin(name);
                latest.current.onTexture?.(null);
                assignRef(latest.current.ref, null);
                state.texture.dispose();
                state.target.destroy();
              },
            };
          const publish = () => {
            latest.current.onTexture?.(texture);
            assignRef(latest.current.ref, { texture, target, scene: world, camera: portal.camera });
          };
          if (sync) flushSync(publish);
          else publish();
          if (previous)
            queueMicrotask(() => {
              previous.texture.dispose();
              previous.target.destroy();
            });
        };
        replace(false);
        world.use({
          name,
          setup() {},
          onDeviceRestored() {
            state.resize(true);
          },
        });
        return state;
      },
      dispose(value) {
        value?.dispose();
      },
      onError,
    },
    [portal.world, portal.camera],
  );
  // One stable view object is updated before the native engine's frame draws.
  const view = useMemo<View | null>(() => (target ? { ...target.view } : null), [target]);
  useCommit(() => {
    target?.resize(false);
    if (view && target) Object.assign(view, target.view);
    portal.parent.views.update();
  }, [target, width, height, onTexture, ref]);
  useCommit(() => {
    if (target && portal.world)
      assignRef(ref, { texture: target.texture, target: target.target, scene: portal.world, camera: portal.camera });
    return () => assignRef(ref, null);
  }, [target, ref, portal.world, portal.camera]);
  useFrame(() => {
    if (target && !target.disposed) {
      target.resize(true);
      if (view) Object.assign(view, target.view);
    }
  }, -100);
  useView(portal.parent, view, renderPriority);
  return portal.value ? <Context.Provider value={portal.value}>{children}</Context.Provider> : null;
});
import { useFBO } from './fbo.js';
export { useFBO, type FBO, type FBOOptions } from './fbo.js';

/** Options of `useDepthBuffer`; every one is optional. */
export interface DepthBufferOptions {
  /** Width and height of the depth texture in texels. Default 256. */
  size?: number;
  /** Frames to draw depth for, then keep the last result (1 for a static scene). Default Infinity: every frame. */
  frames?: number;
  /** Called when the target cannot be made (the hook then returns null). Default: the Canvas's onError. */
  onError?: (error: unknown) => void;
}
/**
 * drei's useDepthBuffer: the scene's depth seen from the Canvas camera, drawn into an owned `size` x `size` depth
 * texture (the scene's depth format and sample count) before the main view, every frame or for the first `frames`
 * frames. Null until the target exists; a new texture after a device restore.
 */
export function useDepthBuffer({ size = 256, frames = Infinity, onError }: DepthBufferOptions = {}): GPUTexture | null {
  if (!Number.isSafeInteger(size) || size < 1)
    throw rangeError(
      'useDepthBuffer size must be a positive integer; pass the texture size in texels',
      'react-arguments',
    );
  if (!(frames === Infinity || (Number.isSafeInteger(frames) && frames >= 1)))
    throw rangeError(
      'useDepthBuffer frames must be a positive integer or Infinity; pass how many frames to draw',
      'react-arguments',
    );
  const scene = useScene(),
    fbo = useFBO(size, size, { depth: true, onError }),
    key = useMemo(() => ({}), []),
    drawn = useRef<{ fbo: unknown; count: number; view: View | null }>({ fbo: null, count: 0, view: null });
  useCommit(() => {
    const release = mainView(scene, key);
    scene.views.entries.set(key, { order: -1, serial: scene.views.serial++, view: null });
    return () => {
      scene.views.entries.delete(key);
      release();
    };
  }, [scene.views, key]);
  // Before the frame's views draw: the depth view is present for the first `frames` frames of each target.
  useFrame(() => {
    const entry = scene.views.entries.get(key),
      state = drawn.current;
    if (!entry) return;
    if (state.fbo !== fbo) Object.assign(state, { fbo, count: 0, view: null });
    const camera = scene.engine.camera as View['camera'];
    if (fbo && state.view?.camera !== camera) state.view = { camera, viewport: [0, 0, 1, 1], target: fbo.target };
    const view = fbo && state.count < frames ? state.view : null;
    if (view) state.count++;
    if (entry.view !== view) {
      entry.view = view;
      scene.views.update();
    }
    syncMain(scene);
  }, -99);
  return fbo?.target.depth ?? null;
}

/** Props of `<ScenePortal>`; every prop is optional. */
export interface ScenePortalProps {
  /**
   * The engine scene the children are built in: the `name` of a `<Scene>` in this Canvas, or a core scene
   * (`engine.createScene(...)`, `engine.scene`). Default: the scene of `node`, else the Canvas's default scene.
   */
  scene?: string | World;
  /**
   * An existing engine mesh the children attach under, as they would under a `<Mesh>` (a loaded model's node, a mesh
   * from `engine.createMesh()`). Default none: the children sit at the top level of the scene.
   */
  node?: MeshHandle;
  children?: ReactNode;
}
/**
 * Renders its children into another engine scene or under an existing mesh while they stay in this React tree (its
 * context, state and events). Meshes, models and scene bindings inside are built in the target scene; a named
 * `<Scene>` or the default scene shares its shadows and lights, and a core scene made outside React gets shadows of its
 * own when a `<Shadows>` inside asks. Renders nothing until a named `<Scene>` mounts. Nothing is drawn unless a view
 * draws the target scene (a `<RenderView scene>` for a `<Scene>`).
 */
export function ScenePortal({ scene, node, children }: ScenePortalProps) {
  const parent = useScene(),
    { engine, views } = parent;
  useSyncExternalStore(
    (listener) => {
      views.listeners.add(listener);
      return () => views.listeners.delete(listener);
    },
    () => views.revision,
    () => 0,
  );
  const mesh = node as unknown as EngineMesh | undefined;
  if (mesh && engine.meshes.get(mesh.id) !== mesh)
    throw fault('attached', 'ScenePortal node is disposed or from another engine; pass a live mesh', 'react-usage');
  const target =
    typeof scene === 'string' ? views.scenes.get(scene) : (scene ?? (mesh ? (mesh.scene as World) : engine.scene));
  if (mesh && target && mesh.scene !== target)
    throw fault('attached', 'ScenePortal node is in another scene than `scene`; pass only one of them', 'react-usage');
  const known = target && sceneContexts.get(target),
    own = useSceneShadows(engine, target && !known ? target : null);
  useCommit(() => {
    if (typeof scene !== 'string' || target) return;
    // Its <Scene> may mount later in this commit; a name still missing afterwards is a mistake.
    queueMicrotask(() => {
      if (!views.scenes.has(scene) && !engine.disposed)
        engine.onError(
          fault(
            'state',
            `<ScenePortal scene="${scene}"> names no <Scene name="${scene}">; add that <Scene>`,
            'react-usage',
          ),
        );
    });
  }, [scene, target, views, engine]);
  const registry = useMemo<Registry | null>(
    () =>
      mesh
        ? {
            current: mesh,
            children: new Set(),
            attachments: new Set(),
            register(child) {
              this.children.add(child);
              child.setParent(mesh);
            },
            unregister(child) {
              this.children.delete(child);
              if (!engine.disposed && engine.meshes.get(child.id) === child) child.setParent(null);
            },
          }
        : null,
    [engine, mesh],
  );
  const value = useMemo<Scene | null>(
    () =>
      target
        ? {
            ...(known || { ...parent, shadows: own.shadows, requestShadows: own.requestShadows }),
            world: target === engine.scene ? null : target,
            registry,
          }
        : null,
    [parent, known, target, registry, own.shadows, own.requestShadows, engine],
  );
  return value ? <Context.Provider value={value}>{children}</Context.Provider> : null;
}
