import { Vector3 } from './vector3.js';
import { Matrix3 } from './matrix3.js';
import type { BoxLike, MatrixLike, PlaneLike, SphereLike, Vec3Like } from './types.js';

// Rotation columns may drift this far from unit length or from perpendicular (float rounding of composed rotations).
const ORTHONORMAL_TOLERANCE = 1e-6;

const finite = (v: Vec3Like, name: string): void => {
  if (!v || typeof v !== 'object') throw new TypeError(`${name} must be an {x, y, z} object, such as a Vector3`);
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z))
    throw new RangeError(`${name} (${v.x}, ${v.y}, ${v.z}) must hold finite numbers; replace NaN or Infinity`);
};
const elements = (m: MatrixLike, size: number, name: string): ArrayLike<number> => {
  const e = m?.elements;
  if (!e || e.length !== size)
    throw new TypeError(`${name} must have ${size} column-major elements, such as a Matrix${size === 9 ? 3 : 4}`);
  for (let i = 0; i < size; i++)
    if (!Number.isFinite(e[i])) throw new RangeError(`${name} element ${i} is ${e[i]}; pass finite numbers`);
  return e;
};
// Throws unless the three columns are unit length and perpendicular.
const orthonormal = (e: ArrayLike<number>, name: string): void => {
  for (let i = 0; i < 3; i++)
    for (let j = i; j < 3; j++) {
      const dot = e[3 * i] * e[3 * j] + e[3 * i + 1] * e[3 * j + 1] + e[3 * i + 2] * e[3 * j + 2];
      if (Math.abs(dot - (i === j ? 1 : 0)) > ORTHONORMAL_TOLERANCE)
        throw new RangeError(
          `${name} must be a pure rotation (unit, perpendicular columns); build it with Matrix3.setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q))`,
        );
    }
};

// Scratch for intersectsOBB (R and |R| + epsilon, row i = axis i of this box, column j = axis j of the other).
const r = new Float64Array(9),
  ar = new Float64Array(9),
  ta = new Float64Array(3),
  local = new Float64Array(6);

/**
 * Oriented bounding box: a box of `halfSize` extents along the columns of `rotation`, centred on `center`.
 * `rotation` is a pure rotation (orthonormal columns); `halfSize` is >= 0 on each axis. Boundaries count as inside,
 * so touching boxes intersect. Methods that take an `out` write into it and return it.
 * @throws TypeError or RangeError from the constructor, `set`, `fromBox3` and `applyMatrix4` for invalid inputs.
 */
export class OBB {
  constructor(
    public center = new Vector3(),
    public halfSize = new Vector3(),
    public rotation = new Matrix3(),
  ) {
    this.set(center, halfSize, rotation);
  }

  /** Copies the values in. @throws RangeError for non-finite values, a negative half size or a non-rotation matrix. */
  set(center: Vec3Like, halfSize: Vec3Like, rotation: MatrixLike): this {
    finite(center, 'OBB center');
    finite(halfSize, 'OBB halfSize');
    if (halfSize.x < 0 || halfSize.y < 0 || halfSize.z < 0)
      throw new RangeError(
        `OBB halfSize (${halfSize.x}, ${halfSize.y}, ${halfSize.z}) must be >= 0 on each axis; pass half the box size`,
      );
    const e = elements(rotation, 9, 'OBB rotation');
    orthonormal(e, 'OBB rotation');
    this.center.copy(center);
    this.halfSize.copy(halfSize);
    if (this.rotation !== rotation) this.rotation.fromArray(e);
    return this;
  }
  copy(obb: OBB): this {
    return this.set(obb.center, obb.halfSize, obb.rotation);
  }
  clone(): OBB {
    return new OBB().copy(this);
  }
  /** The same space as an axis-aligned box (identity rotation). @throws RangeError for an empty or infinite box. */
  fromBox3(box: BoxLike): this {
    const { min, max } = box;
    if (max.x < min.x || max.y < min.y || max.z < min.z)
      throw new RangeError('OBB.fromBox3 box is empty (a min above its max); expand it with points before converting');
    finite(min, 'OBB.fromBox3 box min');
    finite(max, 'OBB.fromBox3 box max');
    this.center.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    this.halfSize.set((max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2);
    this.rotation.identity();
    return this;
  }
  /**
   * Moves the box by an affine matrix: rotation, translation, mirroring, and scale along the box's own axes (folded
   * into `halfSize`). @throws RangeError for a projective matrix, a zero scale axis, or a scale that would shear the
   * box (uneven scale across its rotated axes, which no OBB can hold).
   */
  applyMatrix4(m: MatrixLike): this {
    const e = elements(m, 16, 'OBB.applyMatrix4 matrix');
    if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1)
      throw new RangeError(
        'OBB.applyMatrix4 needs an affine matrix (bottom row 0, 0, 0, 1); a projection cannot move a box',
      );
    const re = this.rotation.elements,
      h = this.halfSize,
      out = [0, 0, 0, 0, 0, 0, 0, 0, 0],
      scale = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const x = re[3 * k],
        y = re[3 * k + 1],
        z = re[3 * k + 2];
      const ax = e[0] * x + e[4] * y + e[8] * z,
        ay = e[1] * x + e[5] * y + e[9] * z,
        az = e[2] * x + e[6] * y + e[10] * z,
        length = Math.hypot(ax, ay, az);
      if (!(length > 0))
        throw new RangeError('OBB.applyMatrix4 matrix scales a box axis to zero; pass a matrix with non-zero scale');
      out[3 * k] = ax / length;
      out[3 * k + 1] = ay / length;
      out[3 * k + 2] = az / length;
      scale[k] = length;
    }
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        if (
          Math.abs(out[3 * i] * out[3 * j] + out[3 * i + 1] * out[3 * j + 1] + out[3 * i + 2] * out[3 * j + 2]) >
          ORTHONORMAL_TOLERANCE
        )
          throw new RangeError(
            'OBB.applyMatrix4 matrix would shear the box (uneven scale across its rotated axes); scale before rotating, or rebuild it with fromBox3 in the scaled space',
          );
    // A mirror leaves the box the same set of points; flip one axis to keep a proper rotation.
    const cx = out[1] * out[5] - out[2] * out[4],
      cy = out[2] * out[3] - out[0] * out[5],
      cz = out[0] * out[4] - out[1] * out[3];
    if (cx * out[6] + cy * out[7] + cz * out[8] < 0) for (let i = 6; i < 9; i++) out[i] = -out[i];
    this.rotation.fromArray(out);
    h.set(h.x * scale[0], h.y * scale[1], h.z * scale[2]);
    this.center.applyMatrix4(m);
    return this;
  }

  // Writes p - center in box coordinates into `local` at `offset`.
  private toLocal(p: Vec3Like, offset: number, isDirection = false): void {
    const e = this.rotation.elements,
      c = this.center,
      x = isDirection ? p.x : p.x - c.x,
      y = isDirection ? p.y : p.y - c.y,
      z = isDirection ? p.z : p.z - c.z;
    for (let k = 0; k < 3; k++) local[offset + k] = e[3 * k] * x + e[3 * k + 1] * y + e[3 * k + 2] * z;
  }
  containsPoint(p: Vec3Like): boolean {
    this.toLocal(p, 0);
    const h = this.halfSize;
    return Math.abs(local[0]) <= h.x && Math.abs(local[1]) <= h.y && Math.abs(local[2]) <= h.z;
  }
  /** The point of the box closest to `p` (`p` itself when inside). */
  clampPoint<T extends Vec3Like>(p: Vec3Like, out: T): T {
    this.toLocal(p, 0);
    const e = this.rotation.elements,
      h = this.halfSize,
      c = this.center;
    const u = Math.max(-h.x, Math.min(h.x, local[0])),
      v = Math.max(-h.y, Math.min(h.y, local[1])),
      w = Math.max(-h.z, Math.min(h.z, local[2]));
    out.x = c.x + e[0] * u + e[3] * v + e[6] * w;
    out.y = c.y + e[1] * u + e[4] * v + e[7] * w;
    out.z = c.z + e[2] * u + e[5] * v + e[8] * w;
    return out;
  }
  /** 0 inside the box, else the distance to its surface. */
  distanceToPoint(p: Vec3Like): number {
    this.toLocal(p, 0);
    const h = this.halfSize,
      dx = Math.max(Math.abs(local[0]) - h.x, 0),
      dy = Math.max(Math.abs(local[1]) - h.y, 0),
      dz = Math.max(Math.abs(local[2]) - h.z, 0);
    return Math.hypot(dx, dy, dz);
  }

  /** False for an empty box. */
  intersectsBox3(box: BoxLike, epsilon = 1e-6): boolean {
    const { min, max } = box;
    if (max.x < min.x || max.y < min.y || max.z < min.z) return false;
    return this.intersectsOBB(scratch.fromBox3(box), epsilon);
  }
  /** False for an empty sphere (negative radius). */
  intersectsSphere(sphere: SphereLike): boolean {
    return sphere.radius >= 0 && this.distanceToPoint(sphere.center) <= sphere.radius;
  }
  /**
   * Separating-axis test over the 15 candidate axes (3 face normals of each box and the 9 edge cross products), in the
   * reduced form of Gottschalk, Lin and Manocha, "OBBTree", SIGGRAPH 1996, section 4 (B placed in A's frame by R, T).
   * `epsilon` pads the axis cosines so near-parallel edges, whose cross product is almost zero, cannot report a false
   * separation. @throws RangeError for a negative or non-finite `epsilon`.
   */
  intersectsOBB(obb: OBB, epsilon = 1e-6): boolean {
    if (!(epsilon >= 0 && epsilon < Infinity))
      throw new RangeError(`OBB.intersectsOBB epsilon ${epsilon} is invalid; pass a finite number >= 0, e.g. 1e-6`);
    const a = this.rotation.elements,
      b = obb.rotation.elements,
      ha = this.halfSize,
      hb = obb.halfSize,
      ea = [ha.x, ha.y, ha.z],
      eb = [hb.x, hb.y, hb.z];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const dot = a[3 * i] * b[3 * j] + a[3 * i + 1] * b[3 * j + 1] + a[3 * i + 2] * b[3 * j + 2];
        r[3 * i + j] = dot;
        ar[3 * i + j] = Math.abs(dot) + epsilon;
      }
    this.toLocal(obb.center, 0);
    ta.set(local.subarray(0, 3));
    // Face normals of this box, then of the other box.
    for (let i = 0; i < 3; i++)
      if (Math.abs(ta[i]) > ea[i] + eb[0] * ar[3 * i] + eb[1] * ar[3 * i + 1] + eb[2] * ar[3 * i + 2]) return false;
    for (let j = 0; j < 3; j++)
      if (
        Math.abs(ta[0] * r[j] + ta[1] * r[3 + j] + ta[2] * r[6 + j]) >
        ea[0] * ar[j] + ea[1] * ar[3 + j] + ea[2] * ar[6 + j] + eb[j]
      )
        return false;
    // Edge pairs: axis i of this box crossed with axis j of the other, in this box's coordinates.
    for (let i = 0; i < 3; i++) {
      const i1 = (i + 1) % 3,
        i2 = (i + 2) % 3;
      for (let j = 0; j < 3; j++) {
        const j1 = (j + 1) % 3,
          j2 = (j + 2) % 3;
        const radius =
          ea[i1] * ar[3 * i2 + j] + ea[i2] * ar[3 * i1 + j] + eb[j1] * ar[3 * i + j2] + eb[j2] * ar[3 * i + j1];
        if (Math.abs(ta[i2] * r[3 * i1 + j] - ta[i1] * r[3 * i2 + j]) > radius) return false;
      }
    }
    return true;
  }
  /** True when the plane passes through or touches the box. */
  intersectsPlane(plane: PlaneLike): boolean {
    const n = plane.normal,
      e = this.rotation.elements,
      h = this.halfSize,
      c = this.center;
    const radius =
      h.x * Math.abs(n.x * e[0] + n.y * e[1] + n.z * e[2]) +
      h.y * Math.abs(n.x * e[3] + n.y * e[4] + n.z * e[5]) +
      h.z * Math.abs(n.x * e[6] + n.y * e[7] + n.z * e[8]);
    return Math.abs(n.x * c.x + n.y * c.y + n.z * c.z + plane.constant) <= radius;
  }
  /**
   * Slab test in the box's own frame. Returns the nearest entry point, or the ray origin when it starts inside (as
   * `Ray.intersectBox` does); null when the ray misses, runs parallel outside a slab, or points away.
   */
  intersectRay<T extends Vec3Like>(ray: { origin: Vec3Like; direction: Vec3Like }, out: T): T | null {
    const t = this.distanceToRay(ray);
    if (t === null) return null;
    const o = ray.origin,
      d = ray.direction;
    out.x = o.x + d.x * t;
    out.y = o.y + d.y * t;
    out.z = o.z + d.z * t;
    return out;
  }
  intersectsRay(ray: { origin: Vec3Like; direction: Vec3Like }): boolean {
    return this.distanceToRay(ray) !== null;
  }
  private distanceToRay(ray: { origin: Vec3Like; direction: Vec3Like }): number | null {
    this.toLocal(ray.origin, 0);
    this.toLocal(ray.direction, 3, true);
    const h = this.halfSize,
      // As Ray.intersectBox: decide on the box grown by 8 epsilons of its farthest corner, return the exact entry.
      reach = Math.hypot(
        Math.abs(local[0]) + Math.abs(h.x),
        Math.abs(local[1]) + Math.abs(h.y),
        Math.abs(local[2]) + Math.abs(h.z),
      ),
      pad = reach < Infinity ? 8 * Number.EPSILON * reach : 0;
    let near = -Infinity,
      far = Infinity,
      entry = -Infinity;
    for (let k = 0; k < 3; k++) {
      const origin = local[k],
        direction = local[3 + k],
        extent = k === 0 ? h.x : k === 1 ? h.y : h.z,
        slack = pad / Math.abs(direction);
      if (direction === 0) {
        if (origin < -extent || origin > extent) return null;
        continue;
      }
      let t0 = (-extent - origin) / direction,
        t1 = (extent - origin) / direction;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > entry) entry = t0;
      if (t0 - slack > near) near = t0 - slack;
      if (t1 + slack < far) far = t1 + slack;
      if (near > far) return null;
    }
    return far < 0 ? null : Math.max(entry, 0);
  }
  equals(obb: OBB, epsilon = 0): boolean {
    return (
      this.center.equals(obb.center, epsilon) &&
      this.halfSize.equals(obb.halfSize, epsilon) &&
      this.rotation.equals(obb.rotation, epsilon)
    );
  }
}

const scratch = /* @__PURE__ */ new OBB();
