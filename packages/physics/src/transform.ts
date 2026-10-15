import {multiplyMatrices} from '@margoengine/math/mat4';

/** Structural view of core's transform store (`meshRuntime(mesh).engine.store`): local TRS per entity and parent ids. */
export interface TransformStoreLike {
  readonly parents: ArrayLike<number>;
  readonly transforms: Readonly<Record<'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw' | 'sx' | 'sy' | 'sz', Float32Array>>;
}

// Module scratch: these helpers never call back into user code, so they cannot be re-entered.
const chain = new Int32Array(65), local = new Float64Array(16), product = new Float64Array(16);

/**
 * World matrix of entity `id` (column-major, float64), composed from the local TRS chain the way core's kernel does
 * (parent * T * R * S). Unlike `mesh.matrix` it includes transform edits made since the engine's last tick. No allocation.
 */
export function worldMatrix(store: TransformStoreLike, id: number, out: Float64Array): Float64Array {
  let count = 0;
  for (let node = id; node !== -1; node = store.parents[node]) {
    if (count === chain.length) throw new RangeError('Parent depth: 64');
    chain[count++] = node;
  }
  localMatrix(store, chain[--count], out);
  while (count) {localMatrix(store, chain[--count], local); multiplyMatrices(out, local, product); out.set(product);}
  return out;
}

function localMatrix(store: TransformStoreLike, id: number, out: Float64Array): void {
  const t = store.transforms, x = t.qx[id], y = t.qy[id], z = t.qz[id], w = t.qw[id], sx = t.sx[id], sy = t.sy[id], sz = t.sz[id];
  out[0] = (1 - 2 * (y * y + z * z)) * sx; out[1] = 2 * (x * y + w * z) * sx; out[2] = 2 * (x * z - w * y) * sx; out[3] = 0;
  out[4] = 2 * (x * y - w * z) * sy; out[5] = (1 - 2 * (x * x + z * z)) * sy; out[6] = 2 * (y * z + w * x) * sy; out[7] = 0;
  out[8] = 2 * (x * z + w * y) * sz; out[9] = 2 * (y * z - w * x) * sz; out[10] = (1 - 2 * (x * x + y * y)) * sz; out[11] = 0;
  out[12] = t.x[id]; out[13] = t.y[id]; out[14] = t.z[id]; out[15] = 1;
}

/** Lengths of the matrix's basis columns: the world scale of a matrix without shear. */
export function matrixScale(m: ArrayLike<number>, out: number[]): number[] {
  out[0] = Math.hypot(m[0], m[1], m[2]); out[1] = Math.hypot(m[4], m[5], m[6]); out[2] = Math.hypot(m[8], m[9], m[10]);
  return out;
}

/**
 * Unit quaternion [x, y, z, w] of the matrix's rotation, from its normalized basis columns. Exact for rotation times
 * a positive (possibly per-axis) scale; with shear or a mirroring scale the result is the nearest it can express.
 */
export function matrixRotation(m: ArrayLike<number>, out: number[] | Float64Array): void {
  // Math.sqrt, not Math.hypot: V8's Math.hypot allocates an array for its arguments, and this runs every frame.
  const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]) || 1, sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]) || 1, sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]) || 1;
  const m00 = m[0] / sx, m10 = m[1] / sx, m20 = m[2] / sx, m01 = m[4] / sy, m11 = m[5] / sy, m21 = m[6] / sy, m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz;
  const trace = m00 + m11 + m22;
  // Shepperd's method: branch on the largest diagonal term for precision.
  if (trace > 0) {const s = 0.5 / Math.sqrt(trace + 1); out[3] = 0.25 / s; out[0] = (m21 - m12) * s; out[1] = (m02 - m20) * s; out[2] = (m10 - m01) * s;}
  else if (m00 > m11 && m00 > m22) {const s = 2 * Math.sqrt(1 + m00 - m11 - m22); out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s;}
  else if (m11 > m22) {const s = 2 * Math.sqrt(1 + m11 - m00 - m22); out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s;}
  else {const s = 2 * Math.sqrt(1 + m22 - m00 - m11); out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s;}
  const length = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]) || 1;
  for (let i = 0; i < 4; i++) out[i] /= length;
}
