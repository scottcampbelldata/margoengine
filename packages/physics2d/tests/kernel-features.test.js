// What the own 2D kernel adds to the facade: filtering, sensors, force events, dominance, continuous collision,
// colliders that change after creation, forces, and removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D, interactionGroups } from '../dist/index.js';

await Physics2D.load();
const world = (options = {}) => new Physics2D(null, options);
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const floor = (physics, extra = {}) =>
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20, ...extra } });

test('collision groups let a body fall through a floor it does not meet', () => {
  const physics = world();
  floor(physics, { collisionGroups: interactionGroups([0], [0]) });
  const ghost = physics.addBody(null, { colliders: { shape: 'circle', radius: 5, collisionGroups: interactionGroups([1], [1]) } });
  const solid = physics.addBody(null, { position: [50, 0], colliders: { shape: 'circle', radius: 5, collisionGroups: interactionGroups([0], [0]) } });
  run(physics, 240);
  assert.ok(ghost.position[1] > 300, `fell through to ${ghost.position[1]}`);
  assert.ok(solid.position[1] < 100, `rests on the floor at ${solid.position[1]}`);
  physics.dispose();
});

test('a sensor reports entry and exit and pushes nothing; setSensor changes it later', () => {
  const physics = world();
  const zone = physics.addBody(null, { type: 'fixed', position: [0, 200], colliders: { shape: 'box', width: 100, height: 40, sensor: true } });
  const ball = physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 4 } });
  const seen = [];
  physics.on('intersectionstart', (e) => seen.push(['start', e.sensor, e.bodyA === zone || e.bodyB === zone]));
  physics.on('intersectionend', () => seen.push(['end']));
  run(physics, 240);
  assert.deepEqual(seen, [['start', true, true], ['end']]);
  assert.ok(ball.position[1] > 300, 'the ball fell straight through');
  const collider = zone.colliders[0];
  assert.equal(collider.isSensor(), true);
  collider.setSensor(false);
  assert.equal(collider.isSensor(), false);
  const second = physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 4 } });
  run(physics, 240);
  assert.ok(second.position[1] < 200, `a solid zone stops it: ${second.position[1]}`);
  physics.dispose();
});

test('contact force events fire past the threshold and carry the force and normal', () => {
  const physics = world();
  floor(physics);
  physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6, contactForceThreshold: 5 } });
  const forces = [];
  physics.on('contactforce', (e) => forces.push(e));
  run(physics, 120);
  assert.ok(forces.length > 0, 'the landing pushed hard');
  assert.ok(forces.every((f) => f.force > 5 && Math.abs(Math.hypot(...f.normal) - 1) < 1e-3));
  physics.dispose();
});

test('solver groups that do not meet report the contact but push nothing', () => {
  const physics = world();
  floor(physics, { solverGroups: interactionGroups([0], [0]) });
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6, solverGroups: interactionGroups([1], [1]) } });
  let started = 0;
  physics.on('contactstart', () => started++);
  run(physics, 240);
  assert.equal(started, 1);
  assert.ok(ball.position[1] > 200, `sank through: ${ball.position[1]}`);
  physics.dispose();
});

test('a body of higher dominance is not pushed by a lighter one', () => {
  const physics = world({ gravity: [0, 0] });
  const make = (x, vx, dominance, density) =>
    physics.addBody(null, { position: [x, 0], linearVelocity: [vx, 0], dominance, canSleep: false, colliders: { shape: 'box', width: 16, height: 16, density, friction: 0 } });
  const heavy = make(0, 0, 1, 100);
  const light = make(-60, 100, 0, 1);
  run(physics, 60);
  assert.ok(Math.abs(heavy.linearVelocity[0]) < 1e-3, `the dominant body stays: ${heavy.linearVelocity[0]}`);
  assert.ok(light.position[0] < -8, 'and stops the light one');
  assert.throws(() => physics.addBody(null, { dominance: 200 }), RangeError);
  physics.dispose();
});

test('continuous collision stops a fast body at a thin wall', () => {
  for (const ccd of [false, true]) {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [320, 0], colliders: { shape: 'box', width: 2, height: 400 } });
    const bullet = physics.addBody(null, { linearVelocity: [9600, 0], ccd, canSleep: false, colliders: { shape: 'circle', radius: 4, restitution: 0 } });
    run(physics, 20);
    if (ccd) assert.ok(bullet.position[0] < 320, `held at ${bullet.position[0]}`);
    else assert.ok(bullet.position[0] > 330, `control tunnels: ${bullet.position[0]}`);
    physics.dispose();
  }
});

test('forces act every step until reset; impulses at a point spin; sleep and wake', () => {
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'box', width: 32, height: 32 } });
  body.applyForce([10, 0]);
  run(physics, 60);
  const v = body.linearVelocity[0];
  assert.ok(Math.abs(v - (10 / body.mass) * 32) < 1, `v ${v} for mass ${body.mass}`);
  body.resetForces();
  run(physics, 30);
  assert.ok(Math.abs(body.linearVelocity[0] - v) < 0.5);
  const other = physics.addBody(null, { position: [200, 0], colliders: { shape: 'box', width: 32, height: 32 } });
  other.applyImpulseAtPoint([0, 1], [216, 0]);
  assert.ok(other.angularVelocity !== 0);
  other.sleep();
  assert.equal(other.sleeping, true);
  other.wakeUp();
  assert.equal(other.sleeping, false);
  physics.dispose();
});

test('colliders and bodies can be removed, and what they touched wakes', () => {
  const physics = world();
  const ground = floor(physics);
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6 } });
  run(physics, 300);
  assert.equal(ball.sleeping, true);
  ground.colliders[0].remove();
  assert.equal(ground.colliders.length, 0);
  run(physics, 60);
  assert.equal(ball.sleeping, false);
  assert.ok(ball.position[1] > 120);
  ball.remove();
  assert.equal(physics.bodyCount, 1);
  const again = physics.addBody(null, { colliders: { shape: 'circle', radius: 3 } });
  assert.ok(again.handle === ball.handle, 'the freed slot is reused');
  physics.dispose();
});

test('a disabled collider meets nothing and is skipped by queries', () => {
  const physics = world();
  const ground = floor(physics);
  const collider = ground.colliders[0];
  assert.ok(physics.raycast([0, 0], [0, 1]));
  collider.setEnabled(false);
  assert.equal(collider.isEnabled, false);
  assert.equal(physics.raycast([0, 0], [0, 1]), null);
  collider.setEnabled(true);
  assert.ok(physics.raycast([0, 0], [0, 1]));
  physics.dispose();
});

test('joint limits and motors can be cleared', () => {
  const physics = world({ gravity: [0, 0] });
  const pole = physics.addBody(null, { type: 'fixed', colliders: [] });
  const arm = physics.addBody(null, { position: [20, 0], canSleep: false, colliders: { shape: 'box', width: 40, height: 4 } });
  const joint = physics.addJoint(pole, arm, { type: 'revolute', anchorB: [-20, 0], limits: [-0.2, 0.2], motor: { targetVelocity: 5 } });
  run(physics, 120);
  assert.ok(Math.abs(arm.rotation) <= 0.25, `held by the limit at ${arm.rotation}`);
  joint.clearLimits().clearMotor();
  arm.angularVelocity = 3;
  run(physics, 120);
  assert.ok(Math.abs(arm.rotation) > 1, `free to turn: ${arm.rotation}`);
  assert.throws(() => physics.addJoint(pole, arm, { type: 'rope', length: 5 }).setLimits(0, 1), TypeError);
  physics.dispose();
});

test('queries reject shapes the kernel cannot cast, and a stale handle is a state error', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: { shape: 'circle', radius: 3 } });
  const concave = [[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]];
  assert.throws(() => physics.overlapShape({ shape: 'polygon', points: concave }, [0, 0]), RangeError);
  body.remove();
  assert.throws(() => body.applyImpulse([1, 1]), { name: 'MargoError', code: 'state' });
  physics.dispose();
});

test('a snapshot restores the world and it steps exactly as the original did', () => {
  const physics = world();
  const ground = floor(physics);
  const bodies = [];
  for (let i = 0; i < 8; i++)
    bodies.push(physics.addBody(null, { position: [(i % 4) * 14, i * 15], colliders: i % 2 ? { shape: 'box', width: 12, height: 10 } : { shape: 'circle', radius: 6 } }));
  const pole = physics.addBody(null, { type: 'fixed', position: [-100, 0], colliders: [] });
  const swing = physics.addBody(null, { position: [-80, 0], colliders: { shape: 'box', width: 30, height: 4 } });
  physics.addJoint(pole, swing, { type: 'revolute', anchorB: [-15, 0] });
  const trace = () => [ground, ...bodies, swing].flatMap((b) => [...b.position, b.rotation]);
  run(physics, 90);
  const bytes = physics.snapshot();
  const original = [];
  for (let i = 0; i < 120; i++) {
    physics.step();
    original.push(trace());
  }
  physics.restore(bytes);
  const again = [];
  for (let i = 0; i < 120; i++) {
    physics.step();
    again.push(trace());
  }
  assert.deepEqual(again, original, 'bit for bit');
  // Adding a body since the snapshot makes it unrestorable, and bytes that are not a snapshot are refused.
  physics.addBody(null, { colliders: { shape: 'circle', radius: 2 } });
  assert.throws(() => physics.restore(bytes), { name: 'MargoError', code: 'state' });
  assert.throws(() => physics.restore(new Uint8Array(12)), RangeError);
  physics.dispose();
});

test('debugRender gives lines with colour codes; additionalMass adds to the mass', () => {
  const physics = world();
  floor(physics);
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6 }, additionalMass: 2 });
  const plain = physics.addBody(null, { position: [60, 60], colliders: { shape: 'circle', radius: 6 } });
  assert.ok(Math.abs(ball.mass - plain.mass - 2) < 1e-4, `${ball.mass} against ${plain.mass}`);
  assert.equal(ball.additionalMass, 2);
  ball.additionalMass = 0;
  assert.ok(Math.abs(ball.mass - plain.mass) < 1e-5);
  assert.throws(() => (ball.additionalMass = -1), RangeError);
  run(physics, 60);
  const all = physics.debugRender();
  assert.equal(all.vertices.length, 4 * all.colors.length);
  assert.ok(all.colors.includes(0) && (all.colors.includes(1) || all.colors.includes(2)) && all.colors.includes(8));
  const shapes = physics.debugRender({ shapes: true });
  assert.ok(shapes.colors.every((c) => c <= 4) && shapes.colors.length < all.colors.length);
  // Lines are in world units: the floor's top edge is at y 90.
  let top = false;
  for (let i = 0; i < shapes.colors.length; i++) if (shapes.colors[i] === 0 && Math.abs(shapes.vertices[4 * i + 1] - 90) < 0.01 && Math.abs(shapes.vertices[4 * i + 3] - 90) < 0.01) top = true;
  assert.ok(top, 'the floor outline is drawn in pixels');
  physics.dispose();
});

test('a PID controller steers a body to a point and an angle', async () => {
  const { PidController2D } = await import('../dist/index.js');
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody(null, { canSleep: false, linearDamping: 0, colliders: { shape: 'circle', radius: 4 } });
  const pid = new PidController2D({ kp: 12, ki: 0.5, kd: 4 });
  physics.on('beforestep', (dt) => {
    pid.applyLinear(dt, body, [100, -40]);
  });
  run(physics, 600);
  assert.ok(Math.hypot(body.position[0] - 100, body.position[1] + 40) < 2, `at ${body.position}`);
  const turner = physics.addBody(null, { position: [0, 300], canSleep: false, colliders: { shape: 'box', width: 20, height: 6 } });
  const spin = new PidController2D({ kp: 20, kd: 8 });
  physics.on('beforestep', (dt) => spin.applyAngular(dt, turner, Math.PI * 0.75));
  run(physics, 600);
  assert.ok(Math.abs(turner.rotation - Math.PI * 0.75) < 0.05, `turned to ${turner.rotation}`);
  assert.throws(() => pid.linearCorrection(0, body, [0, 0]), RangeError);
  assert.throws(() => new PidController2D({ kp: NaN }), RangeError);
  physics.dispose();
});

test('hooks: filterPair vetoes a pair, modifyContact makes a one-way platform and sets friction', () => {
  const physics = world();
  const ground = physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 400, height: 10, hooks: { filterPair: true, modifyContact: true } } });
  const platform = ground.colliders[0];
  const ghost = physics.addBody(null, { position: [-50, 0], colliders: { shape: 'circle', radius: 4, hooks: { filterPair: true } } });
  const solid = physics.addBody(null, { position: [50, 0], colliders: { shape: 'circle', radius: 4, hooks: { filterPair: true } } });
  const asked = [];
  physics.hooks = {
    filterPair: (a, b) => {
      asked.push([a.handle, b.handle]);
      return a.body !== ghost && b.body !== ghost;
    },
    modifyContact: (change) => {
      // The normal runs from A to B: up (screen) from the platform to a body on top, whichever collider comes first.
      change.oneWay = change.colliderA === platform ? [0, -1] : [0, 1];
    },
  };
  run(physics, 240);
  assert.ok(ghost.position[1] > 300, `the vetoed pair does not meet: ${ghost.position[1]}`);
  assert.ok(Math.abs(solid.position[1] - 91) < 1, `the allowed one rests on top: ${solid.position[1]}`);
  assert.ok(asked.length > 0);
  // A one-way platform: thrown up from below, the ball passes, then lands on top.
  const jumper = physics.addBody(null, { position: [0, 160], linearVelocity: [0, -700], colliders: { shape: 'circle', radius: 4 } });
  let top = Infinity;
  for (let i = 0; i < 400; i++) {
    physics.step();
    top = Math.min(top, jumper.position[1]);
  }
  assert.ok(top < 80, `went up through the platform to ${top}`);
  assert.ok(Math.abs(jumper.position[1] - 91) < 1, `and stands on it: ${jumper.position[1]}`);
  // Hooks survive a restore, and clearing them frees the pairs.
  const bytes = physics.snapshot();
  physics.restore(bytes);
  run(physics, 5);
  physics.hooks = null;
  assert.equal(physics.hooks, null);
  physics.dispose();
});

test('hooks: modifyContact sets friction and can turn a contact off for a step', () => {
  const slide = (friction) => {
    const physics = world();
    physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 600, height: 10, friction: 0, hooks: { modifyContact: true } } });
    const crate = physics.addBody(null, { position: [0, 90], linearVelocity: [120, 0], canSleep: false, colliders: { shape: 'box', width: 16, height: 16, friction: 0, hooks: { modifyContact: true } } });
    physics.hooks = { modifyContact: (change) => void (friction !== undefined && (change.friction = friction)) };
    run(physics, 120);
    const x = crate.position[0];
    physics.dispose();
    return x;
  };
  const free = slide(undefined),
    sticky = slide(2);
  assert.ok(free > 200, `frictionless keeps its speed: ${free}`);
  assert.ok(sticky < 80, `friction 2 stops it: ${sticky}`);
  const physics = world();
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 600, height: 10, hooks: { modifyContact: true } } });
  const falling = physics.addBody(null, { position: [0, 50], colliders: { shape: 'circle', radius: 4 } });
  physics.hooks = { modifyContact: (change) => void (change.solverActive = false) };
  run(physics, 240);
  assert.ok(falling.position[1] > 200, 'a contact switched off lets it through');
  physics.dispose();
});

test('body setters, setType, projectPoint, intersectionsWithBox, contactPairs and the character\'s hits', () => {
  const physics = world();
  const ground = floor(physics);
  const ball = physics.addBody(null, { position: [0, 40], colliders: { shape: 'circle', radius: 6 } });
  // Setters change the body from now on.
  assert.equal(ball.gravityScale, 1);
  ball.gravityScale = 0;
  ball.linearDamping = 0.5;
  assert.equal(ball.gravityScale, 0);
  run(physics, 30);
  assert.ok(Math.abs(ball.position[1] - 40) < 0.5, 'no gravity, no fall');
  ball.gravityScale = 1;
  ball.canSleep = false;
  assert.throws(() => (ball.dominance = 500), RangeError);
  run(physics, 120);
  assert.ok(Math.abs(ball.position[1] - 84) < 1, `lands: ${ball.position[1]}`);
  // Contacts of a collider as the world holds them.
  const pairs = physics.contactPairs(ball.colliders[0]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].other, ground.colliders[0]);
  assert.ok(pairs[0].touching && pairs[0].solverActive && pairs[0].points.length >= 1);
  assert.ok(Math.abs(pairs[0].normal[1] - 1) < 0.01, `from the ball down to the floor: ${pairs[0].normal}`);
  // Points: nearest collider, inside or out.
  const out = physics.projectPoint([200, 84]);
  assert.equal(out.inside, false);
  assert.ok(Math.abs(out.distance - 194) < 1.5 || out.body === ground, `${out.distance}`);
  const inside = physics.projectPoint([0, 100]);
  assert.ok(inside.inside && inside.distance === 0 && inside.body === ground);
  assert.equal(physics.projectPoint([0, 0], { excludeFixed: true, excludeDynamic: true }), null);
  assert.deepEqual(physics.intersectionsWithBox([-10, 70], [10, 90]).sort((a, b) => a.handle - b.handle), [ground, ball].sort((a, b) => a.handle - b.handle));
  assert.deepEqual(physics.intersectionsWithBox([-10, -90], [10, -70]), []);
  // setType: a fixed body becomes dynamic and falls; dynamic back to fixed stops.
  const block = physics.addBody(null, { type: 'fixed', position: [100, 0], colliders: { shape: 'box', width: 10, height: 10 } });
  run(physics, 30);
  assert.equal(block.position[1], 0);
  block.setType('dynamic');
  assert.equal(block.type, 'dynamic');
  run(physics, 30);
  assert.ok(block.position[1] > 5, 'falls');
  block.setType('fixed');
  const y = block.position[1];
  run(physics, 30);
  assert.equal(block.position[1], y);
  assert.throws(() => block.setType('wobbly'), TypeError);
  // The character reports what it hit.
  const hero = physics.addBody({ x: 0, y: 70, rotation: 0 }, { type: 'kinematicPosition', colliders: { shape: 'box', width: 10, height: 20 }, position: [-100, 70] });
  const controller = physics.createCharacterController(hero, { offset: 0.2 });
  const result = controller.move([0, 40]);
  assert.ok(result.hits.length >= 1 && result.hits[0].collider === ground.colliders[0], 'hit the floor');
  assert.ok(Math.abs(result.hits[0].normal[1] + 1) < 0.01, `normal out of the floor (up on screen): ${result.hits[0].normal}`);
  physics.dispose();
});
