// The trial, simulated by @margoengine/physics: a cast-iron ball on a seven-link steel chain (a `Rope` of capsules
// joined by spherical joints) hung from the crane's trolley, swung into thirty pine blocks stacked in alternating
// courses on a fixed deck. This file builds the world and reads the two readouts back from the solver's own state.
import { Physics, Rope } from '@margoengine/physics';

export const block = { length: 0.15, height: 0.03, width: 0.05 };
export const ball = { radius: 0.045, eye: 0.012 };
/** The trolley sheave the chain hangs from, and the chain from there to the ball's lifting eye. */
export const pivot = [0, 0.615, 0];
export const chain = { links: 7, length: 0.39, radius: 0.0045 };
/** The ball just clears the tower's near face while it hangs at rest. */
const towerX = ball.radius + block.length / 2 + 0.012;
export const trialSeconds = 3.6;

/** Ten courses of three blocks, alternating between lying along X and along Z. */
export const stack = Array.from({ length: 30 }, (_, i) => {
  const course = Math.floor(i / 3), alongX = course % 2 === 0, offset = ((i % 3) - 1) * (block.width + 0.0006);
  const position = [towerX + (alongX ? 0 : offset), block.height * (course + 0.5) + 0.0002 * course, alongX ? offset : 0];
  return { position, size: alongX ? [block.length, block.height, block.width] : [block.width, block.height, block.length] };
});

let loaded;
export const loadTrial = (signal) => (loaded ??= Physics.load(signal));

/** A fresh world with the ball pulled back by `degrees` toward the mast, held still until the first update. */
export function createTrial(degrees) {
  const physics = new Physics(null, { fidelity: 'high' });
  physics.addBody(null, { type: 'fixed', position: [0, -0.02, 0], colliders: { shape: 'box', halfExtents: [0.74, 0.02, 0.34], friction: 0.6 } });
  // A rounded border sits outside the half extents, so each box is smaller by the border.
  const blocks = stack.map(({ position, size }) => physics.addBody(null, {
    position,
    colliders: { shape: 'box', halfExtents: size.map((s) => s / 2 - 0.0015), borderRadius: 0.0015, density: 'pine', friction: 0.55, restitution: 0.05 },
  }));
  const angle = (degrees * Math.PI) / 180, dir = [-Math.sin(angle), -Math.cos(angle), 0];
  const along = (d) => pivot.map((p, i) => p + dir[i] * d);
  const weight = physics.addBody(null, {
    position: along(chain.length + ball.eye + ball.radius), rotation: [0, 0, Math.sin(-angle / 2), Math.cos(-angle / 2)], ccd: true,
    colliders: { shape: 'sphere', radius: ball.radius, density: 'iron', friction: 0.4, restitution: 0.1 },
  });
  const rope = new Rope(physics, {
    start: pivot, end: along(chain.length), segments: chain.links, radius: chain.radius, attachStart: 'fixed', attachEnd: weight,
    damping: 0.02, angularDamping: 0.2, collider: { density: 'steel', friction: 0.3 },
  });
  const trial = { physics, blocks, weight, rope, time: 0, impactSpeed: null, fallen: new Set(), done: false };
  // The ball's speed as each step begins, so the first ball-block contact force reports the speed it arrived with.
  let arriving = 0;
  physics.on('beforestep', () => (arriving = Math.hypot(...weight.linearVelocity)));
  const isBlock = new Set(blocks);
  physics.on('contactforce', ({ bodyA, bodyB }) => {
    if (trial.impactSpeed === null && ((bodyA === weight && isBlock.has(bodyB)) || (bodyB === weight && isBlock.has(bodyA)))) trial.impactSpeed = arriving;
  });
  return trial;
}

/** Runs the solver for `seconds` (to the end of the trial at most) and counts fallen blocks: a block whose centre has
 * dropped a block height or left its place by half a block width counts once and stays counted. */
export function run(trial, seconds) {
  const span = Math.min(seconds, trialSeconds - trial.time);
  trial.physics.update(span);
  trial.time += span;
  trial.done = trial.time >= trialSeconds - 1e-9;
  trial.blocks.forEach((body, i) => {
    const p = body.position, s = stack[i].position;
    if (s[1] - p[1] >= block.height || Math.hypot(p[0] - s[0], p[2] - s[2]) >= block.width / 2) trial.fallen.add(i);
  });
}

export const disposeTrial = (trial) => trial?.physics.dispose();
