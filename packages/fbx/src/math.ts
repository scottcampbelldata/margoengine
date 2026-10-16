import { invert } from '../../shared/math.js';
import { property, objectName, type FBXNode } from './document.js';

/** Column-major matrices and column vectors, evaluated in double precision. */
export const identity = (): Float64Array => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

export function inverse(m: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  if (!invert(out, m)) throw new RangeError('FBX singular transform');
  return out;
}

function vector(value: ArrayLike<number>, label: string): number[] {
  if (!value || value.length !== 3) throw new TypeError(`FBX ${label} needs three values`);
  const out = Array.from(value);
  if (out.some((v) => !Number.isFinite(v))) throw new RangeError(`FBX ${label} must be finite`);
  return out;
}

export function translation(value: ArrayLike<number>): Float64Array {
  const v = vector(value, 'translation'),
    m = identity();
  m.set(v, 12);
  return m;
}

export function scaling(value: ArrayLike<number>): Float64Array {
  const v = vector(value, 'scale'),
    m = identity();
  for (let i = 0; i < 3; i++) {
    if (!v[i]) throw new RangeError('FBX scale must be nonzero');
    m[i * 5] = v[i];
  }
  return m;
}

const orders = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'];
/** FBX's Euler order names specify the order in which fixed-axis rotations are applied. */
export function rotationEuler(degrees: ArrayLike<number>, order = 0): Float64Array {
  const v = vector(degrees, 'Euler rotation');
  if (!Number.isInteger(order) || !orders[order]) throw new RangeError(`FBX unsupported RotationOrder ${order}`);
  let out = identity();
  for (const axis of orders[order]) {
    const index = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2,
      angle = (v[index] * Math.PI) / 180,
      c = Math.cos(angle),
      s = Math.sin(angle),
      m = identity();
    if (index === 0) {
      m[5] = c;
      m[6] = s;
      m[9] = -s;
      m[10] = c;
    } else if (index === 1) {
      m[0] = c;
      m[2] = -s;
      m[8] = s;
      m[10] = c;
    } else {
      m[0] = c;
      m[1] = s;
      m[4] = -s;
      m[5] = c;
    }
    out = multiply(m, out);
  }
  return out;
}

export function composeTRS(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Float64Array {
  vector(t, 'translation');
  vector(s, 'scale');
  if (q.length !== 4 || Array.from(q).some((v) => !Number.isFinite(v)))
    throw new RangeError('FBX quaternion must be finite');
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!length) throw new RangeError('FBX quaternion must be nonzero');
  const x = q[0] / length,
    y = q[1] / length,
    z = q[2] / length,
    w = q[3] / length;
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ]);
}

export const determinant3 = (m: ArrayLike<number>): number =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

export interface TRS {
  translation: number[];
  rotation: number[];
  scale: number[];
}

/** glTF TRS cannot represent shear. Reject it instead of silently moving vertices or joints. */
export function decomposeTRS(m: ArrayLike<number>): TRS {
  if (
    m.length !== 16 ||
    Array.from(m).some((v) => !Number.isFinite(v)) ||
    Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) + Math.abs(m[15] - 1) > 1e-10
  )
    throw new RangeError('FBX transform must be finite and affine');
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  if (!sx || !sy || !sz) throw new RangeError('FBX singular transform');
  if (determinant3(m) < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const dot = (a: number, b: number) => r[a] * r[b] + r[a + 1] * r[b + 1] + r[a + 2] * r[b + 2];
  if (Math.abs(dot(0, 3)) > 1e-7 || Math.abs(dot(0, 6)) > 1e-7 || Math.abs(dot(3, 6)) > 1e-7)
    throw new RangeError('FBX transform shear cannot be represented as glTF TRS');
  const trace = r[0] + r[4] + r[8];
  let q: number[];
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4];
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = 2 * Math.sqrt(1 + r[0] - r[4] - r[8]);
    q = [s / 4, (r[3] + r[1]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s];
  } else if (r[4] > r[8]) {
    const s = 2 * Math.sqrt(1 + r[4] - r[0] - r[8]);
    q = [(r[3] + r[1]) / s, s / 4, (r[7] + r[5]) / s, (r[6] - r[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r[8] - r[0] - r[4]);
    q = [(r[6] + r[2]) / s, (r[7] + r[5]) / s, s / 4, (r[1] - r[3]) / s];
  }
  const length = Math.hypot(...q),
    sign = q[3] < 0 ? -1 : 1;
  return { translation: [m[12], m[13], m[14]], rotation: q.map((v) => (sign * v) / length), scale: [sx, sy, sz] };
}

export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): number[] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Inverse-transpose direction transform, normalized, including nonuniform and mirrored scales. */
export function transformNormal(m: ArrayLike<number>, x: number, y: number, z: number): number[] {
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[4],
    e = m[5],
    f = m[6],
    g = m[8],
    h = m[9],
    i = m[10],
    det = determinant3(m);
  if (!det || !Number.isFinite(det)) throw new RangeError('FBX singular normal transform');
  const nx = ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) / det;
  const ny = ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) / det;
  const nz = ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) / det,
    length = Math.hypot(nx, ny, nz);
  if (!length || !Number.isFinite(length)) throw new RangeError('FBX normal must be nonzero');
  return [nx / length, ny / length, nz / length];
}

function pvector(node: FBXNode, name: string, fallback = [0, 0, 0]): number[] {
  return vector(property(node, name, fallback) as ArrayLike<number>, name);
}
export interface TransformOverrides {
  translation?: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  scale?: ArrayLike<number>;
}

/** FBX pivot chain. Geometric transforms are deliberately separate: children must not inherit them. */
export function fbxLocalTransform(node: FBXNode, overrides: TransformOverrides = {}): Float64Array {
  // An explicitly disabled rotation space ignores Euler order and pre/post rotations.
  // Absent flags retain authored rotations; some FBX producers omit the default template values.
  const active = property(node, 'RotationActive', 1),
    rotationActive = active !== 0 && active !== false;
  const order = rotationActive ? Number(property(node, 'RotationOrder', 0)) : 0,
    inherit = Number(property(node, 'InheritType', 0));
  if (inherit !== 0) throw new RangeError(`FBX unsupported InheritType ${inherit} on ${objectName(node)}`);
  if (!orders[order]) throw new RangeError(`FBX unsupported RotationOrder ${order} on ${objectName(node)}`);
  const pivot = pvector(node, 'RotationPivot'),
    spivot = pvector(node, 'ScalingPivot');
  const matrices = [
    translation(overrides.translation ?? pvector(node, 'Lcl Translation')),
    translation(pvector(node, 'RotationOffset')),
    translation(pivot),
    rotationActive ? rotationEuler(pvector(node, 'PreRotation')) : identity(),
    rotationEuler(overrides.rotation ?? pvector(node, 'Lcl Rotation'), order),
    rotationActive ? inverse(rotationEuler(pvector(node, 'PostRotation'))) : identity(),
    translation(pivot.map((v) => -v)),
    translation(pvector(node, 'ScalingOffset')),
    translation(spivot),
    scaling(overrides.scale ?? pvector(node, 'Lcl Scaling', [1, 1, 1])),
    translation(spivot.map((v) => -v)),
  ];
  return matrices.reduce((a, b) => multiply(a, b), identity());
}

export function fbxGeometricTransform(node: FBXNode): Float64Array {
  return multiply(
    multiply(translation(pvector(node, 'GeometricTranslation')), rotationEuler(pvector(node, 'GeometricRotation'))),
    scaling(pvector(node, 'GeometricScaling', [1, 1, 1])),
  );
}
