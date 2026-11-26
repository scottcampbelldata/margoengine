// Loads of the air on rigid bodies (flight.ts, fields.ts), taken implicitly in the body's motion so a light body in a strong
// air load stays stable at the world's step; air-hold.ts holds them as forces through the step.
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
