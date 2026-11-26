import { useEffect, useRef } from 'react';
import type { FrameCallback, Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { MeshRef } from './components.js';
import { useCommit, useScene, type Scene } from './internal.js';

function under(scene: Scene, mesh: EngineMesh, root: EngineMesh): boolean {
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++)
    if (id === root.id) return true;
  return false;
}
function shown(scene: Scene, mesh: EngineMesh, root: EngineMesh): boolean {
  const hidden = scene.engine.store.hidden;
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++) {
    if (hidden[id]) return false;
    if (id === root.id) return true;
  }
  return false;
}
// A world box against the camera's six inward planes (core's layout: normal xyz, distance), farthest corner first.
function boxInView(planes: ArrayLike<number>, box: ArrayLike<number>): boolean {
  for (let p = 0; p < 24; p += 4) {
    let d = planes[p + 3];
    for (let axis = 0; axis < 3; axis++) {
      const n = planes[p + axis];
      if (n) d += n * (n > 0 ? box[axis + 3] : box[axis]);
    }
    if (d < 0) return false;
  }
  return true;
}
/**
 * Whether the last drawn frame kept any part of `root` after frustum culling: a mesh of it with geometry the engine
 * did not cull, or a loaded model under it whose world bounds meet the camera's view. Hidden meshes and hidden
 * ancestors count as not drawn.
 */
export function drawnLastFrame(scene: Scene, root: EngineMesh): boolean {
  const { engine } = scene,
    visible = engine.store.visible;
  for (const mesh of engine.meshes.values())
    if (mesh.geometry?.indices.length && visible[mesh.id] && shown(scene, mesh, root)) return true;
  const planes = (engine.camera as { planes?: ArrayLike<number> }).planes;
  if (planes)
    for (const model of scene.resources.models)
      if (
        !model.disposed &&
        under(scene, model.root, root) &&
        shown(scene, model.root, root) &&
        boxInView(planes, model.bounds)
      )
        return true;
  return false;
}
/**
 * Calls `onChange(true)` when the mesh behind the returned ref comes into the camera's view, and `onChange(false)` when
 * it leaves it, judged by the engine's frustum culling of the last drawn frame (the same test drei's `useIntersect`
 * makes with `onBeforeRender`). It starts as not visible, so the first call is `true` once it is drawn. A group counts
 * as visible while any mesh or model under it is. Needs a running frame loop.
 *
 * ```tsx
 * function Spinner() {
 *   const visible = useRef(false);
 *   const ref = useIntersect((inView) => (visible.current = inView));
 *   useFrame((_, delta) => visible.current && ref.current?.setRotation([0, performance.now() / 1000, 0]));
 *   return <Box ref={ref} />;
 * }
 * ```
 */
// The ref is typed `{ current: T | null }`, not RefObject: React 18's ref prop takes RefObject<T> (current T | null)
// and React 19's takes RefObject<T | null>; this shape is both, so <Box ref={ref} /> types on either.
export function useIntersect<T extends MeshRef = MeshHandle>(
  onChange: (visible: boolean) => void,
): { current: T | null } {
  const scene = useScene(),
    ref = useRef<T | null>(null),
    latest = useRef(onChange);
  useCommit(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    let was = false;
    const frame: FrameCallback = () => {
      const mesh = ref.current as unknown as EngineMesh | null,
        now = !!mesh && scene.engine.meshes.get(mesh.id) === mesh && drawnLastFrame(scene, mesh);
      if (now === was) return;
      was = now;
      latest.current(now);
    };
    scene.frames.callbacks.add(frame);
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene]);
  return ref;
}
