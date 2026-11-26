import assert from 'node:assert/strict';
import test from 'node:test';
import { Drivetrain, Physics, Vehicle, brushTyre } from '@margoengine/physics';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { AirSolver } from '@margoengine/physics/flight';
import { generateTouringCar } from '@margoengine/procedural/vehicles';
import { road } from '@margoengine/road';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { Spline } from '@margoengine/splines';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { frameRateIndependent, seekEqualsContinuous } from '../../../physics/tests/coupling/harness.js';
import {
  addRoadVehicle,
  ROAD_DRIVER_LAYOUT,
  ROAD_DRIVER_WORDS,
  roadCornerSpeed,
  roadDrivePath,
  roadGrip,
  RoadDriver,
  RoadSurfaces,
} from '../../dist/driving.js';

const frame60 = { num: 60, den: 1 };
const gravity = [0, -9.81, 0];
const traction = { dry: 0.8, wet: 0.25 };
const dt = 1 / 60;
const close = (actual, expected, bound = 1e-10) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} vs ${expected} ± ${bound}`);
await Physics.load();

function circular(radius, samples = 100) {
  return {
    points: Array.from({ length: samples + 1 }, (_, i) => {
      const angle = ((Math.PI / 2) * i) / samples;
      return [radius * (1 - Math.cos(angle)), 0, radius * Math.sin(angle)];
    }),
  };
}

test('Coulter goal curvature and the level-road speed bound match a measured circular lane', async () => {
  const radius = 20;
  const world = new PhysicsWorld({ rate: frame60, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: dt });
  try {
    const body = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [0.7, 0.2, 1.2] } });
    const path = circular(radius);
    const next = path.points[10];
    const lookAhead = Math.hypot(next[0], next[2]);
    const lane = await RoadDriver.create();
    world.add(new RigidSolver(), { physics });
    world.add(lane, { vehicles: [{ body: body.row, path, traction, maxSpeed: 25, lookAhead, wheelbase: 2.5 }] });
    world.advance(1);
    const command = lane.read(0);
    close(command.targetSpeed, Math.sqrt(traction.dry * Math.abs(gravity[1]) * radius), 1e-9);
    close(command.steer, Math.atan(2.5 / radius) / 0.5, 2 / (1 << 30));
    const port = world.fields.port(lane.commandsField.name);
    assert.equal(port.region.layout, ROAD_DRIVER_LAYOUT);
    assert.equal(regionWords(world.memory, port.region).length, ROAD_DRIVER_WORDS);
  } finally {
    physics.dispose();
  }
});

test('favourable bank increases the available speed by the force-balance amount', () => {
  const radius = 30;
  const bank = 0.1;
  const mu = traction.dry;
  const speed = roadCornerSpeed(1 / radius, -bank, mu);
  close(
    speed,
    Math.sqrt(
      (Math.abs(gravity[1]) * radius * (Math.sin(bank) + mu * Math.cos(bank))) / (Math.cos(bank) - mu * Math.sin(bank)),
    ),
  );
  assert.ok(roadCornerSpeed(1 / radius, bank, mu) < roadCornerSpeed(1 / radius, 0, mu));
  const slope = new Spline([
    [0, 0, 0],
    [0, 0, 5],
    [0, 0, 10],
  ]);
  const lane = roadDrivePath(slope, { bank, offset: 2 });
  close(lane.points[0][0], 2 * Math.cos(bank));
  close(lane.points[0][1], 2 * Math.sin(bank));
});

test('live ATMO-09 wetness reduces look-ahead corner speed', async () => {
  const speeds = [];
  for (const initialWater of [0, 1]) {
    const world = new PhysicsWorld({ rate: frame60, gravity, memory: worldMemory(false) });
    const physics = new Physics(null, { arena: world.arena, gravity });
    try {
      const store = new SurfaceEnergySolver();
      const driver = await RoadDriver.create({ wetnessField: store.wetnessField });
      const body = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [0.7, 0.2, 1.2] } });
      world.add(store, { initialWater, waterCapacity: 1 });
      world.add(new RigidSolver(), { physics });
      world.add(driver, { vehicles: [{ body: body.row, path: circular(20), traction, maxSpeed: 25, wheelbase: 2.5 }] });
      world.advance(2);
      const state = driver.read(0);
      close(state.wetness, store.read().wetness, 1e-9);
      close(state.targetSpeed, Math.sqrt(20 * Math.abs(gravity[1]) * roadGrip(traction, state.wetness)), 1e-9);
      speeds.push(state.targetSpeed);
    } finally {
      physics.dispose();
    }
  }
  assert.ok(speeds[1] < speeds[0] * 0.65);
});

function assemble(driver, frameRate = frame60, threaded = false, curveRadius = 0) {
  const world = new PhysicsWorld({ rate: frameRate, gravity, memory: worldMemory(threaded) });
  const physics = new Physics(null, { arena: world.arena, gravity });
  const points = curveRadius
    ? Array.from({ length: 21 }, (_, i) => {
        const theta = (i - 4) * 0.06;
        return [curveRadius * (1 - Math.cos(theta)), 0, curveRadius * Math.sin(theta)];
      })
    : [
        [0, 0, -8],
        [0, 0, 0],
        [0, 0, 16],
      ];
  const spline = new Spline(points);
  const path = roadDrivePath(spline);
  const surfaces = new RoadSurfaces();
  const ground = surfaces.add(physics, road(spline), { traction });
  const chassis = physics.addBody(null, {
    position: [0, 0.614, 0],
    colliders: { shape: 'box', halfExtents: [0.65, 0.18, 1.2], mass: 1200 },
  });
  const wheels = [-1, 1].flatMap((front) =>
    [-1, 1].map((side) => ({
      position: [0.65 * side, -0.15, 1.0 * front],
      radius: 0.3,
      width: 0.2,
      steer: front > 0,
      suspensionStiffness: 18,
      suspensionCompression: 2.5,
      suspensionRelaxation: 2.5,
      maxSuspensionForce: 8000,
    })),
  );
  const drivetrain = new Drivetrain({ axles: [{ wheels: [0, 1] }, { wheels: [2, 3] }] });
  const vehicle = new Vehicle(physics, chassis, {
    wheels,
    drivetrain,
    tyre: brushTyre(),
    groundMaterial: surfaces.sample,
  });
  world.add(new RigidSolver(), { physics });
  world.add(driver, {
    vehicles: [{ body: chassis.row, attachment: vehicle, path, traction, maxSpeed: 4, wheelbase: 2 }],
  });
  world.couple([driver.id, 'rigid'], 'staggered');
  const unbind = driver.bindVehicle(world, physics, 0);
  return { world, physics, driver, chassis, ground, vehicle, drivetrain, unbind };
}

test('the lane driver moves a real four-wheel vehicle and restores its running engine and wheel state', async () => {
  const { world, physics, driver, ground, chassis, vehicle, drivetrain, unbind } = assemble(await RoadDriver.create());
  try {
    world.advance(25);
    const before = world.takeSnapshot();
    world.advance(150);
    assert.ok(chassis.position[2] > 1);
    assert.ok(Math.abs(chassis.position[0]) < 1e-4);
    assert.equal(vehicle.wheel(0).ground.body, ground);
    assert.ok(driver.read(0).progress > 8);
    assert.ok(drivetrain.rpm > 0);
    const expected = world.hash();
    const state = new Float64Array(vehicle.motionStateWords);
    vehicle.writeMotionState(state);
    world.restoreSnapshot(before.bytes);
    world.advance(150);
    assert.equal(world.hash(), expected);
    const replay = new Float64Array(vehicle.motionStateWords);
    vehicle.writeMotionState(replay);
    assert.deepEqual(replay, state);
  } finally {
    unbind();
    physics.dispose();
  }
});

test('vehicle and road state are identical across display rates and a capped seek', async () => {
  const resources = [];
  const drivers = await Promise.all(Array.from({ length: 5 }, () => RoadDriver.create()));
  const make = (rate) => {
    const fixture = assemble(drivers.shift(), rate);
    resources.push(fixture);
    return fixture.world;
  };
  try {
    frameRateIndependent(make);
    seekEqualsContinuous(() => make({ num: 24, den: 1 }), { at: 7, frames: 36 });
  } finally {
    for (const { unbind, physics } of resources) {
      unbind();
      physics.dispose();
    }
  }
});

test('the bound tyre and drivetrain replay byte-for-byte in both arena memory modes', async () => {
  await Physics.load({ threads: true });
  const a = assemble(await RoadDriver.create(), frame60, false);
  const b = assemble(await RoadDriver.create(), frame60, true);
  try {
    a.world.advance(36);
    b.world.advance(36);
    const saved = b.world.takeSnapshot();
    a.world.advance(120);
    b.world.advance(120);
    assert.equal(a.world.hash(), b.world.hash());
    b.world.restoreSnapshot(saved.bytes);
    b.world.advance(120);
    assert.equal(b.world.hash(), a.world.hash());
  } finally {
    for (const { physics, unbind } of [a, b]) {
      unbind();
      physics.dispose();
    }
  }
});

test('procedural car dimensions become a massive chassis and receive the actual Weather boundary layer on the world clock', async () => {
  const plant = generateTouringCar();
  const wind = new BoundaryLayerWind({ speed: 10, referenceHeight: 2, direction: 0, turbulence: false });
  const world = new PhysicsWorld({ rate: frame60, gravity: [0, 0, 0], memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0] });
  try {
    const wheels = [{ position: [0, 0, 0], radius: 0.38, axle: [0, 0, 1] }];
    const car = await addRoadVehicle(physics, null, {
      size: plant.size,
      mass: 480,
      position: [0, 2, 0],
      wheels,
      forward: [1, 0, 0],
      wind,
    });
    const control = await addRoadVehicle(physics, null, {
      size: plant.size,
      mass: 480,
      position: [0, 2, 8],
      wheels,
      forward: [1, 0, 0],
    });
    assert.ok(plant.parts.body?.positions?.length || Object.keys(plant.parts).length > 1);
    close(car.body.mass, 480, 4e-5);
    const air = new AirSolver();
    world.add(new RigidSolver(), { physics });
    world.add(air, { physics });
    world.couple([air.id, 'rigid'], 'staggered');
    world.advance(60);
    assert.ok(car.body.linearVelocity[0] > 0.01);
    close(control.body.linearVelocity[0], 0);
    const saved = world.takeSnapshot();
    world.advance(120);
    const expected = world.hash();
    world.restoreSnapshot(saved.bytes);
    world.advance(120);
    assert.equal(world.hash(), expected);
  } finally {
    physics.dispose();
  }
});

test('four real wheels steer the chassis through the curved road collider', async () => {
  const radius = 20;
  const { world, physics, vehicle, driver, chassis, unbind, ground } = assemble(await RoadDriver.create(), frame60, false, radius);
  try {
    world.advance(210);
    assert.equal(vehicle.wheel(0).ground?.body, ground);
    assert.ok(chassis.position[2] > 3);
    assert.ok(chassis.position[0] > 0.1);
    const radialError = Math.abs(Math.hypot(chassis.position[0] - radius, chassis.position[2]) - radius);
    assert.ok(radialError < 0.32, `Lane tracking error ${radialError} m`);
    assert.ok(driver.read(0).steer > 0);
  } finally {
    unbind();
    physics.dispose();
  }
});
