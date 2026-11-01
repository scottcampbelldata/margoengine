import { forwardRef, useEffect, useRef } from 'react';
import type { FrameCallback } from '@margoengine/core';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, useMesh, useScene } from './internal.js';

/** Props of `<Billboard>`; every prop is optional. */
export interface BillboardProps extends MeshProps {
  /** Turn towards the camera each frame. Default true. */
  follow?: boolean;
  /** Never tilt up or down (keeps it upright, for signs and trees). Default false. */
  lockX?: boolean;
  /** Never turn left or right. Default false. */
  lockY?: boolean;
}
const unit = (x: number, y: number, z: number): [number, number, number] | null => {
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? [x / length, y / length, z / length] : null;
};
const dot = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
function BillboardBinding({
  follow = true,
  lockX = false,
  lockY = false,
}: Pick<BillboardProps, 'follow' | 'lockX' | 'lockY'>) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef({ follow, lockX, lockY });
  latest.current = { follow, lockX, lockY };
  useEffect(() => {
    const frame: FrameCallback = () => {
      const root = live(registry),
        { engine } = scene;
      if (!root || !latest.current.follow) return;
      engine.store.tick(false);
      const m = root.matrix,
        eye = engine.camera.position,
        // Children face +Z, as a Plane and Text do; the world basis has +Z towards the camera.
        z = unit(latest.current.lockY ? 0 : eye[0] - m[12], latest.current.lockX ? 0 : eye[1] - m[13], eye[2] - m[14]);
      if (!z) return;
      const up = Math.abs(z[1]) > 0.999 ? [0, 0, -Math.sign(z[1])] : [0, 1, 0],
        x = unit(up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0])!,
        y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]],
        // Undo the parent's rotation (its columns without their scale), so the group ends up facing in world space.
        p = engine.meshes.get(engine.store.parents[root.id])?.matrix,
        a = unit(p?.[0] ?? 1, p?.[1] ?? 0, p?.[2] ?? 0),
        b = unit(p?.[4] ?? 0, p?.[5] ?? 1, p?.[6] ?? 0),
        c = unit(p?.[8] ?? 0, p?.[9] ?? 0, p?.[10] ?? 1);
      if (!a || !b || !c) return;
      const m00 = dot(a, x),
        m01 = dot(a, y),
        m02 = dot(a, z),
        m10 = dot(b, x),
        m11 = dot(b, y),
        m12 = dot(b, z),
        m20 = dot(c, x),
        m21 = dot(c, y),
        m22 = dot(c, z),
        trace = m00 + m11 + m22;
      if (trace > 0) root.setQuaternion([m21 - m12, m02 - m20, m10 - m01, 1 + trace]);
      else if (m00 > m11 && m00 > m22) root.setQuaternion([1 + m00 - m11 - m22, m01 + m10, m02 + m20, m21 - m12]);
      else if (m11 > m22) root.setQuaternion([m01 + m10, 1 + m11 - m00 - m22, m12 + m21, m02 - m20]);
      else root.setQuaternion([m02 + m20, m12 + m21, 1 + m22 - m00 - m11, m10 - m01]);
    };
    scene.frames.callbacks.add(frame);
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene, registry]);
  return null;
}
/** A group that keeps facing the camera, whatever its parents do. Its children face it along +Z. */
export const Billboard = forwardRef<MeshRef, BillboardProps>(function Billboard(
  { follow, lockX, lockY, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <Mesh>
        <BillboardBinding follow={follow} lockX={lockX} lockY={lockY} />
        {children}
      </Mesh>
    </Mesh>
  );
});
