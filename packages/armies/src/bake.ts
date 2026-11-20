// A person baked once for a crowd at every distance: the bone texture the near members skin with (instanced
// skinning, @margoengine/animation/instanced-skin), and from those very bones a vertex animation texture of a
// simplified mesh for the far members (@margoengine/animation/vat), so a member handed from one to the other keeps the
// same pose to the float: skinning is linear in the bone matrices, so posing each baked row on the CPU and
// interpolating the posed rows gives what the shader gets by interpolating the matrices. The far mesh is the person's
// own surface simplified by quadric collapses (@margoengine/lod/auto, mesh-edit's simplifier), every kept vertex one of
// the source's with its own skin weights, UVs and normal; vertices that deform differently are never welded.
// Sources: B. Dudash, "Animated Crowd Rendering", GPU Gems 3, chapter 2, 2007 (bone-matrix textures and instanced
// skinning); A. Beacco, N. Pelechano and C. Andujar, "A survey of real-time crowd rendering", Computer Graphics Forum
// 35(8):32-50, 2016 (per-distance representations, pre-skinned far levels); M. Garland and P. S. Heckbert, "Surface
// simplification using quadric error metrics", SIGGRAPH 1997.
import type { BoneBake } from '@margoengine/animation/instanced-skin';
import type { VATClip, VATData, VATBakeOptions } from '@margoengine/animation/vat';
import type { Animation } from '@margoengine/animation';

/** Texture width both bakes wrap at. */
const WIDTH = 2048;
/** Rows of a texture any WebGPU device takes. */
const MOST_ROWS = 8192;

/** A person baked for a crowd. */
export interface PersonBake {
  /** Bone texture and the full mesh: near members, skinned on the GPU. */
  readonly near: BoneBake;
  /** The simplified mesh with the same bones (its own vertices, weights and UVs). */
  readonly farBones: BoneBake;
  /** Vertex animation of the simplified mesh, posed from the same bone rows: far members. */
  readonly far: VATData;
  /** The clips, the same rows in every bake. */
  readonly clips: readonly VATClip[];
  /** Standing height of the bind pose, model units (metres for glTF). */
  readonly height: number;
}

/** Options of {@link bakePerson}. */
export interface PersonBakeOptions extends VATBakeOptions {
  /**
   * Triangles the far mesh keeps, at most. Default 3000: a body a few dozen pixels tall shows no difference, and the
   * far texture of four one-second clips at 30 a second stays near 12 MB.
   */
  farTriangles?: number;
  /** Stops the simplifier. */
  signal?: AbortSignal;
}

/**
 * Bakes a person for {@link import('./lod.js').PersonCrowd}: bones for the near members, a simplified vertex animation
 * for the far ones, posed from the same rows. Takes any `@margoengine/animation` Animation: a glTF, an FBX (a Character
 * Creator export through `@margoengine/humans` `addPerson`), or a body built in code. Loads the bone baker
 * (`@margoengine/animation/instanced-skin`) and the simplifier on first use.
 * @example
 * const bake = await bakePerson(new Animation(model), {clips: ['stand', 'walk', 'run', 'ride']});
 * @throws RangeError for bad options, or when the far texture would pass 8192 rows (fewer clips, a lower fps or fewer
 * far triangles).
 */
export async function bakePerson(animation: Animation, options: PersonBakeOptions = {}): Promise<PersonBake> {
  const farTriangles = options.farTriangles ?? 3000;
  if (!(Number.isInteger(farTriangles) && farTriangles >= 12 && farTriangles <= 1_000_000))
    throw new RangeError('bakePerson farTriangles must be a whole number from 12 to 1000000; pass about 3000');
  options.signal?.throwIfAborted();
  const { bakeBones } = await import('@margoengine/animation/instanced-skin');
  options.signal?.throwIfAborted();
  const near = bakeBones(animation, { fps: options.fps, clips: options.clips }),
    triangles = near.indices.length / 3,
    farBones = triangles > farTriangles ? await reduceBones(near, farTriangles / triangles, options.signal) : near,
    far = vatFromBones(farBones);
  return { near, farBones, far, clips: near.clips, height: personHeight(near) };
}

/** Height of a bake's bind pose: its highest vertex less its lowest, model units. */
export function personHeight(bake: Pick<BoneBake, 'vertices' | 'vertexCount'>): number {
  let lo = Infinity,
    hi = -Infinity;
  for (let v = 0; v < bake.vertexCount; v++) {
    const y = bake.vertices[v * 6 + 1]!;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return bake.vertexCount ? hi - lo : 0;
}

/**
 * The same bake on a simplified mesh: about `ratio` of the triangles, every kept vertex one of the source's with its
 * own position, normal, UV and skin weights, so it shares the bone rows. Vertices at one place that follow different
 * bones (closed lips, a cuff on a wrist) stay apart. Loads `@margoengine/lod/auto` on first use.
 * @throws RangeError for a ratio outside (0, 1], or a mesh over the simplifier's 200,000 vertices.
 */
export async function reduceBones(bake: BoneBake, ratio: number, signal?: AbortSignal): Promise<BoneBake> {
  if (!(ratio > 0 && ratio <= 1)) throw new RangeError('reduceBones ratio must be above 0 and at most 1');
  if (ratio === 1) return bake;
  const { simplifyAttributes } = await import('@margoengine/lod/auto'),
    n = bake.vertexCount,
    packed = new Float32Array(n * 20);
  for (let v = 0; v < n; v++) {
    const o = v * 20;
    packed.set(bake.vertices.subarray(v * 6, v * 6 + 3), o);
    packed.set(bake.vertices.subarray(v * 6 + 3, v * 6 + 6), o + 4);
    // UV0 as the loader packs it (v down): the bake keeps v up.
    packed[o + 12] = bake.uvs[v * 2]!;
    packed[o + 13] = 1 - bake.uvs[v * 2 + 1]!;
    packed.fill(1, o + 16, o + 20);
  }
  // How a vertex deforms: its bones and weights, so the simplifier never welds two that move apart.
  const apart = (v: number) => {
    let key = '';
    for (let i = 0; i < 8; i++) {
      const w = bake.weights[v * 8 + i]!;
      if (w > 0) key += `${bake.joints[v * 8 + i]}:${w.toFixed(3)} `;
    }
    return key;
  };
  const [level] = await simplifyAttributes({ vertices: packed, indices: bake.indices }, [ratio], { signal, apart });
  const sources = level!.sources ?? Uint32Array.from({ length: n }, (_, i) => i),
    count = sources.length,
    vertices = new Float32Array(count * 6),
    joints = new Uint32Array(count * 8),
    weights = new Float32Array(count * 8),
    uvs = new Float32Array(count * 2);
  sources.forEach((from, i) => {
    vertices.set(bake.vertices.subarray(from * 6, from * 6 + 6), i * 6);
    joints.set(bake.joints.subarray(from * 8, from * 8 + 8), i * 8);
    weights.set(bake.weights.subarray(from * 8, from * 8 + 8), i * 8);
    uvs.set(bake.uvs.subarray(from * 2, from * 2 + 2), i * 2);
  });
  return { ...bake, vertexCount: count, vertices, joints, weights, uvs, indices: Uint32Array.from(level!.indices) };
}

/**
 * A vertex animation texture of a bone bake: every row of every clip posed on the CPU exactly as the instanced-skin
 * shader poses it (position: the weighted bone matrices times the bind position; normal: their cofactors times the
 * bind normal), so a `VATCrowd` member and a `SkinnedCrowd` member with the same clip and time stand in the same place.
 * @throws RangeError when the texture would pass 8192 rows of 2048 texels.
 */
export function vatFromBones(bake: BoneBake): VATData {
  const n = bake.vertexCount,
    texelsNeeded = bake.rows * n * 2,
    height = Math.max(1, Math.ceil(texelsNeeded / WIDTH));
  if (height > MOST_ROWS)
    throw new RangeError(
      `A far texture of ${n} vertices and ${bake.rows} rows needs ${height} texture rows, over 8192; bake fewer clips, a lower fps or fewer far triangles`,
    );
  const texels = new Float32Array(WIDTH * height * 4),
    m = new Float64Array(12),
    bones = bake.bones,
    src = bake.texels,
    bw = bake.width;
  for (let row = 0; row < bake.rows; row++) {
    for (let v = 0; v < n; v++) {
      m.fill(0);
      for (let i = 0; i < 8; i++) {
        const w = bake.weights[v * 8 + i]!;
        if (!w) continue;
        const t = (row * bones + bake.joints[v * 8 + i]!) * 3;
        for (let k = 0; k < 3; k++) {
          const x = (t + k) % bw,
            y = Math.floor((t + k) / bw),
            o = (y * bw + x) * 4;
          for (let e = 0; e < 4; e++) m[k * 4 + e]! += w * src[o + e]!;
        }
      }
      const px = bake.vertices[v * 6]!,
        py = bake.vertices[v * 6 + 1]!,
        pz = bake.vertices[v * 6 + 2]!,
        nx = bake.vertices[v * 6 + 3]!,
        ny = bake.vertices[v * 6 + 4]!,
        nz = bake.vertices[v * 6 + 5]!,
        // Rows r0, r1, r2 of the 3x3; the normal goes by its cofactors (cross products of the rows), as the shader.
        a0 = m[0]!, a1 = m[1]!, a2 = m[2]!,
        b0 = m[4]!, b1 = m[5]!, b2 = m[6]!,
        c0x = b1 * m[10]! - b2 * m[9]!,
        c0y = b2 * m[8]! - b0 * m[10]!,
        c0z = b0 * m[9]! - b1 * m[8]!,
        sign = a0 * c0x + a1 * c0y + a2 * c0z < 0 ? -1 : 1,
        c1x = m[9]! * a2 - m[10]! * a1,
        c1y = m[10]! * a0 - m[8]! * a2,
        c1z = m[8]! * a1 - m[9]! * a0,
        c2x = a1 * b2 - a2 * b1,
        c2y = a2 * b0 - a0 * b2,
        c2z = a0 * b1 - a1 * b0,
        o = (row * n + v) * 8;
      texels[o] = a0 * px + a1 * py + a2 * pz + m[3]!;
      texels[o + 1] = b0 * px + b1 * py + b2 * pz + m[7]!;
      texels[o + 2] = m[8]! * px + m[9]! * py + m[10]! * pz + m[11]!;
      texels[o + 3] = 1;
      texels[o + 4] = sign * (c0x * nx + c0y * ny + c0z * nz);
      texels[o + 5] = sign * (c1x * nx + c1y * ny + c1z * nz);
      texels[o + 6] = sign * (c2x * nx + c2y * ny + c2z * nz);
      texels[o + 7] = 0;
    }
  }
  return {
    vertexCount: n,
    rows: bake.rows,
    width: WIDTH,
    texels,
    indices: bake.indices,
    uvs: bake.uvs,
    clips: bake.clips.map((c) => ({ ...c })),
  };
}
