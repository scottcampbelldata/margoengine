// Continuous collision impacts a step, through the facade: one stops a fast ball where it touches, more answer each touch and carry
// the ball on, 0 turns it off. The kernel's own proof is kernel/tests/ccd.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Physics2D } from '../dist/index.js';

const path = process.env.RAPIER2D_MODULE;
const skip = path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module';
let R;
if (path) {
  R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
}

await Physics2D.load();

/** A ball fired along a corridor between two thin walls at 1000 m/s: a step takes it 16.67 m, 5.7 m a leg. */
function corridor(substeps) {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  if (substeps !== undefined) physics.setSolver({ maxCcdSubsteps: substeps });
  for (const x of [-3, 3])
    physics.addBody(null, {
      type: 'fixed',
      position: [x, 0],
      colliders: { shape: 'box', width: 0.1, height: 10, restitution: 1, friction: 0 },
    });
  const ball = physics.addBody(null, {
    ccd: true,
    canSleep: false,
    linearVelocity: [1000, 0],
    colliders: { shape: 'circle', radius: 0.1, restitution: 1, friction: 0 },
  });
  return { physics, ball };
}

test('the limit reads back, defaults to 1, and takes only whole numbers from 0 to 65535', () => {
  const { physics } = corridor();
  assert.equal(physics.solver.maxCcdSubsteps, 1);
  physics.setSolver({ maxCcdSubsteps: 4 });
  assert.equal(physics.solver.maxCcdSubsteps, 4);
  for (const bad of [-1, 1.5, Number.NaN, 65536])
    assert.throws(() => physics.setSolver({ maxCcdSubsteps: bad }), RangeError);
  assert.equal(physics.solver.maxCcdSubsteps, 4, 'a refused value changes nothing');
  const bytes = physics.snapshot();
  physics.setSolver({ maxCcdSubsteps: 0 });
  physics.restore(bytes);
  assert.equal(physics.solver.maxCcdSubsteps, 4, 'a snapshot carries it');
});

test('more impacts a step carry a ball on between two walls: 0 goes through, 1 stops at the first, 4 comes back', () => {
  const x = (substeps) => {
    const { physics, ball } = corridor(substeps);
    physics.step();
    return [ball.position[0], ball.linearVelocity[0]];
  };
  const [off, offV] = x(0);
  assert.ok(Math.abs(off - 16.667) < 0.02 && Math.abs(offV - 1000) < 1, `off: ${off}`);
  const [one, oneV] = x(1);
  assert.ok(Math.abs(one - 2.85) < 0.01 && Math.abs(oneV - 1000) < 1, `1: ${one}`);
  // Three impacts answered (the third at the first wall again) and a fourth sweep that meets nothing: 0.433 m, going left.
  const [four, fourV] = x(4);
  assert.ok(Math.abs(four - 0.433) < 0.05 && Math.abs(fourV + 1000) < 1, `4: ${four}, ${fourV}`);
});

test('an impact answered inside a step is a contact: contactstart, contactend and contactforce events', () => {
  const { physics } = corridor(3);
  for (const body of physics.getBodies())
    for (const collider of body.colliders) collider.setContactForceEventThreshold(1);
  const seen = [];
  physics.on('contactstart', () => seen.push('start'));
  physics.on('contactend', () => seen.push('end'));
  const forces = [];
  physics.on('contactforce', (event) => forces.push(event.force));
  physics.step();
  assert.deepEqual(seen, ['start', 'end', 'start', 'end'], 'two answered impacts, each a touch that began and ended');
  assert.equal(forces.length, 2, 'and each is a contact force');
  assert.ok(Math.abs(forces[0] - forces[1]) < 0.01 * forces[0], 'at restitution 1 the two impacts are alike');
  physics.dispose();
});

test('a fast ball goes through a one-way platform from below and bounces off it from above, through the modifyContact hook', () => {
  const run = (y, vy) => {
    const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
    physics.setSolver({ maxCcdSubsteps: 2 });
    const platform = physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'box', width: 6, height: 0.1, restitution: 1, friction: 0, hooks: { modifyContact: true } },
    });
    physics.hooks = {
      // The normal runs from the first collider to the second: up (screen up is -y) from the platform to a body above it.
      modifyContact: (change) => {
        change.oneWay = change.colliderA === platform.colliders[0] ? [0, -1] : [0, 1];
      },
    };
    const ball = physics.addBody(null, {
      ccd: true,
      canSleep: false,
      position: [0, y],
      linearVelocity: [0, vy],
      colliders: { shape: 'circle', radius: 0.1, restitution: 1, friction: 0, hooks: { modifyContact: true } },
    });
    physics.step();
    const result = [ball.position[1], ball.linearVelocity[1]];
    physics.dispose();
    return result;
  };
  const [below, belowV] = run(2, -300);
  assert.ok(
    Math.abs(below + 3) < 1e-3 && Math.abs(belowV + 300) < 1e-3,
    `from below it goes through: ${below}, ${belowV}`,
  );
  const [above, aboveV] = run(-2, 300);
  assert.ok(
    Math.abs(above + 3.3) < 1e-3 && Math.abs(aboveV + 300) < 1e-3,
    `from above it bounces: ${above}, ${aboveV}`,
  );
});

test('maxCcdSubsteps agrees with Rapier 2D: a ball at 300 m/s between two walls 3 m apart, off, one impact and several', {
  skip,
}, () => {
  // 5 m a step: 1.35 m to the right wall (the walls' faces at +-1.45, the ball's radius 0.1), 2.7 m across to the left one, then 0.95 m back.
  const mine = (substeps) => {
    const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
    physics.setSolver({ maxCcdSubsteps: substeps });
    for (const x of [-1.5, 1.5])
      physics.addBody(null, {
        type: 'fixed',
        position: [x, 0],
        colliders: { shape: 'box', width: 0.1, height: 10, restitution: 1, friction: 0 },
      });
    const ball = physics.addBody(null, {
      ccd: true,
      canSleep: false,
      linearVelocity: [300, 0],
      colliders: { shape: 'circle', radius: 0.1, restitution: 1, friction: 0, density: 1 },
    });
    physics.step();
    const result = [ball.position[0], ball.linearVelocity[0]];
    physics.dispose();
    return result;
  };
  const theirs = (substeps) => {
    const world = new R.World({ x: 0, y: 0 });
    world.integrationParameters.maxCcdSubsteps = substeps;
    for (const x of [-1.5, 1.5])
      world.createCollider(
        R.ColliderDesc.cuboid(0.05, 5).setRestitution(1).setFriction(0),
        world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 0)),
      );
    const ball = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setLinvel(300, 0).setCcdEnabled(true).setCanSleep(false),
    );
    world.createCollider(R.ColliderDesc.ball(0.1).setRestitution(1).setFriction(0).setDensity(1), ball);
    world.timestep = 1 / 60;
    world.step();
    return [ball.translation().x, ball.linvel().x];
  };
  // 0: both go through, and at 1: both stop at the first wall with the velocity they came with.
  for (const [substeps, bound] of [
    [0, 1e-3],
    [1, 0.02],
  ]) {
    const [x, v] = mine(substeps);
    const [theirX, theirV] = theirs(substeps);
    assert.ok(Math.abs(x - theirX) < bound, `${substeps}: x ${x} against ${theirX}`);
    assert.ok(Math.abs(v - theirV) < 1e-3, `${substeps}: v ${v} against ${theirV}`);
  }
  // Two and more: both bounce the ball back off the first wall at the speed it came with (restitution 1) and have it going left. Where they
  // leave it differs, and the difference is Rapier's: its substeps do not carry a body on through the whole of what is left of the step
  // (with two it is 3 cm past the first wall, with four 0.4 m left of the middle but still going left, having covered 3 of the 5 m), and
  // here it covers all of it: from the first wall across to the second (2 impacts: it stops there, going left) and back, 0.4 left of the middle.
  const [, v2] = mine(2);
  const [, theirV2] = theirs(2);
  assert.ok(Math.abs(v2 - theirV2) < 1e-3, `two: v ${v2} against ${theirV2}`);
  const [two, twoV] = mine(2);
  assert.ok(Math.abs(two + 1.35) < 0.02 && Math.abs(twoV + 300) < 1e-3, `two: ${two}, ${twoV}`);
  const [four, fourV] = mine(4);
  assert.ok(Math.abs(four + 0.4) < 0.02 && Math.abs(fourV - 300) < 1e-3, `four: ${four}, ${fourV}`);
});

test('minCcdDt, ccdTolerance and ccdMaxAdvances change where a sweep stops, by the 3D names and meanings', () => {
  const run = (options) => {
    const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
    physics.setSolver(options);
    physics.addBody(null, { type: 'fixed', position: [3, 0], colliders: { shape: 'box', width: 0.1, height: 10 } });
    const ball = physics.addBody(null, {
      ccd: true,
      canSleep: false,
      position: [0.6, 0],
      linearVelocity: [300, 0],
      colliders: { shape: 'circle', radius: 0.1, restitution: 0 },
    });
    physics.step();
    const x = ball.position[0];
    physics.dispose();
    return x;
  };
  assert.ok(Math.abs(run({}) - 2.85) < 0.01, 'by default it reaches the wall');
  assert.ok(Math.abs(run({ ccdMaxAdvances: 0 }) - 0.6) < 1e-4, 'with no advance it is held where the sweep began');
  assert.ok(
    Math.abs(run({ minCcdDt: 1 }) - 0.6) < 1e-4,
    'with an advance never worth taking it is held too, and never goes through',
  );
  assert.ok(
    run({ ccdTolerance: 0.001 }) > run({ ccdTolerance: 0.05 }) + 0.01,
    'a coarser tolerance stops farther from the wall',
  );
  for (const bad of [{ ccdTolerance: 0 }, { ccdMaxAdvances: 4097 }, { ccdMaxAdvances: 2.5 }, { minCcdDt: -1 }])
    assert.throws(() => run(bad), RangeError);
});
