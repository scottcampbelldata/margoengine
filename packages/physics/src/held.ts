// Loads of the air held on rigid bodies (flight.ts, fields.ts): as forces through the whole step, and taken implicitly in
// the body's motion so a light body in a strong air load stays stable at the world's step.
import type { PhysicsBody } from './body.js';
import { scale, solve, sub } from './lattice.js';
import type { Vec3 } from './math.js';

/** A body's force and torque about its centre of mass, as a function of a change of its velocity and spin. */
export type Wrench = (dv: Vec3, dw: Vec3) => [Vec3, Vec3];

/**
 * The load to hold through a step of `dt`, taken implicitly in the body's motion: the air's force and torque depend on the
 * body's velocity and spin, and a light body with a large wing would be over-damped by them in one explicit step (its roll
 * damping times the step reaches past 2, where an explicit step diverges). The load W(nu) is linearised about the motion at
 * the start, J = dW/dnu by central differences of 1 mm/s and 1 mrad/s, and the change of motion solves (I - dt M^-1 J) dnu =
 * dt (M^-1 W(0) + g), the backward Euler step of the load with the body's fall (M the body's mass and world inertia, g its
 * gravity); the load held is then W(0) + J dnu, the load at the end of the step.
 */
export function implicitWrench(body: PhysicsBody, wrench: Wrench, dt: number, gravity: Vec3): [Vec3, Vec3] {
  const [f0, t0] = wrench([0, 0, 0], [0, 0, 0]);
  if (body.type !== 'dynamic' || !(dt > 0)) return [f0, t0];
  const h = 1e-3,
    jacobian = new Float64Array(36);
  for (let k = 0; k < 6; k++) {
    const d: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    d[k] = h;
    const [fp, tp] = wrench([d[0], d[1], d[2]], [d[3], d[4], d[5]]);
    d[k] = -h;
    const [fm, tm] = wrench([d[0], d[1], d[2]], [d[3], d[4], d[5]]),
      column = [...sub(fp, fm), ...sub(tp, tm)];
    for (let r = 0; r < 6; r++) jacobian[6 * r + k] = column[r]! / (2 * h);
  }
  const inverseMass = body.effectiveInverseMass,
    inverseInertia = body.effectiveWorldInverseInertia,
    // M^-1 applied to a row block: the inverse mass on the force rows, the inverse inertia on the torque rows.
    mInv = (r: number, c: number): number =>
      r < 3 ? (r === c ? inverseMass[r]! : 0) : c < 3 ? 0 : inverseInertia[3 * (r - 3) + (c - 3)]!,
    system = new Float64Array(36),
    rhs = new Float64Array(6),
    w0 = [...f0, ...t0],
    // The body's own fall through the step is part of its change of motion: a rotor holding a drone up meets no climb.
    fall = scale(gravity, body.gravityScale);
  for (let r = 0; r < 6; r++) {
    let b = r < 3 && inverseMass[r]! > 0 ? fall[r]! : 0;
    for (let k = 0; k < 6; k++) b += mInv(r, k) * w0[k]!;
    rhs[r] = dt * b;
    for (let c = 0; c < 6; c++) {
      let mj = 0;
      for (let k = 0; k < 6; k++) mj += mInv(r, k) * jacobian[6 * k + c]!;
      system[6 * r + c] = (r === c ? 1 : 0) - dt * mj;
    }
  }
  const dnu = solve(system, rhs, 6),
    held = [0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 6; r++) {
    let jd = 0;
    for (let c = 0; c < 6; c++) jd += jacobian[6 * r + c]! * dnu[c]!;
    held[r] = w0[r]! + jd;
  }
  return [
    [held[0]!, held[1]!, held[2]!],
    [held[3]!, held[4]!, held[5]!],
  ];
}

/**
 * A load held on a body as a force through the whole step (`addForce`, `addTorque`), changed each step by the difference
 * from the last, so it acts as a force does. An impulse at the start of a step would let gravity pull back through it, and a
 * hovering drone would creep up half g dt^2 a step (the soft attachments' finding, docs/known-bugs.md).
 */
export class HeldLoad {
  private readonly force: [number, number, number] = [0, 0, 0];
  private readonly torque: [number, number, number] = [0, 0, 0];

  /** Holds `force` (N) and `torque` (N m, about the centre of mass) on `body` from now on. An unchanged load leaves it asleep. */
  set(body: PhysicsBody, force: Vec3, torque: Vec3, wakeUp = true): void {
    if (body.type !== 'dynamic') return;
    const df: Vec3 = [force[0] - this.force[0], force[1] - this.force[1], force[2] - this.force[2]],
      dt: Vec3 = [torque[0] - this.torque[0], torque[1] - this.torque[1], torque[2] - this.torque[2]];
    if (df[0] !== 0 || df[1] !== 0 || df[2] !== 0) body.addForce(df, undefined, wakeUp);
    if (dt[0] !== 0 || dt[1] !== 0 || dt[2] !== 0) body.addTorque(dt, wakeUp);
    [this.force[0], this.force[1], this.force[2]] = force;
    [this.torque[0], this.torque[1], this.torque[2]] = torque;
  }

  /** Takes the load off (waking the body unless `wakeUp` is false). */
  clear(body: PhysicsBody, wakeUp = true): void {
    this.set(body, [0, 0, 0], [0, 0, 0], wakeUp);
  }
}
