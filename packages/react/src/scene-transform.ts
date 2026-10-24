import type { Engine, Mesh } from '@margoengine/core/extension';
import { normalizeQuaternion, rotateByQuaternion, rotationToQuaternion } from '@margoengine/math/quat';

export type Triple = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export interface WorldPose {
  position: Triple;
  rotation: Quaternion;
  scale: Triple;
}

/** Decompose an engine world matrix without another scene graph or transform store. */
export function worldPose(mesh: Mesh): WorldPose {
  mesh.engine.store.tick(false);
  const m = mesh.matrix,
    sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  const determinant =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  const x = determinant < 0 ? -sx : sx;
  if (!x || !sy || !sz) throw new RangeError('Physics and XR require invertible transforms');
  const q = rotationToQuaternion(m, [0, 0, 0, 0] as [number, number, number, number], x, sy, sz);
  return {
    position: [m[12], m[13], m[14]],
    rotation: normalizeQuaternion(q, q),
    scale: [x, sy, sz],
  };
}

export function rotate(point: Triple, q: Quaternion): [number, number, number] {
  return rotateByQuaternion(point, q);
}

/** Keep the React hierarchy while the physics/XR plugins supply world-space poses. */
export function setWorldPose(mesh: Mesh, position: Triple, rotation: Quaternion): void {
  const engine = mesh.engine,
    parentId = engine.store.parents[mesh.id],
    parent = engine.meshes.get(parentId);
  if (!parent) {
    mesh.setPosition(position).setQuaternion(rotation);
    return;
  }
  const parentPose = worldPose(parent),
    m = parent.matrix;
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new RangeError('Physics and XR require invertible parent transforms');
  const x = position[0] - m[12],
    y = position[1] - m[13],
    z = position[2] - m[14];
  mesh.setPosition([
    ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) / det,
    ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) / det,
    ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) / det,
  ]);
  const [px, py, pz, pw] = parentPose.rotation,
    [qx, qy, qz, qw] = rotation;
  mesh.setQuaternion([
    pw * qx - px * qw - py * qz + pz * qy,
    pw * qy + px * qz - py * qw - pz * qx,
    pw * qz - px * qy + py * qx - pz * qw,
    pw * qw + px * qx + py * qy + pz * qz,
  ]);
}

export function descendants(engine: Engine, root: Mesh): Mesh[] {
  return [...engine.meshes.values()].filter((mesh) => {
    for (let id = mesh.id; id !== -1; id = engine.store.parents[id]) if (id === root.id) return true;
    return false;
  });
}
