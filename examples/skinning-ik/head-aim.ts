import type { Mesh, Vec3 } from '@margoengine/core/extension';

type Point = [number, number, number];
type Rotation = [number, number, number, number];

export interface HeadClearance {
  /** Conservative head-local bounds, including the authored neck/collar. */
  min: Vec3;
  max: Vec3;
  targetRadius: number;
  margin?: number;
  /** Optional chest-top plane in captured-rest head coordinates. */
  chestFloor?: number;
  /** Lower neck seat is bonded; only cowling above this local Y uses the plane. */
  cowlingMinY?: number;
  /** Exact convex-hull vertices can replace the conservative cowling box. */
  chestPoints?: ArrayLike<number>;
  /** Additional posed-joint clearance in authored units, without changing the scene. */
  rotationClearance?: (rotation: readonly number[], out: Float64Array) => void;
  /**
   * Explicit demo-owned commit for this controller's reused normal-array rotations.
   * Must synchronously validate and write the head quaternion and Euler state;
   * must not mutate the rotation. Omit to call the current public Mesh setter.
   */
  writeRotation?: (rotation: readonly number[]) => void;
}

function point(value: Vec3, out?: Point): void {
  if (!value || value.length !== 3) throw new RangeError('Head aim requires a finite scene point');
  const x = value[0],
    y = value[1],
    z = value[2];
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(Math.fround(x)) ||
    !Number.isFinite(Math.fround(y)) ||
    !Number.isFinite(Math.fround(z))
  )
    throw new RangeError('Head aim requires a finite scene point');
  if (out) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
  }
}

/** Absolute optical aiming for the demo's rigid, parallel binocular lenses. */
export class HeadAim {
  readonly head: Mesh;
  readonly maxAngle: number;
  readonly origin: Point = [0, 0, 0];
  readonly forward: Point = [0, 0, -1];
  limited = false;
  /** Angular difference between the presented optical ray and target, radians. */
  rayError = 0;
  /** Target distance from the presented forward optical ray, scene units. */
  rayDistance = 0;
  /** Applied rotation away from the captured authored rest orientation. */
  angle = 0;
  /** Sphere clearance from the configured head proxy, after its margin. */
  headClearance = Infinity;
  clearanceResolved = true;

  private readonly optical: Point;
  private readonly rest: Rotation;
  private readonly target: Point = [0, 0, 0];
  private readonly output: Rotation = [0, 0, 0, 1];
  private readonly previous: Rotation = [NaN, NaN, NaN, NaN];
  private readonly committed: Rotation = [NaN, NaN, NaN, NaN];
  private readonly committedEuler: [number, number, number] = [NaN, NaN, NaN];
  private rx = 0;
  private ry = 0;
  private rz = 0;
  private rw = 1;
  private scale = 1;
  private readonly minimum?: Point;
  private readonly maximum?: Point;
  private readonly radius: number;
  private readonly chestFloor?: number;
  private readonly cowlingMinY: number;
  private readonly chestPoints?: Float64Array;
  private readonly rotationClearance?: HeadClearance['rotationClearance'];
  private readonly writeRotation?: HeadClearance['writeRotation'];
  private readonly clearanceRotation: Rotation = [0, 0, 0, 1];
  private readonly rotationDistance = new Float64Array(1);
  // Private handoffs: candidate angle, three scalar inputs, and scalar result.
  private readonly clearanceScratch = new Float64Array(5);
  private px = 0;
  private py = 0;
  private pz = 0;
  private ax = 0;
  private ay = 0;
  private az = 0;
  private readonly norm = new Float64Array(4);
  private aimCached = false;
  private readonly cachedMatrix = new Float32Array(16);
  // Target, exact normalized rest frame and presented local quaternion. Matrix
  // values alone would miss a double-precision rest-frame change rounded by Float32.
  private readonly cachedInput = new Float64Array(16);
  private readonly cachedDiagnostics = new Float64Array(12);

  private length3Into(): void {
    const result = this.norm;
    let x = result[0],
      y = result[1],
      z = result[2];
    const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (!scale) {
      result[3] = 0;
      return;
    }
    x /= scale;
    y /= scale;
    z /= scale;
    result[3] = scale * Math.sqrt(x * x + y * y + z * z);
  }

  constructor(head: Mesh, opticalLocal: Vec3, maxAngle = 1.3, clearance?: HeadClearance) {
    head.check();
    point(opticalLocal);
    if (!Number.isFinite(maxAngle) || maxAngle < 0 || maxAngle > Math.PI) {
      throw new RangeError('Head travel must be between zero and PI radians');
    }
    this.head = head;
    this.maxAngle = maxAngle;
    this.radius = 0;
    this.cowlingMinY = 0;
    if (clearance) {
      const writer = clearance.writeRotation;
      if (writer !== undefined && typeof writer !== 'function') throw new RangeError('Invalid head rotation writer');
      this.writeRotation = writer;
      if (clearance.rotationClearance !== undefined && typeof clearance.rotationClearance !== 'function')
        throw new RangeError('Invalid head joint clearance callback');
      this.rotationClearance = clearance.rotationClearance;
      point(clearance.min);
      point(clearance.max);
      const margin = clearance.margin ?? 0;
      if (
        !Number.isFinite(clearance.targetRadius) ||
        clearance.targetRadius < 0 ||
        !Number.isFinite(margin) ||
        margin < 0 ||
        !Number.isFinite(clearance.targetRadius + margin) ||
        clearance.min[0] > clearance.max[0] ||
        clearance.min[1] > clearance.max[1] ||
        clearance.min[2] > clearance.max[2]
      ) {
        throw new RangeError('Invalid head clearance proxy');
      }
      this.minimum = [...clearance.min];
      this.maximum = [...clearance.max];
      this.radius = clearance.targetRadius + margin;
      if (clearance.chestFloor !== undefined) {
        const minY = clearance.cowlingMinY ?? clearance.min[1];
        if (
          !Number.isFinite(clearance.chestFloor) ||
          !Number.isFinite(Math.fround(clearance.chestFloor)) ||
          !Number.isFinite(minY) ||
          minY < clearance.min[1] ||
          minY > clearance.max[1]
        )
          throw new RangeError('Invalid head chest clearance plane');
        this.chestFloor = clearance.chestFloor;
        this.cowlingMinY = minY;
        if (clearance.chestPoints) {
          const source = clearance.chestPoints;
          if (!Number.isInteger(source.length) || !source.length || source.length % 3 || source.length > 30000) {
            throw new RangeError('Invalid head cowling hull');
          }
          for (let i = 0; i < source.length; i++)
            if (!Number.isFinite(source[i]) || !Number.isFinite(Math.fround(source[i]))) {
              throw new RangeError('Invalid head cowling hull');
            }
          this.chestPoints = new Float64Array(source);
        }
      }
    }
    this.optical = [opticalLocal[0], opticalLocal[1], opticalLocal[2]];
    const t = head.engine.store.transforms,
      id = head.id;
    this.rest = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    this.restFrame();
    this.diagnostics();
  }

  // Compose current parent orientation with captured local rest, independent of
  // the last aimed head rotation. Validate the same positive uniform hierarchy
  // supported by the arm adapter before changing the head.
  private restFrame(): void {
    this.head.check();
    const store = this.head.engine.store,
      t = store.transforms;
    let x = this.rest[0],
      y = this.rest[1],
      z = this.rest[2],
      w = this.rest[3],
      scale = 1;
    let steps = 0;
    for (let id = this.head.id; id !== -1; id = store.parents[id]) {
      if (++steps > store.capacity) throw new RangeError('Invalid head hierarchy');
      const sx = t.sx[id],
        sy = t.sy[id],
        sz = t.sz[id];
      const tolerance = Math.max(sx, sy, sz) * 1e-5;
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        !Number.isFinite(sz) ||
        sx <= 0 ||
        sy <= 0 ||
        sz <= 0 ||
        Math.abs(sx - sy) > tolerance ||
        Math.abs(sx - sz) > tolerance
      ) {
        throw new RangeError('Head aim requires positive uniform ancestor scales');
      }
      scale *= sx;
      const ax = id === this.head.id ? this.rest[0] : t.qx[id];
      const ay = id === this.head.id ? this.rest[1] : t.qy[id];
      const az = id === this.head.id ? this.rest[2] : t.qz[id];
      const aw = id === this.head.id ? this.rest[3] : t.qw[id];
      const norm = Math.sqrt(ax * ax + ay * ay + az * az + aw * aw);
      if (!Number.isFinite(norm) || norm === 0) throw new RangeError('Invalid head ancestor rotation');
      if (id !== this.head.id) {
        const nx = aw * x + ax * w + ay * z - az * y;
        const ny = aw * y - ax * z + ay * w + az * x;
        const nz = aw * z + ax * y - ay * x + az * w;
        w = aw * w - ax * x - ay * y - az * z;
        x = nx;
        y = ny;
        z = nz;
      }
    }
    const norm = Math.sqrt(x * x + y * y + z * z + w * w);
    if (!Number.isFinite(norm) || !norm || !Number.isFinite(Math.fround(scale)) || Math.fround(scale) <= 0) {
      throw new RangeError('Head rest frame exceeds scene precision');
    }
    this.rx = x / norm;
    this.ry = y / norm;
    this.rz = z / norm;
    this.rw = w / norm;
    this.scale = scale;
    store.tick(false);
    const m = this.head.matrix;
    for (let i = 0; i < 16; i++) {
      if (!Number.isFinite(m[i])) throw new RangeError('Head world frame exceeds scene precision');
    }
    const directionNorm = this.norm;
    directionNorm[0] = m[8];
    directionNorm[1] = m[9];
    directionNorm[2] = m[10];
    this.length3Into();
    if (!directionNorm[3]) throw new RangeError('Head world frame exceeds scene precision');
  }

  /** Aim the central optical ray; clamped/inside-orbit targets remain bounded. */
  update(target: Vec3): this {
    point(target, this.target);
    target = this.target;
    this.restFrame();
    if (this.useAimCache()) return this;
    const m = this.head.matrix;
    const dx = target[0] - m[12],
      dy = target[1] - m[13],
      dz = target[2] - m[14];
    // Inverse rest rotation, followed by uniform world-scale removal.
    const tx = 2 * (-this.ry * dz + this.rz * dy);
    const ty = 2 * (-this.rz * dx + this.rx * dz);
    const tz = 2 * (-this.rx * dy + this.ry * dx);
    let vx = (dx + this.rw * tx - this.ry * tz + this.rz * ty) / this.scale;
    let vy = (dy + this.rw * ty - this.rz * tx + this.rx * tz) / this.scale;
    let vz = (dz + this.rw * tz - this.rx * ty + this.ry * tx) / this.scale;
    this.px = vx;
    this.py = vy;
    this.pz = vz;
    const norm = this.norm;
    norm[0] = vx;
    norm[1] = vy;
    norm[2] = vz;
    this.length3Into();
    const distance = norm[3],
      ox = this.optical[0],
      oy = this.optical[1],
      oz = this.optical[2];
    // f=(0,0,-1), a=o.f=-oz. Solve |o+lambda*f|=|v| for the
    // nonnegative optical-ray distance; offset geometry rotates with the head.
    const discriminant = distance * distance - ox * ox - oy * oy;
    const lambda = discriminant >= 0 ? oz + Math.sqrt(discriminant) : -1;
    let limited = lambda < 0,
      wx = ox,
      wy = oy,
      wz = oz - Math.max(0, lambda);
    // Inside the optical orbit the nearest point on a freely rotated forward
    // ray is its origin. Aim that optical offset toward the target, then apply
    // the same neck bound. The remaining error is explicit in diagnostics.
    norm[0] = wx;
    norm[1] = wy;
    norm[2] = wz;
    this.length3Into();
    const wl = norm[3];
    let qx = 0,
      qy = 0,
      qz = 0,
      qw = 1;
    if (distance > 0 && wl > 0) {
      wx /= wl;
      wy /= wl;
      wz /= wl;
      vx /= distance;
      vy /= distance;
      vz /= distance;
      qx = wy * vz - wz * vy;
      qy = wz * vx - wx * vz;
      qz = wx * vy - wy * vx;
      norm[0] = qx;
      norm[1] = qy;
      norm[2] = qz;
      this.length3Into();
      let axisLength = norm[3];
      const dot = Math.max(-1, Math.min(1, wx * vx + wy * vy + wz * vz));
      const angle = Math.atan2(axisLength, dot);
      if (axisLength === 0 && dot < 0) {
        // Exact opposition has no unique shortest axis; choose one in rest
        // coordinates so repeated probe updates cannot depend on history.
        if (Math.abs(wx) > Math.abs(wz)) {
          qx = -wy;
          qy = wx;
          qz = 0;
        } else {
          qx = 0;
          qy = -wz;
          qz = wy;
        }
        norm[0] = qx;
        norm[1] = qy;
        norm[2] = qz;
        this.length3Into();
        axisLength = norm[3];
      }
      if (angle > this.maxAngle) limited = true;
      this.angle = Math.min(angle, this.maxAngle);
      let appliedAngle = this.angle;
      this.ax = axisLength > 0 ? qx / axisLength : 0;
      this.ay = axisLength > 0 ? qy / axisLength : 0;
      this.az = axisLength > 0 ? qz / axisLength : 0;
      const scratch = this.clearanceScratch;
      let blocked = false;
      if (this.minimum) {
        scratch[0] = this.angle;
        this.clearanceAtInto();
        blocked = scratch[4] < 1e-5;
      }
      if (blocked) {
        limited = true;
        const desiredAngle = this.angle;
        scratch[0] = desiredAngle;
        this.clearanceAtInto();
        let bestAngle = desiredAngle,
          bestClearance = scratch[4],
          safe = false;
        // Search the absolute rest-to-gaze arc. A clear rest pose remains a
        // deterministic fallback; no previous-frame rotation enters the solve.
        for (let sample = 1; sample <= 32; sample++) {
          const candidate = desiredAngle * (1 - sample / 32);
          scratch[0] = candidate;
          this.clearanceAtInto();
          const clearance = scratch[4];
          if (clearance > bestClearance) {
            bestClearance = clearance;
            bestAngle = candidate;
          }
          if (clearance < 1e-5) continue;
          let low = candidate,
            high = desiredAngle * (1 - (sample - 1) / 32);
          for (let iteration = 0; iteration < 14; iteration++) {
            const middle = (low + high) / 2;
            scratch[0] = middle;
            this.clearanceAtInto();
            if (scratch[4] >= 1e-5) low = middle;
            else high = middle;
          }
          bestAngle = low;
          safe = true;
          break;
        }
        // If the rest pose is also obstructed, a bounded turn away from the
        // target may clear it. Check that same deterministic rotation plane.
        if (!safe && axisLength > 0)
          for (let sample = 1; sample <= 32; sample++) {
            const candidate = (-this.maxAngle * sample) / 32;
            scratch[0] = candidate;
            this.clearanceAtInto();
            const clearance = scratch[4];
            if (clearance > bestClearance) {
              bestClearance = clearance;
              bestAngle = candidate;
            }
            if (clearance < 1e-5) continue;
            let low = candidate,
              high = (-this.maxAngle * (sample - 1)) / 32;
            for (let iteration = 0; iteration < 14; iteration++) {
              const middle = (low + high) / 2;
              scratch[0] = middle;
              this.clearanceAtInto();
              if (scratch[4] >= 1e-5) low = middle;
              else high = middle;
            }
            bestAngle = low;
            safe = true;
            break;
          }
        appliedAngle = bestAngle;
        this.angle = Math.abs(appliedAngle);
        this.clearanceResolved = safe;
      } else this.clearanceResolved = true;
      const factor = axisLength > 0 ? Math.sin(appliedAngle * 0.5) / axisLength : 0;
      qx *= factor;
      qy *= factor;
      qz *= factor;
      qw = Math.cos(appliedAngle * 0.5);
    } else {
      limited = true;
      this.angle = 0;
      if (this.minimum) {
        this.clearanceScratch[0] = 0;
        this.clearanceAtInto();
        this.clearanceResolved = this.clearanceScratch[4] >= 0;
      } else this.clearanceResolved = true;
    }
    const r = this.rest,
      out = this.output;
    out[0] = r[3] * qx + r[0] * qw + r[1] * qz - r[2] * qy;
    out[1] = r[3] * qy - r[0] * qz + r[1] * qw + r[2] * qx;
    out[2] = r[3] * qz + r[0] * qy - r[1] * qx + r[2] * qw;
    out[3] = r[3] * qw - r[0] * qx - r[1] * qy - r[2] * qz;
    this.commit(out);
    this.limited = limited;
    this.diagnostics(target);
    this.rememberAim();
    return this;
  }

  private useAimCache(): boolean {
    // A joint guard can depend on arm transforms absent from the gaze key.
    if (!this.aimCached || this.rotationClearance) return false;
    const input = this.cachedInput,
      matrix = this.head.matrix,
      t = this.head.engine.store.transforms,
      euler = this.head.euler,
      id = this.head.id;
    for (let i = 0; i < 3; i++) if (!Object.is(input[i], this.target[i])) return false;
    if (
      !Object.is(input[3], this.rx) ||
      !Object.is(input[4], this.ry) ||
      !Object.is(input[5], this.rz) ||
      !Object.is(input[6], this.rw) ||
      !Object.is(input[7], this.scale) ||
      !Object.is(input[8], t.qx[id]) ||
      !Object.is(input[9], t.qy[id]) ||
      !Object.is(input[10], t.qz[id]) ||
      !Object.is(input[11], t.qw[id]) ||
      !Object.is(input[12], this.maxAngle) ||
      !Object.is(input[13], euler[0]) ||
      !Object.is(input[14], euler[1]) ||
      !Object.is(input[15], euler[2])
    )
      return false;
    for (let i = 0; i < 16; i++) if (!Object.is(this.cachedMatrix[i], matrix[i])) return false;
    const result = this.cachedDiagnostics;
    for (let i = 0; i < 3; i++) {
      this.origin[i] = result[i];
      this.forward[i] = result[3 + i];
    }
    this.rayError = result[6];
    this.rayDistance = result[7];
    this.angle = result[8];
    if (this.minimum) this.headClearance = result[9];
    this.limited = result[10] !== 0;
    this.clearanceResolved = result[11] !== 0;
    return true;
  }
  private rememberAim(): void {
    const input = this.cachedInput,
      t = this.head.engine.store.transforms,
      euler = this.head.euler,
      id = this.head.id;
    for (let i = 0; i < 3; i++) input[i] = this.target[i];
    input[3] = this.rx;
    input[4] = this.ry;
    input[5] = this.rz;
    input[6] = this.rw;
    input[7] = this.scale;
    input[8] = t.qx[id];
    input[9] = t.qy[id];
    input[10] = t.qz[id];
    input[11] = t.qw[id];
    input[12] = this.maxAngle;
    input[13] = euler[0];
    input[14] = euler[1];
    input[15] = euler[2];
    this.cachedMatrix.set(this.head.matrix);
    const result = this.cachedDiagnostics;
    for (let i = 0; i < 3; i++) {
      result[i] = this.origin[i];
      result[3 + i] = this.forward[i];
    }
    result[6] = this.rayError;
    result[7] = this.rayDistance;
    result[8] = this.angle;
    result[9] = this.headClearance;
    result[10] = +this.limited;
    result[11] = +this.clearanceResolved;
    this.aimCached = true;
  }

  private clearanceAtInto(): void {
    const scratch = this.clearanceScratch,
      angle = scratch[0],
      sine = Math.sin(angle / 2),
      w = Math.cos(angle / 2),
      x = this.ax * sine,
      y = this.ay * sine,
      z = this.az * sine;
    const tx = 2 * (-y * this.pz + z * this.py),
      ty = 2 * (-z * this.px + x * this.pz),
      tz = 2 * (-x * this.py + y * this.px);
    scratch[1] = this.px + w * tx - y * tz + z * ty;
    scratch[2] = this.py + w * ty - z * tx + x * tz;
    scratch[3] = this.pz + w * tz - x * ty + y * tx;
    this.proxyClearanceInto();
    let clearance = scratch[4];
    if (this.rotationClearance) {
      const r = this.rest,
        out = this.clearanceRotation;
      out[0] = r[3] * x + r[0] * w + r[1] * z - r[2] * y;
      out[1] = r[3] * y - r[0] * z + r[1] * w + r[2] * x;
      out[2] = r[3] * z + r[0] * y - r[1] * x + r[2] * w;
      out[3] = r[3] * w - r[0] * x - r[1] * y - r[2] * z;
      this.jointClearanceInto(out);
      clearance = Math.min(clearance, this.rotationDistance[0]);
    }
    if (this.chestFloor === undefined) {
      scratch[4] = clearance;
      return;
    }
    const rowX = 2 * (x * y + z * w),
      rowY = 1 - 2 * (x * x + z * z),
      rowZ = 2 * (y * z - x * w);
    scratch[1] = rowX;
    scratch[2] = rowY;
    scratch[3] = rowZ;
    this.floorClearanceInto();
    scratch[4] = Math.min(clearance, scratch[4]);
  }

  private jointClearanceInto(rotation: readonly number[]): void {
    const out = this.rotationDistance;
    out[0] = NaN;
    this.rotationClearance!(rotation, out);
    if (!Number.isFinite(out[0])) throw new RangeError('Head joint clearance must write a finite distance');
  }

  private floorClearanceInto(): void {
    const scratch = this.clearanceScratch,
      x = scratch[1],
      y = scratch[2],
      z = scratch[3];
    if (this.chestPoints) {
      let low = Infinity;
      const points = this.chestPoints;
      for (let i = 0; i < points.length; i += 3)
        low = Math.min(low, x * points[i] + y * points[i + 1] + z * points[i + 2]);
      scratch[4] = low - this.chestFloor!;
      return;
    }
    const min = this.minimum!,
      max = this.maximum!;
    scratch[4] =
      x * (x >= 0 ? min[0] : max[0]) +
      y * (y >= 0 ? this.cowlingMinY : max[1]) +
      z * (z >= 0 ? min[2] : max[2]) -
      this.chestFloor!;
  }

  private proxyClearanceInto(): void {
    const scratch = this.clearanceScratch,
      x = scratch[1],
      y = scratch[2],
      z = scratch[3],
      min = this.minimum!,
      max = this.maximum!,
      norm = this.norm;
    norm[0] = Math.max(min[0] - x, 0, x - max[0]);
    norm[1] = Math.max(min[1] - y, 0, y - max[1]);
    norm[2] = Math.max(min[2] - z, 0, z - max[2]);
    this.length3Into();
    scratch[4] = norm[3] - this.radius;
  }

  /** Check a presented/rest pose without changing rotation or temporal state. */
  checkClearance(target: Vec3): boolean {
    point(target, this.target);
    this.aimCached = false;
    this.restFrame();
    this.diagnostics(this.target);
    return this.clearanceResolved;
  }

  private commit(rotation: Rotation): void {
    const t = this.head.engine.store.transforms,
      euler = this.head.euler,
      id = this.head.id;
    if (
      rotation[0] !== this.previous[0] ||
      rotation[1] !== this.previous[1] ||
      rotation[2] !== this.previous[2] ||
      rotation[3] !== this.previous[3] ||
      t.qx[id] !== this.committed[0] ||
      t.qy[id] !== this.committed[1] ||
      t.qz[id] !== this.committed[2] ||
      t.qw[id] !== this.committed[3] ||
      !Object.is(euler[0], this.committedEuler[0]) ||
      !Object.is(euler[1], this.committedEuler[1]) ||
      !Object.is(euler[2], this.committedEuler[2])
    ) {
      if (this.writeRotation) this.writeRotation(rotation);
      else this.head.setQuaternion(rotation);
      for (let i = 0; i < 4; i++) this.previous[i] = rotation[i];
      this.committed[0] = t.qx[id];
      this.committed[1] = t.qy[id];
      this.committed[2] = t.qz[id];
      this.committed[3] = t.qw[id];
      this.committedEuler[0] = euler[0];
      this.committedEuler[1] = euler[1];
      this.committedEuler[2] = euler[2];
    }
    this.head.engine.store.tick(false);
  }

  private diagnostics(target?: Vec3): void {
    const m = this.head.matrix,
      o = this.optical;
    this.origin[0] = m[0] * o[0] + m[4] * o[1] + m[8] * o[2] + m[12];
    this.origin[1] = m[1] * o[0] + m[5] * o[1] + m[9] * o[2] + m[13];
    this.origin[2] = m[2] * o[0] + m[6] * o[1] + m[10] * o[2] + m[14];
    const norm = this.norm;
    norm[0] = m[8];
    norm[1] = m[9];
    norm[2] = m[10];
    this.length3Into();
    const length = norm[3];
    this.forward[0] = -m[8] / length;
    this.forward[1] = -m[9] / length;
    this.forward[2] = -m[10] / length;
    this.rayError = this.rayDistance = 0;
    if (target) {
      const x = target[0] - this.origin[0],
        y = target[1] - this.origin[1],
        z = target[2] - this.origin[2];
      const along = x * this.forward[0] + y * this.forward[1] + z * this.forward[2];
      norm[0] = y * this.forward[2] - z * this.forward[1];
      norm[1] = z * this.forward[0] - x * this.forward[2];
      norm[2] = x * this.forward[1] - y * this.forward[0];
      this.length3Into();
      this.rayDistance = norm[3];
      this.rayError = Math.atan2(this.rayDistance, along);
      if (along < 0) {
        norm[0] = x;
        norm[1] = y;
        norm[2] = z;
        this.length3Into();
        this.rayDistance = norm[3];
      }
      if (this.minimum) {
        const dx = target[0] - m[12],
          dy = target[1] - m[13],
          dz = target[2] - m[14],
          divisor = this.scale * this.scale;
        const scratch = this.clearanceScratch;
        scratch[1] = (m[0] * dx + m[1] * dy + m[2] * dz) / divisor;
        scratch[2] = (m[4] * dx + m[5] * dy + m[6] * dz) / divisor;
        scratch[3] = (m[8] * dx + m[9] * dy + m[10] * dz) / divisor;
        this.proxyClearanceInto();
        this.headClearance = scratch[4];
        if (this.chestFloor !== undefined) {
          const ux = 2 * (this.rx * this.ry - this.rz * this.rw),
            uy = 1 - 2 * (this.rx * this.rx + this.rz * this.rz),
            uz = 2 * (this.ry * this.rz + this.rx * this.rw);
          scratch[1] = (ux * m[0] + uy * m[1] + uz * m[2]) / this.scale;
          scratch[2] = (ux * m[4] + uy * m[5] + uz * m[6]) / this.scale;
          scratch[3] = (ux * m[8] + uy * m[9] + uz * m[10]) / this.scale;
          this.floorClearanceInto();
          this.headClearance = Math.min(this.headClearance, scratch[4]);
        }
        if (this.rotationClearance) {
          const t = this.head.engine.store.transforms,
            id = this.head.id,
            rotation = this.clearanceRotation;
          rotation[0] = t.qx[id];
          rotation[1] = t.qy[id];
          rotation[2] = t.qz[id];
          rotation[3] = t.qw[id];
          this.jointClearanceInto(rotation);
          this.headClearance = Math.min(this.headClearance, this.rotationDistance[0]);
        }
        this.clearanceResolved = this.headClearance >= 0;
        this.limited ||= !this.clearanceResolved;
      }
    }
  }

  /** Restore the captured local rest orientation, also clearing the aim cache. */
  reset(target?: Vec3): this {
    if (target) {
      point(target, this.target);
    }
    this.aimCached = false;
    this.restFrame();
    this.commit(this.rest);
    this.angle = 0;
    this.limited = false;
    this.headClearance = Infinity;
    this.clearanceResolved = true;
    this.diagnostics(target ? this.target : undefined);
    return this;
  }
}
