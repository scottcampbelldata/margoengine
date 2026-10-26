// Dense per-vertex, per-bone skin weights: what solving and painting edit. Export reads the strongest few per vertex
// (glTF JOINTS_0 / WEIGHTS_0) with toInfluences.

/**
 * Per-vertex joint indices and weights, `influences` of each per vertex: glTF's JOINTS_0 / WEIGHTS_0 at 4 (the shape of
 * `@margoengine/exporters/skin`'s `SkinWeights` and `Skin.attach`'s arguments). Unused slots hold joint 0, weight 0.
 */
export interface VertexInfluences {
  readonly joints: Uint16Array;
  readonly weights: Float32Array;
  /** Slots per vertex (default 4). */
  readonly influences?: number;
}

/** Most vertex-bone pairs a {@link WeightMap} holds (2^28, one gigabyte of weights). */
const MAX_PAIRS = 1 << 28;

/**
 * Skin weights for every vertex and bone, row-major (`values[vertex * boneCount + bone]`). Solvers return one and the
 * painter edits one; {@link WeightMap.toInfluences} gives the export form.
 */
export class WeightMap {
  /** `vertexCount * boneCount` weights, one row per vertex. */
  readonly values: Float32Array;

  /**
   * @param vertexCount Vertices (rows), at least 1.
   * @param boneCount Bones (columns), 1-65,536.
   * @param values Optional initial weights (copied), `vertexCount * boneCount` of them; default all zero.
   * @throws RangeError for counts out of range or a wrong-length `values`.
   */
  constructor(
    readonly vertexCount: number,
    readonly boneCount: number,
    values?: ArrayLike<number>,
  ) {
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 1)
      throw new RangeError(`WeightMap vertexCount ${vertexCount} must be a positive integer`);
    if (!Number.isSafeInteger(boneCount) || boneCount < 1 || boneCount > 65536)
      throw new RangeError(`WeightMap boneCount ${boneCount} must be an integer from 1 to 65,536`);
    if (vertexCount * boneCount > MAX_PAIRS)
      throw new RangeError('WeightMap vertices times bones exceed 2^28; weight the mesh in parts');
    this.values = new Float32Array(vertexCount * boneCount);
    if (values !== undefined) {
      if (values?.length !== this.values.length)
        throw new RangeError(`WeightMap values need ${this.values.length} numbers (vertices times bones)`);
      this.values.set(values);
    }
  }

  /** Weight of `bone` on `vertex`. */
  get(vertex: number, bone: number): number {
    return this.values[this.index(vertex, bone)];
  }

  /** Sets one weight (finite, 0 or more); call {@link normalize} after a batch of edits. */
  set(vertex: number, bone: number, weight: number): this {
    if (!(weight >= 0 && weight < Infinity)) throw new RangeError(`Weight ${weight} must be finite and 0 or more`);
    this.values[this.index(vertex, bone)] = weight;
    return this;
  }

  private index(vertex: number, bone: number): number {
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= this.vertexCount)
      throw new RangeError(
        `Vertex ${vertex} is outside the ${this.vertexCount} vertices; pass 0 to ${this.vertexCount - 1}`,
      );
    if (!Number.isInteger(bone) || bone < 0 || bone >= this.boneCount)
      throw new RangeError(`Bone ${bone} is outside the ${this.boneCount} bones; pass 0 to ${this.boneCount - 1}`);
    return vertex * this.boneCount + bone;
  }

  /**
   * Scales each vertex's weights to sum to 1. Weights of `locked` bones are kept; the others share what remains (none
   * when the locked ones already reach 1). A vertex with no unlocked weight to scale is left as it is; find those
   * with `checkSkin`. Negative and non-finite weights become 0 first.
   */
  normalize({ locked }: { locked?: readonly number[] } = {}): this {
    const b = this.boneCount,
      v = this.values,
      lock = lockMask(b, locked);
    for (let row = 0; row < v.length; row += b) normalizeRow(v, row, b, lock);
    return this;
  }

  /** A copy. */
  clone(): WeightMap {
    return new WeightMap(this.vertexCount, this.boneCount, this.values);
  }

  /**
   * The strongest `max` weights per vertex (default 4, glTF's JOINTS_0 / WEIGHTS_0), renormalised to sum to 1, sorted
   * strongest first; unused slots are joint 0 with weight 0. Ties keep the lower bone index.
   */
  toInfluences(max = 4): VertexInfluences {
    if (!Number.isInteger(max) || max < 1 || max > 16) throw new RangeError('Influences per vertex must be 1 to 16');
    const n = this.vertexCount,
      b = this.boneCount,
      v = this.values,
      joints = new Uint16Array(n * max),
      weights = new Float32Array(n * max),
      best = new Int32Array(max);
    for (let vertex = 0; vertex < n; vertex++) {
      const row = vertex * b;
      let kept = 0;
      for (let bone = 0; bone < b; bone++) {
        const w = v[row + bone];
        if (!(w > 0)) continue;
        // Insertion into the sorted top list: stronger first, the lower index first on ties.
        let at = kept < max ? kept++ : max;
        while (at > 0 && v[row + best[at - 1]] < w) {
          if (at < max) best[at] = best[at - 1];
          at--;
        }
        if (at < max) best[at] = bone;
      }
      let sum = 0;
      for (let k = 0; k < kept; k++) sum += v[row + best[k]];
      for (let k = 0; k < kept; k++) {
        joints[vertex * max + k] = best[k];
        weights[vertex * max + k] = v[row + best[k]] / sum;
      }
    }
    return { joints, weights, influences: max };
  }

  /**
   * A map from per-vertex influences (glTF JOINTS_0 / WEIGHTS_0, or wider): weights listed twice for one joint add up.
   * @param boneCount Bones in the skin; default one more than the largest joint index.
   */
  static fromInfluences(influences: VertexInfluences, boneCount?: number): WeightMap {
    const { joints, weights } = influences ?? ({} as VertexInfluences),
      width = influences?.influences ?? 4;
    if (!Number.isInteger(width) || width < 1 || joints?.length !== weights?.length || joints.length % width)
      throw new TypeError(`Influences need equal-length joints and weights, ${width} per vertex`);
    let largest = 0;
    for (let i = 0; i < joints.length; i++) if (joints[i] > largest) largest = joints[i];
    const bones = boneCount ?? largest + 1;
    if (largest >= bones) throw new RangeError(`Joint ${largest} is outside the ${bones} bones; pass boneCount`);
    const map = new WeightMap(joints.length / width, bones);
    for (let i = 0; i < joints.length; i++) {
      const w = weights[i];
      if (!(w >= 0 && w < Infinity)) throw new RangeError(`Weight ${i} (${w}) must be finite and 0 or more`);
      map.values[Math.floor(i / width) * bones + joints[i]] += w;
    }
    return map;
  }
}

/** Uint8 lock flags per bone. @throws RangeError for an out-of-range bone. */
export function lockMask(boneCount: number, locked: readonly number[] | undefined): Uint8Array {
  const mask = new Uint8Array(boneCount);
  if (locked === undefined) return mask;
  if (!Array.isArray(locked)) throw new TypeError('locked must be an array of bone indices');
  for (const bone of locked) {
    if (!Number.isInteger(bone) || bone < 0 || bone >= boneCount)
      throw new RangeError(`Locked bone ${bone} is outside the ${boneCount} bones; pass 0 to ${boneCount - 1}`);
    mask[bone] = 1;
  }
  return mask;
}

/** Normalises one row in place (see WeightMap.normalize). */
export function normalizeRow(v: Float32Array, row: number, b: number, lock: Uint8Array): void {
  let fixed = 0,
    free = 0;
  for (let k = 0; k < b; k++) {
    let w = v[row + k];
    if (!(w > 0 && w < Infinity)) w = v[row + k] = 0;
    if (lock[k]) fixed += w;
    else free += w;
  }
  if (!(free > 0)) return;
  const scale = Math.max(0, 1 - fixed) / free;
  for (let k = 0; k < b; k++) if (!lock[k]) v[row + k] *= scale;
}
