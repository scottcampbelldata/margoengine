import { forwardRef, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Camera, type CameraOptions } from '@margoengine/core';
import type { RenderView as View } from '@margoengine/core/extension';
import type { Texture } from '@margoengine/materials';
import { MargoError } from '@margoengine/math/errors';
import { Context, assignRef, useCommit, useCreated, useScene, type Scene, type Views, type World } from './internal.js';
import { useFrame } from './components.js';
import { optionalPeer } from './optional.js';

let serial = 0;
const mains = new WeakMap<Views, { owners: Set<object>; key: object }>();
function syncMain(scene: Scene): void {
  const hold = mains.get(scene.views); if (!hold) return;
  const explicit = [...scene.views.entries].some(([key, entry]) => key !== hold.key && !hold.owners.has(key) && entry.view && !entry.view.target);
  if (explicit && scene.views.entries.delete(hold.key)) scene.views.update();
  if (!explicit && !scene.views.entries.has(hold.key)) {
    scene.views.entries.set(hold.key, { order: 0, serial: scene.views.serial++, view: { camera: scene.engine.camera, viewport: [0, 0, 1, 1] } }); scene.views.update();
  }
}
function mainView(scene: Scene, owner: object): () => void {
  let hold = mains.get(scene.views);
  if (!hold) {
    hold = { owners: new Set(), key: {} }; mains.set(scene.views, hold);
  }
  hold.owners.add(owner); syncMain(scene);
  const current = hold;
  return () => {
    current.owners.delete(owner);
    if (!current.owners.size) { scene.views.entries.delete(current.key); mains.delete(scene.views); }
    scene.views.update();
  };
}
function useWorld(camera?: Camera, options?: CameraOptions, background?: string | null) {
  const parent = useScene(), [world, setWorld] = useState<World | null>(null);
  const local = useMemo(() => camera ?? new Camera(options), [camera]);
  useCommit(() => {
    const made = parent.engine.createScene(`react-portal:${++serial}`); setWorld(made);
    return () => { setWorld(value => value === made ? null : value); if (!parent.engine.disposed) made.dispose(); };
  }, [parent.engine]);
  useCommit(() => { if (options) Object.assign(local, options); if (world) world.background = background; }, [local, world, options, background]);
  const value = useMemo(() => {
    if (!world) return null;
    // Hooks and camera bindings see the portal camera; resource ownership stays in the native Scene.
    const engine = new Proxy(parent.engine, { get(target, key) { if (key === 'camera') return local; if (key === 'scene') return world; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
    return { ...parent, engine, world, registry: null, cameraOverrides: new Set<() => void>() };
  }, [parent, world, local]);
  return { parent, world, camera: local, value };
}
function useView(scene: Scene, view: View | null, order: number): void {
  const key = useMemo(() => ({}), []);
  useCommit(() => {
    const release = mainView(scene, key);
    scene.views.entries.set(key, { order, serial: scene.views.serial++, view }); scene.views.update();
    return () => { scene.views.entries.delete(key); release(); };
  }, [scene.views, scene.engine, key]);
  useCommit(() => { const entry = scene.views.entries.get(key); if (entry) { entry.order = order; entry.view = view; scene.views.update(); } }, [scene.views, key, order, view]);
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
  if (!Number.isFinite(renderPriority) || renderPriority <= 0) throw new RangeError('Hud priority must be positive; pass a value above zero.');
  const portal = useWorld(camera, cameraOptions, null);
  const view = useMemo<View | null>(() => portal.world ? { camera: portal.camera, scene: portal.world as View['scene'], viewport: [0, 0, 1, 1], clear: { color: false, depth: true } } : null, [portal.world, portal.camera]);
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
export const RenderTexture = /* @__PURE__ */ forwardRef<RenderTextureHandle, RenderTextureProps>(function RenderTexture({ children, width, height, camera, cameraOptions, background = '#000000', renderPriority = -1, onTexture, onError }, ref) {
  for (const size of [width, height]) if (size !== undefined && (!Number.isSafeInteger(size) || size < 1)) throw new RangeError('RenderTexture dimensions must be positive integers; pass physical texel sizes.');
  if (!Number.isFinite(renderPriority) || renderPriority >= 0) throw new RangeError('RenderTexture priority must be negative; render targets before the main view.');
  const portal = useWorld(camera, cameraOptions, background), latest = useRef({ width, height, onTexture, ref }); latest.current = { width, height, onTexture, ref };
  const target = useCreated(portal.parent, {
    load: () => optionalPeer('@margoengine/materials', () => import('@margoengine/materials')),
    create(api): TargetState | null {
      if (!portal.world) return null;
      const engine = portal.parent.engine, world = portal.world, name = `react-render-texture:${++serial}`;
      let state!: TargetState;
      const replace = (sync: boolean) => {
        const device = engine.gpu;
        if (!device) throw new MargoError('unsupported', 'RenderTexture requires a WebGPU or compatibility device; use the WebGL2 compatibility device entry.');
        const w = latest.current.width ?? Math.max(1, engine.canvas.width), h = latest.current.height ?? Math.max(1, engine.canvas.height);
        if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D) throw new RangeError('RenderTexture exceeds device limits; reduce width or height.');
        if (state && state.device === device && state.width === w && state.height === h) return;
        const previous = state && { target: state.target, texture: state.texture };
        const target = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 21 });
        let texture: Texture;
        try { texture = new api.Texture(target, { wrapS: 'clamp', wrapT: 'clamp' }); }
        catch (error) { target.destroy(); throw error; }
        const view: View = { camera: portal.camera, scene: world as View['scene'], viewport: [0, 0, 1, 1], target: { color: target } };
        if (state) Object.assign(state, { device, target, texture, view, width: w, height: h });
        else state = { device, target, texture, view, width: w, height: h, disposed: false, resize: replace, dispose() {
          if (state.disposed) return; state.disposed = true;
          if (!engine.disposed && engine.scenes.has(world)) world.removePlugin(name);
          latest.current.onTexture?.(null); assignRef(latest.current.ref, null); state.texture.dispose(); state.target.destroy();
        } };
        const publish = () => { latest.current.onTexture?.(texture); assignRef(latest.current.ref, { texture, target, scene: world, camera: portal.camera }); };
        if (sync) flushSync(publish); else publish();
        if (previous) queueMicrotask(() => { previous.texture.dispose(); previous.target.destroy(); });
      };
      replace(false);
      world.use({ name, setup() {}, onDeviceRestored() { state.resize(true); } });
      return state;
    },
    dispose(value) { value?.dispose(); }, onError,
  }, [portal.world, portal.camera]);
  // One stable view object is updated before the native engine's frame draws.
  const view = useMemo<View | null>(() => target ? { ...target.view } : null, [target]);
  useCommit(() => { target?.resize(false); if (view && target) Object.assign(view, target.view); portal.parent.views.update(); }, [target, width, height, onTexture, ref]);
  useCommit(() => { if (target && portal.world) assignRef(ref, { texture: target.texture, target: target.target, scene: portal.world, camera: portal.camera }); return () => assignRef(ref, null); }, [target, ref, portal.world, portal.camera]);
  useFrame(() => { if (target && !target.disposed) { target.resize(true); if (view) Object.assign(view, target.view); } }, -100);
  useView(portal.parent, view, renderPriority);
  return portal.value ? <Context.Provider value={portal.value}>{children}</Context.Provider> : null;
});
