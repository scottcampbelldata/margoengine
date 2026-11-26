import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroundLocomotion } from '@margoengine/physics/locomotion';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

const rate = { num: 60, den: 1 };
const zero = [0, 0, 0];
const centreFoot = { hip: zero, rest: [0, 0], phase: 0 };
const close = (actual, expected, scale = 1) =>
  assert.ok(Math.abs(actual - expected) <= 256 * Number.EPSILON * scale, actual + ' vs ' + expected);
const components = (actual, expected, scale) => actual.forEach((value, i) => close(value, expected[i], scale));

const build = async (bodies, options = {}, loaded = {}) => {
  const locomotion = await GroundLocomotion.load(loaded);
  const world = new PhysicsWorld({ rate, gravity: zero, ...options }).add(locomotion, { bodies });
  return { world, locomotion };
};

test('Hu equation 2 uses the same unit slip for forward, backward and transverse friction', async () => {
  const base = {
    kind: 'snake',
    mass: 2,
    length: 1,
    links: 1,
    radius: 0.1,
    stiffness: 5,
    damping: 0,
    frequency: 0,
    bend: 0,
    position: [0, 0.09, 0],
    friction: 0.2,
    reverseFriction: 0.4,
    lateralFriction: 0.3,
  };
  const { world, locomotion } = await build([
    { ...base, velocity: [3, 0, 4] },
    { ...base, velocity: [3, 0, -4] },
  ]);
  world.advance(1);
  const load = 5 * (0.1 - 0.09);
  for (const [index, speed, coefficient] of [
    [0, 4, 0.2],
    [1, -4, 0.4],
  ]) {
    const curve = [-load * 0.3 * (3 / 5), load, -load * coefficient * (speed / 5)];
    components(locomotion.readContact(index, 0).force, curve);
    components(locomotion.read(index).velocity, [3 + curve[0] / 120, curve[1] / 120, speed + curve[2] / 120], 5);
    assert.ok(curve[0] * 3 + curve[2] * speed < 0, 'passive ground friction dissipates slip energy');
  }
});

test('an animated slithering chain preserves exact length and cannot propel its COM in free flight', async () => {
  const links = 19;
  const length = 1.9;
  const spacing = length / links;
  const { world, locomotion } = await build([{ kind: 'snake', links, length, position: [0, 1, 0], frequency: 1 }]);
  const start = locomotion.readContact(0, 0);
  world.advance(11);
  const nodes = Array.from({ length: links }, (_, i) => locomotion.readContact(0, i));
  assert.notDeepEqual(nodes[0].axis, start.axis);
  const average = [0, 0, 0];
  for (const [i, node] of nodes.entries()) {
    components(node.force, zero);
    close(Math.hypot(...node.axis), 1);
    node.position.forEach((point, axis) => {
      average[axis] += point / links;
      if (i + 1 < links) {
        const next = nodes[i + 1];
        close(point + 0.5 * spacing * node.axis[axis], next.position[axis] - 0.5 * spacing * next.axis[axis], length);
      }
    });
  }
  const body = locomotion.read(0);
  components(average, [0, 1, 0]);
  assert.deepEqual(body.position, [0, 1, 0]);
  assert.deepEqual(body.velocity, zero);
  assert.deepEqual(body.angularMomentum, zero);
});

test('a passive leg delivers its axial spring load and clips friction to compression', async () => {
  const axisFoot = { ...centreFoot, rest: [0, 0.3] };
  const base = {
    kind: 'lizard',
    mass: 4,
    inertia: 1,
    stiffness: 40,
    damping: 0,
    legLength: 1,
    frequency: 0,
    push: 0,
    position: [0, 0.92, 0],
    feet: [centreFoot],
  };
  const { world, locomotion } = await build([base, { ...base, feet: [axisFoot], friction: 0.1 }]);
  world.advance(1);
  const straight = 40 * (1 - 0.92);
  components(locomotion.readContact(0, 0).force, [0, straight, 0]);
  close(locomotion.read(0).velocity[1], straight / (4 * 60));
  const length = Math.hypot(0.3, 0.92);
  const vertical = (40 * (1 - length) * 0.92) / length;
  components(locomotion.readContact(1, 0).force, [0, vertical, -0.1 * vertical]);
  close(locomotion.read(1).angularMomentum[0], (-0.92 * (-0.1 * vertical) - 0.3 * vertical) / 60);
  assert.equal(locomotion.readContact(0, 1).stance, false, 'torso collision is dormant on the leg spring');
});

test('feet in swing do not support gravity or generate a reaction wrench', async () => {
  const { world, locomotion } = await build(
    [
      {
        kind: 'insect',
        mass: 2,
        feet: [{ ...centreFoot, phase: 0.8 }],
        bodyRadius: 0.02,
        frequency: 0,
        stiffness: 15,
        position: [0, 1, 0],
        duty: 0.5,
        legLength: 2,
        swingHeight: 0.5,
      },
    ],
    { gravity: [0, -3, 0] },
  );
  world.advance(1);
  const foot = locomotion.readContact(0, 0);
  assert.equal(foot.stance, false);
  assert.ok(foot.position[1] > 0);
  assert.deepEqual(foot.force, zero);
  assert.deepEqual(foot.couple, zero);
  close(locomotion.read(0).velocity[1], -3 / 60);
});

test('the gait families alternate opposite groups and pin stance feet as the body travels', async () => {
  const kinds = ['lizard', 'insect', 'spider', 'crab'];
  const { world, locomotion } = await build(
    kinds.map((kind) => ({ kind, duty: 0.5, phase: 0.1 })),
    {
      gravity: [0, -9.80665, 0],
    },
  );
  const first = [];
  for (const [body, n] of [4, 6, 8, 8].entries()) {
    assert.equal(locomotion.contactCount(body), n + 1);
    let left = 0;
    for (let i = 0; i < n; i++) {
      const firstHalf = (Math.floor(i / 2) + (i % 2)) % 2 === 0;
      const point = locomotion.readContact(body, i);
      assert.equal(point.stance, firstHalf);
      if (point.stance) left++;
    }
    assert.equal(left, n / 2);
    first.push(locomotion.readContact(body, 0).position);
  }
  world.advance(1);
  first.forEach((foot, body) => assert.deepEqual(locomotion.readContact(body, 0).position, foot));
  world.advance(5);
  assert.equal(locomotion.readContact(1, 0).stance, false);
  assert.equal(locomotion.readContact(1, 1).stance, true);
});

test('default stance drives the four legged templates and crab translates across its body axis', async () => {
  const kinds = ['lizard', 'insect', 'spider', 'crab'];
  const gravity = [0, -9.80665, 0];
  const { world, locomotion } = await build(
    kinds.map((kind) => ({ kind })),
    { gravity },
  );
  world.advance(120);
  const targets = [0.35 * 0.06 * 3, 0.35 * 0.023 * 6, 0.35 * 0.045 * 4, 0.35 * 0.048 * 4];
  targets.forEach((target, body) => {
    const i = body === 3 ? 0 : 2;
    const pose = locomotion.read(body);
    assert.ok(pose.position[i] > target, kinds[body] + ' covers at least one second of its two-second command');
    assert.ok(pose.position[1] > 2 * [0.015, 0.00575, 0.01125, 0.012][body], 'body remains on its legs');
    close(Math.hypot(...pose.rotation), 1);
    assert.ok(Math.abs(pose.position[2 - i]) < 0.01 * pose.position[i]);
    for (let toe = 0; toe < locomotion.contactCount(body); toe++) {
      const { force, couple } = locomotion.readContact(body, toe);
      const lever = 0.5 * [0.06, 0.023, 0.045, 0.048][body];
      assert.ok(Math.hypot(force[0], force[2]) + Math.hypot(...couple) / lever <= 0.8 * force[1] + 1e-14);
    }
  });
});

test('an undulating snake advances on anisotropic ground and stays horizontally still with no traction', async () => {
  const { world, locomotion } = await build(
    [
      { kind: 'snake' },
      {
        kind: 'snake',
        friction: 0,
        lateralFriction: 0,
        reverseFriction: 0,
      },
    ],
    { gravity: [0, -9.80665, 0] },
  );
  world.advance(120);
  const loaded = locomotion.read(0);
  const smooth = locomotion.read(1);
  assert.ok(loaded.position[2] > 0.025, 'moves farther than one link radius in two wave periods');
  assert.equal(smooth.position[0], 0);
  assert.equal(smooth.position[2], 0);
  assert.ok(Math.abs(loaded.position[1] - 0.025 * 0.85) < 0.025 / 32, 'level-height spring equilibrium');
});

test('torso contact arrests a fall when the configured legs are out of reach', async () => {
  const { world, locomotion } = await build(
    [
      {
        kind: 'insect',
        feet: [{ ...centreFoot, phase: 0.75 }],
        bodyRadius: 0.09,
        mass: 1,
        inertia: 0.02,
        legLength: 0.02,
        frequency: 0,
        stiffness: 1000,
        position: [0, 0.25, 0],
        duty: 0.5,
      },
    ],
    { gravity: [0, -9.8, 0] },
  );
  world.advance(120);
  assert.equal(locomotion.readContact(0, 0).stance, false);
  assert.equal(locomotion.readContact(0, 1).stance, true);
  assert.ok(Math.abs(locomotion.read(0).position[1] - (0.09 - 9.8 / 1000)) < 1e-6);
});

test('kernel roles replay across shared and plain memory, including memory growth', async () => {
  const bodies = [{ kind: 'snake' }, { kind: 'spider' }];
  const gravity = [0, -9.80665, 0];
  const a = await build(bodies, { memory: worldMemory(false), gravity });
  const b = await build(bodies, { memory: worldMemory(true), gravity });
  for (const lane of [a, b]) lane.world.advance(17);
  assert.equal(a.world.hash(), b.world.hash());
  a.world.memory.grow(1);
  b.world.memory.grow(1);
  for (const lane of [a, b]) lane.world.advance(38);
  assert.equal(a.world.hash(), b.world.hash());
});

test('invalid options and indices tell callers how to repair the argument', async () => {
  const solver = await GroundLocomotion.load();
  assert.throws(
    () => new PhysicsWorld().add(solver, { bodies: [{ kind: 'snake', links: 0 }] }),
    /positive safe integer/,
  );
  assert.throws(() => new PhysicsWorld().add(solver, { bodies: [{ kind: 'crab', duty: 1 }] }), /strictly between/);
  assert.throws(
    () => new PhysicsWorld().add(solver, { bodies: [{ kind: 'spider', frequency: 1e30 }] }),
    /fastest physics world rate/,
  );
  assert.throws(() => solver.read(0), /configured ground animal/);
  await assert.rejects(GroundLocomotion.load({ signal: AbortSignal.abort() }), { name: 'AbortError' });
});
