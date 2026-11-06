// Dual quaternion skinning: bones blend as rigid motions, so a twisted joint keeps its volume where blended matrices
// collapse it (the candy-wrapper at a forearm or shoulder). Kavan, Collins, Zara and O'Sullivan, "Skinning with Dual
// Quaternions", I3D 2007. A bone's matrix is split exactly into rotation, translation and a symmetric stretch, so scaled
// and mirrored bones keep working: the stretch blends linearly and applies first, then the blended rigid motion.
import { batchedDeformationShader, type SkinningMode } from './shader.js';

const FLOATS = 16;

/** Eigenvectors of the symmetric 3x3 `b` (row major, destroyed) into `v` (columns), eigenvalues left on `b`'s diagonal. */
function jacobi(b: Float64Array, v: Float64Array): void {
  v.fill(0);
  v[0] = v[4] = v[8] = 1;
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = b[1] * b[1] + b[2] * b[2] + b[5] * b[5],
      size = b[0] * b[0] + b[4] * b[4] + b[8] * b[8];
    if (off <= 1e-32 * size) return;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        const apq = b[p * 3 + q];
        if (!apq) continue;
        const theta = (b[q * 3 + q] - b[p * 3 + p]) / (2 * apq),
          t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const bkp = b[k * 3 + p],
            bkq = b[k * 3 + q];
          b[k * 3 + p] = c * bkp - s * bkq;
          b[k * 3 + q] = s * bkp + c * bkq;
        }
        for (let k = 0; k < 3; k++) {
          const bpk = b[p * 3 + k],
            bqk = b[q * 3 + k];
          b[p * 3 + k] = c * bpk - s * bqk;
          b[q * 3 + k] = s * bpk + c * bqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p],
            vkq = v[k * 3 + q];
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
  }
}

const gram = new Float64Array(9),
  eigen = new Float64Array(9),
  left = new Float64Array(9),
  turn = new Float64Array(9),
  order = [0, 1, 2];

const det3 = (m: Float64Array) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/**
 * Splits the upper 3x3 of the column-major matrix at `m[o]` into a proper rotation `turn` (row major) and the symmetric
 * stretch it returns through `out` at `at` (s00, s11, s22, s01, s02, s12), so the matrix equals rotation times stretch.
 * A bone scaled to nothing has a stretch of rank below three: its rotation is completed, never undefined. A mirrored
 * bone takes the sign on the stretch, not on one axis, so neighbouring mirrored bones stay close together.
 */
function polar(m: ArrayLike<number>, o: number, out: Float32Array, at: number): void {
  // a[r][c] = m[o + c * 4 + r]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      gram[i * 3 + j] =
        m[o + i * 4] * m[o + j * 4] + m[o + i * 4 + 1] * m[o + j * 4 + 1] + m[o + i * 4 + 2] * m[o + j * 4 + 2];
  jacobi(gram, eigen);
  order.sort((a, b) => gram[b * 4] - gram[a * 4]);
  const sigma = order.map((i) => Math.sqrt(Math.max(gram[i * 4], 0))),
    floor = sigma[0] * 1e-7;
  let rank = 0;
  for (let k = 0; k < 3; k++) {
    const i = order[k];
    if (sigma[k] <= floor || !sigma[k]) continue;
    rank++;
    // Column k of `left` is A v / sigma.
    for (let r = 0; r < 3; r++)
      left[r * 3 + k] =
        (m[o + r] * eigen[i] + m[o + 4 + r] * eigen[3 + i] + m[o + 8 + r] * eigen[6 + i]) / sigma[k];
  }
  if (rank === 0) {
    for (let k = 0; k < 3; k++) for (let r = 0; r < 3; r++) left[r * 3 + k] = eigen[r * 3 + order[k]];
  } else if (rank === 1) {
    // Any direction square to the first: the bone has no extent along it.
    const x = left[0],
      y = left[3],
      z = left[6],
      a = Math.abs(x) < 0.6 ? 1 : 0,
      b = a ? 0 : 1,
      d = a * x + b * y,
      ux = a - d * x,
      uy = b - d * y,
      uz = -d * z,
      n = Math.hypot(ux, uy, uz);
    left[1] = ux / n;
    left[4] = uy / n;
    left[7] = uz / n;
  }
  if (rank && rank < 3) {
    left[2] = left[3] * left[7] - left[6] * left[4];
    left[5] = left[6] * left[1] - left[0] * left[7];
    left[8] = left[0] * left[4] - left[3] * left[1];
  }
  // turn = left * right^T, with right's columns the eigenvectors in sigma order.
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += left[r * 3 + k] * eigen[c * 3 + order[k]];
      turn[r * 3 + c] = sum;
    }
  let sign = 1;
  if (det3(turn) < 0) {
    if (rank === 3) {
      sign = -1;
      for (let i = 0; i < 9; i++) turn[i] = -turn[i];
    } else {
      // The missing axis has no extent, so turning it the other way changes nothing the stretch keeps.
      for (let r = 0; r < 3; r++) {
        const i = order[2];
        for (let c = 0; c < 3; c++) turn[r * 3 + c] -= 2 * left[r * 3 + 2] * eigen[c * 3 + i];
      }
    }
  }
  const s = (a: number, b: number) => {
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += sigma[k] * eigen[a * 3 + order[k]] * eigen[b * 3 + order[k]];
    return sign * sum;
  };
  out[at] = s(0, 0);
  out[at + 1] = s(1, 1);
  out[at + 2] = s(2, 2);
  out[at + 3] = s(0, 1);
  out[at + 4] = s(0, 2);
  out[at + 5] = s(1, 2);
  out[at + 6] = out[at + 7] = 0;
}

/** The unit quaternion of the proper rotation `turn` into `out`. */
function quaternion(out: Float64Array): void {
  const r = turn,
    trace = r[0] + r[4] + r[8];
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = s / 4;
    x = (r[7] - r[5]) / s;
    y = (r[2] - r[6]) / s;
    z = (r[3] - r[1]) / s;
  } else if (r[0] >= r[4] && r[0] >= r[8]) {
    const s = 2 * Math.sqrt(Math.max(1 + r[0] - r[4] - r[8], 0));
    w = (r[7] - r[5]) / s;
    x = s / 4;
    y = (r[1] + r[3]) / s;
    z = (r[2] + r[6]) / s;
  } else if (r[4] >= r[8]) {
    const s = 2 * Math.sqrt(Math.max(1 + r[4] - r[0] - r[8], 0));
    w = (r[2] - r[6]) / s;
    x = (r[1] + r[3]) / s;
    y = s / 4;
    z = (r[5] + r[7]) / s;
  } else {
    const s = 2 * Math.sqrt(Math.max(1 + r[8] - r[0] - r[4], 0));
    w = (r[3] - r[1]) / s;
    x = (r[2] + r[6]) / s;
    y = (r[5] + r[7]) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  out[0] = x / n;
  out[1] = y / n;
  out[2] = z / n;
  out[3] = w / n;
}

const unit = new Float64Array(4);

/**
 * Turns bone matrices (column major, 16 floats each, as a skin palette holds them) into 16-float dual quaternion slots:
 * the rotation quaternion, its dual part, then the symmetric stretch (s00, s11, s22, s01, s02, s12, 0, 0). `out` may be
 * `palette` itself. Every finite matrix encodes, singular and mirrored ones included; shear goes into the stretch.
 */
export function encodeDualQuaternions(palette: Float32Array, out: Float32Array = palette): Float32Array {
  if (palette.length % FLOATS || out.length < palette.length)
    throw new RangeError('Invalid bone palette; pass 16 floats per bone and an output at least as long');
  for (let o = 0; o < palette.length; o += FLOATS) {
    const tx = palette[o + 12],
      ty = palette[o + 13],
      tz = palette[o + 14];
    polar(palette, o, out, o + 8);
    quaternion(unit);
    const [x, y, z, w] = unit;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = w;
    out[o + 4] = 0.5 * (tx * w + ty * z - tz * y);
    out[o + 5] = 0.5 * (-tx * z + ty * w + tz * x);
    out[o + 6] = 0.5 * (tx * y - ty * x + tz * w);
    out[o + 7] = -0.5 * (tx * x + ty * y + tz * z);
  }
  return out;
}

const blendLines = (extra: boolean) => {
  const influences = ['x', 'y', 'z', 'w'].map((c) => [`joints.${c}`, `jointWeights.${c}`]);
  if (extra) for (const c of ['x', 'y', 'z', 'w']) influences.push([`jointsExtra.${c}`, `weightsExtra.${c}`]);
  return /* wgsl */ `var pivot=${influences[0][0]};var heaviest=${influences[0][1]};
    ${influences
      .slice(1)
      .map(([j, w]) => `if(${w}>heaviest){heaviest=${w};pivot=${j};}`)
      .join('')}
    let near=boneMatrices[s.bones+pivot][0];
    var real=vec4f(0);var dual=vec4f(0);var stretchA=vec4f(0);var stretchB=vec4f(0);
    ${influences
      .map(
        ([j, w]) =>
          `{let b=boneMatrices[s.bones+${j}];let k=select(${w},-${w},dot(b[0],near)<0);real+=b[0]*k;dual+=b[1]*k;stretchA+=b[2]*${w};stretchB+=b[3]*${w};}`,
      )
      .join('\n    ')}
    let size=length(real);let turn=real/size;let moved=dual/size;
    let shift=2*(turn.w*moved.xyz-moved.w*turn.xyz+cross(turn.xyz,moved.xyz));
    let stretch=mat3x3f(stretchA.x,stretchA.w,stretchB.x,stretchA.w,stretchA.y,stretchB.y,stretchB.x,stretchB.y,stretchA.z);
    v.position=vec4f(rotated(turn,stretch*v.position.xyz)+shift,1);
    let normalMatrix=mat3x3f(cross(stretch[1],stretch[2]),cross(stretch[2],stretch[0]),cross(stretch[0],stretch[1]));
    let handedness=sign(dot(stretch[0],cross(stretch[1],stretch[2])));
    v.normal=vec4f(rotated(turn,normalMatrix*v.normal.xyz*handedness),0);
    v.tangent=vec4f(rotated(turn,stretch*v.tangent.xyz),v.tangent.w*handedness);`;
};

/**
 * The `skinning` option of `Animation`: dual quaternion blending for every skinned primitive of that Animation.
 *
 * @example
 * ```ts
 * const animation = Animation.attach(model, { skinning: dualQuaternionSkinning });
 * ```
 */
export const dualQuaternionSkinning: SkinningMode = {
  name: 'dual-quaternion',
  shader: (extra) =>
    batchedDeformationShader(extra, {
      functions: 'fn rotated(q:vec4f,x:vec3f)->vec3f {return x+2*cross(q.xyz,cross(q.xyz,x)+q.w*x);}',
      blend: blendLines(extra),
    }),
  encode: (palette) => {
    encodeDualQuaternions(palette);
  },
};

/** Where one vertex goes, the CPU twin of the shader. */
export interface SkinnedVertex {
  position: [number, number, number];
  normal: [number, number, number];
}

const rotate = (q: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] => {
  const cx = q[1] * z - q[2] * y + q[3] * x,
    cy = q[2] * x - q[0] * z + q[3] * y,
    cz = q[0] * y - q[1] * x + q[3] * z;
  return [x + 2 * (q[1] * cz - q[2] * cy), y + 2 * (q[2] * cx - q[0] * cz), z + 2 * (q[0] * cy - q[1] * cx)];
};

/**
 * One vertex under encoded bones (`encodeDualQuaternions`), the same steps as the GPU in double precision, for checks
 * and CPU picking. `joints` and `weights` are parallel, with weights summing to 1; the normal comes back unit length.
 */
export function skinDualQuaternion(
  slots: Float32Array,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  position: ArrayLike<number>,
  normal: ArrayLike<number> = [0, 0, 1],
): SkinnedVertex {
  if (joints.length !== weights.length || !joints.length)
    throw new RangeError('Invalid influences; pass as many joints as weights, at least one');
  let pivot = joints[0],
    heaviest = weights[0];
  for (let i = 1; i < joints.length; i++)
    if (weights[i] > heaviest) {
      heaviest = weights[i];
      pivot = joints[i];
    }
  const near = pivot * FLOATS,
    real = [0, 0, 0, 0],
    dual = [0, 0, 0, 0],
    s = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < joints.length; i++) {
    const o = joints[i] * FLOATS,
      w = weights[i];
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += slots[o + c] * slots[near + c];
    const k = dot < 0 ? -w : w;
    for (let c = 0; c < 4; c++) {
      real[c] += slots[o + c] * k;
      dual[c] += slots[o + 4 + c] * k;
    }
    for (let c = 0; c < 6; c++) s[c] += slots[o + 8 + c] * w;
  }
  const size = Math.hypot(...real),
    q = real.map((v) => v / size),
    e = dual.map((v) => v / size),
    x = position[0],
    y = position[1],
    z = position[2],
    px = s[0] * x + s[3] * y + s[4] * z,
    py = s[3] * x + s[1] * y + s[5] * z,
    pz = s[4] * x + s[5] * y + s[2] * z,
    moved = rotate(q, px, py, pz),
    shift = [
      2 * (q[3] * e[0] - e[3] * q[0] + q[1] * e[2] - q[2] * e[1]),
      2 * (q[3] * e[1] - e[3] * q[1] + q[2] * e[0] - q[0] * e[2]),
      2 * (q[3] * e[2] - e[3] * q[2] + q[0] * e[1] - q[1] * e[0]),
    ],
    // Cofactors of the symmetric stretch, with the sign of its determinant.
    c00 = s[1] * s[2] - s[5] * s[5],
    c01 = s[4] * s[5] - s[3] * s[2],
    c02 = s[3] * s[5] - s[4] * s[1],
    c11 = s[0] * s[2] - s[4] * s[4],
    c12 = s[3] * s[4] - s[0] * s[5],
    c22 = s[0] * s[1] - s[3] * s[3],
    hand = Math.sign(s[0] * c00 + s[3] * c01 + s[4] * c02),
    n = rotate(
      q,
      hand * (c00 * normal[0] + c01 * normal[1] + c02 * normal[2]),
      hand * (c01 * normal[0] + c11 * normal[1] + c12 * normal[2]),
      hand * (c02 * normal[0] + c12 * normal[1] + c22 * normal[2]),
    ),
    length = Math.hypot(n[0], n[1], n[2]) || 1;
  return {
    position: [moved[0] + shift[0], moved[1] + shift[1], moved[2] + shift[2]],
    normal: [n[0] / length, n[1] / length, n[2] / length],
  };
}
