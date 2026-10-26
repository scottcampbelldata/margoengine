// Skin checks before export: the faults game engines reject or render wrongly. glTF 2.0 (section 3.7.3.3) requires
// joint indices inside the skin, weights that are 0 or more and sum to 1 per vertex, and at most four influences in
// JOINTS_0 / WEIGHTS_0 (engines such as Unity, Unreal, Godot and Roblox default to four).
import { checkRig, type RigJoint } from './rig.js';
import { WeightMap, type VertexInfluences } from './weight-map.js';

/** What a {@link SkinIssue} is about. */
export type SkinIssueCode =
  | 'unweighted'
  | 'too-many-influences'
  | 'not-normalized'
  | 'negative-weight'
  | 'non-finite'
  | 'invalid-joint'
  | 'degenerate-bone';

/** One kind of fault found by {@link checkSkin}, with up to 16 examples. */
export interface SkinIssue {
  readonly code: SkinIssueCode;
  /** How many vertices (or bones, for `degenerate-bone`) have it. */
  readonly count: number;
  /** The first vertices with it (at most 16). */
  readonly vertices: readonly number[];
  /** The bones involved (`degenerate-bone`, `invalid-joint`), at most 16. */
  readonly bones: readonly number[];
  /** The fault and its fix, in one sentence. */
  readonly message: string;
}

/** {@link checkSkin}'s result. */
export interface SkinReport {
  /** True when there are no issues. */
  readonly ok: boolean;
  readonly vertexCount: number;
  readonly issues: readonly SkinIssue[];
}

/** Input to {@link checkSkin}: weights, and optionally the skeleton they bind to. */
export interface SkinCheckInput {
  /** Per-vertex influences (JOINTS_0 / WEIGHTS_0, or wider) or a dense {@link WeightMap}. */
  readonly weights: VertexInfluences | WeightMap;
  /** Joints in the skin (default the WeightMap's bone count, or one more than the largest index). */
  readonly jointCount?: number;
  /** Most nonzero weights a vertex may have (default 4). */
  readonly maxInfluences?: number;
  /** Largest |sum - 1| that counts as normalised (default 1e-3). */
  readonly tolerance?: number;
  /** Rest skeleton: bones whose joint sits on its parent's position (zero length) are reported. */
  readonly joints?: readonly RigJoint[];
  /** Inverse bind matrices, 16 per joint: non-finite or non-invertible ones (a zero scale) are reported. */
  readonly inverseBindMatrices?: ArrayLike<number>;
}

const EXAMPLES = 16;
const FIX: Record<SkinIssueCode, string> = {
  unweighted: 'have no weight; paint them or run boneHeatWeights',
  'too-many-influences': 'have more nonzero weights than allowed; export with toInfluences(4)',
  'not-normalized': "have weights that don't sum to 1; call normalize()",
  'negative-weight': 'have negative weights; set them to 0 and call normalize()',
  'non-finite': 'have NaN or infinite weights; repaint or recompute them',
  'invalid-joint': 'name joints outside the skin; fix the joint indices or pass jointCount',
  'degenerate-bone': 'are degenerate (zero length, or a non-invertible bind matrix); move the joint or fix its scale',
};

/**
 * Checks skin weights before export: unweighted vertices, more than `maxInfluences` (4) influences, weights that do
 * not sum to 1, negative or non-finite weights, joint indices outside the skin, and degenerate bones (a joint at its
 * parent's position, or a non-invertible inverse bind matrix). Returns every kind of fault found; nothing is changed.
 */
export function checkSkin(input: SkinCheckInput): SkinReport {
  const { weights, maxInfluences = 4, tolerance = 1e-3 } = input ?? ({} as SkinCheckInput);
  if (!Number.isInteger(maxInfluences) || maxInfluences < 1)
    throw new RangeError('checkSkin maxInfluences must be a positive integer');
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError('checkSkin tolerance must be from 0 to below 1');
  let width: number, joints: ArrayLike<number> | null, values: ArrayLike<number>, jointCount: number;
  if (weights instanceof WeightMap) {
    width = weights.boneCount;
    joints = null;
    values = weights.values;
    jointCount = input.jointCount ?? weights.boneCount;
  } else {
    width = weights?.influences ?? 4;
    joints = weights?.joints;
    values = weights?.weights;
    if (!Number.isInteger(width) || width < 1 || joints?.length !== values?.length || joints.length % width)
      throw new TypeError(`checkSkin weights need equal-length joints and weights, ${width} per vertex`);
    let largest = 0;
    for (let i = 0; i < joints.length; i++) if (joints[i] > largest) largest = joints[i];
    jointCount = input.jointCount ?? largest + 1;
  }
  if (!Number.isInteger(jointCount) || jointCount < 1) throw new RangeError('checkSkin jointCount must be at least 1');
  const vertexCount = values.length / width,
    found = new Map<SkinIssueCode, { count: number; last: number; vertices: number[]; bones: Set<number> }>(),
    note = (code: SkinIssueCode, vertex: number, bone = -1) => {
      let entry = found.get(code);
      if (!entry) found.set(code, (entry = { count: 0, last: -1, vertices: [], bones: new Set() }));
      if (vertex >= 0) {
        if (entry.last !== vertex) {
          entry.last = vertex;
          entry.count++;
          if (entry.vertices.length < EXAMPLES) entry.vertices.push(vertex);
        }
      } else entry.count++;
      if (bone >= 0 && entry.bones.size < EXAMPLES) entry.bones.add(bone);
    };
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let sum = 0,
      nonzero = 0,
      broken = false;
    for (let k = 0; k < width; k++) {
      const w = values[vertex * width + k];
      if (!Number.isFinite(w)) {
        note('non-finite', vertex);
        broken = true;
        continue;
      }
      if (w < 0) note('negative-weight', vertex);
      if (w !== 0) {
        nonzero++;
        if (joints) {
          const j = joints[vertex * width + k];
          if (!Number.isInteger(j) || j < 0 || j >= jointCount) note('invalid-joint', vertex, j);
        }
      }
      sum += w;
    }
    if (broken) continue;
    if (nonzero === 0) note('unweighted', vertex);
    else if (Math.abs(sum - 1) > tolerance) note('not-normalized', vertex);
    if (nonzero > maxInfluences) note('too-many-influences', vertex);
  }
  if (input.joints !== undefined) {
    checkRig(input.joints);
    const rig = input.joints;
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (const { position } of rig)
      for (let c = 0; c < 3; c++) (low[c] = Math.min(low[c], position[c])), (high[c] = Math.max(high[c], position[c]));
    const size = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
    rig.forEach((joint, j) => {
      if (joint.parent < 0) return;
      const p = rig[joint.parent].position,
        q = joint.position;
      if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= 1e-6 * size) note('degenerate-bone', -1, j);
    });
  }
  const matrices = input.inverseBindMatrices;
  if (matrices !== undefined) {
    if (matrices?.length % 16 || !matrices.length)
      throw new TypeError('checkSkin inverseBindMatrices need 16 per joint');
    for (let j = 0; j < matrices.length / 16; j++) {
      const m = Array.from({ length: 16 }, (_, k) => matrices[j * 16 + k]);
      // Determinant of the upper 3x3 (the affine part decides invertibility).
      const det =
        m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      if (!m.every(Number.isFinite) || Math.abs(det) < 1e-12) note('degenerate-bone', -1, j);
    }
  }
  const issues: SkinIssue[] = [...found].map(([code, entry]) => {
    const bones = [...entry.bones].sort((a, b) => a - b),
      subject =
        code === 'degenerate-bone' ? `${entry.count} bone(s) (${bones.join(', ')})` : `${entry.count} vertex(es)`;
    return { code, count: entry.count, vertices: entry.vertices, bones, message: `${subject} ${FIX[code]}` };
  });
  return { ok: issues.length === 0, vertexCount, issues };
}

/**
 * {@link checkSkin}, throwing when it finds anything: call it right before export.
 * @throws RangeError naming every fault found and its fix.
 */
export function assertSkin(input: SkinCheckInput): void {
  const report = checkSkin(input);
  if (!report.ok)
    throw new RangeError(`Skin is not ready to export: ${report.issues.map((issue) => issue.message).join('; ')}`);
}
