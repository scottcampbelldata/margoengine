// Scene graph conveniences over core's transform store: tree walks, per-mesh data, world transforms and aiming. Core keeps
// a mesh's local position, rotation and scale and its parent; everything here reads those, so a result is right as soon
// as a value is written, before any frame. Written from the matrix and quaternion definitions.
import type { Mesh, Scene } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { rotationToQuaternion, splitTRS } from '@margoengine/math/quat';
import type { MutableVec3, Vec3, Vec3Like } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** A place for a result: an array of at least 3 numbers, or an object with `x`, `y` and `z`. */
export type VectorTarget = number[] | Float32Array | Float64Array | Vec3Like;
/** A point in world space: `[x, y, z]`, an object with `x`, `y` and `z`, or a mesh, meaning its world position. */
export type WorldPoint = Vec3 | Vec3Like | Mesh;
/** A world quaternion `[x, y, z, w]`. */
export type WorldQuaternion = [x: number, y: number, z: number, w: number];

/** Options of {@link lookAt}. */
export interface LookAtOptions {
  /** World direction the mesh's +Y leans toward. Default `[0, 1, 0]`. */
  up?: Vec3;
}

const data = new WeakMap<object, Record<string, unknown>>();

/** The mesh's direct children in the order they were attached, as a new array. Throws after the mesh is disposed. */
export function children(mesh: Mesh): Mesh[] {
  mesh.check();
  const runtime = meshRuntime(mesh),
    out: Mesh[] = [];
  for (const id of runtime.kids ?? []) out.push(runtime.engine.meshes.get(id) as unknown as Mesh);
  return out;
}

/** The mesh's parent, or null at the top of the tree. Throws after the mesh is disposed. */
export function parent(mesh: Mesh): Mesh | null {
  mesh.check();
  const runtime = meshRuntime(mesh),
    id = runtime.engine.store.parents[runtime.id];
  return id === -1 ? null : (runtime.engine.meshes.get(id) as unknown as Mesh);
}

const live = (mesh: Mesh) => {
  const runtime = meshRuntime(mesh);
  return !runtime.engine.disposed && runtime.engine.meshes.get(runtime.id) === runtime;
};
const walk = (mesh: Mesh, visitor: (mesh: Mesh) => void) => {
  visitor(mesh);
  // Live again after the visitor: it may dispose or move what comes next, so this copy of the list is checked as it goes.
  if (live(mesh)) for (const child of children(mesh)) if (live(child)) walk(child, visitor);
};

/**
 * Calls `visitor` for `target` and every mesh below it, parents before children, children in attach order. A scene
 * visits each mesh with no parent and what is below it. The visitor may dispose or reparent meshes: a mesh disposed
 * before its turn is skipped.
 */
export function traverse(target: Mesh | Scene, visitor: (mesh: Mesh) => void): void {
  if (typeof visitor !== 'function') throw typeError('traverse: visitor function', 'arguments');
  if ('meshes' in target) {
    for (const mesh of [...target.meshes.values()]) if (live(mesh) && parent(mesh) === null) walk(mesh, visitor);
    return;
  }
  target.check();
  walk(target, visitor);
}

/**
 * The mesh's own object for anything you want to keep with it, made on first use. Pass `value` to replace it. Margo
 * never reads it, and it goes when the mesh does.
 */
export function userData(mesh: Mesh, value?: Record<string, unknown>): Record<string, unknown> {
  mesh.check();
  if (value !== undefined) {
    if (typeof value !== 'object' || value === null) throw typeError('userData: object', 'arguments');
    data.set(mesh, value);
    return value;
  }
  let own = data.get(mesh);
  if (!own) data.set(mesh, (own = {}));
  return own;
}

/** `out` = `a` x `b`, for column-major affine matrices. `out` may be `b`. */
const multiply = (a: Float64Array, b: Float64Array, out: Float64Array) => {
  for (let c = 0; c < 4; c++) {
    const x = b[c * 4],
      y = b[c * 4 + 1],
      z = b[c * 4 + 2],
      w = c === 3 ? 1 : 0;
    for (let r = 0; r < 3; r++) out[c * 4 + r] = a[r] * x + a[4 + r] * y + a[8 + r] * z + a[12 + r] * w;
  }
  out[3] = out[7] = out[11] = 0;
  out[15] = 1;
};
/** The local matrix of slot `id`, as the kernel builds it (its quaternion normalized there too). */
const local = ({ transforms: t }: ReturnType<typeof meshRuntime>['engine']['store'], id: number, out: Float64Array) => {
  const length = Math.hypot(t.qx[id], t.qy[id], t.qz[id], t.qw[id]) || 1,
    x = t.qx[id] / length,
    y = t.qy[id] / length,
    z = t.qz[id] / length,
    w = t.qw[id] / length,
    sx = t.sx[id],
    sy = t.sy[id],
    sz = t.sz[id];
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + w * z) * sx;
  out[2] = 2 * (x * z - w * y) * sx;
  out[3] = 0;
  out[4] = 2 * (x * y - w * z) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + w * x) * sy;
  out[7] = 0;
  out[8] = 2 * (x * z + w * y) * sz;
  out[9] = 2 * (y * z - w * x) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[11] = 0;
  out[12] = t.x[id];
  out[13] = t.y[id];
  out[14] = t.z[id];
  out[15] = 1;
};
const step = new Float64Array(16);
/**
 * The world matrix from the current local values up the parents, in float64 (column-major, a new array). `mesh.matrix`
 * is the same matrix as of the last frame. Joint limits apply at the next frame, so a value outside its limit counts as
 * written until then.
 */
export function worldMatrix(mesh: Mesh): Float64Array {
  mesh.check();
  const { engine, id } = meshRuntime(mesh),
    store = engine.store,
    out = new Float64Array(16);
  local(store, id, out);
  for (let at = store.parents[id]; at !== -1; at = store.parents[at]) {
    local(store, at, step);
    multiply(step, out, out);
  }
  return out;
}

const write = <T extends VectorTarget | undefined>(out: T, x: number, y: number, z: number): T | MutableVec3 => {
  if (out === undefined) return [x, y, z];
  if ('x' in out) Object.assign(out, { x, y, z });
  else {
    out[0] = x;
    out[1] = y;
    out[2] = z;
  }
  return out;
};
const split = (mesh: Mesh) => {
  // Infinity: a world matrix under a rotated, unevenly scaled parent has shear, and this reports the nearest rotation.
  const parts = splitTRS(worldMatrix(mesh), Number.POSITIVE_INFINITY);
  if (!parts.ok) throw fault('state', `World matrix of a mesh is ${parts.reason}`, 'transform');
  return parts;
};

/** The mesh's position in world space, in `out` or a new `[x, y, z]`. Right as soon as a value is written. */
export function getWorldPosition(mesh: Mesh): MutableVec3;
export function getWorldPosition<T extends VectorTarget>(mesh: Mesh, out: T): T;
export function getWorldPosition(mesh: Mesh, out?: VectorTarget): VectorTarget {
  const m = worldMatrix(mesh);
  return write(out, m[12], m[13], m[14]) as VectorTarget;
}

/** The mesh's rotation in world space as `[x, y, z, w]`, in `out` or a new array. With a mirror, the scale's x holds it. */
export function getWorldQuaternion(mesh: Mesh, out: WorldQuaternion = [0, 0, 0, 1]): WorldQuaternion {
  const rotation = split(mesh).rotation,
    length = Math.hypot(...rotation);
  for (let i = 0; i < 4; i++) out[i] = rotation[i] / length;
  return out;
}

/** The mesh's scale in world space, in `out` or a new `[x, y, z]`. A mirror shows as a negative x. */
export function getWorldScale(mesh: Mesh): MutableVec3;
export function getWorldScale<T extends VectorTarget>(mesh: Mesh, out: T): T;
export function getWorldScale(mesh: Mesh, out?: VectorTarget): VectorTarget {
  const [x, y, z] = split(mesh).scale;
  return write(out, x, y, z) as VectorTarget;
}

const point = (value: WorldPoint): MutableVec3 => {
  if (value === null || typeof value !== 'object') throw typeError('lookAt: expected a point or a mesh', 'arguments');
  if ('setParent' in value) return getWorldPosition(value);
  const [x, y, z] = 'x' in value ? [value.x, value.y, value.z] : value;
  if (![x, y, z].every(Number.isFinite)) throw rangeError('lookAt: finite coordinates', 'transform');
  return [x, y, z];
};
const cross = (a: readonly number[], b: readonly number[]): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Scaled to length 1, or null for a zero vector. */
const unit = (v: MutableVec3): MutableVec3 | null => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
};
/** `v` through the inverse of the matrix's upper 3x3: from world directions into the parent's space. */
const intoParent = (m: Float64Array, v: readonly number[]): MutableVec3 => {
  const x = cross([m[4], m[5], m[6]], [m[8], m[9], m[10]]),
    y = cross([m[8], m[9], m[10]], [m[0], m[1], m[2]]),
    z = cross([m[0], m[1], m[2]], [m[4], m[5], m[6]]),
    det = m[0] * x[0] + m[1] * x[1] + m[2] * x[2];
  return [
    (x[0] * v[0] + x[1] * v[1] + x[2] * v[2]) / det,
    (y[0] * v[0] + y[1] * v[1] + y[2] * v[2]) / det,
    (z[0] * v[0] + z[1] * v[1] + z[2] * v[2]) / det,
  ];
};

/**
 * Turns the mesh so its +Z points at `target`, with +Y leaning toward `up`. That is the way a glTF model faces; a camera
 * looks down its -Z and aims with `camera.target`. Holds under any parent: the direction is taken back through the
 * parent's matrix. At the target itself the mesh keeps its rotation; looking straight along `up` picks the world axis
 * furthest from it.
 */
export function lookAt<T extends Mesh>(mesh: T, target: WorldPoint, { up = [0, 1, 0] }: LookAtOptions = {}): T {
  const from = getWorldPosition(mesh),
    to = point(target),
    above = parent(mesh);
  let forward: readonly number[] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    lean: readonly number[] = up;
  if (!forward[0] && !forward[1] && !forward[2]) return mesh;
  if (above) {
    const m = worldMatrix(above);
    forward = intoParent(m, forward);
    lean = intoParent(m, up);
  }
  const z = unit([...forward] as MutableVec3)!,
    // Parallel within rounding: the cross of near-equal vectors is noise, so it must be well above float64 epsilon.
    side = cross(lean, z),
    size = Math.hypot(side[0], side[1], side[2]) / (Math.hypot(lean[0], lean[1], lean[2]) || 1),
    axis = [0, 1, 2].reduce((best, i) => (Math.abs(z[i]) < Math.abs(z[best]) ? i : best), 0),
    x = unit(size > 1e-9 ? side : cross([+(axis === 0), +(axis === 1), +(axis === 2)], z))!,
    y = cross(z, x);
  mesh.setQuaternion(rotationToQuaternion([...x, ...y, ...z]));
  return mesh;
}
