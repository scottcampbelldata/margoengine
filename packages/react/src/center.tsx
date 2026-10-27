import { forwardRef, useEffect, useRef } from 'react';
import type { FrameCallback } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { useScene, useMesh, live, type Scene } from './internal.js';

function descendant(scene: Scene, mesh: EngineMesh, root: EngineMesh): boolean {
  for (let id = mesh.id, depth = 0; id >= 0 && depth < 64; id = scene.engine.store.parents[id], depth++)
    if (id === root.id) return true;
  return false;
}
// The frozen stage keeps worldBounds private. Use its vertex/world-matrix
// calculation here, with PBRModel.bounds for geometry owned by loader plugins.
export function sceneWorldBounds(scene: Scene, root: EngineMesh, output = new Float32Array(6)): Float32Array | null {
  scene.engine.store.tick(false);
  output.fill(Infinity, 0, 3);
  output.fill(-Infinity, 3);
  for (const mesh of scene.engine.meshes.values()) {
    if (!mesh.geometry || !descendant(scene, mesh, root)) continue;
    const vertices = mesh.geometry.vertices,
      m = mesh.matrix;
    for (let i = 0; i < vertices.length; i += 6)
      for (let axis = 0; axis < 3; axis++) {
        const value =
          m[axis] * vertices[i] + m[axis + 4] * vertices[i + 1] + m[axis + 8] * vertices[i + 2] + m[axis + 12];
        output[axis] = Math.min(output[axis], value);
        output[axis + 3] = Math.max(output[axis + 3], value);
      }
  }
  for (const model of scene.resources.models)
    if (!model.disposed && descendant(scene, model.root, root)) {
      const bounds = model.bounds;
      for (let axis = 0; axis < 3; axis++) {
        output[axis] = Math.min(output[axis], bounds[axis]);
        output[axis + 3] = Math.max(output[axis + 3], bounds[axis + 3]);
      }
    }
  return Number.isFinite(output[0]) ? output : null;
}
/** Props of the Center component; every prop is optional unless noted. */
export interface CenterProps extends MeshProps {
  disableX?: boolean;
  disableY?: boolean;
  disableZ?: boolean;
}
function CenterBinding({
  disableX = false,
  disableY = false,
  disableZ = false,
}: Pick<CenterProps, 'disableX' | 'disableY' | 'disableZ'>) {
  const scene = useScene(),
    registry = useMesh(),
    flags = useRef([disableX, disableY, disableZ]);
  flags.current = [disableX, disableY, disableZ];
  useEffect(() => {
    const bounds = new Float32Array(6);
    const center = () => {
      const root = live(registry);
      if (!root || !sceneWorldBounds(scene, root, bounds)) return;
      const parent = scene.engine.meshes.get(scene.engine.store.parents[root.id]),
        m = parent?.matrix;
      const dx = (m?.[12] ?? 0) - (bounds[0] + bounds[3]) / 2,
        dy = (m?.[13] ?? 0) - (bounds[1] + bounds[4]) / 2,
        dz = (m?.[14] ?? 0) - (bounds[2] + bounds[5]) / 2;
      let delta = [dx, dy, dz];
      if (m) {
        const a = m[0],
          b = m[4],
          c = m[8],
          d = m[1],
          e = m[5],
          f = m[9],
          g = m[2],
          h = m[6],
          i = m[10];
        const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if (!determinant) return;
        delta = [
          ((e * i - f * h) * dx + (c * h - b * i) * dy + (b * f - c * e) * dz) / determinant,
          ((f * g - d * i) * dx + (a * i - c * g) * dy + (c * d - a * f) * dz) / determinant,
          ((d * h - e * g) * dx + (b * g - a * h) * dy + (a * e - b * d) * dz) / determinant,
        ];
      }
      const position = [root.position.x, root.position.y, root.position.z];
      let changed = false;
      for (let axis = 0; axis < 3; axis++)
        if (!flags.current[axis] && Math.abs(delta[axis]) > 1e-5) {
          position[axis] += delta[axis];
          changed = true;
        }
      if (changed) root.setPosition(position as [number, number, number]);
    };
    const frame: FrameCallback = () => center();
    scene.frames.callbacks.add(frame);
    queueMicrotask(() => {
      if (scene.frames.callbacks.has(frame) && !scene.engine.disposed) center();
    });
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene.engine, scene.frames, scene.resources, registry]);
  return null;
}
/** Recenter descendants while retaining the outer group's declared transform. */
export const Center = forwardRef<MeshRef, CenterProps>(function Center(
  { disableX, disableY, disableZ, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <Mesh>
        <CenterBinding disableX={disableX} disableY={disableY} disableZ={disableZ} />
        {children}
      </Mesh>
    </Mesh>
  );
});
