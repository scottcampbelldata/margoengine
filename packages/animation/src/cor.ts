// Skinning with optimized centres of rotation (Le and Hodgins, "Real-time skeletal skinning with optimized centers of
// rotation", ACM TOG 35(4):37, 2016, https://doi.org/10.1145/2897824.2925959). Each vertex turns by the blended
// rotation of its bones (a normalized quaternion sum, as dual quaternion skinning blends it, Kavan et al. 2008) about
// its own centre of rotation, and that centre goes where the linear blend of the bones takes it:
//   v' = R (v - c) + sum_i w_i M_i c.
// A bent joint then neither collapses (linear blending pulls the skin towards the joint) nor bulges (dual quaternion
// blending turns the skin about the bones' own joint, so the outside of a bend balloons out), and a twisted limb keeps
// its volume. The centre c is the area-weighted mean of the mesh's triangles, each counted by how alike its weights
// are to the vertex's (the paper's similarity, sigma 0.1): it sits inside the part of the surface that moves with the
// same bones in the same proportions, so a coat's side panel turns about the middle of the chest, not about the
// shoulder joint. Centres are computed once per mesh in the bind pose.
import { batchedDeformationShader, type SkinMeshPart, type SkinningMode } from './shader.js';
import { encodeDualQuaternions, type SkinnedVertex } from './dqs.js';

const FLOATS = 16;

/** Options of {@link rotationCentres}. */
export interface RotationCentreOptions {
  /** Width of the weight similarity kernel (the paper's sigma). Default 0.1. */
  sigma?: number;
  /**
   * Triangles whose weights agree to within `1 / steps` per bone are summed together before the vertices read them, so
   * the work grows with the variety of weights, not the triangle count. Vertex weights are used exactly. Default 16.
   */
  steps?: number;
}

/** A vertex's influences as sorted bone ids and weights summing to 1; none when its weights sum to zero. */
function influencesOf(part: SkinMeshPart, v: number, bones: number[], amounts: number[]): void {
  bones.length = amounts.length = 0;
  let sum = 0;
  for (let i = 0; i < part.influences; i++) {
    const w = part.weights[v * part.influences + i];
    if (!(w > 0)) continue;
    const j = part.joints[v * part.influences + i],
      at = bones.indexOf(j);
    if (at >= 0) amounts[at] += w;
    else {
      bones.push(j);
      amounts.push(w);
    }
    sum += w;
  }
  // Insertion sort by bone, then normalize.
  for (let i = 1; i < bones.length; i++)
    for (let k = i; k > 0 && bones[k - 1] > bones[k]; k--) {
      [bones[k - 1], bones[k]] = [bones[k], bones[k - 1]];
      [amounts[k - 1], amounts[k]] = [amounts[k], amounts[k - 1]];
    }
  for (let i = 0; i < amounts.length; i++) amounts[i] /= sum;
}

interface Cluster {
  bones: number[];
  /** Area-weighted sum of the member triangles' weights, divided by `area` once all are in. */
  weights: Float64Array;
  area: number;
  /** Area-weighted sum of the member triangles' centroids. */
  x: number;
  y: number;
  z: number;
}

/**
 * Every vertex's centre of rotation (Le and Hodgins 2016), for all primitives of one skinned mesh in their bind pose:
 * one `Float32Array` per part, four numbers per vertex, the centre then 1, or the vertex's own position then 0 where
 * no triangle shares two of its bones (a vertex on one bone, whose skin is rigid wherever its centre is).
 *
 * @example
 * ```ts
 * import { rotationCentres } from '@margoengine/animation/cor';
 * // Two triangles along x, the left one on bone 0, the right one half and half on bones 0 and 1.
 * const [centres] = rotationCentres([{
 *   positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
 *   triangles: [0, 1, 2, 1, 3, 2],
 *   joints: [0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
 *   weights: [1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0],
 *   influences: 4,
 * }]);
 * console.log(centres.length); // 16: four numbers for each of the four vertices
 * ```
 */
export function rotationCentres(parts: readonly SkinMeshPart[], options: RotationCentreOptions = {}): Float32Array[] {
  const sigma = options.sigma ?? 0.1,
    steps = options.steps ?? 16;
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw new RangeError('rotationCentres sigma must be a positive number');
  if (!(steps >= 1) || !Number.isInteger(steps)) throw new RangeError('rotationCentres steps must be a whole number >= 1');
  for (const part of parts) {
    const count = part.positions.length / 3;
    if (!Number.isInteger(count) || part.joints.length !== count * part.influences || part.weights.length !== count * part.influences)
      throw new RangeError('rotationCentres parts need three positions and `influences` joints and weights per vertex');
    if (part.triangles && part.triangles.length % 3)
      throw new RangeError('rotationCentres triangles must come in threes');
  }
  const s2 = sigma * sigma,
    clusters = new Map<string, Cluster>(),
    bones: number[] = [],
    amounts: number[] = [],
    corner = new Map<number, number>();
  // Triangles with two or more bones, summed into clusters of like weights.
  for (const part of parts) {
    const tris = part.triangles,
      P = part.positions,
      count = P.length / 3;
    if (!tris) continue;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t],
        b = tris[t + 1],
        c = tris[t + 2];
      if (a >= count || b >= count || c >= count) throw new RangeError('rotationCentres triangle corner out of range');
      const ux = P[b * 3] - P[a * 3],
        uy = P[b * 3 + 1] - P[a * 3 + 1],
        uz = P[b * 3 + 2] - P[a * 3 + 2],
        vx = P[c * 3] - P[a * 3],
        vy = P[c * 3 + 1] - P[a * 3 + 1],
        vz = P[c * 3 + 2] - P[a * 3 + 2],
        area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (!(area > 0)) continue;
      corner.clear();
      for (const v of [a, b, c]) {
        influencesOf(part, v, bones, amounts);
        for (let i = 0; i < bones.length; i++) corner.set(bones[i], (corner.get(bones[i]) ?? 0) + amounts[i] / 3);
      }
      if (corner.size < 2) continue;
      const ids = [...corner.keys()].sort((x, y) => x - y);
      let key = '';
      for (const j of ids) key += j + ':' + Math.round(corner.get(j)! * steps) + ',';
      let cluster = clusters.get(key);
      if (!cluster)
        clusters.set(key, (cluster = { bones: ids, weights: new Float64Array(ids.length), area: 0, x: 0, y: 0, z: 0 }));
      for (let i = 0; i < ids.length; i++) cluster.weights[i] += corner.get(ids[i])! * area;
      cluster.area += area;
      cluster.x += (area * (P[a * 3] + P[b * 3] + P[c * 3])) / 3;
      cluster.y += (area * (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1])) / 3;
      cluster.z += (area * (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2])) / 3;
    }
  }
  const list = [...clusters.values()];
  let maxBone = 0;
  for (const cluster of list) {
    for (let i = 0; i < cluster.weights.length; i++) cluster.weights[i] /= cluster.area;
    maxBone = Math.max(maxBone, cluster.bones[cluster.bones.length - 1]);
  }
  for (const part of parts) for (let i = 0; i < part.joints.length; i++) maxBone = Math.max(maxBone, part.joints[i]);
  // Clusters by each pair of bones they hold: only a cluster sharing two of a vertex's bones is alike to it.
  const span = maxBone + 1,
    byPair = new Map<number, number[]>();
  list.forEach((cluster, id) => {
    const b = cluster.bones;
    for (let i = 0; i < b.length; i++)
      for (let k = i + 1; k < b.length; k++) {
        const key = b[i] * span + b[k];
        let ids = byPair.get(key);
        if (!ids) byPair.set(key, (ids = []));
        ids.push(id);
      }
  });
  const seen = new Int32Array(list.length).fill(-1),
    dense = new Float64Array(span),
    memo = new Map<string, Float64Array | null>(),
    out: Float32Array[] = [];
  let visit = 0;
  for (const part of parts) {
    const P = part.positions,
      count = P.length / 3,
      data = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
      data[v * 4] = P[v * 3];
      data[v * 4 + 1] = P[v * 3 + 1];
      data[v * 4 + 2] = P[v * 3 + 2];
      influencesOf(part, v, bones, amounts);
      if (bones.length < 2) continue;
      // Vertices with the same weights (to 1/4096) share one centre.
      let key = '';
      for (let i = 0; i < bones.length; i++) key += bones[i] + ':' + Math.round(amounts[i] * 4096) + ',';
      let centre = memo.get(key);
      if (centre === undefined) {
        visit++;
        for (let i = 0; i < bones.length; i++) dense[bones[i]] = amounts[i];
        let sx = 0,
          sy = 0,
          sz = 0,
          sw = 0;
        for (let i = 0; i < bones.length; i++)
          for (let k = i + 1; k < bones.length; k++)
            for (const id of byPair.get(bones[i] * span + bones[k]) ?? []) {
              if (seen[id] === visit) continue;
              seen[id] = visit;
              const cluster = list[id],
                cb = cluster.bones,
                cw = cluster.weights;
              // The similarity: every pair of bones both hold, by how alike their two weights' ratios are.
              let s = 0;
              for (let a = 0; a < cb.length; a++) {
                const pa = dense[cb[a]];
                if (!pa) continue;
                const ta = cw[a];
                for (let b = a + 1; b < cb.length; b++) {
                  const pb = dense[cb[b]];
                  if (!pb) continue;
                  const tb = cw[b],
                    d = pa * tb - pb * ta;
                  s += pa * pb * ta * tb * Math.exp(-(d * d) / s2);
                }
              }
              if (!s) continue;
              sw += s * cluster.area;
              sx += s * cluster.x;
              sy += s * cluster.y;
              sz += s * cluster.z;
            }
        for (let i = 0; i < bones.length; i++) dense[bones[i]] = 0;
        centre = sw > 0 ? Float64Array.of(sx / sw, sy / sw, sz / sw) : null;
        memo.set(key, centre);
      }
      if (!centre) continue;
      data[v * 4] = centre[0];
      data[v * 4 + 1] = centre[1];
      data[v * 4 + 2] = centre[2];
      data[v * 4 + 3] = 1;
    }
    out.push(data);
  }
  return out;
}

const rotateQ = (q: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] => {
  const cx = q[1] * z - q[2] * y + q[3] * x,
    cy = q[2] * x - q[0] * z + q[3] * y,
    cz = q[0] * y - q[1] * x + q[3] * z;
  return [x + 2 * (q[1] * cz - q[2] * cy), y + 2 * (q[2] * cx - q[0] * cz), z + 2 * (q[0] * cy - q[1] * cx)];
};

/**
 * One vertex under bones encoded by `encodeDualQuaternions` (`@margoengine/animation/dqs`), about its centre of
 * rotation `centre` (from {@link rotationCentres}): the shader's steps in double precision, for checks and CPU picking.
 * `joints` and `weights` are parallel, weights summing to 1; the normal comes back unit length.
 */
export function skinCenterOfRotation(
  slots: Float32Array,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  position: ArrayLike<number>,
  normal: ArrayLike<number> = [0, 0, 1],
  centre: ArrayLike<number> = position,
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
    s = [0, 0, 0, 0, 0, 0],
    moved = [0, 0, 0],
    cx = centre[0],
    cy = centre[1],
    cz = centre[2];
  for (let i = 0; i < joints.length; i++) {
    const o = joints[i] * FLOATS,
      w = weights[i];
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += slots[o + c] * slots[near + c];
    const k = dot < 0 ? -w : w;
    for (let c = 0; c < 4; c++) real[c] += slots[o + c] * k;
    for (let c = 0; c < 6; c++) s[c] += slots[o + 8 + c] * w;
    // The bone's own matrix on the centre: its stretch, its rotation, then its shift (the dual part).
    const q = slots.subarray(o, o + 4),
      e = slots.subarray(o + 4, o + 8),
      t = rotateQ(
        q,
        slots[o + 8] * cx + slots[o + 11] * cy + slots[o + 12] * cz,
        slots[o + 11] * cx + slots[o + 9] * cy + slots[o + 13] * cz,
        slots[o + 12] * cx + slots[o + 13] * cy + slots[o + 10] * cz,
      );
    moved[0] += w * (t[0] + 2 * (q[3] * e[0] - e[3] * q[0] + q[1] * e[2] - q[2] * e[1]));
    moved[1] += w * (t[1] + 2 * (q[3] * e[1] - e[3] * q[1] + q[2] * e[0] - q[0] * e[2]));
    moved[2] += w * (t[2] + 2 * (q[3] * e[2] - e[3] * q[2] + q[0] * e[1] - q[1] * e[0]));
  }
  const size = Math.hypot(...real),
    q = real.map((v) => v / size),
    x = position[0] - cx,
    y = position[1] - cy,
    z = position[2] - cz,
    turned = rotateQ(q, s[0] * x + s[3] * y + s[4] * z, s[3] * x + s[1] * y + s[5] * z, s[4] * x + s[5] * y + s[2] * z),
    c00 = s[1] * s[2] - s[5] * s[5],
    c01 = s[4] * s[5] - s[3] * s[2],
    c02 = s[3] * s[5] - s[4] * s[1],
    c11 = s[0] * s[2] - s[4] * s[4],
    c12 = s[3] * s[4] - s[0] * s[5],
    c22 = s[0] * s[1] - s[3] * s[3],
    hand = s[0] * c00 + s[3] * c01 + s[4] * c02 >= 0 ? 1 : -1,
    bx = hand * (c00 * normal[0] + c01 * normal[1] + c02 * normal[2]),
    by = hand * (c01 * normal[0] + c11 * normal[1] + c12 * normal[2]),
    bz = hand * (c02 * normal[0] + c12 * normal[1] + c22 * normal[2]),
    bent = bx * bx + by * by + bz * bz > 0,
    n = rotateQ(q, bent ? bx : 0, bent ? by : 1, bent ? bz : 0),
    length = Math.hypot(n[0], n[1], n[2]) || 1;
  return {
    position: [turned[0] + moved[0], turned[1] + moved[1], turned[2] + moved[2]],
    normal: [n[0] / length, n[1] / length, n[2] / length],
  };
}

/** The WGSL blend: the rotation by the normalized quaternion sum about `vertexData.xyz`, which moves linearly. */
const blendLines = (extra: boolean) => {
  const influences = ['x', 'y', 'z', 'w'].map((c) => [`joints.${c}`, `jointWeights.${c}`]);
  if (extra) for (const c of ['x', 'y', 'z', 'w']) influences.push([`jointsExtra.${c}`, `weightsExtra.${c}`]);
  return /* wgsl */ `var pivot=${influences[0][0]};var heaviest=${influences[0][1]};
    ${influences
      .slice(1)
      .map(([j, w]) => `if(${w}>heaviest){heaviest=${w};pivot=${j};}`)
      .join('')}
    let near=boneMatrices[s.bones+pivot][0];let centre=vertexData.xyz;
    var real=vec4f(0);var stretchA=vec4f(0);var stretchB=vec4f(0);var moved=vec3f(0);
    ${influences
      .map(
        ([j, w]) =>
          `{let b=boneMatrices[s.bones+${j}];let k=select(${w},-${w},dot(b[0],near)<0);real+=b[0]*k;stretchA+=b[2]*${w};stretchB+=b[3]*${w};moved+=placed(b,centre)*${w};}`,
      )
      .join('\n    ')}
    let turn=real/length(real);
    let stretch=mat3x3f(stretchA.x,stretchA.w,stretchB.x,stretchA.w,stretchA.y,stretchB.y,stretchB.x,stretchB.y,stretchA.z);
    v.position=vec4f(rotated(turn,stretch*(v.position.xyz-centre))+moved,1);
    let normalMatrix=mat3x3f(cross(stretch[1],stretch[2]),cross(stretch[2],stretch[0]),cross(stretch[0],stretch[1]));
    let handedness=select(-1.0,1.0,dot(stretch[0],cross(stretch[1],stretch[2]))>=0.0);let bent=normalMatrix*v.normal.xyz*handedness;
    v.normal=vec4f(rotated(turn,select(vec3f(0,1,0),bent,dot(bent,bent)>0.0)),0);
    v.tangent=vec4f(rotated(turn,stretch*v.tangent.xyz),v.tangent.w*handedness);`;
};

/** A bone's own matrix on a point, from its encoded slot: stretch, rotation, then the shift of its dual part. */
const functions = /* wgsl */ `fn rotated(q:vec4f,x:vec3f)->vec3f {return x+2*cross(q.xyz,cross(q.xyz,x)+q.w*x);}
fn placed(b:mat4x4f,p:vec3f)->vec3f {
  let st=mat3x3f(b[2].x,b[2].w,b[3].x,b[2].w,b[2].y,b[3].y,b[3].x,b[3].y,b[2].z);
  return rotated(b[0],st*p)+2*(b[0].w*b[1].xyz-b[1].w*b[0].xyz+cross(b[0].xyz,b[1].xyz));
}`;

/**
 * The `skinning` option of `Animation` for skinning with optimized centres of rotation (Le and Hodgins 2016): no
 * collapse at a bent or twisted joint and no bulge on the outside of a bend. Each skinned mesh's centres are computed
 * once, from all of its primitives in the bind pose ({@link rotationCentres}); its `blend` gives the same pose on the
 * CPU for synchronous raycasts. `@margoengine/humans` `addPerson` uses it by default.
 *
 * @example
 * ```ts
 * import { Animation } from '@margoengine/animation';
 * import { centerOfRotationSkinning } from '@margoengine/animation/cor';
 * const animation = Animation.attach(model, { skinning: centerOfRotationSkinning });
 * ```
 */
export const centerOfRotationSkinning: SkinningMode = {
  name: 'center-of-rotation',
  shader: (extra) => batchedDeformationShader(extra, { functions, blend: blendLines(extra) }, true),
  encode: (palette) => {
    encodeDualQuaternions(palette);
  },
  blend: (palette, joints, weights, position, normal, _share, data) =>
    skinCenterOfRotation(palette, joints, weights, position, normal, data ?? position),
  vertexData: (parts) => rotationCentres(parts),
};
