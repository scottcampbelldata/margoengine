// A drag joint: pick a point of a body and pull it toward a target with a soft constraint, as a mouse joint does. It is the soft
// constraint of Catto, "Soft Constraints", GDC 2011, written as a frequency and a damping ratio, so a light body and a heavy one
// follow the pointer alike: every step the joint gives the body the impulse that moves the grabbed point toward the target by the
// implicit spring and damper of the constraint, with the effective mass of the point (the body's mass and its inertia about the
// grip). Whatever else pushes the body (gravity, contacts) is solved by the world around it.
import { jointInput } from './joint-errors.js';
import { conjugateQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { PhysicsBody } from './body.js';
import { checkVec, type Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

/** Options of {@link DragJoint}. */
export interface DragOptions {
  /** Natural frequency of the pull in hertz (default 5): the dragged body follows the target with this rhythm whatever its mass. */
  frequency?: number;
  /** Damping ratio (default 0.7): 1 settles without overshoot, less rings. */
  damping?: number;
  /** The most force the pull may use, in newtons (default Infinity), so a far target cannot hurl a body: it is also a cap on the impulse of a step. */
  maxForce?: number;
}

type V = [number, number, number];
const sub = (a: Vec3, b: Vec3): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Solves the 3 by 3 system `m x = b` by Cramer's rule. */
function solve3(m: number[][], b: Vec3): V {
  const [a, c, d] = m[0]!,
    [e, f, g] = m[1]!,
    [h, i, j] = m[2]!,
    det = a! * (f! * j! - g! * i!) - c! * (e! * j! - g! * h!) + d! * (e! * i! - f! * h!);
  if (Math.abs(det) < 1e-20) return [0, 0, 0];
  const x = (b[0] * (f! * j! - g! * i!) - c! * (b[1] * j! - g! * b[2]) + d! * (b[1] * i! - f! * b[2])) / det,
    y = (a! * (b[1] * j! - g! * b[2]) - b[0] * (e! * j! - g! * h!) + d! * (e! * b[2] - b[1] * h!)) / det,
    z = (a! * (f! * b[2] - b[1] * i!) - c! * (e! * b[2] - b[1] * h!) + b[0] * (e! * i! - f! * h!)) / det;
  return [x, y, z];
}

/**
 * Drags a point of a dynamic body toward a target: `new DragJoint(physics, body, point)` grabs the body at the world `point`, and
 * `setTarget(point)` moves what it is pulled toward. `remove()` lets go (so does removing the body).
 */
export class DragJoint implements PhysicsAttachment {
  private target: Vec3;
  private readonly local: Vec3;
  private readonly omega: number;
  private readonly ratio: number;
  private readonly limit: number;
  private released = false;

  constructor(
    private readonly physics: Physics,
    readonly body: PhysicsBody,
    point: Vec3,
    options: DragOptions = {},
  ) {
    checkVec(point, 'Grab point');
    const { frequency = 5, damping = 0.7, maxForce = Number.POSITIVE_INFINITY } = options;
    if (!(frequency > 0 && Number.isFinite(frequency)))
      throw jointInput('Drag frequency is a positive number of hertz; pass options.frequency above 0.');
    if (!(damping >= 0 && Number.isFinite(damping)))
      throw jointInput('Drag damping ratio is 0 or more; pass options.damping of 0 or above.');
    if (!(maxForce > 0))
      throw jointInput(
        'Drag maxForce is a positive number of newtons; pass options.maxForce above 0 or leave it out.',
      );
    if (body.type !== 'dynamic')
      throw jointInput('A drag joint pulls a dynamic body; pass a body made with type dynamic.');
    this.omega = 2 * Math.PI * frequency;
    this.ratio = damping;
    this.limit = maxForce;
    this.target = [...point];
    this.local = rotateByQuaternion(sub(point, body.position), conjugateQuaternion(body.rotation)) as V;
    physics.attach(this);
  }

  /** Where the body is pulled toward. */
  get targetPoint(): Vec3 {
    return [...this.target];
  }

  /** Moves the target to a world point and wakes the body. */
  setTarget(point: Vec3): this {
    checkVec(point, 'Drag target');
    this.target = [...point];
    this.body.setLinearVelocity(this.body.linearVelocity, true);
    return this;
  }

  /** Where the grabbed point of the body is now. */
  gripPoint(): Vec3 {
    const turned = rotateByQuaternion(this.local, this.body.rotation) as Vec3,
      p = this.body.position;
    return [p[0] + turned[0], p[1] + turned[1], p[2] + turned[2]];
  }

  /** @internal The impulse of this step. */
  beforeStep(dt: number): void {
    const body = this.body;
    if (this.released || !body.valid || body.sleeping) return;
    const grip = this.gripPoint(),
      arm = sub(grip, body.position),
      v = body.linearVelocity,
      w = body.angularVelocity,
      speed = [
        v[0] + (w[1] * arm[2] - w[2] * arm[1]),
        v[1] + (w[2] * arm[0] - w[0] * arm[2]),
        v[2] + (w[0] * arm[1] - w[1] * arm[0]),
      ] as V,
      error = sub(grip, this.target),
      // The point's effective mass matrix inverse K = I / m - [r] J^-1 [r] with J the inertia in world axes.
      m = body.mass,
      [ix, iy, iz] = body.principalInertia,
      frame = multiplyQuaternions(body.rotation, body.inertiaFrame),
      axes = [
        rotateByQuaternion([1, 0, 0], frame) as V,
        rotateByQuaternion([0, 1, 0], frame) as V,
        rotateByQuaternion([0, 0, 1], frame) as V,
      ],
      moments = [ix, iy, iz],
      inverse = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
    for (let k = 0; k < 3; k++)
      if (moments[k]! > 0)
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 3; c++) inverse[r]![c]! += (axes[k]![r]! * axes[k]![c]!) / moments[k]!;
    // [r] J^-1 [r]^T, with [r] the cross product matrix of the arm.
    const skew = [
      [0, -arm[2], arm[1]],
      [arm[2], 0, -arm[0]],
      [-arm[1], arm[0], 0],
    ];
    const k3 = [
      [1 / m, 0, 0],
      [0, 1 / m, 0],
      [0, 0, 1 / m],
    ];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += skew[r]![a]! * inverse[a]![b]! * skew[c]![b]!;
        k3[r]![c]! += sum;
      }
    // The soft constraint: damping d = 2 m zeta omega and stiffness k = m omega^2 on the point's mass m (the harmonic mean of the
    // diagonal of K^-1), gamma = 1 / (dt (d + dt k)), beta = dt k / (d + dt k).
    const mass = 3 / (k3[0]![0]! + k3[1]![1]! + k3[2]![2]!),
      d = 2 * mass * this.ratio * this.omega,
      k = mass * this.omega * this.omega,
      gamma = 1 / (dt * (d + dt * k)),
      beta = (dt * k) / (d + dt * k);
    const system = k3.map((row, r) => row.map((x, c) => x + (r === c ? gamma : 0))),
      impulse = solve3(system, [
        -(speed[0] + (beta / dt) * error[0]),
        -(speed[1] + (beta / dt) * error[1]),
        -(speed[2] + (beta / dt) * error[2]),
      ]);
    const size = Math.hypot(impulse[0], impulse[1], impulse[2]),
      cap = this.limit * dt;
    const scaled: V =
      size > cap ? [(impulse[0] * cap) / size, (impulse[1] * cap) / size, (impulse[2] * cap) / size] : impulse;
    body.applyImpulse(scaled, grip, true);
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.body) this.remove();
  }

  /** Lets go. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
  }

  /** Removes it, as `remove()` does, so `using` releases it at the end of its scope. */
  [Symbol.dispose](): void {
    this.remove();
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }
}
