// Many transforms in one call: the same store writes as `mesh.position.set` and `mesh.setQuaternion`, with the mesh checks,
// the validation and the column lookups done once per call instead of once per value.
import type { Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { hypot } from '../../shared/hypot.js';

/** Nearest float64 that rounds to float32 infinity: what `mesh.position.set` compares with. */
const OVERFLOW = 3.4028235677973366e38;
/** Below this a value rounds to float32 zero: what `mesh.scale.set` compares with. */
const UNDERFLOW = 7.006492321624085e-46;
type Numbers = ArrayLike<number>;

/** What {@link TransformWriter.write} writes. Every field is optional; row `i` belongs to mesh `i`. */
export interface TransformRows {
  /** `x, y, z` per mesh, world units relative to the parent. */
  positions?: Numbers;
  /** `x, y, z, w` per mesh, any non-zero length. Give this or `rotations`, not both. */
  quaternions?: Numbers;
  /** Euler XYZ `x, y, z` per mesh, in radians. Give this or `quaternions`, not both. */
  rotations?: Numbers;
  /** `x, y, z` per mesh, each non-zero. */
  scales?: Numbers;
}

/** Range of {@link TransformWriter.write}, in rows of the writer's list. */
export interface TransformRange {
  /** First row to write. Default 0. */
  from?: number;
  /** Rows to write. Default the rest of the list. Each array then holds that many rows, row 0 for mesh `from`. */
  count?: number;
}

/**
 * Writes the transforms of a fixed list of meshes from typed arrays, for scenes where thousands of meshes move every
 * frame. The result is what the setters give, `mesh.rotation` included, and the next frame draws it. All or nothing: a
 * bad value or a disposed mesh throws before anything changes.
 */
export class TransformWriter {
  private readonly meshes: readonly Mesh[];
  private readonly ids: Int32Array;
  private readonly engine: ReturnType<typeof meshRuntime>['engine'];
  constructor(meshes: readonly Mesh[]) {
    if (!Array.isArray(meshes) || !meshes.length) throw typeError('TransformWriter: a list of meshes', 'arguments');
    this.meshes = [...meshes];
    this.ids = new Int32Array(meshes.length);
    const first = meshRuntime(meshes[0]).engine;
    meshes.forEach((mesh, i) => {
      mesh.check();
      const runtime = meshRuntime(mesh);
      if (runtime.engine !== first) throw typeError('TransformWriter: meshes of one engine', 'arguments');
      this.ids[i] = runtime.id;
    });
    this.engine = first;
  }
  /** Meshes in the list. */
  get length(): number {
    return this.ids.length;
  }
  /** Writes each given field for the rows of `range`, and returns this. */
  write({ positions, quaternions, rotations, scales }: TransformRows, { from = 0, count }: TransformRange = {}): this {
    const size = count ?? this.ids.length - from;
    if (!Number.isInteger(from) || !Number.isInteger(size) || from < 0 || size < 0 || from + size > this.ids.length)
      throw rangeError('TransformWriter: rows outside the list', 'transform');
    if (quaternions && rotations) throw typeError('TransformWriter: quaternions or rotations, not both', 'arguments');
    this.check(from, size);
    if (positions) rows(positions, 3, size, 'positions');
    if (rotations) rows(rotations, 3, size, 'rotations');
    if (scales) {
      rows(scales, 3, size, 'scales');
      for (let i = 0, end = size * 3; i < end; i++)
        if (!(scales[i] > UNDERFLOW || scales[i] < -UNDERFLOW)) throw rangeError('Invalid transform', 'transform');
    }
    if (quaternions) {
      rows(quaternions, 4, size, 'quaternions');
      for (let i = 0, end = size * 4; i < end; i += 4)
        if (!(quaternions[i] || quaternions[i + 1] || quaternions[i + 2] || quaternions[i + 3]))
          throw rangeError('Quaternion nonzero', 'transform');
    }
    const store = this.engine.store,
      t = store.transforms,
      ids = this.ids;
    if (positions) {
      const { x, y, z } = t;
      for (let i = 0, at = 0; i < size; i++, at += 3) {
        const id = ids[from + i];
        x[id] = positions[at];
        y[id] = positions[at + 1];
        z[id] = positions[at + 2];
      }
    }
    if (scales) {
      const { sx, sy, sz } = t;
      for (let i = 0, at = 0; i < size; i++, at += 3) {
        const id = ids[from + i];
        sx[id] = scales[at];
        sy[id] = scales[at + 1];
        sz[id] = scales[at + 2];
      }
    }
    if (rotations) {
      const lanes = store.rotations;
      for (let i = 0, at = 0; i < size; i++, at += 3) {
        const lane = ids[from + i] * 3;
        lanes[lane] = rotations[at];
        lanes[lane + 1] = rotations[at + 1];
        lanes[lane + 2] = rotations[at + 2];
        meshRuntime(this.meshes[from + i]).syncRotation();
      }
    }
    if (quaternions) {
      const { qx, qy, qz, qw } = t,
        lanes = store.rotations;
      for (let i = 0, at = 0; i < size; i++, at += 4) {
        const id = ids[from + i],
          a = quaternions[at],
          b = quaternions[at + 1],
          c = quaternions[at + 2],
          d = quaternions[at + 3],
          length = hypot(4, a, b, c, d),
          x = a / length,
          y = b / length,
          z = c / length,
          w = d / length,
          lane = id * 3,
          sinPitch = 2 * (x * z + w * y);
        qx[id] = x;
        qy[id] = y;
        qz[id] = z;
        qw[id] = w;
        // The Euler lanes `mesh.rotation` reads and joint limits clamp, by the formula of `setQuaternion`.
        lanes[lane + 1] = Math.asin(sinPitch > 1 ? 1 : sinPitch < -1 ? -1 : sinPitch);
        lanes[lane] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
        lanes[lane + 2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
      }
    }
    return this;
  }
  /** Every mesh of the rows still lives: a slot freed and reused by another mesh must not be written. */
  private check(from: number, size: number): void {
    const { disposed, meshes } = this.engine;
    if (disposed) throw fault('disposed', 'Engine disposed');
    for (let i = from, end = from + size; i < end; i++)
      if (meshes.get(this.ids[i]) !== (this.meshes[i] as unknown))
        throw fault('disposed', `Mesh disposed: row ${i}; make a new TransformWriter`);
  }
}

/** The array holds `size` rows of `width` values, each finite as float32. */
function rows(values: Numbers, width: number, size: number, name: string): void {
  const end = size * width;
  if (values?.length === undefined || values.length < end)
    throw rangeError(`TransformWriter: ${name} needs ${end} values`, 'transform');
  for (let i = 0; i < end; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !(value < OVERFLOW && value > -OVERFLOW))
      throw rangeError('Invalid transform', 'transform');
  }
}
