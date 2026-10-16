import type { Vec3 } from '@margoengine/core/extension';

type Point = [number, number, number];
export interface TargetMotionOptions {
  /** World units per second. The demo uses metre-scale authored geometry. */
  maxSpeed?: number;
  /** Critically damped response in inverse seconds. */
  response?: number;
}
function point(value: Vec3): void {
  if (
    !value ||
    value.length !== 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2]) ||
    !Number.isFinite(Math.fround(value[0])) ||
    !Number.isFinite(Math.fround(value[1])) ||
    !Number.isFinite(Math.fround(value[2]))
  ) {
    throw new RangeError('Target motion requires a finite scene point');
  }
}
/** Reused, speed-limited target command; collision checks still belong to IK. */
export class TargetMotion {
  readonly position: Point;
  readonly maxSpeed: number;
  readonly response: number;
  settled = true;
  private readonly velocity = new Float64Array(3);
  private readonly next = new Float64Array(3);
  private readonly nextVelocity = new Float64Array(3);
  private readonly norm = new Float64Array(4);

  private lengthInto(): void {
    const out = this.norm;
    let x = out[0],
      y = out[1],
      z = out[2];
    const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (!scale) {
      out[3] = 0;
      return;
    }
    x /= scale;
    y /= scale;
    z /= scale;
    out[3] = scale * Math.sqrt(x * x + y * y + z * z);
  }

  constructor(initial: Vec3, options: TargetMotionOptions = {}) {
    point(initial);
    const speed = options.maxSpeed ?? 1.8,
      response = options.response ?? 18;
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(response) || response <= 0 || response > 10000) {
      throw new RangeError('Target motion speed and response must be positive and finite');
    }
    this.position = [initial[0], initial[1], initial[2]];
    this.maxSpeed = speed;
    this.response = response;
  }

  update(target: Vec3, dt: number): Point {
    point(target);
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Target motion dt must be finite and nonnegative');
    if (dt === 0) return this.position;
    // Read before mutating output so callers may safely reuse position as input.
    const tx = target[0],
      ty = target[1],
      tz = target[2],
      p = this.position,
      next = this.next,
      velocity = this.velocity,
      nextVelocity = this.nextVelocity,
      u = this.response * dt,
      decay = Math.exp(-u);
    for (let axis = 0; axis < 3; axis++) {
      const goal = axis === 0 ? tx : axis === 1 ? ty : tz,
        offset = p[axis] - goal;
      // Large time steps have completely decayed. Avoid Infinity*0 while the
      // displacement below still obeys the explicit linear-speed bound.
      if (offset === 0 || u > 50) {
        next[axis] = goal;
        nextVelocity[axis] = 0;
        continue;
      }
      const v = velocity[axis],
        mixed = v + this.response * offset;
      next[axis] = goal + (offset + mixed * dt) * decay;
      nextVelocity[axis] = (v - this.response * mixed * dt) * decay;
      // A changed goal may meet carried velocity. Stop at that coordinate
      // instead of overshooting the requested endpoint.
      if ((next[axis] - goal) * offset <= 0) {
        next[axis] = goal;
        nextVelocity[axis] = 0;
      }
      if ((next[axis] - p[axis]) * offset > 0) {
        next[axis] = p[axis];
        nextVelocity[axis] = 0;
      }
    }
    const dx = next[0] - p[0],
      dy = next[1] - p[1],
      dz = next[2] - p[2],
      norm = this.norm;
    norm[0] = dx;
    norm[1] = dy;
    norm[2] = dz;
    this.lengthInto();
    const distance = norm[3],
      limit = this.maxSpeed * dt;
    const ratio = distance > limit ? limit / distance : 1;
    norm[0] = tx - p[0];
    norm[1] = ty - p[1];
    norm[2] = tz - p[2];
    this.lengthInto();
    const snapStep = norm[3];
    p[0] += dx * ratio;
    p[1] += dy * ratio;
    p[2] += dz * ratio;
    norm[0] = nextVelocity[0];
    norm[1] = nextVelocity[1];
    norm[2] = nextVelocity[2];
    this.lengthInto();
    const speed = norm[3],
      speedRatio = speed > this.maxSpeed ? this.maxSpeed / speed : 1;
    velocity[0] = nextVelocity[0] * speedRatio;
    velocity[1] = nextVelocity[1] * speedRatio;
    velocity[2] = nextVelocity[2] * speedRatio;
    norm[0] = tx - p[0];
    norm[1] = ty - p[1];
    norm[2] = tz - p[2];
    this.lengthInto();
    const remaining = norm[3];
    if (remaining < 1e-4 && speed < 0.002 && snapStep <= limit) {
      p[0] = tx;
      p[1] = ty;
      p[2] = tz;
      velocity.fill(0);
    }
    this.settled =
      p[0] === tx && p[1] === ty && p[2] === tz && velocity[0] === 0 && velocity[1] === 0 && velocity[2] === 0;
    return p;
  }

  reset(position: Vec3): Point {
    point(position);
    this.position[0] = position[0];
    this.position[1] = position[1];
    this.position[2] = position[2];
    this.velocity.fill(0);
    this.settled = true;
    return this.position;
  }
}
