import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushShellSolver } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const material = {
  thickness: 0.015,
  density: 7800,
  youngModulus: 200e6,
  poissonRatio: 0.3,
  yieldStress: 350e3,
  hardeningModulus: 1.2e6,
};
const zero = [0, 0, 0];
const positions = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
];
const triangles = [[0, 1, 2]];

function near(got, want, bound) {
  assert.ok(Math.abs(got - want) <= bound, `expected ${want}, got ${got}, tolerance ${bound}`);
}

async function model(params = {}, gravity = zero, shared = false) {
  const shell = await CrushShellSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(shared) });
  world.add(shell, { positions, triangles, material, ...params });
  return { shell, world };
}

test('a crush shell refuses a second world and keeps advancing in the first', async () => {
  const first = await model({ pinned: [0, 1] });
  using shell = first.shell;
  const second = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: zero, memory: worldMemory(false) });
  const accepted = shell.readMesh();
  assert.throws(() => second.add(shell, { positions, triangles, material }), {
    name: 'MargoError',
    code: 'attached',
    message: /Load a separate shell solver.*#ductile-crush/,
  });
  assert.deepEqual(shell.readMesh(), accepted);
  shell.setForce(2, [0, 0, 1]);
  first.world.advance(1);
  assert.ok(shell.readMesh().positions[8] > accepted.positions[8]);
});

test('free sheet follows analytic gravity motion without artificial strain or work in either arena', async () => {
  const gravity = [0, -9.81, 0];
  const velocity = [0.45, -1.5, 0.2];
  const run = async (shared) => {
    const { shell, world } = await model({ velocities: positions.map(() => velocity) }, gravity, shared);
    const cell = [11, -4, 8];
    world.setCell(shell.id, cell);
    world.advance(15);
    const { positions: current, velocities } = shell.readMesh();
    const port = world.fields.port(shell.positionField.name);
    assert.deepEqual(port.cell, cell);
    assert.deepEqual(regionWords(world.memory, port.region), current);
    const time = 15 / 60;
    for (const [i, point] of positions.entries()) {
      for (let axis = 0; axis < 3; axis++) {
        near(velocities[3 * i + axis], velocity[axis] + time * gravity[axis], 4e-10);
        near(current[3 * i + axis], point[axis] + time * velocity[axis] + 0.5 * time ** 2 * gravity[axis], 4e-10);
      }
    }
    assert.equal(shell.readFace(0).equivalentPlasticStrain, 0);
    near(shell.readBudget().membrane, 0, 1e-18);
    assert.equal(shell.readBudget().appliedWork, 0);
    const mass = (material.density * material.thickness) / 2;
    near(shell.readBudget().kinetic, 0.5 * mass * velocities.slice(0, 3).reduce((sum, v) => sum + v * v, 0), 1e-8);
    return shell.readMesh();
  };
  assert.deepEqual(await run(false), await run(true));
});

test('native shell work scales with the number of faces at fixed element size', async (t) => {
  const grid = async (copies, shared) => {
    const mesh = { positions: [], triangles: [] };
    for (let panel = 0; panel < copies; panel++) {
      const row = mesh.positions.length;
      const x = 2 * panel;
      mesh.positions.push([x, 0, 0], [x + 1, 0, 0], [x + 1, 1, 0], [x, 1, 0]);
      mesh.triangles.push([row, row + 1, row + 2], [row, row + 2, row + 3]);
    }
    const { shell, world } = await model({ ...mesh, recordWork: true }, zero, shared);
    assert.equal(shell.readWork().substeps, 0);
    world.advance(1);
    const saved = world.takeSnapshot();
    const work = shell.readWork();
    assert.ok(work.substeps > 0);
    assert.equal(work.membraneEvaluations, 2 * copies * (work.substeps + 1));
    assert.equal(work.hingeEvaluations, copies * (work.substeps + 1));
    assert.equal(work.seamQuadraturePoints, 0);
    assert.equal(work.sphereFaceChecks, 0);
    assert.equal(work.pressureFaceVisits, 0);
    world.advance(2);
    world.restoreSnapshot(saved.bytes);
    assert.deepEqual(shell.readWork(), work);
    return work;
  };
  const small = await grid(16, false);
  const large = await grid(64, false);
  assert.equal(large.substeps, small.substeps);
  assert.equal(large.membraneEvaluations, 4 * small.membraneEvaluations);
  assert.equal(large.hingeEvaluations, 4 * small.hingeEvaluations);
  assert.deepEqual(await grid(64, true), large);
  t.diagnostic(
    `32/128 faces, ${large.substeps} substeps, ${small.membraneEvaluations}/${large.membraneEvaluations} membrane and ${small.hingeEvaluations}/${large.hingeEvaluations} hinge evaluations.`,
  );
});

test('real vertex loads exercise J2 hardening, fixed reaction, irreversible work and exact replay', async () => {
  const { shell, world } = await model({ pinned: [0, 2] });
  const volume = material.thickness / 2;
  world.advance(1);
  const before = world.takeSnapshot();
  const measure = () => {
    shell.setForce(1, [5000, 0, 0]);
    world.advance(2);
    const mesh = shell.readMesh();
    const face = shell.readFace(0);
    const budget = shell.readBudget();
    assert.ok(mesh.positions[3] > 1.005);
    const [xx, yy, xy] = face.stress;
    near(xy, 0, 1e-9);
    assert.ok(face.equivalentPlasticStrain > 0.005);
    const mise = Math.sqrt(xx ** 2 - xx * yy + yy ** 2 + 3 * xy ** 2);
    near(mise, material.yieldStress + material.hardeningModulus * face.equivalentPlasticStrain, 1e-7);
    near(budget.plasticDissipation, volume * material.yieldStress * face.equivalentPlasticStrain, 1e-10);
    near(budget.hardening, 0.5 * volume * material.hardeningModulus * face.equivalentPlasticStrain ** 2, 1e-10);
    near(budget.appliedWork, 5000 * (mesh.positions[3] - 1), 1e-9);
    near(shell.supportReaction(0)[0] + shell.supportReaction(2)[0], -volume * xx * mesh.positions[3], 1e-8);
    const stored = budget.kinetic + budget.membrane + budget.hardening + budget.plasticDissipation;
    near(stored, budget.appliedWork, 0.035 * budget.appliedWork);
    shell.setForce(1, zero);
    world.advance(3);
    assert.ok(shell.readBudget().plasticDissipation >= budget.plasticDissipation);
    assert.equal(shell.readBudget().appliedWork, budget.appliedWork);
    return { mesh: shell.readMesh(), budget: shell.readBudget(), face: shell.readFace(0), hash: world.hash() };
  };
  const loaded = measure();
  world.restoreSnapshot(before.bytes);
  assert.equal(shell.readBudget().appliedWork, 0);
  assert.deepEqual(measure(), loaded);
});

test('a live loaded crease converts its measured angle to hinge energy and transmits support force', async () => {
  const { shell, world } = await model({
    positions: [...positions, [0, -1, 0]],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
    pinned: [0, 1, 3],
  });
  const force = 5;
  shell.setForce(2, [0, 0, force]);
  world.advance(5);
  const { positions: mesh, triangles: faces } = shell.readMesh();
  assert.deepEqual(faces, new Uint32Array([0, 1, 2, 1, 0, 3]));
  assert.ok(mesh[8] > 1e-4);
  const angle = Math.atan2(mesh[8], mesh[7]);
  const flexural = (material.youngModulus * material.thickness ** 3) / (12 * (1 - material.poissonRatio ** 2));
  near(shell.readBudget().bending, 0.5 * 3 * flexural * angle ** 2, 1e-10);
  assert.ok(shell.supportReaction(3)[2] > 0);
  assert.equal(shell.supportReaction(2)[2], 0);
  near(mesh[11], 0, 0);
});

test('invalid mesh rejects precisely and degenerate drift publishes no partial shell state', async () => {
  await assert.rejects(
    model({
      positions: [...positions, [1, 1, 0]],
      triangles: [
        [0, 1, 2],
        [0, 1, 3],
      ],
    }),
    {
      code: 'state',
      message: /Use consistently wound shell faces/,
    },
  );
  await assert.rejects(model({ positions: [...positions, [1, 1, 0]], triangles }), {
    code: 'state',
    message: /Give every shell vertex incident area/,
  });
  const { world, shell } = await model({ pinned: [0, 1, 2] });
  const before = shell.readMesh();
  const workBefore = shell.readNativeWork();
  shell.setForce(2, [0, 0, 1e200]);
  assert.throws(() => world.advance(1), {
    code: 'failed',
    message: /Reduce the load/,
  });
  assert.deepEqual(shell.readMesh(), before);
  assert.deepEqual(shell.supportReaction(2), zero);
  assert.deepEqual(shell.readNativeWork(), workBefore);
});

async function sphereModel({
  rateLevel,
  fixed,
  position,
  speed = zero,
  pinned,
  sphereCell = zero,
  shared = false,
  substeps = 4,
  friction,
  presentationHz = 60,
  mesh = { positions, triangles },
  contactManifold,
  recordWork,
}) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: { num: presentationHz, den: 1 }, gravity: zero, memory: worldMemory(shared) });
  const physics = new Physics(null, {
    arena: world.arena,
    gravity: zero,
    fixedTimestep: 1 / (60 << rateLevel),
    substeps,
  });
  const radius = 0.125;
  const contactModulus = 7e6;
  const mass = 14;
  const sphere = physics.addBody(null, {
    ...(fixed ? { type: 'fixed' } : {}),
    position,
    linearVelocity: speed,
    colliders: { shape: 'sphere', radius, mass, sensor: true },
  });
  const shell = await CrushShellSolver.loadRigid({ rate: rateLevel });
  world.add(new RigidSolver(), { physics, capacity: physics.kernel.capacity });
  world.add(shell, {
    ...mesh,
    material,
    pinned,
    cellSize: 2,
    spheres: [{ body: sphere.row, radius, contactModulus, friction }],
    contactManifold,
    recordWork,
  });
  world.setCell('rigid', sphereCell);
  world.couple([shell.id, 'rigid'], 'staggered');
  return { world, physics, sphere, shell, radius, contactModulus, mass };
}

test('fixed sphere contact distributes independent Hertz load and work to all three shell supports', async () => {
  const loaded = await sphereModel({
    rateLevel: 2,
    fixed: true,
    position: [-3.75, 4.25, 0.125],
    pinned: [0, 1, 2],
    sphereCell: [2, -2, 0],
  });
  using _physics = loaded.physics;
  const { world, shell, radius, contactModulus } = loaded;
  world.advance(1);
  const compression = 0.5 * material.thickness;
  const force = (4 / 3) * contactModulus * Math.sqrt(radius) * compression ** 1.5;
  const hit = shell.readSphereContact(0);
  near(hit.compression, compression, 4e-16);
  near(hit.energy, 0.4 * force * compression, 1e-12);
  near(hit.impulse[2], force / 240, 1e-10);
  near(shell.supportReaction(0)[2], force / 2, 1e-9);
  near(shell.supportReaction(1)[2], force / 4, 1e-9);
  near(shell.supportReaction(2)[2], force / 4, 1e-9);
  assert.deepEqual(shell.readMesh().positions, Float64Array.from(positions.flat()));
});

test('a fixed sphere loads both faces of a folded sheet and does not double-count coplanar edges or vertices', async () => {
  const folded = {
    positions: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    triangles: [
      [0, 2, 1],
      [0, 1, 3],
    ],
  };
  const evaluate = async (mesh, position, contactManifold) => {
    const loaded = await sphereModel({
      rateLevel: 2,
      fixed: true,
      position,
      pinned: mesh.positions.map((_, i) => i),
      mesh,
      contactManifold,
    });
    using _physics = loaded.physics;
    loaded.world.advance(1);
    return {
      hit: loaded.shell.readSphereContact(0),
      reactions: mesh.positions.map((_, i) => loaded.shell.supportReaction(i)),
    };
  };
  const normal = (4 / 3) * 7e6 * Math.sqrt(0.125) * (0.5 * material.thickness) ** 1.5;
  const multi = await evaluate(folded, [0.125, 0.25, 0.125], true);
  near(multi.hit.impulse[0], normal / 240, 1e-10);
  near(multi.hit.impulse[2], normal / 240, 1e-10);
  near(multi.hit.energy, 2 * 0.4 * normal * 0.5 * material.thickness, 1e-12);
  near(multi.reactions[2][2], normal * 0.125, 1e-9);
  near(multi.reactions[3][0], normal * 0.125, 1e-9);
  const single = await evaluate(folded, [0.125, 0.25, 0.125], false);
  assert.equal(single.hit.impulse[0], 0);
  near(single.hit.impulse[2], normal / 240, 1e-10);

  // The projection lands first on a shared diagonal, then at a four-face junction.
  const planar = {
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.5, 0.5, 0],
    ],
    triangles: [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 0, 4],
    ],
  };
  for (const position of [
    [0.4375, 0.4375, 0.125],
    [0.5, 0.5, 0.125],
    [0.5, 0.4375, 0.125],
  ]) {
    const { hit, reactions } = await evaluate(planar, position, true);
    near(hit.impulse[2], normal / 240, 1e-10);
    near(hit.energy, 0.4 * normal * 0.5 * material.thickness, 1e-12);
    near(
      reactions.reduce((sum, force) => sum + force[2], 0),
      normal,
      1e-9,
    );
  }
});

test('opposite shell contacts dissipate sliding even when their normal impulses cancel', async () => {
  const mesh = {
    positions: [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.25, 0, 0],
      [0.25, 0, 1],
      [0.25, 1, 0],
    ],
    triangles: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  const run = async (shared) => {
    const loaded = await sphereModel({
      rateLevel: 3,
      fixed: false,
      position: [0.125, 0.25, 0.25],
      speed: [0, 2, 0],
      pinned: [0, 1, 2, 3, 4, 5],
      mesh,
      contactManifold: true,
      friction: 0.025,
      recordWork: true,
      shared,
      presentationHz: 480,
    });
    using _physics = loaded.physics;
    const { world, sphere, shell, mass, contactModulus, radius } = loaded;
    const force = (4 / 3) * contactModulus * Math.sqrt(radius) * (0.5 * material.thickness) ** 1.5;
    const frictionForce = 2 * 0.025 * force;
    world.advance(1);
    const saved = world.takeSnapshot();
    const before = sphere.linearVelocity[1];
    const measure = () => {
      world.advance(2);
      const hit = shell.readSphereContact(0);
      const friction = shell.readSphereFriction(0);
      const work = shell.readWork();
      const sliding = sphere.linearVelocity[1];
      near(hit.impulse[0], 0, 1e-12);
      near(hit.impulse[1], -frictionForce / 480, 1e-8);
      near(friction.angularImpulse[2], 0, 1e-11);
      near(friction.dissipatedEnergy, 0.5 * mass * (before ** 2 - sliding ** 2), 5e-6);
      near(
        shell.supportReaction(0)[1] + shell.supportReaction(1)[1] + shell.supportReaction(2)[1],
        -0.025 * force,
        1e-6,
      );
      near(
        shell.supportReaction(3)[1] + shell.supportReaction(4)[1] + shell.supportReaction(5)[1],
        -0.025 * force,
        1e-6,
      );
      assert.equal(work.sphereFaceChecks, 2 * (3 * work.substeps + 1));
      return { hit, friction, sliding, work };
    };
    const expected = measure();
    world.restoreSnapshot(saved.bytes);
    assert.deepEqual(measure(), expected);
    return expected;
  };
  assert.deepEqual(await run(false), await run(true));
});

test('moving rigid sphere transfers reciprocal linear and angular momentum to a deforming shell and replays', async (t) => {
  const loaded = await sphereModel({ rateLevel: 3, fixed: false, position: [0.3, 0.2, 0.17], speed: [0, 0, -0.8] });
  using _physics = loaded.physics;
  const { world, shell, sphere, mass } = loaded;
  // Start from the first completed world tick, with the accumulator allocated and the sphere still clear.
  world.advance(1);
  assert.equal(shell.readSphereContact(0).compression, 0);
  const saved = world.takeSnapshot();
  const nodeMass = (material.density * material.thickness) / 6;
  const initialMomentum = mass * sphere.linearVelocity[2];
  const initialCenter = sphere.position;
  const initialAngular = [initialCenter[1] * initialMomentum, -initialCenter[0] * initialMomentum];
  const measure = () => {
    let peak = 0;
    for (let frame = 2; frame <= 9; frame++) {
      world.advance(frame);
      peak = Math.max(peak, shell.readSphereContact(0).compression);
    }
    assert.ok(peak > 0.002);
    assert.ok(sphere.linearVelocity[2] > 0.1);
    assert.deepEqual(sphere.angularVelocity, zero);
    const mesh = shell.readMesh();
    const v = sphere.linearVelocity;
    near(
      mass * v[2] + nodeMass * (mesh.velocities[2] + mesh.velocities[5] + mesh.velocities[8]),
      initialMomentum,
      2e-5,
    );
    const center = sphere.position;
    let lx = mass * (center[1] * v[2] - center[2] * v[1]);
    let ly = mass * (center[2] * v[0] - center[0] * v[2]);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lx +=
        nodeMass * (mesh.positions[i + 1] * mesh.velocities[i + 2] - mesh.positions[i + 2] * mesh.velocities[i + 1]);
      ly += nodeMass * (mesh.positions[i + 2] * mesh.velocities[i] - mesh.positions[i] * mesh.velocities[i + 2]);
    }
    near(lx, initialAngular[0], 0.008);
    near(ly, initialAngular[1], 0.008);
    assert.ok(mesh.positions[2] < -0.005);
    assert.ok(Math.abs(mesh.positions[2] - mesh.positions[5]) > 0.002);
    return { mesh, reaction: shell.readSphereContact(0), p: sphere.position, v, hash: world.hash() };
  };
  const first = measure();
  const budget = shell.readBudget();
  const startEnergy = (0.5 * initialMomentum ** 2) / mass;
  const endEnergy =
    0.5 * mass * first.v.reduce((sum, value) => sum + value * value, 0) +
    budget.kinetic +
    budget.membrane +
    budget.bending +
    budget.hardening +
    budget.plasticDissipation +
    first.reaction.energy;
  t.diagnostic(`Mechanical energy and plastic work ${startEnergy.toFixed(6)} → ${endEnergy.toFixed(6)} J`);
  near(endEnergy, startEnergy, 2e-4);
  world.restoreSnapshot(saved.bytes);
  assert.deepEqual(measure(), first);
});

test('native shell friction transfers angular impulse and dissipates the measured slip work', async (t) => {
  const run = async (friction, speed, shared) => {
    const level = 3;
    const loaded = await sphereModel({
      rateLevel: level,
      presentationHz: 60 << level,
      fixed: false,
      pinned: [0, 1, 2],
      position: [0.25, 0.25, 0.1315],
      speed: [speed, 0, 0],
      friction,
      shared,
    });
    using _physics = loaded.physics;
    const { world, shell, sphere, mass, radius, contactModulus } = loaded;
    const inertia = 0.4 * mass * radius * radius;
    world.advance(1);
    const startVelocity = sphere.linearVelocity;
    const startAngular = sphere.angularVelocity;
    const startCenter = sphere.position;
    const depth = radius + 0.5 * material.thickness - startCenter[2];
    const initialEnergy =
      0.5 * mass * startVelocity.reduce((sum, x) => sum + x ** 2, 0) +
      0.5 * inertia * startAngular.reduce((sum, x) => sum + x ** 2, 0) +
      (8 / 15) * contactModulus * Math.sqrt(radius * depth) * depth ** 2;
    const saved = world.takeSnapshot();
    const measure = () => {
      let normal = 0;
      let sliding = 0;
      let torque = 0;
      let work = 0;
      for (let frame = 2; frame <= 12; frame++) {
        world.advance(frame);
        const contact = shell.readSphereContact(0);
        const tangent = shell.readSphereFriction(0);
        normal += contact.impulse[2];
        sliding += contact.impulse[0];
        torque += tangent.angularImpulse[1];
        work += tangent.dissipatedEnergy;
        if (friction < 0.1 && contact.compression > 0) {
          const supports = [0, 1, 2].map((i) => shell.supportReaction(i));
          const load = supports.reduce((sum, row) => sum + row[2], 0);
          const tangentLoad = supports.reduce((sum, row) => sum + row[0], 0);
          near(-tangentLoad / load, friction, 3e-9);
        }
      }
      const v = sphere.linearVelocity;
      const omega = sphere.angularVelocity;
      const currentEnergy =
        0.5 * mass * v.reduce((sum, x) => sum + x ** 2, 0) +
        0.5 * inertia * omega.reduce((sum, x) => sum + x ** 2, 0) +
        shell.readSphereContact(0).energy;
      near(mass * (v[0] - startVelocity[0]), sliding, 1e-5);
      near(inertia * (omega[1] - startAngular[1]), torque, 1e-6);
      near(currentEnergy + work, initialEnergy, 6e-4);
      assert.ok(work > 0 && torque > 0 && normal > 0 && sliding < 0);
      return { v, omega, work, sliding, normal, torque, hash: world.hash() };
    };
    const result = measure();
    world.restoreSnapshot(saved.bytes);
    assert.deepEqual(measure(), result);
    return { ...result, hash: undefined };
  };
  const stick = await run(1, 0.1, false);
  near(stick.v[0] - 0.1325 * stick.omega[1], 0, 5e-4);
  const slide = await run(0.02, 1.2, false);
  near(-slide.sliding / slide.normal, 0.02, 3e-9);
  assert.ok(slide.v[0] > 1);
  assert.deepEqual(await run(1, 0.1, true), stick);
  t.diagnostic(
    `Dry stick dissipates ${stick.work.toFixed(6)} J. Sliding impulse ratio ${(-slide.sliding / slide.normal).toFixed(6)}.`,
  );
});

test('a glancing sphere exchanges reciprocal linear and angular momentum with a free sheet', async () => {
  const scene = await sphereModel({
    rateLevel: 4,
    presentationHz: 960,
    fixed: false,
    position: [0.3, 0.25, 0.135],
    speed: [0.6, 0.15, -0.8],
    friction: 0.28,
  });
  using _physics = scene.physics;
  const { world, sphere, shell, mass, radius } = scene;
  const nodeMass = (material.density * material.thickness) / 6;
  const inertia = 0.4 * mass * radius * radius;
  const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
  const momentum = () => {
    const linear = sphere.linearVelocity.map((value) => mass * value);
    const angular = cross(sphere.position, linear).map((value, axis) => value + inertia * sphere.angularVelocity[axis]);
    const mesh = shell.readMesh();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p = mesh.velocities.slice(i, i + 3).map((value) => nodeMass * value);
      const l = cross(mesh.positions.slice(i, i + 3), p);
      for (let axis = 0; axis < 3; axis++) {
        linear[axis] += p[axis];
        angular[axis] += l[axis];
      }
    }
    return { linear, angular };
  };
  const before = momentum();
  let dissipated = 0;
  for (let frame = 1; frame <= 48; frame++) {
    world.advance(frame);
    dissipated += shell.readSphereFriction(0).dissipatedEnergy;
  }
  const after = momentum();
  assert.ok(dissipated > 0.05 && Math.abs(sphere.angularVelocity[1]) > 0.01);
  assert.ok(shell.readMesh().velocities.some((value, axis) => axis % 3 === 0 && Math.abs(value) > 0.002));
  for (let axis = 0; axis < 3; axis++) {
    near(after.linear[axis], before.linear[axis], 2e-5);
    near(after.angular[axis], before.angular[axis], 2e-4);
  }
});

test('a negative sphere friction input gives an actionable solver error', async () => {
  await assert.rejects(
    () => sphereModel({ rateLevel: 3, fixed: true, position: [0.25, 0.25, 0.15], friction: -0.01 }),
    { code: 'state', message: /Choose a finite nonnegative friction coefficient/ },
  );
});

test('a one-substep moving rigid integrator cannot realize both contact moments', async () => {
  const loaded = await sphereModel({ rateLevel: 1, fixed: false, position: [0.3, 0.2, 0.16], substeps: 1 });
  using _physics = loaded.physics;
  assert.throws(() => loaded.world.advance(1), {
    code: 'state',
    message: /Use at least two rigid substeps/,
  });
});

const joined = {
  positions: [
    [-1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  triangles: [
    [0, 1, 2],
    [3, 4, 5],
  ],
  seams: [
    {
      sides: [
        [1, 2],
        [3, 5],
      ],
      stiffness: 4e5,
      peakTraction: 12e3,
      toughness: 600,
    },
  ],
};

function joinedModel(speed) {
  const velocities = joined.positions.map((_, index) => [index < 3 ? -speed : speed, 0, 0]);
  return model({ ...joined, velocities });
}

function openingInPlane(mesh) {
  const lip = [1, 2, 5, 3].map((vertex) => [mesh.positions[3 * vertex], mesh.positions[3 * vertex + 1]]);
  const twice = lip.reduce((sum, [x, y], i) => {
    const [nextX, nextY] = lip[(i + 1) % lip.length];
    return sum + x * nextY - y * nextX;
  }, 0);
  return Math.abs(twice) / 2;
}

function totalSeamEnergy(shell) {
  const state = shell.readBudget();
  const seam = shell.readSeam(0);
  return (
    state.kinetic +
    state.membrane +
    state.bending +
    state.hardening +
    state.plasticDissipation +
    seam.elasticEnergy +
    seam.fractureWork
  );
}

test('distributed seam releases real sheet edges using the specified fracture energy and replays', async () => {
  const { shell, world } = await joinedModel(0.8);
  const start = world.takeSnapshot();
  const initialEnergy = shell.readBudget().kinetic;
  const measure = () => {
    world.advance(18);
    const tear = shell.readSeam(0);
    const mesh = shell.readMesh();
    assert.equal(tear.broken, true);
    assert.equal(tear.elasticEnergy, 0);
    near(tear.fractureWork, joined.seams[0].toughness * material.thickness, 1e-11);
    near(tear.openingArea, openingInPlane(mesh), 1e-11);
    assert.ok(tear.openingArea > 0.1);
    near(totalSeamEnergy(shell), initialEnergy, 0.01);
    const totalSpeed = mesh.velocities.filter((_, index) => index % 3 === 0).reduce((sum, value) => sum + value, 0);
    near(totalSpeed, 0, 1e-10);
    assert.deepEqual(mesh.triangles, new Uint32Array([0, 1, 2, 3, 4, 5]));
    return { tear, mesh, hash: world.hash() };
  };
  const first = measure();
  world.restoreSnapshot(start.bytes);
  assert.deepEqual(measure(), first);
});

test('insufficient work softens the seam and unloads without unsealing the panel', async () => {
  const { shell, world } = await joinedModel(0.29);
  world.advance(7);
  const loading = shell.readSeam(0);
  assert.ok(loading.fractureWork > 0);
  world.advance(15);
  const unloading = shell.readSeam(0);
  assert.equal(unloading.broken, false);
  assert.equal(unloading.openingArea, 0);
  assert.ok(unloading.fractureWork >= loading.fractureWork);
  assert.ok(unloading.separation[0] < unloading.history[0]);
  assert.ok(unloading.history[0] > 0.03);
  const peak = unloading.history[0];
  assert.ok(peak < 0.1);
});

test('invalid cohesive seam inputs identify boundary, endpoint order and fracture law', async () => {
  const base = joined.seams[0];
  for (const [seam, message] of [
    [
      {
        ...base,
        sides: [
          [1, 2],
          [0, 1],
        ],
      },
      /Pair two distinct existing shell boundaries/,
    ],
    [
      {
        ...base,
        sides: [
          [1, 2],
          [5, 3],
        ],
      },
      /matching rest positions and endpoint order/,
    ],
    [{ ...base, toughness: 1 }, /choose a failure opening above initiation/],
  ]) {
    await assert.rejects(model({ ...joined, seams: [seam] }), { code: 'state', message });
  }
});

const rolling = { rollingDirection: [1, 0, 0], r0: 0.49, r45: 0.59, r90: 0.51 };

test('rolled sheet uses its original material directions under alternate triangle bases', async () => {
  const run = async (triangles) => {
    const { shell, world } = await model({
      triangles,
      pinned: [0, 2],
      material: { ...material, anisotropy: rolling },
    });
    shell.setForce(1, [5000, 0, 0]);
    world.advance(2);
    const { positions, velocities } = shell.readMesh();
    const face = shell.readFace(0);
    assert.ok(face.equivalentPlasticStrain > 1e-3);
    const [xx, yy, xy] = face.stress;
    const g = 1 / (1 + rolling.r0);
    const h = rolling.r0 * g;
    const f = h / rolling.r90;
    const n = ((rolling.r0 + rolling.r90) * (rolling.r45 + 0.5) * g) / rolling.r90;
    const equivalent = Math.sqrt(f * yy ** 2 + g * xx ** 2 + h * (xx - yy) ** 2 + 2 * n * xy ** 2);
    near(equivalent, material.yieldStress + material.hardeningModulus * face.equivalentPlasticStrain, 1e-7);
    return { positions, velocities, face };
  };
  const first = await run([[0, 1, 2]]);
  const next = await run([[1, 2, 0]]);
  for (const [index, value] of first.positions.entries()) near(next.positions[index], value, 3e-14);
  for (const [index, value] of first.velocities.entries()) near(next.velocities[index], value, 1e-12);
  for (const [index, value] of first.face.stress.entries()) near(next.face.stress[index], value, 1e-7);
});

test('rolled shell rejects unusable coupon values and directions normal to a sheet', async () => {
  for (const [anisotropy, message] of [
    [{ ...rolling, r45: 0 }, /Use finite positive Lankford ratios/],
    [{ ...rolling, rollingDirection: [0, 0, 1] }, /Give a rolling direction with a tangent projection/],
  ]) {
    await assert.rejects(model({ material: { ...material, anisotropy } }), { code: 'state', message });
  }
});

test('a falling sheet replays across presentation clocks and snapshots', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => CrushShellSolver.load()));
  const fall = (rate = { num: 24, den: 1 }) => {
    const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0], memory: worldMemory(false) });
    world.add(solvers.shift(), { positions, triangles, material, velocities: positions.map(() => [0.45, -1.5, 0.2]) });
    return world;
  };
  frameRateIndependent(fall);
  seekEqualsContinuous(() => fall(), { at: 2, frames: 12 });
});
