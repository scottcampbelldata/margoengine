import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Camera, RenderView as CoreView } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Context, useCommit, useScene, type World } from './internal.js';

/** Props of `<Scene>`. */
export interface SceneProps {
  /** Name a `<RenderView scene>` draws it by; unique in the Canvas. */
  name: string;
  /** Clear colour (`#rrggbb`) of views drawing this scene, or null to keep what is below (an overlay). */
  background?: string | null;
  children?: ReactNode;
}
/**
 * A separate set of meshes drawn only by the `<RenderView>`s that name it: a HUD overlay, an item preview, a picture in
 * picture (core's `engine.createScene`). `<Mesh>`, `Box`, `Sphere`, `Plane` and `Group` inside are created in it.
 * Plugins and models stay in the default scene for now. Disposed with its meshes on unmount.
 */
export function Scene({ name, background, children }: SceneProps) {
  const parent = useScene(),
    { engine, views } = parent,
    [world, setWorld] = useState<World | null>(null);
  useCommit(() => {
    if (views.scenes.has(name))
      throw new MargoError('attached', `Two <Scene name="${name}">s in one Canvas; give each its own name`);
    const created = engine.createScene(name);
    views.scenes.set(name, created);
    views.revision++;
    for (const listener of views.listeners) listener();
    setWorld(created);
    return () => {
      if (views.scenes.get(name) === created) views.scenes.delete(name);
      views.revision++;
      for (const listener of views.listeners) listener();
      setWorld((current) => (current === created ? null : current));
      if (!engine.disposed) created.dispose();
    };
  }, [engine, views, name]);
  useCommit(() => {
    if (world) world.background = background;
  }, [world, background]);
  const value = useMemo(() => (world ? { ...parent, world, registry: null } : null), [parent, world]);
  return value ? <Context.Provider value={value}>{children}</Context.Provider> : null;
}

/** Props of `<RenderView>`: one `RenderView` of the Canvas. */
export interface RenderViewProps {
  /** The camera it draws through: a core `Camera`. Default the Canvas camera. */
  camera?: Camera;
  /** [x, y, width, height] from the top left, in fractions of the canvas (or pixels with `pixels`). Default whole. */
  viewport?: readonly [number, number, number, number];
  pixels?: boolean;
  /** Clip rectangle inside the viewport, same units. */
  scissor?: readonly [number, number, number, number];
  /** `color`: `#rrggbb`, or false to keep what is below; `depth: false` keeps the depth. */
  clear?: CoreView['clear'];
  /** Draw only meshes whose `layers` share a bit with this mask. */
  layers?: number;
  /** The `<Scene name>` it draws. Default the Canvas's default scene. */
  scene?: string;
  /** Draw into these textures instead of the canvas. */
  target?: CoreView['target'];
  /** Stable id for per-view effect history (TAA, motion blur). */
  id?: string;
  /** Draw order: lower first, then mount order. Default 0. */
  order?: number;
}
/**
 * Draws the Canvas through a camera into part of it (split screen, a four-view CAD layout, a minimap) or into a
 * texture. With one or more `<RenderView>`s the Canvas draws only those, in `order`; list a view without `camera` to keep the
 * main camera. Picking follows the view under the pointer. Works on WebGPU and WebGL2.
 */
export function RenderView({
  camera,
  viewport = [0, 0, 1, 1],
  pixels,
  scissor,
  clear,
  layers,
  scene,
  target,
  id,
  order = 0,
}: RenderViewProps): null {
  const { engine, views } = useScene();
  const revision = useSyncExternalStore(
    (listener) => {
      views.listeners.add(listener);
      return () => views.listeners.delete(listener);
    },
    () => views.revision,
    () => 0,
  );
  const key = useMemo(() => ({}), []);
  useCommit(() => {
    views.entries.set(key, { order, serial: views.serial++, view: null });
    return () => {
      views.entries.delete(key);
      views.update();
    };
  }, [views, key]);
  useCommit(() => {
    const entry = views.entries.get(key);
    if (!entry) return;
    const world = scene === undefined ? undefined : views.scenes.get(scene);
    entry.order = order;
    if (scene !== undefined && !world) {
      // Its <Scene> may mount later in this commit; a name still missing afterwards is a mistake.
      entry.view = null;
      views.update();
      queueMicrotask(() => {
        if (views.entries.has(key) && !views.scenes.has(scene) && !engine.disposed)
          engine.onError(
            new MargoError(
              'state',
              `<RenderView scene="${scene}"> names no <Scene name="${scene}"> in this Canvas; add that <Scene>`,
            ),
          );
      });
      return;
    }
    entry.view = {
      camera: (camera ?? engine.camera) as CoreView['camera'],
      viewport,
      ...(pixels !== undefined && { pixels }),
      ...(scissor && { scissor }),
      ...(clear && { clear }),
      ...(layers !== undefined && { layers }),
      ...(world && { scene: world as unknown as CoreView['scene'] }),
      ...(target && { target }),
      ...(id !== undefined && { id }),
    };
    views.update();
  });
  void revision;
  return null;
}
