// Clean-room affine hierarchy operations. See docs/clean-room.md, batch 226.
import type { Mesh, Scene } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { Matrix4 } from '@margoengine/math';
import type { Vec3, Vec3Like, MutableVec3 } from '@margoengine/math';
import { axisAngleToQuaternion, multiplyQuaternions, rotateByQuaternion, splitTRS } from '@margoengine/math/quat';
import { rangeError, typeError } from '../../shared/errors.js';
import { children, parent, traverse, worldMatrix } from './index.js';
import type { VectorTarget } from './index.js';
import { sceneMutation } from './mutations.js';

/** Mesh selection function. Search includes the supplied root. */
export type MeshPredicate = (mesh: Mesh) => boolean;

/** All matching meshes in depth-first attach order, including the root. */
export function find(target: Mesh | Scene, predicate: MeshPredicate): Mesh[] {
  if (typeof predicate !== 'function') throw typeError('find: supply a predicate', 'arguments');
  const result: Mesh[] = [];
  traverse(target, (mesh) => { if (predicate(mesh)) result.push(mesh); });
  return result;
}

/** First depth-first match, or null. The predicate is not called after the first match. */
export function findOne(target: Mesh | Scene, predicate: MeshPredicate): Mesh | null {
  if (typeof predicate !== 'function') throw typeError('findOne: supply a predicate', 'arguments');
  let result: Mesh | null = null;
  traverse(target, (mesh) => { if (result === null && predicate(mesh)) result = mesh; });
  return result;
}

/** First mesh with exactly this name, including the root, or null. Names need not be unique. */
export function findByName(target: Mesh | Scene, name: string): Mesh | null {
  return findOne(target, (mesh) => mesh.name === name);
}

/** First mesh with this engine slot id, or null. Disposed mesh ids can be reused. */
export function findById(target: Mesh | Scene, id: number): Mesh | null {
  return findOne(target, (mesh) => meshRuntime(mesh).id === id);
}

/** Walk visible branches only. An invisible mesh prunes its entire subtree. */
export function traverseVisible(target: Mesh | Scene, visitor: (mesh: Mesh) => void): void {
  if (typeof visitor !== 'function') throw typeError('traverseVisible: supply a visitor', 'arguments');
  const visit = (mesh: Mesh) => {
    const runtime = meshRuntime(mesh);
    if (runtime.engine.disposed || runtime.engine.meshes.get(runtime.id) !== runtime || !mesh.visible) return;
    visitor(mesh);
    if (runtime.engine.meshes.get(runtime.id) === runtime && !runtime.engine.disposed)
      for (const child of children(mesh)) visit(child);
  };
  if ('meshes' in target) {
    for (const mesh of [...target.meshes.values()]) {
      const r = meshRuntime(mesh);
      if (!r.engine.disposed && r.engine.meshes.get(r.id) === r && parent(mesh) === null) visit(mesh);
    }
  } else { target.check(); visit(target); }
}

/** Visit the original ancestor chain, nearest first, excluding the mesh itself. */
export function traverseAncestors(mesh: Mesh, visitor: (mesh: Mesh) => void): void {
  if (typeof visitor !== 'function') throw typeError('traverseAncestors: supply a visitor', 'arguments');
  const ancestors: Mesh[] = [];
  for (let at = parent(mesh); at; at = parent(at)) ancestors.push(at);
  for (const at of ancestors) {
    const r = meshRuntime(at);
    if (!r.engine.disposed && r.engine.meshes.get(r.id) === r) visitor(at);
  }
}

/** Unparent a mesh, retaining its local transform. Returns the mesh. */
export function removeFromParent<T extends Mesh>(mesh: T): T { return mesh.setParent(null); }

const coordinates = (value: Vec3 | Vec3Like): MutableVec3 => {
  const v: MutableVec3 = 'x' in value ? [value.x, value.y, value.z] : [value[0], value[1], value[2]];
  if (!v.every(Number.isFinite)) throw rangeError('graph: supply finite coordinates', 'transform');
  return v;
};
const write = (out: VectorTarget, v: readonly number[]) => {
  if ('x' in out) { out.x = v[0]; out.y = v[1]; out.z = v[2]; }
  else { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; }
  return out;
};
const inverse = (m: Float64Array) => {
  const matrix = new Matrix4().fromArray(m), det = matrix.determinant();
  if (!Number.isFinite(det) || det === 0) throw rangeError('graph: use an invertible transform', 'transform');
  return matrix.invert();
};
const transformPoint = (m: Float64Array, v: readonly number[]): MutableVec3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

/** Transform a local point into world space. Returns a new tuple unless `out` is supplied. */
export function localToWorld(mesh: Mesh, point: Vec3 | Vec3Like): MutableVec3;
export function localToWorld<T extends VectorTarget>(mesh: Mesh, point: Vec3 | Vec3Like, out: T): T;
export function localToWorld(mesh: Mesh, point: Vec3 | Vec3Like, out: VectorTarget = [0, 0, 0]): VectorTarget {
  return write(out, transformPoint(worldMatrix(mesh), coordinates(point)));
}

/** Transform a world point into local space, including scaled and sheared ancestors. */
export function worldToLocal(mesh: Mesh, point: Vec3 | Vec3Like): MutableVec3;
export function worldToLocal<T extends VectorTarget>(mesh: Mesh, point: Vec3 | Vec3Like, out: T): T;
export function worldToLocal(mesh: Mesh, point: Vec3 | Vec3Like, out: VectorTarget = [0, 0, 0]): VectorTarget {
  return write(out, transformPoint(inverse(worldMatrix(mesh)).elements, coordinates(point)));
}

const parts = (m: Float64Array) => {
  const result = splitTRS(m, 1e-6);
  if (!result.ok) throw rangeError(`graph: ${result.reason}; choose parents permitting a TRS transform`, 'transform');
  if (![...result.position, ...result.rotation, ...result.scale].every((v) => Number.isFinite(Math.fround(v))) ||
    result.scale.some((v) => Math.fround(v) === 0))
    throw rangeError('graph: result must fit nonzero float32 TRS scales', 'transform');
  return result;
};

/**
 * Reparent `mesh` to `newParent` while keeping its world transform. Null attaches to the scene root.
 * Shear that cannot be represented by local TRS rejects before any mutation. Same-parent calls are no-ops.
 */
export function attach<T extends Mesh>(newParent: Mesh | null, mesh: T): T {
  mesh.check(); newParent?.check();
  if (parent(mesh) === newParent) return mesh;
  const world = worldMatrix(mesh);
  const matrix = newParent ? inverse(worldMatrix(newParent)).multiply({ elements: world }).elements : world;
  const p = parts(matrix);
  return sceneMutation(meshRuntime(mesh).engine, () => {
    mesh.setParent(newParent);
    return mesh.setPosition(p.position).setQuaternion(p.rotation).setScale(p.scale);
  });
}

const axisUnit = (axis: Vec3 | Vec3Like, amount: number) => {
  const v = coordinates(axis), length = Math.hypot(...v);
  if (!length || !Number.isFinite(length) || !Number.isFinite(amount))
    throw rangeError('graph: supply a nonzero axis and finite amount', 'transform');
  return v.map((x) => x / length) as MutableVec3;
};
const quaternion = (mesh: Mesh) => {
  mesh.check();
  const { engine, id } = meshRuntime(mesh), t = engine.store.transforms;
  const q = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]], length = Math.hypot(...q);
  return q.map((v) => v / length);
};

/** Translate along a normalized mesh-local axis. Distance is in parent units, independent of mesh scale. */
export function translateOnAxis<T extends Mesh>(mesh: T, axis: Vec3 | Vec3Like, distance: number): T {
  const direction = rotateByQuaternion(axisUnit(axis, distance), quaternion(mesh)), p = mesh.position;
  return mesh.setPosition([p.x + direction[0] * distance, p.y + direction[1] * distance, p.z + direction[2] * distance]);
}

/** Rotate around a normalized local axis, by radians. */
export function rotateOnAxis<T extends Mesh>(mesh: T, axis: Vec3 | Vec3Like, radians: number): T {
  const v = axisUnit(axis, radians);
  return mesh.setQuaternion(multiplyQuaternions(quaternion(mesh), axisAngleToQuaternion(v, radians)));
}

/** Rotate about a world axis at the mesh origin. Rejects an unrepresentable local shear before mutation. */
export function rotateOnWorldAxis<T extends Mesh>(mesh: T, axis: Vec3 | Vec3Like, radians: number): T {
  const v = axisUnit(axis, radians), m = worldMatrix(mesh), above = parent(mesh);
  const rotation = new Matrix4().makeRotationAxis({ x: v[0], y: v[1], z: v[2] }, radians);
  rotation.multiply({ elements: m });
  rotation.elements.set(m.subarray(12, 15), 12);
  const local = above ? inverse(worldMatrix(above)).multiply(rotation) : rotation;
  const p = parts(local.elements);
  return mesh.setQuaternion(p.rotation).setScale(p.scale);
}
