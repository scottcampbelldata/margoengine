// The cradle's motion, simulated by @margoengine/physics: five steel balls, each hung from the frame by a hinge (the
// two strings of a real cradle keep a ball swinging in one plane, as a revolute joint does), touching in a line.
// The engine resolves a strike into touching balls one pair at a time (Guendelman, Bridson and Fedkiw 2003), so one
// lifted ball sends one off the far end and two send two. This file only reads the bodies back for the picture.
import { Physics } from '@margoengine/physics';

export const gravity = 9.81;
export const radius = 0.026;
export const length = 0.247;
export const restY = 0.1;
export const pivotY = restY + length;
export const count = 5;
export const spacing = radius * 2;
export const lift = (34 * Math.PI) / 180;
/** Hardened, polished steel at a cradle's speeds (under 1 m/s) bounces back almost whole. */
export const restitution = 0.995;
const step = 1 / 240;

export const pivotX = (index) => (index - (count - 1) / 2) * spacing;

let loaded;
/** Loads the physics kernel once; call before `initialise`. */
export const loadMotion = (signal) => (loaded ??= Physics.load(signal));

export function initialise(lifted) {
  const physics = new Physics(null, { fixedTimestep: step, fidelity: 'high' });
  const frame = physics.addBody(null, { type: 'fixed', position: [0, pivotY, 0] });
  const balls = [];
  for (let i = 0; i < count; i++) {
    const angle = i < lifted ? -lift : 0;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const ball = physics.addBody(null, {
      position: [pivotX(i) + length * sin, pivotY - length * cos, 0],
      colliders: { shape: 'sphere', radius, density: 'steel', restitution, friction: 0 },
    });
    physics.addJoint(frame, ball, {
      type: 'revolute', axis: [0, 0, 1],
      anchorA: [pivotX(i), 0, 0], anchorB: [-length * sin, length * cos, 0],
    });
    balls.push(ball);
  }
  const system = {
    physics, balls,
    mass: balls[0].mass,
    angle: new Float64Array(count),
    velocity: new Float64Array(count),
    x: new Float64Array(count), y: new Float64Array(count),
    time: 0, contacts: 0, contacting: false,
  };
  read(system);
  system.initial = energy(system);
  return system;
}

function read(s) {
  let touching = false;
  for (let i = 0; i < count; i++) {
    const p = s.balls[i].position, v = s.balls[i].linearVelocity;
    const dx = p[0] - pivotX(i), dy = pivotY - p[1];
    s.x[i] = p[0];
    s.y[i] = p[1];
    s.angle[i] = Math.atan2(dx, dy);
    // Angular speed about the pivot: the velocity's part along the swing, over the arm.
    s.velocity[i] = (v[0] * Math.cos(s.angle[i]) + v[1] * Math.sin(s.angle[i])) / length;
    if (i && Math.hypot(p[0] - s.balls[i - 1].position[0], p[1] - s.balls[i - 1].position[1]) < 2 * radius + 1e-4) touching = true;
  }
  const struck = touching && s.velocity.reduce((m, w) => Math.max(m, Math.abs(w)), 0) > 0.05;
  if (struck && !s.contacting) s.contacts++;
  s.contacting = struck;
}

export function advance(s, seconds) {
  s.physics.update(seconds);
  s.time += seconds;
  read(s);
}

/** Kinetic plus potential energy of the balls, J (spin about each ball's centre is under 0.5 percent of it). */
export function energy(s) {
  let sum = 0;
  for (const ball of s.balls) {
    const v = ball.linearVelocity;
    sum += 0.5 * s.mass * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) + s.mass * gravity * (ball.position[1] - restY);
  }
  return sum;
}

export function disposeMotion(s) {
  s?.physics.dispose();
}
