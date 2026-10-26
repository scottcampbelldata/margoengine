// Weight painting: brush strokes that add, subtract, replace or smooth one bone's weight around a point, keeping every
// touched vertex normalised, with undo. Vertices at one position (seams, voxel faces) are painted as one.
import type { Vec3 } from '@margoengine/math';
import { neighbours, weld, type WeightMesh } from './mesh.js';
import { lockMask, normalizeRow, type WeightMap } from './weight-map.js';

/** How a stroke changes weights. */
export type BrushMode = 'add' | 'subtract' | 'replace' | 'smooth';
/** Brush strength across its radius: `smooth` (default, smoothstep), `linear`, or `constant`. */
export type BrushFalloff = 'smooth' | 'linear' | 'constant';

/** One brush dab: {@link WeightPainter.stroke}. */
export interface BrushStroke {
  /** What the brush does. `smooth` blends every unlocked bone toward the neighbours' average. */
  readonly mode: BrushMode;
  /** Bone painted by `add`, `subtract` and `replace` (ignored by `smooth`). */
  readonly bone?: number;
  /** Brush centre in mesh space. */
  readonly center: Vec3;
  /** Brush radius in mesh units, above 0. */
  readonly radius: number;
  /** 0-1 (default 0.5): the amount added or removed at the centre, or the blend toward the value or the average. */
  readonly strength?: number;
  /** Target weight for `replace` (default 1). */
  readonly value?: number;
  /** Default `smooth`. */
  readonly falloff?: BrushFalloff;
}

/** The record of one stroke: which vertices it changed and how to put them back. */
export interface WeightEdit {
  /** Input vertices the stroke changed. */
  readonly vertices: Uint32Array;
  /** Restores the weights the stroke changed. Undo strokes newest first. */
  undo(): void;
}

/** Options for {@link WeightPainter}. */
export interface WeightPainterOptions {
  /** Parent bone per bone (a skeleton's `parents`): weight subtracted from a vertex with no other bone goes to the parent. */
  readonly parents?: readonly number[];
  /** Bones whose weights strokes never change. Change it any time. */
  locked?: readonly number[];
  /** Welding tolerance as a fraction of the mesh's size (default 1e-6). */
  readonly weld?: number;
}

/**
 * Paints a {@link WeightMap} on a mesh. Every stroke leaves the vertices it touches summing to 1: when one bone gains
 * or loses weight the other unlocked bones on that vertex are scaled to make up the difference (a vertex whose other
 * bones hold nothing passes subtracted weight to the painted bone's parent, when `parents` is given and the parent is
 * unlocked; otherwise its weight cannot drop). Locked bones keep their weights.
 */
export class WeightPainter {
  /** Bones strokes leave alone. */
  locked: readonly number[];
  private readonly point: Int32Array;
  private readonly positions: Float64Array;
  private readonly members: Int32Array;
  private readonly memberOffsets: Int32Array;
  private readonly offsets: Int32Array;
  private readonly columns: Int32Array;
  private readonly parents?: readonly number[];

  /**
   * @param weights The weights to edit, one row per mesh vertex.
   * @param mesh The mesh they belong to.
   * @throws RangeError when the mesh and the weights have different vertex counts.
   */
  constructor(
    readonly weights: WeightMap,
    mesh: WeightMesh,
    options: WeightPainterOptions = {},
  ) {
    const welded = weld(mesh, options.weld);
    if (welded.vertexCount !== weights?.vertexCount)
      throw new RangeError(
        `WeightPainter mesh has ${welded.vertexCount} vertices but the weights ${weights?.vertexCount}; pair them`,
      );
    if (options.parents !== undefined) {
      if (!Array.isArray(options.parents) || options.parents.length !== weights.boneCount)
        throw new RangeError(`WeightPainter parents needs one entry per bone (${weights.boneCount})`);
      this.parents = options.parents;
    }
    this.locked = options.locked ?? [];
    lockMask(weights.boneCount, this.locked);
    this.point = welded.point;
    this.positions = welded.positions;
    ({ offsets: this.offsets, columns: this.columns } = neighbours(welded));
    // Input vertices of each welded point, so a stroke writes every duplicate.
    const m = welded.positions.length / 3,
      counts = new Int32Array(m + 1);
    for (let v = 0; v < welded.point.length; v++) counts[welded.point[v] + 1]++;
    for (let i = 0; i < m; i++) counts[i + 1] += counts[i];
    this.memberOffsets = counts.slice();
    this.members = new Int32Array(welded.point.length);
    for (let v = 0; v < welded.point.length; v++) this.members[counts[welded.point[v]]++] = v;
  }

  /**
   * Applies one brush dab and returns its {@link WeightEdit} (undo). Brush strength at a vertex is `strength` times
   * the falloff of its distance from `center` over `radius`.
   * @throws RangeError for an invalid stroke.
   */
  stroke(stroke: BrushStroke): WeightEdit {
    const { mode, center, radius } = stroke ?? ({} as BrushStroke),
      strength = stroke.strength ?? 0.5,
      falloff = stroke.falloff ?? 'smooth',
      value = stroke.value ?? 1,
      b = this.weights.boneCount;
    if (!['add', 'subtract', 'replace', 'smooth'].includes(mode))
      throw new RangeError(`Brush mode ${String(mode)} must be add, subtract, replace or smooth`);
    if (!center || center.length !== 3 || !center.every(Number.isFinite))
      throw new RangeError('Brush center must be three finite numbers');
    if (!(radius > 0 && radius < Infinity)) throw new RangeError('Brush radius must be finite and above 0');
    if (!(strength >= 0 && strength <= 1)) throw new RangeError('Brush strength must be from 0 to 1');
    if (!(value >= 0 && value <= 1)) throw new RangeError('Brush value must be from 0 to 1');
    if (!['smooth', 'linear', 'constant'].includes(falloff))
      throw new RangeError('Brush falloff must be smooth, linear or constant');
    const bone = stroke.bone ?? -1;
    if (mode !== 'smooth' && !(Number.isInteger(bone) && bone >= 0 && bone < b))
      throw new RangeError(`Brush bone ${stroke.bone} must be one of the ${b} bones`);
    const lock = lockMask(b, this.locked);
    if (mode !== 'smooth' && lock[bone]) throw new RangeError(`Bone ${bone} is locked; unlock it to paint it`);
    // Points under the brush and their brush strengths.
    const p = this.positions,
      touched: number[] = [],
      amounts: number[] = [];
    for (let i = 0; i < p.length / 3; i++) {
      const d = Math.hypot(p[i * 3] - center[0], p[i * 3 + 1] - center[1], p[i * 3 + 2] - center[2]) / radius;
      if (d >= 1) continue;
      const f = falloff === 'constant' ? 1 : falloff === 'linear' ? 1 - d : 1 - d * d * (3 - 2 * d);
      if (f * strength > 0) touched.push(i), amounts.push(f * strength);
    }
    const values = this.weights.values,
      rows = new Float32Array(touched.length * b),
      row = (i: number) => this.members[this.memberOffsets[i]] * b;
    touched.forEach((i, k) => rows.set(values.subarray(row(i), row(i) + b), k * b));
    const next = new Float32Array(rows);
    touched.forEach((i, k) => {
      const o = k * b,
        s = amounts[k];
      if (mode === 'smooth') {
        // Toward the neighbours' mean (read from the weights before this stroke).
        const start = this.offsets[i],
          end = this.offsets[i + 1];
        if (end === start) return;
        for (let bone = 0; bone < b; bone++) {
          if (lock[bone]) continue;
          let mean = 0;
          for (let n = start; n < end; n++) mean += values[row(this.columns[n]) + bone];
          mean /= end - start;
          next[o + bone] += (mean - next[o + bone]) * s;
        }
        normalizeRow(next, o, b, lock);
        return;
      }
      const old = next[o + bone];
      let target = mode === 'add' ? old + s : mode === 'subtract' ? old - s : old + (value - old) * s;
      let fixed = 0,
        others = 0;
      for (let k2 = 0; k2 < b; k2++)
        if (k2 !== bone) {
          if (lock[k2]) fixed += next[o + k2];
          else others += next[o + k2];
        }
      target = Math.min(Math.max(target, 0), Math.max(0, 1 - fixed));
      const rest = Math.max(0, 1 - fixed - target);
      if (others > 0) {
        for (let k2 = 0; k2 < b; k2++) if (k2 !== bone && !lock[k2]) next[o + k2] *= rest / others;
      } else if (rest > 0) {
        const parent = this.parents?.[bone] ?? -1;
        if (parent >= 0 && parent !== bone && !lock[parent]) next[o + parent] = rest;
        else target = Math.max(0, 1 - fixed); // nothing can take the weight: the bone keeps it
      }
      next[o + bone] = target;
    });
    // Write every input vertex of each touched point.
    const changed: number[] = [];
    touched.forEach((i, k) => {
      for (let m = this.memberOffsets[i]; m < this.memberOffsets[i + 1]; m++) {
        const v = this.members[m];
        values.set(next.subarray(k * b, k * b + b), v * b);
        changed.push(v);
      }
    });
    const vertices = Uint32Array.from(changed),
      before = new Float32Array(vertices.length * b);
    let at = 0;
    touched.forEach((i, k) => {
      for (let m = this.memberOffsets[i]; m < this.memberOffsets[i + 1]; m++)
        before.set(rows.subarray(k * b, k * b + b), at++ * b);
    });
    return {
      vertices,
      undo: () => {
        vertices.forEach((v, k) => values.set(before.subarray(k * b, k * b + b), v * b));
      },
    };
  }

  /**
   * Smooths every unlocked weight over the whole mesh `iterations` times (default 1), each pass moving a vertex
   * `strength` (default 0.5) of the way to its neighbours' mean, then renormalising. Returns the undo record.
   */
  smoothAll({ iterations = 1, strength = 0.5 }: { iterations?: number; strength?: number } = {}): WeightEdit {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000)
      throw new RangeError('Smooth iterations must be an integer from 1 to 1,000');
    if (!(strength >= 0 && strength <= 1)) throw new RangeError('Smooth strength must be from 0 to 1');
    const b = this.weights.boneCount,
      values = this.weights.values,
      before = values.slice(),
      lock = lockMask(b, this.locked),
      m = this.positions.length / 3,
      row = (i: number) => this.members[this.memberOffsets[i]] * b,
      next = new Float32Array(m * b);
    for (let pass = 0; pass < iterations; pass++) {
      for (let i = 0; i < m; i++) {
        const o = i * b,
          start = this.offsets[i],
          end = this.offsets[i + 1];
        next.set(values.subarray(row(i), row(i) + b), o);
        if (end === start) continue;
        for (let bone = 0; bone < b; bone++) {
          if (lock[bone]) continue;
          let mean = 0;
          for (let n = start; n < end; n++) mean += values[row(this.columns[n]) + bone];
          next[o + bone] += (mean / (end - start) - next[o + bone]) * strength;
        }
        normalizeRow(next, o, b, lock);
      }
      for (let i = 0; i < m; i++)
        for (let k = this.memberOffsets[i]; k < this.memberOffsets[i + 1]; k++)
          values.set(next.subarray(i * b, i * b + b), this.members[k] * b);
    }
    const vertices = Uint32Array.from({ length: this.weights.vertexCount }, (_, v) => v);
    return { vertices, undo: () => values.set(before) };
  }

  /** Normalises every vertex (see {@link WeightMap.normalize}, with this painter's locked bones). */
  normalize(): this {
    this.weights.normalize({ locked: this.locked });
    return this;
  }

  /** Index of the welded point an input vertex belongs to (vertices sharing it are painted together). */
  pointOf(vertex: number): number {
    return this.point[vertex];
  }
}
