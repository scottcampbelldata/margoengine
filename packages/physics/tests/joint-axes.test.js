// DYN-03 (docs/physics-parity-bar.md P3): limits and motors on every axis a joint leaves free, the joint debug view, and
// the joints' coded errors. Closed-form checks: a stop holds at its edge, a capped motor reaches its speed only when the
// cap covers the load, an arc is drawn at the radius and angles of its limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

const near = (got, want, within, what) => assert.ok(Math.abs(got - want) <= within, `${what}: ${got} against ${want}`);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Rotation vector of a unit quaternion. */
function rotationVector([x, y, z, w]) {
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, w);
  return [(x / s) * angle, (y / s) * angle, (z / s) * angle];
}

test('a ball joint holds each limited turn inside its range and leaves the others free', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    post = physics.addBody(null, { type: 'fixed', colliders: [] }),
    ball = physics.addBody(null, { position: [0, -1, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 1 } }),
    joint = physics.addJoint(post, ball, { type: 'spherical', anchorB: [0, 1, 0], limits: { angY: [-0.3, 0.3] } });
  joint.axisLimits('angY').forEach((v, k) => near(v, [-0.3, 0.3][k], 1e-7, 'angY limit reads back'));
  assert.equal(joint.axisLimits('angX'), null);
  ball.setAngularVelocity([0, 2, 0]); // about the limited axis
  for (let i = 0; i < 120; i++) physics.step();
  near(rotationVector(ball.rotation)[1], 0.3, 0.01, 'the turn about y stops at its limit');
  ball.setAngularVelocity([0, 0, 0]);
  joint.setAxisLimits('angX', -0.5, 0.5);
  ball.setAngularVelocity([-3, 0, 0]); // a swing about the pivot: the ball's centre moves at w x r
  ball.setLinearVelocity([0, 0, 3]);
  for (let i = 0; i < 120; i++) physics.step();
  near(rotationVector(ball.rotation)[0], -0.5, 0.02, 'a limit set later holds too');
  near(distance(ball.position, [0, 0, 0]), 1, 1e-3, 'the anchors still meet');
  assert.throws(() => joint.setAxisLimits('linX', 0, 1), { code: 'unsupported', message: /locks linX/ });
  assert.throws(() => joint.setRotationMotor([0, 0, 0, 1]), { code: 'unsupported', message: /cone joint/ });
  physics.dispose();
});

test('a ball joint motor on one turn reaches its speed when its cap covers the load, and stalls below it', () => {
  const spin = (maxForce) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      post = physics.addBody(null, { type: 'fixed', colliders: [] }),
      // A solid sphere of 2 kg and 0.5 m: I = 2/5 m r^2 = 0.2 kg m^2, so 2 rad/s in 1 s takes 0.4 N m.
      ball = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 2 } });
    physics.addJoint(post, ball, {
      type: 'spherical',
      motors: { angZ: { targetVelocity: 2, damping: 1e4, model: 'force', maxForce } },
    });
    for (let i = 0; i < 60; i++) physics.step();
    const w = ball.angularVelocity;
    physics.dispose();
    return w;
  };
  const free = spin(100);
  near(free[2], 2, 0.01, 'an uncapped motor spins at its target');
  near(Math.hypot(free[0], free[1]), 0, 1e-6, 'and only about its axis');
  // At a cap of 0.1 N m the spin grows by 0.1 / 0.2 = 0.5 rad/s each second: 0.5 rad/s after 60 steps of 1/60 s.
  near(spin(0.1)[2], 0.5, 0.02, 'a capped motor accelerates at cap / inertia');
});

test('a spring stops at its least and greatest length, and between them it is a spring', () => {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
    hook = physics.addBody(null, { type: 'fixed', colliders: [] }),
    // 10 kg on 100 N/m would hang 1 + 0.981 m down at rest; the stop at 1.5 m holds it there.
    weight = physics.addBody(null, { position: [0, -1, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 10 } }),
    spring = physics.addJoint(hook, weight, {
      type: 'spring',
      restLength: 1,
      stiffness: 100,
      damping: 20,
      maxLength: 1.5,
    });
  spring.axisLimits('linX').forEach((v, k) => near(v, [0, 1.5][k], 1e-7, 'spring stops read back'));
  for (let i = 0; i < 240; i++) physics.step();
  near(-weight.position[1], 1.5, 5e-3, 'held at its greatest length');
  near(spring.force[1], 98.1, 1, 'the stop and the spring carry the weight together');
  spring.setAxisLimits('linX', 0.5, 3);
  for (let i = 0; i < 600; i++) physics.step();
  near(-weight.position[1], 1.981, 0.01, 'inside its range it hangs at rest length plus m g / k');
  const strut = physics.addBody(null, { position: [3, -0.2, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } }),
    up = physics.addBody(null, { type: 'fixed', position: [3, 0, 0], colliders: [] });
  physics.addJoint(up, strut, { type: 'spring', restLength: 0, stiffness: 1000, minLength: 0.4 });
  for (let i = 0; i < 120; i++) physics.step();
  near(distance(strut.position, up.position), 0.4, 5e-3, 'held at its least length against a spring that pulls it in');
  assert.throws(() => spring.setAxisMotor('linX', { targetVelocity: 1 }), {
    code: 'unsupported',
    message: /spring itself/,
  });
  assert.throws(() => spring.setAxisLimits('linY', 0, 1), { code: 'unsupported', message: /linX/ });
  assert.throws(() => spring.setAxisLimits('linX', -1, 1), { code: 'unsupported', message: /from 0 up/ });
  assert.throws(
    () => physics.addJoint(hook, strut, { type: 'spring', restLength: 1, stiffness: 1, minLength: 2, maxLength: 1 }),
    { code: 'unsupported', message: /minLength <= maxLength/ },
  );
  physics.dispose();
});

test('a rope takes a least length too, and a hinge and a slider take their axis by name', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { type: 'fixed', colliders: [] }),
    b = physics.addBody(null, { position: [0, -1, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } }),
    rope = physics.addJoint(a, b, { type: 'rope', length: 2 });
  rope.setAxisLimits('linX', 0.8, 2);
  b.setLinearVelocity([0, 3, 0]);
  for (let i = 0; i < 60; i++) physics.step();
  near(distance(a.position, b.position), 0.8, 5e-3, 'a rope with a least length is a strut there');
  const hinge = physics.addJoint(
    a,
    physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1] } }),
    {
      type: 'revolute',
      axis: [0, 0, 1],
    },
  );
  hinge.setAxisLimits('angX', -1, 1);
  assert.deepEqual(hinge.limits, [-1, 1], 'angX is the hinge axis setLimits sets');
  assert.throws(() => hinge.setAxisLimits('angY', 0, 1), { code: 'unsupported', message: /locks angY/ });
  const cone = physics.addJoint(a, b, { type: 'cone', swing: 0.5 });
  assert.throws(() => cone.setAxisLimits('angX', 0, 1), { code: 'unsupported', message: /setCone/ });
  physics.dispose();
});

test('the joint debug view draws frame axes at the anchors and each limit where it is', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    post = physics.addBody(null, { type: 'fixed', position: [0, 2, 0], colliders: [] }),
    door = physics.addBody(null, { position: [0.5, 2, 0], colliders: { shape: 'box', halfExtents: [0.5, 1, 0.05] } });
  physics.addJoint(post, door, { type: 'revolute', axis: [0, 1, 0], anchorB: [-0.5, 0, 0], limits: [0, 1.5] });
  const plain = physics.debugRender({ colliders: false, contacts: false }),
    framed = physics.debugRender({
      colliders: false,
      contacts: false,
      jointFrames: true,
      style: { jointFrameLength: 1 },
    });
  const segments = (lines) => {
    const out = [];
    for (let i = 0; i < lines.vertices.length; i += 6) {
      out.push({
        a: [...lines.vertices.subarray(i, i + 3)],
        b: [...lines.vertices.subarray(i + 3, i + 6)],
        color: [...lines.colors.subarray((i / 3) * 4, (i / 3) * 4 + 4)],
      });
    }
    return out;
  };
  assert.equal(segments(plain).length, 3, 'without it: the joint line and one to each body');
  const extra = segments(framed).slice(3),
    gold = extra.filter((s) => Math.abs(s.color[0] - 1) < 1e-6 && Math.abs(s.color[1] - 0.8) < 1e-6),
    axes = extra.filter((s) => !gold.includes(s));
  assert.equal(axes.length, 6, 'three axes for each frame');
  // The hinge's frame A has x along +y (its axis), so the arc about it runs at radius 0.8 around the anchor at (0, 2, 0).
  const anchor = [0, 2, 0],
    rim = gold.filter((s) => distance(s.a, anchor) > 1e-6 && distance(s.b, anchor) > 1e-6);
  assert.ok(rim.length >= 6, `an arc of several segments (${rim.length})`);
  for (const s of rim) {
    near(distance(s.a, anchor), 0.8, 1e-5, 'arc radius');
    near(s.a[1], 2, 1e-5, 'the arc lies across the hinge axis');
  }
  // Its ends are the limits: the angle between the two spokes is 1.5 rad.
  const spokes = gold.filter((s) => distance(s.a, anchor) < 1e-6).map((s) => s.b.map((v, k) => v - anchor[k]));
  assert.equal(spokes.length, 2);
  const cos = (spokes[0][0] * spokes[1][0] + spokes[0][2] * spokes[1][2]) / 0.64;
  near(Math.acos(cos), 1.5, 1e-5, 'the spokes stand at min and max');
  physics.dispose();
});

test('the same joints give the same state hash, and a snapshot and restore step on to the same bits', () => {
  const build = () => {
    const physics = new Physics(null),
      top = physics.addBody(null, { type: 'fixed', position: [0, 3, 0], colliders: [] }),
      ball = physics.addBody(null, { position: [0.4, 2, 0.1], colliders: { shape: 'sphere', radius: 0.2, mass: 2 } }),
      bob = physics.addBody(null, {
        position: [1, 2.5, 0],
        colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass: 1 },
      });
    physics.addJoint(top, ball, {
      type: 'spherical',
      anchorB: [0, 1, 0],
      limits: { angX: [-0.4, 0.4], angZ: [-0.2, 0.6] },
      motors: { angY: { targetVelocity: 1, maxForce: 2 } },
    });
    physics.addJoint(top, bob, {
      type: 'spring',
      restLength: 0.5,
      stiffness: 300,
      damping: 4,
      minLength: 0.3,
      maxLength: 0.9,
    });
    ball.setAngularVelocity([1, 0.5, -2]);
    return physics;
  };
  const run = (physics, steps) => Array.from({ length: steps }, () => (physics.step(), physics.kernel.hash));
  const one = build(),
    two = build();
  assert.deepEqual(run(two, 90), run(one, 90), 'two runs agree at every step');
  const snapshot = one.takeSnapshot(),
    after = run(one, 60);
  one.restoreSnapshot(snapshot);
  assert.deepEqual(run(one, 60), after, 'restored, it steps on to the same bits');
  one.dispose();
  two.dispose();
});

test('joint errors are coded and carry the joints help link', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { type: 'fixed', colliders: [] }),
    b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1 } });
  assert.throws(() => physics.addJoint(a, b, { type: 'rope', length: -1 }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /positive finite.*; see https:\/\/margoengine\.com\/errors#physics-joints$/,
  });
  const joint = physics.addJoint(a, b, { type: 'fixed' });
  joint.remove();
  assert.throws(() => joint.setAnchorA([0, 0, 0]), { code: 'state', message: /#physics-joints$/ });
  physics.dispose();
});
