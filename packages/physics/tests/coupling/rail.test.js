import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RAIL_CAR_LAYOUT,
  RAIL_CAR_WORDS,
  RailRoute,
  RailSolver,
  railCreepForce,
  railRouteAtSwitches,
} from '@margoengine/physics/rail';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { generateLocomotive } from '@margoengine/procedural/vehicles';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const RATE = { num: 60, den: 1 };
const GRAVITY = [0, -9.80665, 0];
const RADIUS = 0.35;
const MASS = 24000 + 2 * 2000 + 4 * 650;
const close = (actual, expected, bound) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} differs from ${expected} by more than ${bound}`);

function route({ radius = 0, bank = 0, joint = 0, slope = 0, length = 240 } = {}) {
  return new RailRoute(
    Array.from({ length: length / 2 + 1 }, (_, i) => {
      const s = 2 * i,
        a = radius ? s / radius : 0;
      return {
        centre: radius ? [radius * (1 - Math.cos(a)), slope * s, radius * Math.sin(a)] : [0, slope * s, s],
        cant: bank,
        leftHeight: i === 26 ? joint : 0,
        rightHeight: i === 26 ? joint : 0,
      };
    }),
  );
}

function setup(track, car = {}, rate = RATE, shared = false) {
  const world = new PhysicsWorld({ rate, gravity: GRAVITY, memory: worldMemory(shared) });
  const rail = new RailSolver();
  world.add(rail, { cars: [{ track, distance: 42, speed: 10, ...car }] });
  return { world, rail };
}

test('Polach force reduces to Kalker at low creep, opposes slip and obeys the adhesion bound', () => {
  const adhesion = { friction: 0.32, highSlipRatio: 0.58, decay: 0, adhesionFactor: 0.86, slipFactor: 0.58 };
  const normal = 12000,
    creepStiffness = 600000,
    V = 10,
    slip = 1e-8;
  const g = (x, y, patch = adhesion) =>
    railCreepForce({
      slip: [x, y],
      rollingSpeed: V,
      normal,
      creepStiffness,
      adhesion: patch,
    });
  close(g(slip, 0)[0] / slip, ((-creepStiffness / V) * (adhesion.adhesionFactor + adhesion.slipFactor)) / 2, 1e-7);
  const largeSlip = 1e8;
  const epsAtLimit = (Math.PI * creepStiffness * largeSlip) / (4 * V * normal * adhesion.friction);
  const adhesionBound = adhesion.friction * normal;
  const remainder = adhesionBound + g(largeSlip, 0)[0];
  assert.ok(remainder >= 0 && remainder <= (2 * adhesionBound) / (Math.PI * adhesion.slipFactor * epsAtLimit));
  const force = g(0.08, -0.06);
  const epsilon = (Math.PI * creepStiffness * 0.01) / (4 * normal * adhesion.friction);
  const a = adhesion.adhesionFactor * epsilon;
  const expected =
    ((2 * normal * adhesion.friction) / Math.PI) * (a / (1 + a * a) + Math.atan(adhesion.slipFactor * epsilon));
  close(Math.hypot(...force), expected, 1e-9);
  assert.ok(force[0] < 0 && force[1] > 0);
  assert.deepEqual(g(0.1, 0.2, { ...adhesion, friction: 0 }), [0, 0]);
});

test('turnout choices use the authored branch and preserve the common surveyed approach', () => {
  const stations = (...pairs) => pairs.map(([x, z]) => ({ centre: [x, 0, z] }));
  const sections = [
    { name: 'approach', stations: stations([0, 0], [0, 20]), next: ['main', 'loop'] },
    { name: 'main', stations: stations([0, 20], [0, 40]) },
    { name: 'loop', stations: stations([0, 20], [5, 40]) },
  ];
  const through = railRouteAtSwitches(sections, 'approach');
  const loop = railRouteAtSwitches(sections, 'approach', { approach: 'loop' });
  assert.deepEqual(through.sample(10).centre, loop.sample(10).centre);
  assert.deepEqual(loop.sample(loop.length).centre, [5, 0, 40]);
  assert.deepEqual(through.sample(through.length).centre, [0, 0, 40]);
  assert.equal(loop.sample(loop.length + 1).supported, false);
  assert.throws(() => railRouteAtSwitches(sections, 'approach', { approach: 'other' }), /authored outgoing/);
});

test('LAST-TRAM-1: a loaded four-axle car rolls the measured distance at omega = v/r', () => {
  const { world, rail } = setup(route());
  world.advance(120);
  const car = rail.read(0);
  close(car.distance, 62, 4e-12);
  close(car.speed, 10, 1e-12);
  close(car.longitudinalForce, 0, 1e-8);
  for (const wheel of car.wheelsets) {
    close(wheel.angle, 20 / RADIUS, 2e-12);
    close(wheel.angularVelocity, 10 / RADIUS, 1e-12);
    close(wheel.leftLoad, (MASS * -GRAVITY[1]) / 8, 1e-7);
    close(wheel.rightLoad, wheel.leftLoad, 1e-9);
  }
  const port = world.fields.port(rail.carField.name);
  assert.equal(port.region.layout, RAIL_CAR_LAYOUT);
  assert.equal(regionWords(world.memory, port.region).length, RAIL_CAR_WORDS);
});

test('LAST-TRAM-1/2: curvature turns the bogie and a balanced cant cancels most sprung roll', () => {
  const radius = 100,
    speed = 10;
  const bank = Math.atan((speed * speed) / (radius * -GRAVITY[1]));
  const flat = setup(route({ radius }));
  const canted = setup(route({ radius, bank }));
  flat.world.advance(120);
  canted.world.advance(120);
  const a = flat.rail.read(0),
    b = canted.rail.read(0);
  const equilibrium = (24000 * 1.05 * ((speed * speed) / radius)) / (2 * 190000 * (1.435 / 2) ** 2);
  close(-a.roll, equilibrium, 0.007);
  assert.ok(Math.abs(b.roll) < Math.abs(a.roll) * 0.03);
  assert.ok(a.lateralForce > 0 && a.bogieYaw.some((yaw) => Math.abs(yaw) > 0.0002));
  assert.equal(a.lostSupport, 0);
});

test('forward and reverse wheelsets produce the same outer-rail acceleration at either curve hand', () => {
  const speed = 10;
  const arclength = 42;
  for (const radius of [100, -100]) {
    const bank = Math.sign(radius) * 0.03;
    const track = route({ radius, bank });
    const forward = setup(track, { speed: +speed, distance: arclength });
    const reverse = setup(track, { speed: -speed, distance: arclength });
    const dt = 1 / 7680;
    const context = { tick: 0, level: 7, cell: [0, 0, 0], seed: 0, inputs: new Map() };
    forward.rail.step(context, dt);
    reverse.rail.step(context, dt);
    const a = forward.rail.read(0);
    const b = reverse.rail.read(0);
    assert.ok(a.distance > arclength && b.distance < arclength);
    assert.equal(a.sway, b.sway);
    assert.equal(a.roll, b.roll);
    assert.deepEqual(a.bogieSway, b.bogieSway);
    const { tangent, right, curvature } = track.sample(arclength);
    const bankProjection = right[0] * tangent[2] - right[2] * tangent[0];
    const acceleration = GRAVITY[1] * right[1] - speed * speed * curvature * bankProjection;
    close(a.sway / (dt * dt), acceleration, 128 * Number.EPSILON);
    const rollMomentPerInertia = (8 * 1.05) / (1.435 * 1.435);
    close(a.roll / (dt * dt), acceleration * rollMomentPerInertia, 512 * Number.EPSILON);
    assert.equal(Math.sign(a.sway), -Math.sign(radius));
  }
});

test('LAST-TRAM-2/3: the leading sprung bogie rides the joint before the trailing bogie', () => {
  const stock = generateLocomotive({ arrangement: '4-4-0' });
  const { world, rail } = setup(route({ joint: 0.016 }), { centreHeight: stock.size[1] * 0.4 });
  world.advance(48);
  const leading = rail.read(0);
  assert.ok(leading.bogieHeave[1] > leading.bogieHeave[0] + 0.002);
  assert.ok(leading.heave > 0.001 && leading.pitch > 0);
  const rearAtJoint = Math.round((60 * (52 + 6.6 / 2 - 42)) / 10);
  world.advance(rearAtJoint);
  const trailing = rail.read(0);
  assert.ok(trailing.bogieHeave[0] > trailing.bogieHeave[1] + 0.002);
  world.advance(660);
  assert.ok(Math.abs(rail.read(0).heave) < 0.00015);
  assert.ok(stock.size.every((size) => size > 0) && Object.keys(stock.parts).length > 5);
});

test('LAST-TRAM-6: live weather wetness limits hard braking and produces wheel slip and nose dive', () => {
  const braking = (initialWater) => {
    const track = route();
    const world = new PhysicsWorld({ rate: RATE, gravity: GRAVITY, memory: worldMemory(false) });
    const weather = new SurfaceEnergySolver();
    const rail = new RailSolver({ wetnessField: weather.wetnessField });
    world.add(weather, { initialWater, waterCapacity: 1 });
    world.add(rail, { cars: [{ track, distance: 42, speed: 10, maxBrakeTorque: 6000 }] });
    rail.setControls(0, { brake: 1 });
    let pitch = 0;
    for (let frame = 1; frame <= 120; frame++) {
      world.advance(frame);
      pitch = Math.min(pitch, rail.read(0).pitch);
    }
    return { car: rail.read(0), weather: weather.read(), pitch };
  };
  const dry = braking(0),
    wet = braking(1);
  assert.ok(wet.weather.wetness > 0.9 && dry.weather.wetness < 0.1);
  assert.ok(dry.car.speed < wet.car.speed - 1);
  assert.ok(dry.car.distance < wet.car.distance - 1);
  assert.ok(wet.car.speed - RADIUS * wet.car.wheelsets[0].angularVelocity > 0.5);
  assert.ok(wet.pitch < -0.005 && dry.pitch < wet.pitch);
  assert.ok(Math.abs(wet.car.longitudinalForce) <= 0.121 * MASS * -GRAVITY[1]);
});

test('coupler slack carries no load and buffer compression gives equal and opposite forces', () => {
  const track = route();
  for (const [initialGap, direction] of [
    [0.01, 0],
    [-0.1, -1],
    [0.1, 1],
  ]) {
    const world = new PhysicsWorld({ rate: RATE, gravity: GRAVITY, memory: worldMemory(false) });
    const rail = new RailSolver();
    world.add(rail, {
      cars: [
        { track, distance: 55 + initialGap },
        { track, distance: 42 },
      ],
      couplers: [{ front: 0, rear: 1, restDistance: 13 }],
    });
    world.advance(1);
    const a = rail.read(0),
      b = rail.read(1);
    close(a.couplerForce + b.couplerForce, 0, 1e-9);
    assert.equal(Math.sign(b.couplerForce), direction);
    assert.equal(Math.sign(b.speed), direction);
  }
});

test('the wheel supports release and the sprung car drops when its surveyed route ends', () => {
  const { world, rail } = setup(route({ length: 60 }), { distance: 54, speed: 8 });
  world.advance(12);
  assert.equal(rail.read(0).derailment, false);
  world.advance(130);
  const outside = rail.read(0);
  assert.ok(outside.derailment && outside.distance > 60 && outside.heave < -0.5);
  assert.equal(outside.lostSupport, 15);
});

function wireParams(track, energized = true) {
  return { cars: [{ track, distance: 42, speed: 10 }], wire: { track, pantographs: [{ car: 0, energized }] } };
}

async function wireSetup(track, shared = false, energized = true) {
  const world = new PhysicsWorld({ rate: RATE, gravity: GRAVITY, memory: worldMemory(shared) });
  const rail = await RailSolver.load(world.memory);
  world.add(rail, wireParams(track, energized));
  return { world, rail };
}

test('LAST-TRAM-4: a moving sprung head raises the contact wire, sends waves and marks a powered separation', async () => {
  const { world, rail } = await wireSetup(route());
  const baseline = rail.readWire(44);
  const expected = 5.1 - (1.05 * -GRAVITY[1] * 12 * 20) / (2 * 12500);
  close(baseline.height, expected, 1e-12);
  let contacted = false,
    released = false,
    spark = false,
    lateralWave = false;
  for (let frame = 1; frame <= 130; frame++) {
    world.advance(frame);
    const head = rail.readPantograph(0);
    contacted ||= head.contactForce > 50;
    released ||= contacted && head.gap > 0 && !head.inContact;
    spark ||= head.arc;
    lateralWave ||= Math.abs(rail.readWire(44).lateralOffset - baseline.lateralOffset) > 1e-5;
  }
  assert.ok(contacted && released && spark && lateralWave);
  close(rail.readWire(32).height, 5.1, 1e-12);
});

test('plain and shared wire state match through a snapshot and an exact replay', async () => {
  const track = route({ joint: 0.008 });
  const a = await wireSetup(track, false);
  const b = await wireSetup(track, true);
  for (const side of [a, b]) {
    side.rail.setControls(0, { drive: 0.3 });
    side.world.advance(34);
  }
  assert.equal(a.world.hash(), b.world.hash());
  const saved = b.world.takeSnapshot();
  a.world.advance(115);
  b.world.advance(115);
  const expected = a.world.hash();
  assert.equal(b.world.hash(), expected);
  b.world.restoreSnapshot(saved.bytes);
  b.world.advance(115);
  assert.equal(b.world.hash(), expected);
});

test('invalid surveyed geometry and contact inputs report coded actions', () => {
  const coded = (message) => ({ name: 'MargoError', code: 'state', message });
  assert.throws(() => new RailRoute([null, { centre: [0, 0, 10] }]), coded(/three centre coordinates/));
  assert.throws(
    () => new RailRoute([{ centre: [-Number.MAX_VALUE, 0, 0] }, { centre: [Number.MAX_VALUE, 0, 0] }]),
    coded(/horizontal station spacing/),
  );
  assert.throws(() => railCreepForce({ slip: [1] }), coded(/two rail slip velocities/));
  assert.throws(() => setup(route(), { mass: Number.MAX_VALUE }), coded(/finite static wheel reaction/));
});

test('rail publications use the live signed cell across advancement and replay', async () => {
  const { world, rail } = await wireSetup(route());
  const cell = [-7, 3, -2];
  world.shiftOrigin([7, -3, 2]);
  const saved = world.takeSnapshot();
  world.advance(20);
  const expected = world.takeSnapshot();
  for (const { name } of [rail.carField, rail.wireField]) {
    assert.deepEqual(world.fields.port(name).cell, cell);
  }
  world.restoreSnapshot(saved.bytes);
  world.advance(20);
  assert.deepEqual(world.takeSnapshot().bytes, expected.bytes);
});

test('derived car overflow leaves accepted running gear and native wire data unchanged', async () => {
  const track = route({ radius: 100 });
  const world = new PhysicsWorld({ rate: RATE, gravity: GRAVITY, memory: worldMemory(true) });
  using rail = await RailSolver.load(world.memory, { threads: 2 });
  const setup = wireParams(track);
  world.add(rail, { ...setup, cars: [...setup.cars, { track, distance: 65, speed: 1e190 }] });
  const accepted = world.takeSnapshot();
  assert.equal(rail.wireWorkCounts(), undefined);
  assert.throws(() => rail.step({ tick: 0, level: 7, seed: 0, cell: [0, 0, 0], inputs: new Map() }, 1 / 7680), {
    name: 'MargoError',
    code: 'state',
    message: /forces exceed finite range/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  assert.equal(rail.wireWorkCounts(), undefined);
});

test('rail contact and suspension are independent of display rate and capped scrubbing', () => {
  const track = route({ joint: 0.014, radius: 140, bank: 0.06 });
  const make = (rate) => {
    const { rail, world } = setup(track, {}, rate);
    rail.setControls(0, { brake: 0.3 });
    return world;
  };
  frameRateIndependent(make);
  seekEqualsContinuous(() => make({ num: 24, den: 1 }), { frames: 76, at: 25 });
});
