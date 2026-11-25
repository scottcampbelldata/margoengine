// A motorcycle: two wheels on tyres, a rider that steers into the fall, a lean that follows the turn and a counter-steer that starts it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Motorcycle, Physics } from '../dist/index.js';

await Physics.load();

/** A 250 kg bike at 10 m/s on a floor, wheels 1.4 m apart, upright (or leaning by `lean` radians toward +X to start with). */
function bike(options = {}, lean = 0, speed = 10) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [500, 0.5, 500], friction: 1 },
  });
  const chassis = physics.addBody(null, {
      position: [0, 0.95, 0],
      colliders: { shape: 'box', halfExtents: [0.15, 0.3, 0.9], mass: 250 },
    }),
    wheel = (z) => ({
      position: [0, -0.25, z],
      radius: 0.3,
      suspensionRestLength: 0.25,
      suspensionStiffness: 30,
      suspensionCompression: 4,
      suspensionRelaxation: 5,
    }),
    rider = new Motorcycle(physics, chassis, { front: wheel(0.7), rear: wheel(-0.7), ...options });
  chassis.setLinearVelocity([0, 0, speed]);
  // A turn about +Z by an angle tilts the up axis toward -X, so a lean toward +X is a turn by the negative.
  if (lean) chassis.setRotation([0, 0, Math.sin(-lean / 2), Math.cos(-lean / 2)]);
  return { physics, chassis, rider };
}
const cruise = (rider, input = {}) => rider.setInput({ throttle: rider.speed < 10 ? 0.3 : 0, ...input });

test('a rider steers into the fall and brings a bike that leans back upright, where one let go falls over', () => {
  const held = bike({}, 0.12);
  let worst = 0;
  for (let i = 0; i < 360; i++) {
    cruise(held.rider);
    held.physics.step();
    if (i > 240) worst = Math.max(worst, Math.abs(held.rider.lean));
  }
  assert.ok(worst < 0.03, `upright after four seconds: ${worst} rad`);
  assert.ok(held.rider.speed > 9, `still rolling: ${held.rider.speed}`);
  held.physics.dispose();
  const dropped = bike({ balance: false }, 0.12);
  for (let i = 0; i < 120; i++) dropped.physics.step();
  assert.ok(Math.abs(dropped.rider.lean) > 1.2, `without the rider it is on its side: ${dropped.rider.lean} rad`);
  dropped.physics.dispose();
});

test('a turn asked for becomes the lean that balances it, started by steering the other way', () => {
  for (const sign of [1, -1]) {
    const { physics, chassis, rider } = bike();
    for (let i = 0; i < 90; i++) {
      cruise(rider);
      physics.step();
    }
    let counter = 0;
    for (let i = 0; i < 120; i++) {
      cruise(rider, { steer: 0.5 * sign });
      physics.step();
      // The wheel is turned away from the turn at the start: the counter-steer.
      if (i < 20) counter = Math.max(counter, -sign * rider.steering);
    }
    const target = Math.atan2(0.5 * 7, 9.81);
    assert.ok(counter > 0.1, `counter-steered by ${counter} rad before leaning`);
    assert.ok(
      Math.abs(rider.lean - sign * target) < 0.35 * target,
      `lean ${rider.lean} follows the target ${sign * target}`,
    );
    assert.equal(Math.sign(rider.lean), sign, 'into the turn');
    // The sideways acceleration is what that lean holds: g tan(lean), within a third of it.
    const lateral = rider.speed * chassis.angularVelocity[1],
      held = 9.81 * Math.tan(rider.lean);
    assert.ok(
      Math.abs(lateral - held) < 0.4 * Math.abs(held) + 0.5,
      `lateral acceleration ${lateral} against the lean's ${held}`,
    );
    assert.equal(Math.sign(chassis.angularVelocity[1]), sign, 'and it turns that way');
    physics.dispose();
  }
});

test('a bike with its throttle on keeps going, and a motorcycle refuses what makes no sense', () => {
  const { physics, rider } = bike();
  for (let i = 0; i < 240; i++) {
    cruise(rider, { throttle: 0.5 });
    physics.step();
  }
  assert.ok(rider.speed > 11, `it accelerates: ${rider.speed}`);
  assert.ok(Math.abs(rider.lean) < 0.02, 'and stays upright');
  assert.throws(() => rider.setInput({ steer: Number.NaN }), RangeError);
  physics.dispose();
  const world = new Physics(null),
    chassis = world.addBody(null, { colliders: { shape: 'box', halfExtents: [0.15, 0.3, 0.9], mass: 250 } });
  assert.throws(() => new Motorcycle(world, chassis, {}), /front and a rear wheel/);
  const wheel = { position: [0, -0.25, 0.7], radius: 0.3 };
  assert.throws(() => new Motorcycle(world, chassis, { front: wheel, rear: wheel }), /wheels are apart/);
  assert.throws(
    () =>
      new Motorcycle(world, chassis, { front: wheel, rear: { ...wheel, position: [0, -0.25, -0.7] }, balanceGain: 0 }),
    /balanceGain/,
  );
  world.dispose();
});

test('the rider keeps a bike that leans up from 4 to 30 m/s, the gains scaled with the speed squared and the speed above 8 m/s', () => {
  for (const speed of [4, 6, 8, 12, 20, 30]) {
    for (const sign of [1, -1]) {
      const { physics, rider } = bike({}, 0.1 * sign, speed);
      let worst = 0;
      for (let i = 0; i < 480; i++) {
        rider.setInput({ throttle: rider.speed < speed ? 0.3 : 0 });
        physics.step();
        if (i > 300) worst = Math.max(worst, Math.abs(rider.lean));
        assert.ok(Math.abs(rider.lean) < 0.6, `speed ${speed}: it fell to ${rider.lean} rad at step ${i}`);
      }
      assert.ok(worst < 0.03, `speed ${speed}, lean ${0.1 * sign}: upright after five seconds: ${worst} rad`);
      assert.ok(rider.speed > 0.6 * speed, `speed ${speed}: still rolling at ${rider.speed}`);
      physics.dispose();
    }
  }
});
