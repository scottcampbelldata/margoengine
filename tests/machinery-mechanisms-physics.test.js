// Physics-joint models of the classic mechanisms track the closed-form poses of @margoengine/machinery/mechanisms: a crank driven by
// a hinge motor, the follower held by the kernel's joints (a hinge, a slider, a pin in a slot as a generic joint, a gear), stepped at
// 60 Hz. Each follower is compared with the pose function at the crank angle the simulation actually reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics, GearJoint } from '@margoengine/physics';
import {
  genevaPose,
  genevaCrankRadius,
  scotchYokePose,
  oldhamPose,
  epicyclicSpeeds,
} from '@margoengine/machinery/mechanisms';

await Physics.load();

const zAngle = (q) => 2 * Math.atan2(q[2], q[3]);
const zTurn = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
const unwrap = (angle, near) => angle + 2 * Math.PI * Math.round((near - angle) / (2 * Math.PI));
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);

function world() {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const ground = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: [] });
  return { physics, ground };
}
const disc = (physics, position, rotation = [0, 0, 0, 1]) =>
  physics.addBody(null, {
    position,
    rotation,
    colliders: { shape: 'cylinder', radius: 0.05, halfHeight: 0.01, mass: 1 },
  });
const crank = (physics, ground, speed, rotation) => {
  const body = disc(physics, [0, 0, 0], rotation);
  physics.addJoint(ground, body, { type: 'revolute', axis: [0, 0, 1], motor: { targetVelocity: speed, damping: 1e4 } });
  return body;
};

test('Scotch yoke: a slider and a pin in its slot follow r cos(t) exactly', () => {
  const { physics, ground } = world(),
    r = 0.142;
  const driver = crank(physics, ground, 2);
  const yoke = disc(physics, [r, 0, 0.05]);
  physics.addJoint(ground, yoke, { type: 'prismatic', axis: [1, 0, 0], anchorA: [r, 0, 0.05] });
  // The slot runs along the yoke's y; the pin may slide along it and turn about z.
  physics.addJoint(yoke, driver, {
    type: 'generic',
    anchorA: [0, 0, -0.05],
    anchorB: [r, 0, 0],
    locked: ['linX', 'linZ', 'angX', 'angY'],
  });
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    const t = zAngle(driver.rotation);
    worst = Math.max(worst, Math.abs(yoke.position[0] - scotchYokePose(t, r).slide));
  }
  assert.ok(zAngle(driver.rotation) !== 0, 'the crank turned');
  near(worst, 0, 2e-4, 'yoke travel against r cos(t)');
});

test('Geneva: the pin in a slot turns the wheel along genevaPose through a stroke', () => {
  const slots = 4,
    c = 0.32,
    r = genevaCrankRadius(slots, c),
    entry = -(Math.PI / 2 - Math.PI / slots);
  const { physics, ground } = world();
  const driver = crank(physics, ground, 1.5, zTurn(entry));
  // The wheel at rest before the stroke, its slot pointing back at the pin: at angle pi + pi/n in the wheel's frame.
  const wheel = disc(physics, [c, 0, 0.05]);
  physics.addJoint(ground, wheel, { type: 'revolute', axis: [0, 0, 1], anchorA: [c, 0, 0.05] });
  const slot = Math.PI + Math.PI / slots;
  physics.addJoint(wheel, driver, {
    type: 'generic',
    frameA: zTurn(slot),
    anchorA: [0, 0, -0.05],
    anchorB: [r, 0, 0],
    locked: ['linY', 'linZ', 'angX', 'angY'],
  });
  const start = genevaPose(entry, { slots, centerDistance: c }).wheel;
  let worst = 0,
    t = entry;
  while (t < -entry - 0.02) {
    physics.step();
    t = unwrap(zAngle(driver.rotation), t);
    const expected = genevaPose(t, { slots, centerDistance: c }).wheel - start;
    worst = Math.max(worst, Math.abs(unwrap(zAngle(wheel.rotation), expected) - expected));
  }
  assert.ok(
    unwrap(zAngle(wheel.rotation), -1.5) < -1.45,
    `the wheel indexed nearly a quarter turn (${zAngle(wheel.rotation)})`,
  );
  near(worst, 0, 2e-3, 'wheel angle against genevaPose');
});

test('Oldham: a disc on two crossed sliders carries the input angle to the offset shaft', () => {
  const { physics, ground } = world(),
    d = 0.104;
  const input = crank(physics, ground, 3);
  const output = disc(physics, [d, 0, 0.1]);
  physics.addJoint(ground, output, { type: 'revolute', axis: [0, 0, 1], anchorA: [d, 0, 0.1] });
  const middle = disc(physics, [d, 0, 0.05]);
  physics.addJoint(input, middle, {
    type: 'generic',
    anchorA: [d, 0, 0.05],
    locked: ['linY', 'linZ', 'angX', 'angY', 'angZ'],
  });
  physics.addJoint(output, middle, {
    type: 'generic',
    anchorA: [0, 0, -0.05],
    locked: ['linX', 'linZ', 'angX', 'angY', 'angZ'],
  });
  let worstAngle = 0,
    worstCentre = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    const t = zAngle(input.rotation),
      pose = oldhamPose(t, d);
    worstAngle = Math.max(worstAngle, Math.abs(unwrap(zAngle(output.rotation), t) - pose.output));
    worstCentre = Math.max(
      worstCentre,
      Math.hypot(middle.position[0] - pose.center[0], middle.position[1] - pose.center[1]),
    );
  }
  near(worstAngle, 0, 2e-3, 'output angle equals input');
  near(worstCentre, 0, 5e-4, 'disc centre on d cos(t) (cos t, sin t)');
});

test("Epicyclic: a gear joint at Willis's ratio turns the carrier at sun * Zs / (Zs + Zr) with the ring held", () => {
  const teeth = { sun: 21, planet: 18, ring: 57 };
  const { physics, ground } = world();
  const sun = crank(physics, ground, 2);
  const carrier = disc(physics, [0, 0, 0.5]); // apart from the sun: the two are not jointed, so they would collide
  physics.addJoint(ground, carrier, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0.5] });
  const { carrier: rate } = epicyclicSpeeds(teeth, { sun: 1, ring: 0 });
  new GearJoint(physics, sun, carrier, { ratio: -1 / rate });
  let t = 0,
    worst = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    t = unwrap(zAngle(sun.rotation), t);
    const expected = epicyclicSpeeds(teeth, { sun: t, ring: 0 }).carrier;
    worst = Math.max(worst, Math.abs(unwrap(zAngle(carrier.rotation), expected) - expected));
  }
  assert.ok(t > 6, `the sun turned (${t})`);
  near(worst, 0, 1e-3, 'carrier against Willis');
});
