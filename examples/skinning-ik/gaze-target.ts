import type { Mesh, Vec3 } from '@margoengine/core/extension';

type Point = [number, number, number];
interface GazeTargetOptions {
  /** Front of the head proxy in its authored local coordinates. */
  front: number;
  targetRadius: number;
  margin?: number;
  /** Additional target-conditioning clearance; does not replace mesh checks. */
  reserve?: number;
}

function point(value: ArrayLike<number>, out?: Point): void {
  if (!value || value.length !== 3) throw new RangeError('Gaze target requires a finite scene point');
  const x = value[0],
    y = value[1],
    z = value[2];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(Math.fround(x)) ||
    !Number.isFinite(Math.fround(y)) ||
    !Number.isFinite(Math.fround(z))
  )
    throw new RangeError('Gaze target requires a finite scene point');
  if (out) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
  }
}

function coordinates(x: number, y: number, z: number): void {
  if (!Number.isFinite(Math.fround(x)) || !Number.isFinite(Math.fround(y)) || !Number.isFinite(Math.fround(z)))
    throw new RangeError('Gaze target exceeds scene precision');
}

/**
 * Demo policy for the held light: keep close targets in a viewable workspace.
 * Exact gaze puts the target at (opticalX, opticalY, z) in the aimed head frame.
 * Its pivot radius must therefore clear the head's front plus the orb radius.
 * Projection preserves model X/Y and moves only forward, never the neck.
 * This necessary proxy bound is still followed by every posed mesh/head check.
 */
export class GazeTarget {
  readonly minimumRadius: number;
  readonly conditionedRadius: number;
  projected = false;
  private readonly head: Mesh;
  private readonly frame: Mesh;
  private headScale = 1;
  private frameScale = 1;
  private px = 0;
  private py = 0;
  private pz = 0;
  private guardRadius = 0;
  private readonly input: Point = [0, 0, 0];
  private readonly local: Point = [0, 0, 0];
  private readonly projection = new Float64Array(4);
  private readonly distance = new Float64Array(1);

  constructor(head: Mesh, frame: Mesh, optical: Vec3, options: GazeTargetOptions) {
    const offset: Point = [0, 0, 0];
    point(optical, offset);
    const margin = options.margin ?? 0,
      reserve = options.reserve ?? 0.001;
    if (
      !Number.isFinite(options.front) ||
      !Number.isFinite(options.targetRadius) ||
      options.targetRadius < 0 ||
      !Number.isFinite(margin) ||
      margin < 0 ||
      !Number.isFinite(reserve) ||
      reserve < 0
    )
      throw new RangeError('Invalid gaze target geometry');
    const front = Math.min(offset[2], options.front - options.targetRadius - margin);
    this.minimumRadius = Math.hypot(offset[0], offset[1], front);
    this.conditionedRadius = Math.hypot(offset[0], offset[1], front - reserve);
    if (!Number.isFinite(Math.fround(this.conditionedRadius)) || this.minimumRadius <= 0)
      throw new RangeError('Invalid gaze target geometry');
    this.head = head;
    this.frame = frame;
    this.refresh();
    this.guardRadius = this.minimumRadius;
  }

  private refresh(): void {
    this.head.check();
    this.frame.check();
    if (this.head.engine !== this.frame.engine) throw new RangeError('Gaze frame must contain the head');
    const store = this.head.engine.store,
      t = store.transforms;
    let scale = 1,
      frameScale = 1,
      found = false,
      steps = 0;
    for (let id = this.head.id; id !== -1; id = store.parents[id]) {
      if (++steps > store.capacity) throw new RangeError('Invalid gaze target hierarchy');
      const x = t.sx[id],
        y = t.sy[id],
        z = t.sz[id],
        tolerance = Math.max(x, y, z) * 1e-5;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        x <= 0 ||
        y <= 0 ||
        z <= 0 ||
        Math.abs(x - y) > tolerance ||
        Math.abs(x - z) > tolerance
      )
        throw new RangeError('Gaze target requires positive uniform ancestor scales');
      const qx = t.qx[id],
        qy = t.qy[id],
        qz = t.qz[id],
        qw = t.qw[id];
      if (
        !Number.isFinite(qx) ||
        !Number.isFinite(qy) ||
        !Number.isFinite(qz) ||
        !Number.isFinite(qw) ||
        qx * qx + qy * qy + qz * qz + qw * qw === 0
      )
        throw new RangeError('Invalid gaze target ancestor rotation');
      scale *= x;
      found ||= id === this.frame.id;
      if (found) frameScale *= x;
    }
    if (
      !found ||
      !Number.isFinite(Math.fround(scale)) ||
      Math.fround(scale) <= 0 ||
      !Number.isFinite(Math.fround(frameScale)) ||
      Math.fround(frameScale) <= 0
    )
      throw new RangeError('Gaze frame must contain the head at a finite scale');
    store.tick(false);
    const head = this.head.matrix,
      frame = this.frame.matrix;
    for (let i = 0; i < 16; i++)
      if (!Number.isFinite(head[i]) || !Number.isFinite(frame[i]))
        throw new RangeError('Gaze target frame exceeds scene precision');
    this.headScale = scale;
    this.frameScale = frameScale;
    this.px = head[12];
    this.py = head[13];
    this.pz = head[14];
  }

  private projectLocalInto(target: ArrayLike<number>): void {
    const m = this.frame.matrix,
      inverseScale = 1 / (this.frameScale * this.frameScale),
      wx = this.px - m[12],
      wy = this.py - m[13],
      wz = this.pz - m[14],
      px = (m[0] * wx + m[1] * wy + m[2] * wz) * inverseScale,
      py = (m[4] * wx + m[5] * wy + m[6] * wz) * inverseScale,
      pz = (m[8] * wx + m[9] * wy + m[10] * wz) * inverseScale,
      x = target[0],
      y = target[1],
      z = target[2],
      dx = x - px,
      dy = y - py,
      dz = z - pz,
      radius = (this.conditionedRadius * this.headScale) / this.frameScale,
      square = radius * radius;
    const projected = dx * dx + dy * dy + dz * dz < square,
      nextZ = projected ? pz - Math.sqrt(Math.max(0, square - dx * dx - dy * dy)) : z;
    coordinates(x, y, nextZ);
    this.projection[0] = x;
    this.projection[1] = y;
    this.projection[2] = nextZ;
    this.projection[3] = +projected;
  }

  /** Caller-owned model-local destination; the raw control/drag target stays intact. */
  projectLocal(target: ArrayLike<number>, out: Point): Point {
    point(target, this.input);
    this.refresh();
    this.projectLocalInto(this.input);
    out[0] = this.projection[0];
    out[1] = this.projection[1];
    out[2] = this.projection[2];
    this.projected = !!this.projection[3];
    return out;
  }

  /** Condition a world-space goal before the speed-limited target filter. */
  project(target: Vec3, out: Point): Point {
    point(target, this.input);
    target = this.input;
    this.refresh();
    this.distanceInto(target, this.distance);
    if (this.distance[0] >= this.conditionedRadius * this.headScale) {
      out[0] = target[0];
      out[1] = target[1];
      out[2] = target[2];
      this.projected = false;
      return out;
    }
    const m = this.frame.matrix,
      x = target[0] - m[12],
      y = target[1] - m[13],
      z = target[2] - m[14],
      inverseScale = 1 / (this.frameScale * this.frameScale),
      local = this.local;
    local[0] = (m[0] * x + m[1] * y + m[2] * z) * inverseScale;
    local[1] = (m[4] * x + m[5] * y + m[6] * z) * inverseScale;
    local[2] = (m[8] * x + m[9] * y + m[10] * z) * inverseScale;
    this.projectLocalInto(local);
    const p = this.projection,
      projected = !!p[3],
      nextX = projected ? m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] : target[0],
      nextY = projected ? m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] : target[1],
      nextZ = projected ? m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] : target[2];
    coordinates(nextX, nextY, nextZ);
    out[0] = nextX;
    out[1] = nextY;
    out[2] = nextZ;
    this.projected = projected;
    return out;
  }

  /**
   * Capture the moving pivot after torso motion, before candidate evaluation.
   * Enabling gaze while already close permits a gradual outward recovery;
   * it cannot invalidate the previously accepted pose and force a reset.
   */
  beginStep(accepted: Vec3): void {
    point(accepted, this.input);
    this.refresh();
    this.distanceInto(this.input, this.distance);
    this.guardRadius = Math.min(this.minimumRadius, Math.max(0, this.distance[0] / this.headScale - 0.00001));
  }

  private distanceInto(candidate: Vec3, out: Float64Array): void {
    let x = candidate[0] - this.px,
      y = candidate[1] - this.py,
      z = candidate[2] - this.pz;
    const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (!scale) {
      out[0] = 0;
      return;
    }
    x /= scale;
    y /= scale;
    z /= scale;
    out[0] = scale * Math.sqrt(x * x + y * y + z * z);
  }

  /** Additional candidate constraint, including filter chords; never projects a presented pose. */
  clearance(candidate: Vec3, out: Float64Array): void {
    point(candidate, this.input);
    // No-solve/probe audits may follow an external parent edit. Refresh geometry
    // without advancing the accepted-radius recovery captured by beginStep().
    this.refresh();
    this.distanceInto(this.input, out);
    out[0] -= this.guardRadius * this.headScale;
  }

  /**
   * A distant filtered goal can lie across the excluded ball. The arm's short
   * contact chase must first go around it, rather than repeatedly cutting the
   * same inward chord. This bounded tangent request never moves a presented
   * joint; the complete arm/head checks still accept or reject the waypoint.
   */
  waypoint(accepted: Vec3, command: Vec3, maxStep: number, out: Point): Point {
    point(accepted, this.input);
    point(command, this.local);
    if (!Number.isFinite(maxStep) || maxStep < 0) throw new RangeError('Invalid gaze waypoint step');
    this.refresh();
    const p = this.input,
      q = this.local,
      x = p[0] - this.px,
      y = p[1] - this.py,
      z = p[2] - this.pz,
      dx = q[0] - p[0],
      dy = q[1] - p[1],
      dz = q[2] - p[2],
      lengthSquared = dx * dx + dy * dy + dz * dz,
      dot = x * dx + y * dy + z * dz,
      t = lengthSquared ? Math.max(0, Math.min(1, -dot / lengthSquared)) : 0,
      cx = x + dx * t,
      cy = y + dy * t,
      cz = z + dz * t,
      radius = (this.guardRadius + 0.00001) * this.headScale;
    if (dot >= 0 || !lengthSquared || cx * cx + cy * cy + cz * cz >= radius * radius) {
      // The filter can be ahead of an arm held at contact. Also cap a clear
      // release from the accepted hand; a subsegment of a clear line stays clear.
      const length = Math.sqrt(lengthSquared),
        ratio = length > maxStep ? maxStep / length : 1,
        nextX = p[0] + dx * ratio,
        nextY = p[1] + dy * ratio,
        nextZ = p[2] + dz * ratio;
      coordinates(nextX, nextY, nextZ);
      out[0] = nextX;
      out[1] = nextY;
      out[2] = nextZ;
      return out;
    }
    const distance = Math.sqrt(x * x + y * y + z * z);
    if (!distance || maxStep === 0) {
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return out;
    }
    const nx = x / distance,
      ny = y / distance,
      nz = z / distance,
      inward = dx * nx + dy * ny + dz * nz;
    let tx = dx - nx * inward,
      ty = dy - ny * inward,
      tz = dz - nz * inward;
    let tangentLength = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tangentLength <= Math.sqrt(lengthSquared) * 1e-6) {
      // Exact opposition has no unique shortest side. Use a conditioned model
      // direction, also for sub-microradian perturbations, rather than marching
      // outward forever. This routing choice is independent of world axes.
      const m = this.frame.matrix;
      let fx = -m[8] / this.frameScale,
        fy = -m[9] / this.frameScale,
        fz = -m[10] / this.frameScale,
        along = fx * nx + fy * ny + fz * nz;
      fx -= nx * along;
      fy -= ny * along;
      fz -= nz * along;
      let length = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (length < 0.25) {
        fx = -m[0] / this.frameScale;
        fy = -m[1] / this.frameScale;
        fz = -m[2] / this.frameScale;
        along = fx * nx + fy * ny + fz * nz;
        fx -= nx * along;
        fy -= ny * along;
        fz -= nz * along;
        length = Math.sqrt(fx * fx + fy * fy + fz * fz);
      }
      tx = fx / length;
      ty = fy / length;
      tz = fz / length;
      tangentLength = 1;
    }
    const outward = Math.min(0.0002 * this.headScale, maxStep * 0.1),
      tangentStep = Math.min(tangentLength, Math.sqrt(Math.max(0, maxStep * maxStep - outward * outward))),
      ratio = tangentLength ? tangentStep / tangentLength : 0;
    tx = tx * ratio + nx * outward;
    ty = ty * ratio + ny * outward;
    tz = tz * ratio + nz * outward;
    const nextX = p[0] + tx,
      nextY = p[1] + ty,
      nextZ = p[2] + tz;
    coordinates(nextX, nextY, nextZ);
    out[0] = nextX;
    out[1] = nextY;
    out[2] = nextZ;
    return out;
  }
}
