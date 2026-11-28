import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavMesh } from '@margoengine/navmesh';
import {
  PEDESTRIAN_CONTACT_FIELD,
  PEDESTRIAN_FORCE_FIELD,
  PEDESTRIAN_INTENT_FIELD,
  PEDESTRIAN_KINEMATICS_FIELD,
  PEDESTRIAN_LAYOUT,
  PedestrianCrowd,
} from '@margoengine/physics/pedestrians';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const origin = [0, 0, 0];
const dt = 1 / 60;
const rate = { num: 60, den: 1 };
const close = (got, wanted, relative = 2e-12) =>
  assert.ok(Math.abs(got - wanted) <= relative * Math.max(1, Math.abs(wanted)), got + ' vs ' + wanted);
const group = (solver, bodies, params = {}, options = {}) =>
  new PhysicsWorld({ rate, ...options }).add(solver, { bodies, ...params });

test('a free walker approaches commanded velocity from a finite desired-force response', async () => {
  const solver = await PedestrianCrowd.load();
  const speed = 1.2;
  const world = group(solver, [{ position: origin, preferredVelocity: [speed, 0], responseSeconds: 0.5 }], {
    stiffness: 0,
  });
  world.advance(60);
  const decay = (1 + dt / 0.5) ** -60;
  close(solver.read(0).velocity[0], speed * (1 - decay));
  assert.ok(solver.read(0).position[0] > 0 && solver.read(0).position[0] < speed);
});

test('PA-74 and OPENING-NIGHT-2: two compressed bodies exchange equal impulse with inverse mass yielding', async () => {
  const solver = await PedestrianCrowd.load();
  const k = 2500,
    overlap = 0.06;
  const a = { position: [-0.2, 0, 0], mass: 20, driveAcceleration: 0 };
  const b = { position: [0.2, 0, 0], mass: 80, driveAcceleration: 0 };
  const world = group(solver, [a, b], { stiffness: k, sliding: 0, anticipation: 0 });
  world.advance(1);
  const impulse = (dt * k * overlap) / (1 + k * dt * dt * (1 / a.mass + 1 / b.mass));
  const low = solver.read(0),
    high = solver.read(1);
  close(low.velocity[0], -impulse / a.mass);
  close(high.velocity[0], impulse / b.mass);
  close(a.mass * low.velocity[0] + b.mass * high.velocity[0], 0);
  close(low.normalLoad, impulse / dt);
  close(high.normalLoad, impulse / dt);
  close(low.contactForce[0] + high.contactForce[0], 0);
  assert.ok(high.position[0] - low.position[0] > 0.4);
});

test('sliding friction damps a contact pair and preserves its undriven tangential momentum', async () => {
  const solver = await PedestrianCrowd.load();
  const k = 2200,
    sliding = 2500,
    mass = 50,
    overlap = 0.06;
  const members = [
    { position: [-0.2, 0, 0], velocity: [0, 1], mass, driveAcceleration: 0 },
    { position: [0.2, 0, 0], velocity: [0, -1], mass, driveAcceleration: 0 },
  ];
  const world = group(solver, members, { stiffness: k, sliding, anticipation: 0 });
  world.advance(1);
  const compression = overlap / (1 + (k * dt * dt * 2) / mass);
  const j = dt * sliding * compression;
  const keep = 1 / (1 + (j * 2) / mass);
  close(solver.read(0).velocity[2], keep);
  close(solver.read(1).velocity[2], -keep);
});

test('OPENING-NIGHT-5: a potential future encounter changes speed before either shoulder touches', async () => {
  const solver = await PedestrianCrowd.load();
  const gain = 1.6,
    decay = 3,
    reaction = 0.15;
  const circle = { mass: 30, width: 0.5, depth: 0.5, responseSeconds: 0.5 };
  const world = group(
    solver,
    [
      { ...circle, position: [-1.25, 0, 0], velocity: [1, 0], preferredVelocity: [1, 0] },
      { ...circle, position: [1.25, 0, 0], velocity: [-1, 0], preferredVelocity: [-1, 0] },
      { ...circle, position: [0, 0, 4], velocity: [1, 0], preferredVelocity: [1, 0] },
    ],
    { anticipation: gain, anticipationDecay: decay, reactionSeconds: reaction, stiffness: 0 },
  );
  world.advance(1);
  // Two 0.25 m radius discs at 2.5 m, closing at 2 m/s. The first root is 1 s.
  // For collinear motion the magnitude of d(tau)/d(separation) is 1/(2 m/s).
  const time = 1 + reaction;
  const force = (gain * Math.exp(-time / decay) * (2 / time ** 3 + 1 / (decay * time ** 2))) / 2;
  close(solver.read(0).anticipationForce[0], -force);
  close(solver.read(1).anticipationForce[0], force);
  assert.deepEqual(solver.read(2).anticipationForce, [0, 0]);
  assert.equal(solver.read(0).normalLoad, 0);
  assert.ok(solver.read(0).velocity[0] < 1);
});

test('OPENING-NIGHT-1: a physical wall resists a walker with a compressive force', async () => {
  const solver = await PedestrianCrowd.load();
  const mass = 75,
    speed = 1.2,
    k = 15000;
  const world = group(solver, [{ position: [0, 0, -0.15], velocity: [0, speed], mass, driveAcceleration: 0 }], {
    stiffness: k,
    walls: [
      [
        [-3, 0],
        [3, 0],
      ],
    ],
  });
  world.advance(1);
  const fitted = (dt * k * (0.14 - 0.15 + dt * speed)) / (1 + (k * dt * dt) / mass);
  close(solver.read(0).normalLoad, fitted / dt);
  close(solver.read(0).velocity[2], speed - fitted / mass);
  assert.ok(solver.read(0).contactForce[1] < 0);
});

test('OPENING-NIGHT-8: an elliptical torso turns enough to fit a narrower aperture', async () => {
  const solver = await PedestrianCrowd.load();
  const width = 0.56,
    depth = 0.24,
    gap = 0.39;
  const person = { position: [0, 0, -1], width, depth, path: [[0, 0, 2]] };
  const world = group(solver, [person], {
    walls: [
      [
        [-3, 0],
        [-gap / 2, 0],
      ],
      [
        [gap / 2, 0],
        [3, 0],
      ],
    ],
    apertures: [
      [
        [-gap / 2, 0],
        [gap / 2, 0],
      ],
    ],
  });
  for (let frame = 1; frame <= 150; frame++) {
    world.advance(frame);
    const walker = solver.read(0);
    if (walker.position[2] < 0) continue;
    const halfSpan = Math.hypot(width * walker.heading[1], depth * walker.heading[0]) / 2;
    assert.ok(halfSpan <= gap / 2, halfSpan + ' vs ' + gap / 2);
    assert.ok(Math.abs(walker.heading[0]) > 0);
    return;
  }
  assert.fail('the walker should turn and pass the aperture');
});

function doorway() {
  const positions = [
    [-0.32, -0.48],
    [0.32, -0.49],
    [-0.32, -0.98],
    [0.32, -1.03],
    [-0.32, -1.53],
    [0.32, -1.43],
  ];
  const gap = 0.8;
  return {
    bodies: positions.map(([x, z]) => ({
      position: [x, 0, z],
      path: [
        [0, 0, 0.4],
        [0, 0, 4],
      ],
    })),
    walls: [
      [
        [-3, 0],
        [-gap / 2, 0],
      ],
      [
        [gap / 2, 0],
        [3, 0],
      ],
    ],
    apertures: [
      [
        [-gap / 2, 0],
        [gap / 2, 0],
      ],
    ],
    stiffness: 20000,
  };
}

test('OPENING-NIGHT-7: walkers load each other, pass through a door in a queue and then release', async () => {
  const solver = await PedestrianCrowd.load();
  const config = doorway();
  const world = new PhysicsWorld({ rate }).add(solver, config);
  const firstCrossings = Array(config.bodies.length).fill(null);
  let contact = 0;
  for (let frame = 1; frame <= 480; frame++) {
    world.advance(frame);
    for (let row = 0; row < config.bodies.length; row++) {
      const body = solver.read(row);
      if (body.position[2] >= 0 && firstCrossings[row] === null) firstCrossings[row] = frame;
      if (frame <= 180) contact = Math.max(contact, body.normalLoad);
    }
  }
  assert.ok(contact > 0, 'the simulated queue has real compressive loads');
  assert.ok(firstCrossings.every((frame) => frame > 0) && new Set(firstCrossings).size > 1);
  for (let row = 0; row < config.bodies.length; row++) {
    assert.ok(solver.read(row).position[2] > 3, 'each body clears the departure region');
  }
});

test('CITY-TO-STREET-2: the real NavMesh supplies a pedestrian route and grade', async () => {
  const path = new NavMesh(
    [
      [-2, -1, -2],
      [2, -1, -2],
      [2, 1, 2],
      [-2, 1, 2],
    ],
    [[0, 1, 2, 3]],
  );
  const start = [0, -0.5, -1],
    end = [0, 0.5, 1];
  const route = path.route(start, end);
  assert.ok(route);
  const solver = await PedestrianCrowd.load();
  const world = group(solver, [{ position: start, path: route.points }], { ground: path });
  world.advance(90);
  const got = solver.read(0);
  assert.ok(got.position[2] > 0);
  close(got.position[1], got.position[2] / 2);
  close(got.velocity[1], got.velocity[2] / 2);
});

function portWriter(field, values) {
  let site, region;
  return {
    describe: () => ({
      id: field.name + '-source',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field, access: 'write' }],
    }),
    init(host) {
      site = host;
      region = host.allocate(field.name, values.length * 8, 'f64', PEDESTRIAN_LAYOUT);
      new Float64Array(site.memory.buffer, region.byteOffset, values.length).set(values);
    },
    step() {},
    exportPorts: (tick) => [{ field: field.name, cell: origin, region, tick }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('pedestrian ground may grow plain memory or reject a later row without losing accepted state', async () => {
  const cell = [-13, 7, -4];
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) })
    .add(portWriter(PEDESTRIAN_INTENT_FIELD, [0.3, 0, -0.2, 0.2]), {})
    .add(portWriter(PEDESTRIAN_FORCE_FIELD, [0, 0, 0, 0]), {});
  using solver = await PedestrianCrowd.load({ readIntent: true, readForces: true });
  let grow = false;
  let reject = false;
  let reenter;
  const ground = {
    locate: () => 0,
    heightAt(_polygon, x) {
      if (grow) {
        world.memory.grow(1);
        grow = false;
      }
      if (x > 1) {
        reenter?.();
        if (reject) return NaN;
      }
      return 0.05 * x;
    },
  };
  world.add(
    solver,
    {
      bodies: [{ position: [-2, -0.1, 0] }, { position: [2, 0.1, 2] }],
      ground,
      stiffness: 0,
    },
    cell,
  );
  for (const port of solver.exportPorts(-1)) assert.deepEqual(port.cell, cell);
  world.advance(10);
  const saved = world.takeSnapshot().bytes.slice();
  const receipt = solver.readNativeWork();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const borrow = (field, byteOffset, values) => {
    new Float64Array(memory.buffer, byteOffset, values.length).set(values);
    return {
      field: field.name,
      tick: 0,
      cell: [-7, -2, 13],
      region: {
        name: field.name,
        type: 'f64',
        layout: PEDESTRIAN_LAYOUT,
        byteOffset,
        byteLength: 8 * values.length,
        memory,
      },
    };
  };
  const intent = borrow(PEDESTRIAN_INTENT_FIELD, 24, [0.5, 0.1, -0.2, 0.8]);
  const force = borrow(PEDESTRIAN_FORCE_FIELD, 72, [45, 0, 0, 50]);
  const context = {
    cell,
    tick: 0,
    level: 0,
    seed: 0,
    inputs: new Map([
      [intent.field, intent],
      [force.field, force],
    ]),
  };
  const rejected = (message) => {
    assert.throws(() => solver.step(context, dt), { code: 'state', message });
    assert.deepEqual(world.takeSnapshot().bytes, saved);
    assert.deepEqual(solver.readNativeWork(), receipt);
  };
  reject = true;
  rejected(/finite walkable height.*#pedestrians/);
  reject = false;
  reenter = () => solver.setPreferredVelocity(0, [2, 1]);
  rejected(/after the current step finishes.*#pedestrians/);
  reenter = undefined;
  intent.region.byteOffset++;
  rejected(/aligned pedestrian input.*#pedestrians/);
  intent.region.byteOffset--;
  const step = () => {
    solver.step(context, dt);
    assert.equal(solver.read(0).position[1], 0.05 * solver.read(0).position[0]);
    return world.takeSnapshot().bytes.slice();
  };
  const next = step();
  world.restoreSnapshot(saved);
  const oldView = world.memory.buffer;
  grow = true;
  assert.deepEqual(step(), next);
  assert.equal(oldView.byteLength, 0);
  world.shiftOrigin([3, -4, 10]);
  for (const port of solver.exportPorts(0)) assert.deepEqual(port.cell, [-16, 11, -14]);
  world.restoreSnapshot(saved);
  assert.deepEqual(world.takeSnapshot().bytes, saved);
});

test('separate registry writers steer or push a body and the reader receives SI contact and kinematic state', async () => {
  const person = { position: origin, mass: 50, responseSeconds: 0.5 };
  const solver = await PedestrianCrowd.load({ readIntent: true, readForces: true });
  const world = group(solver, [person], { stiffness: 0 });
  world.add(portWriter(PEDESTRIAN_FORCE_FIELD, [0, 100]), {});
  world.add(portWriter(PEDESTRIAN_INTENT_FIELD, [1, 0]), {});
  world.advance(1);
  const pose = solver.read(0);
  close(pose.velocity[0], (dt * 2) / (1 + dt * 2));
  close(pose.velocity[2], (dt * 100) / 50);
  const written = solver.exportPorts(1);
  const kinematics = written.find(({ field }) => field === PEDESTRIAN_KINEMATICS_FIELD.name);
  const loads = written.find(({ field }) => field === PEDESTRIAN_CONTACT_FIELD.name);
  assert.equal(kinematics.region.layout, PEDESTRIAN_LAYOUT);
  assert.equal(loads.region.layout, PEDESTRIAN_LAYOUT);
  const state = new Float64Array(world.memory.buffer, kinematics.region.byteOffset, 9);
  assert.deepEqual([...state.slice(0, 6)], [...pose.position, ...pose.velocity]);
  close(state[8], dt * Math.hypot(pose.velocity[0], pose.velocity[2]));
  assert.equal(pose.normalLoad, 0);
});

test('PedestrianCrowd reproduces its contact and route state across frame rates, snapshots and memory kinds', async () => {
  const solvers = await Promise.all(Array.from({ length: 7 }, () => PedestrianCrowd.load()));
  const make = (rate, memory) => new PhysicsWorld({ rate, memory }).add(solvers.shift(), doorway());
  frameRateIndependent((rate) => make(rate), { seconds: 2 });
  seekEqualsContinuous(() => make({ num: 24, den: 1 }));
  const plain = make(rate, worldMemory(false));
  const shared = make(rate);
  plain.advance(120);
  shared.advance(120);
  assert.equal(plain.hash(), shared.hash());
});

test('the exact contact load reaches a registered downstream dynamic-character stand-in', async () => {
  const solver = await PedestrianCrowd.load();
  let host, observed;
  const consumer = {
    describe: () => ({
      id: 'pose-handoff-fixture',
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: PEDESTRIAN_CONTACT_FIELD, access: 'read' },
        { field: PEDESTRIAN_KINEMATICS_FIELD, access: 'read' },
      ],
    }),
    init(owner) {
      host = owner;
      observed = owner.allocate('hand-off', 16, 'f64', 1);
    },
    step(context) {
      const { region } = context.inputs.get(PEDESTRIAN_CONTACT_FIELD.name);
      const pose = context.inputs.get(PEDESTRIAN_KINEMATICS_FIELD.name).region;
      assert.equal(region.layout, PEDESTRIAN_LAYOUT);
      const contacts = new Float64Array(
        (region.memory ?? host.memory).buffer,
        region.byteOffset,
        region.byteLength / 8,
      );
      const kinematics = new Float64Array((pose.memory ?? host.memory).buffer, pose.byteOffset, pose.byteLength / 8);
      new Float64Array(host.memory.buffer, observed.byteOffset, 2).set([contacts[2], kinematics[3]]);
    },
    exportPorts: () => [],
    importPorts() {},
    stateRegions: () => [observed],
    extraState: () => [],
  };
  const world = group(
    solver,
    [
      { position: [-0.2, 0, 0], mass: 20, driveAcceleration: 0 },
      { position: [0.2, 0, 0], mass: 80, driveAcceleration: 0 },
    ],
    { stiffness: 2500 },
  ).add(consumer, {});
  world.advance(1);
  const values = new Float64Array(world.memory.buffer, observed.byteOffset, 2);
  assert.ok(values[0] > 0 && values[1] < 0);
  close(values[0], solver.read(0).normalLoad);
  close(values[1], solver.read(0).velocity[0]);
});

test('restoring the world restores the preferred velocity override as well as pose', async () => {
  const solver = await PedestrianCrowd.load();
  const world = group(solver, [{ position: origin, path: [[0, 0, 2]] }]);
  solver.setPreferredVelocity(0, [1, 0]);
  const saved = world.takeSnapshot();
  world.advance(12);
  const expected = world.hash();
  solver.setPreferredVelocity(0, null);
  world.restoreSnapshot(saved.bytes);
  world.advance(12);
  assert.equal(world.hash(), expected);
});

test('a force port can move a body into contact beyond its old-motion search cells in one step', async () => {
  const solver = await PedestrianCrowd.load({ readForces: true });
  const bodies = [
    { position: [-1, 0, 0], mass: 20, driveAcceleration: 0 },
    { position: [1, 0, 0], mass: 80, driveAcceleration: 0 },
  ];
  const push = 240000;
  const world = group(solver, bodies, { stiffness: 2500, densityRadius: 0.2, observationSeconds: 0.1 }).add(
    portWriter(PEDESTRIAN_FORCE_FIELD, [push, 0, 0, 0]),
    {},
  );
  world.advance(1);
  const a = solver.read(0),
    b = solver.read(1);
  assert.ok(a.normalLoad > 0 && b.velocity[0] > 0);
  close(20 * a.velocity[0] + 80 * b.velocity[0], push * dt);
});

test('local packing reduces propulsion by the normalized compact density estimate', async () => {
  const solver = await PedestrianCrowd.load();
  const config = { width: 0.12, depth: 0.12, preferredVelocity: [0, 1], responseSeconds: 0.5 };
  const world = group(
    solver,
    [
      { ...config, position: [-0.25, 0, 0] },
      { ...config, position: [0.25, 0, 0] },
      { ...config, position: [3, 0, 0] },
    ],
    { stiffness: 0, densityRadius: 1, packingDensity: 1.4, densityResponse: 2 },
  );
  world.advance(1);
  const solitary = 4 / Math.PI;
  const crowded = solitary * (1 + (1 - 0.25) ** 3);
  close(solver.read(0).density, crowded);
  close(solver.read(2).density, solitary);
  close(solver.read(0).velocity[2], dt / (0.5 + dt) / (1 + (2 * (crowded - 1.4)) / 1.4));
  close(solver.read(2).velocity[2], dt / (0.5 + dt));
});
