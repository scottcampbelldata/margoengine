import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, Vehicle, brushTyre } from '@margoengine/physics';
import { bankedRoad } from '@margoengine/road/banking';
import { Spline } from '@margoengine/splines';
import { roadGrip, RoadSurfaces } from '../dist/driving.js';

await Physics.load();
const zero = [0, 0, 0];
const dt = 1 / 60;
const close = (actual, expected, bound) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} vs ${expected} ± ${bound}`);

function chassis(physics, mass = 100) {
  return physics.addBody(null, {
    position: [0, 0.55, 0],
    colliders: { shape: 'box', halfExtents: [0.15, 0.1, 0.15], mass },
  });
}
const roadWheel = { position: [0, 0, 0], radius: 0.3, suspensionStiffness: 10, cast: 'shape' };
const traction = { dry: 0.9, wet: 0.3 };

function surface(physics, { fixed = true, speed = 0, mass = 500 } = {}) {
  return physics.addBody(null, {
    type: fixed ? 'fixed' : 'dynamic',
    linearVelocity: [0, 0, speed],
    colliders: { shape: 'box', halfExtents: [3, 0.1, 6], mass },
  });
}

test('a banked road provides the actual kerb and bank collider and wet tire traction', async () => {
  const physics = new Physics(null, { gravity: zero });
  try {
    const surfaces = new RoadSurfaces();
    const spline = new Spline([
      [0, 0, -4],
      [0, 0, 0],
      [0, 0, 4],
    ]);
    const mesh = await bankedRoad(spline, { bank: 0.12 });
    const road = surfaces.add(physics, mesh, { traction, wetness: 0.5 });
    const right = physics.raycast([1, 1, 0], [0, -1, 0], { maxDistance: 2 });
    const left = physics.raycast([-1, 1, 0], [0, -1, 0], { maxDistance: 2 });
    assert.equal(right.collider.body, road);
    close(right.point[1] - left.point[1], 2 * Math.tan(0.12), 3e-6);
    const cart = chassis(physics);
    const vehicle = new Vehicle(physics, cart, {
      wheels: [roadWheel],
      groundMaterial: surfaces.sample,
      maxEngineForce: 1e4,
    });
    vehicle.setInput({ throttle: 1 });
    physics.step();
    assert.equal(vehicle.wheel(0).ground?.body, road);
    close(vehicle.wheelGround(0).grip, 0.6, 1e-12);
    close(vehicle.wheel(0).forwardImpulse, vehicle.wheel(0).load * 0.6 * dt, 1e-9);
    assert.equal(vehicle.wheelGround(0).sinkage, 0);
  } finally {
    physics.dispose();
  }
});

test('a moving deck carries surface velocity and receives the opposite normal and traction impulses', () => {
  const physics = new Physics(null, { gravity: zero });
  try {
    const deck = surface(physics, { fixed: false, speed: 1 });
    const car = chassis(physics);
    const contacts = new RoadSurfaces().register(deck.colliders[0], { traction });
    const vehicle = new Vehicle(physics, car, {
      wheels: [roadWheel],
      groundMaterial: contacts.sample,
      groundReaction: true,
    });
    vehicle.setInput({ brake: 1 });
    physics.step();
    const wheel = vehicle.wheel(0);
    assert.ok(wheel.inContact && wheel.forwardImpulse > 0 && wheel.ground.body === deck);
    assert.ok(car.linearVelocity[1] > 0 && deck.linearVelocity[1] < 0);
    assert.ok(car.linearVelocity[2] > 0 && deck.linearVelocity[2] < 1);
    close(500 * deck.linearVelocity[1] + 100 * car.linearVelocity[1], 0, 5e-7);
    close(500 * deck.linearVelocity[2] + 100 * car.linearVelocity[2], 500, 4e-5);
  } finally {
    physics.dispose();
  }
});

test('the supporting pressure and suspension force meet at the analytic Bekker sinkage', () => {
  const physics = new Physics(null, { gravity: zero });
  try {
    const bed = surface(physics);
    const car = chassis(physics);
    const contacts = new RoadSurfaces().register(bed.colliders[0], {
      traction: { ...traction, soil: { stiffness: 4000, exponent: 1, area: 0.25 } },
    });
    const vehicle = new Vehicle(physics, car, { wheels: [roadWheel], groundMaterial: contacts.sample });
    physics.step();
    const result = vehicle.wheelGround(0);
    close(result.sinkage, 0.075, 1e-6);
    close(vehicle.wheel(0).suspensionLength, 0.225, 1e-6);
    close(vehicle.wheel(0).load, 1000 * result.sinkage, 1e-4);
  } finally {
    physics.dispose();
  }
});

test('a fully slick surface bounds both slip forces of a physical tyre at exactly zero', () => {
  const physics = new Physics(null, { gravity: zero });
  try {
    const ground = surface(physics);
    const car = chassis(physics);
    const contacts = new RoadSurfaces().register(ground.colliders[0], { traction: { dry: 0, wet: 0 } });
    const vehicle = new Vehicle(physics, car, {
      wheels: [roadWheel],
      groundMaterial: contacts.sample,
      tyre: brushTyre(),
    });
    car.setLinearVelocity([1, 0, 1]);
    vehicle.setInput({ throttle: 1 });
    physics.step();
    const wheel = vehicle.wheel(0);
    assert.ok(wheel.load > 0);
    assert.equal(Math.abs(wheel.forwardImpulse) + Math.abs(wheel.sideImpulse), 0);
    assert.equal(car.linearVelocity[0], 1);
    assert.equal(car.linearVelocity[2], 1);
  } finally {
    physics.dispose();
  }
});

test('invalid road weather gives a repairable error', () => {
  assert.throws(() => roadGrip(traction, -1), /Choose normalized road wetness/);
  assert.throws(() => roadGrip({ dry: 0.4, wet: 0.8 }), /Choose finite road grip coefficients/);
});
