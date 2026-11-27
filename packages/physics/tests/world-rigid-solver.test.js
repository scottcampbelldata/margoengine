// The rigid kernel as a framework solver: stepped by a PhysicsWorld it gives the same bits as Physics stepped alone, publishes
// every body's state, takes the impulses other solvers add (as linear and angular impulse pairs), refuses a step that is no
// framework rate, and its state snapshots and restores with the world, refusing a world laid out with other capacities.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_MOBILITY_WORDS,
  BODY_WORDS,
  IMPULSE_WORDS,
  PhysicsWorld,
  RigidSolver,
  rateLevelOf,
  regionWords,
  worldMemory,
} from '../dist/world.js';

await Physics.load();

/** A floor, a falling box and a tumbling capsule, at a 1/60 s step unless `step` is given. */
function scene({ step = 1 / 60, bodies = 0, arena } = {}) {
  const physics = new Physics(null, { fixedTimestep: step, ...(arena ? { arena } : {}) });
  if (bodies) physics.kernel.reserve(bodies, bodies);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const box = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
    capsule = physics.addBody(null, {
      position: [1, 3, 0],
      angularVelocity: [1, 2, 0],
      colliders: { shape: 'capsule', radius: 0.2, halfHeight: 0.4 },
    });
  return { physics, box, capsule };
}

test('stepped by a world, the rigid solver gives the bits Physics gives stepped alone', () => {
  const alone = scene(),
    inWorld = scene(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: inWorld.physics });
  world.advance(90);
  for (let i = 0; i < 90; i++) alone.physics.step();
  assert.equal(inWorld.physics.stepCount, 90);
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash);
  assert.deepEqual(inWorld.box.position, alone.box.position);
  alone.physics.dispose();
  inWorld.physics.dispose();
});

test('the rigid solver keeps working when another solver added mid-run grows the world memory under it', () => {
  // The rigid solver takes its views afresh at each use, never across steps: another solver's allocation grows the memory,
  // which detaches every view over it, and the rigid solver steps, publishes and takes impulses on as before.
  const alone = scene(),
    inWorld = scene(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: inWorld.physics });
  world.advance(30);
  const before = world.arena.memory.buffer.byteLength,
    seen = [];
  const grower = {
    describe: () => ({ id: 'grower', fields: [{ field: BODIES_FIELD, access: 'read' }], rate: 0, stableRate: () => 0 }),
    init(host) {
      this.host = host;
      host.allocate('big', 4 << 20, 'u8', 1);
    },
    step(context) {
      const port = context.inputs.get('bodies');
      seen.push(new Float32Array(this.host.memory.buffer, port.region.byteOffset, BODY_WORDS).slice());
    },
    exportPorts: () => [],
    importPorts() {},
    stateRegions: () => [],
    extraState: () => [],
  };
  world.add(grower, {});
  assert.ok(world.arena.memory.buffer.byteLength >= before + (4 << 20), 'the memory grew by the new region');
  world.advance(90);
  for (let i = 0; i < 90; i++) alone.physics.step();
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash, 'the same bits as stepped alone');
  assert.equal(seen.length, 60, 'the reader stepped on every frame after it joined');
  assert.ok(
    seen.every((r) => r.every(Number.isFinite)),
    'every published record reads whole',
  );
  // Row 0 is the floor, added first: the record read after the growth is its pose.
  assert.deepEqual([...seen.at(-1).subarray(0, 3)], [0, -0.5, 0]);
  alone.physics.dispose();
  inWorld.physics.dispose();
});

test('the bodies port holds every body: pose, centre of mass, velocities, inverse mass, world inverse inertia and substeps', () => {
  const { physics, capsule } = scene();
  let published = null;
  const reader = {
    describe: () => ({ id: 'reader', fields: [{ field: BODIES_FIELD, access: 'read' }], rate: 0, stableRate: () => 0 }),
    init(host) {
      this.host = host;
    },
    step(context) {
      const port = context.inputs.get('bodies');
      published = new Float32Array(this.host.memory.buffer, port.region.byteOffset, port.region.byteLength / 4).slice();
    },
    exportPorts: () => [],
    importPorts() {},
    stateRegions: () => [],
    extraState: () => [],
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(reader, {});
  world.advance(30);
  const at = capsule.row * BODY_WORDS,
    record = published.subarray(at, at + BODY_WORDS),
    f = Math.fround;
  // The reader stepped after the rigid solver published at the last coupling tick, so the record is the pose then.
  assert.equal(record[23], 1, 'a moving body');
  assert.deepEqual([...record.subarray(0, 3)], capsule.position.map(f));
  assert.deepEqual([...record.subarray(3, 7)], capsule.rotation.map(f));
  assert.deepEqual([...record.subarray(10, 13)], capsule.linearVelocity.map(f));
  assert.equal(record[16], f(1 / capsule.mass));
  // The substeps its last step took: the world's times 2^k for its island's level (a held force moves it by
  // (v + F dt (s + 1) / (2 s m)) dt, which a solver holding a load from its pose needs).
  assert.equal(record[24], physics.substeps * 2 ** physics.kernel.columns.substepLevel[capsule.row], 'its substeps');
  assert.ok(record[24] >= physics.substeps);
  assert.equal(published[0 * BODY_WORDS + 23], 0, 'the fixed floor is not moving');
  assert.equal(published[0 * BODY_WORDS + 24], 0, 'and takes no substeps');
  physics.dispose();
});

test('impulses other solvers add land as linear and angular impulse pairs, as an impulse at a point does', () => {
  const pushed = scene(),
    direct = scene(),
    J = [0, 4, 1],
    point = [0.3, 2.2, 0.1];
  // The contributor pushes the box once, at a point: (J, (p - c) x J), with c its centre of mass at the time.
  const pusher = {
    describe: () => ({
      id: 'pusher',
      fields: [
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        { field: BODIES_FIELD, access: 'read' },
      ],
      rate: 0,
      stableRate: () => 0,
    }),
    init(host) {
      this.host = host;
      this.region = host.allocate('push', 8 * IMPULSE_WORDS * pushed.physics.kernel.capacity, 'f64', 1);
      this.pushed = false;
    },
    step(context) {
      const words = new Float64Array(this.host.memory.buffer, this.region.byteOffset, this.region.byteLength / 8);
      words.fill(0);
      if (this.pushed) return;
      const bodies = context.inputs.get('bodies'),
        record = new Float32Array(
          this.host.memory.buffer,
          bodies.region.byteOffset + pushed.box.row * BODY_WORDS * 4,
          BODY_WORDS,
        ),
        r = [point[0] - record[7], point[1] - record[8], point[2] - record[9]],
        at = pushed.box.row * IMPULSE_WORDS;
      words.set(
        [J[0], J[1], J[2], r[1] * J[2] - r[2] * J[1], r[2] * J[0] - r[0] * J[2], r[0] * J[1] - r[1] * J[0]],
        at,
      );
      this.pushed = true;
    },
    exportPorts(tick) {
      return [{ field: BODY_IMPULSES_FIELD.name, region: this.region, tick, cell: [0, 0, 0] }];
    },
    importPorts() {},
    stateRegions: () => [this.region].filter(Boolean),
    extraState: () => [],
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics: pushed.physics })
    .add(pusher, {});
  world.advance(1);
  world.advance(3);
  // The same push by the body API, before the first step: the pusher (its id sorts before 'rigid') stepped first at the
  // first tick and published, and the rigid solver summed it into that tick's step, about the centre of mass it had then.
  const c = direct.box.worldCenterOfMass,
    r = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  direct.box.applyImpulse(J);
  direct.box.applyTorqueImpulse([r[1] * J[2] - r[2] * J[1], r[2] * J[0] - r[0] * J[2], r[0] * J[1] - r[1] * J[0]]);
  for (let i = 0; i < 3; i++) direct.physics.step();
  for (const k of [0, 1, 2]) {
    assert.equal(pushed.box.linearVelocity[k], direct.box.linearVelocity[k], `linear ${k}`);
    assert.equal(pushed.box.angularVelocity[k], direct.box.angularVelocity[k], `angular ${k}`);
  }
  assert.ok(Math.abs(pushed.box.angularVelocity[2]) > 0.1, 'the push at a point turned the box');
  pushed.physics.dispose();
  direct.physics.dispose();
});

test('the frame-zero mobility predicts the six impulse responses of a rotated, axis-locked rigid body', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60, substeps: 1 });
  try {
    const fixed = physics.addBody(null, { type: 'fixed', position: [0, -10, 0] });
    const disabled = physics.addBody(null, { position: [0, -10, 0], colliders: { shape: 'sphere', radius: 1 } });
    disabled.enabled = false;
    const body = physics.addBody(null, {
      position: [5, 2, 3],
      rotation: [0.25, 0.25, 0.25, Math.sqrt(13) / 4],
      massProperties: { mass: 10, centerOfMass: [0.375, 0, 0], principalInertia: [1, 3, 5] },
      colliders: { shape: 'box', halfExtents: [0.25, 0.5, 0.75] },
      enabledTranslations: [true, false, true],
      enabledRotations: [false, true, true],
    });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }, [7, 0, 0]);
    const bodies = world.fields.port(BODIES_FIELD.name);
    const mobility = world.fields.port(BODY_MOBILITY_FIELD.name);
    assert.equal(bodies.region.layout, 2);
    assert.equal(bodies.region.byteLength, world.bodyRows * 25 * 4);
    assert.deepEqual(mobility.cell, bodies.cell);
    assert.equal(mobility.tick, -1);
    const words = regionWords(world.memory, mobility.region);
    const at = body.row * BODY_MOBILITY_WORDS;
    const [mx, my, mz, xx, xy, xz, yy, yz, zz] = words.slice(at, at + BODY_MOBILITY_WORDS);
    const inverse = [
      [xx, xy, xz],
      [xy, yy, yz],
      [xz, yz, zz],
    ];
    const raw = regionWords(world.memory, bodies.region);
    assert.ok(Math.abs(raw[body.row * BODY_WORDS + 18]) > 0.05, 'the dry inertia couples the locked X and free Y axes');
    assert.ok(Math.abs(yz) > 0.05, 'free angular axes remain coupled');
    assert.deepEqual([mx, my, mz], body.effectiveInverseMass.map(Math.fround));
    assert.deepEqual(inverse.flat(), body.effectiveWorldInverseInertia.map(Math.fround));
    for (const immobile of [fixed, disabled]) {
      const start = immobile.row * BODY_MOBILITY_WORDS;
      assert.ok(words.subarray(start, start + BODY_MOBILITY_WORDS).every((entry) => entry === 0));
    }

    const zero = world.takeSnapshot();
    for (const kind of ['linear', 'angular', 'held angular']) {
      for (let axis = 0; axis < 3; axis++) {
        world.restoreSnapshot(zero.bytes);
        const push = [0, 0, 0];
        push[axis] = 1;
        if (kind === 'linear') body.applyImpulse(push);
        else if (kind === 'angular') body.applyTorqueImpulse(push);
        else body.addTorque(push.map((x) => x / physics.fixedTimestep));
        world.advance(1);
        const got = kind === 'linear' ? body.linearVelocity : body.angularVelocity;
        const expected = kind === 'linear' ? [mx * push[0], my * push[1], mz * push[2]] : inverse[axis];
        // At a zero entry the lock acts exactly. Nonzero columns cross the f32 kernel's quaternion rotation and solve.
        const bound = 8 * 2 ** -23 * Math.max(...expected.map(Math.abs));
        for (let k = 0; k < 3; k++) {
          const error = Math.abs(got[k] - expected[k]);
          assert.ok(error <= (expected[k] === 0 ? 0 : bound), `${kind} ${axis} → ${k}: ${got[k]} vs ${expected[k]}`);
        }
      }
    }
  } finally {
    physics.dispose();
  }
});

test('older rigid checkpoint layouts remain selectable without a mobility port', () => {
  const { physics } = scene();
  try {
    const world = new PhysicsWorld().add(new RigidSolver('rigid', { publishMobility: false }), { physics });
    assert.equal(world.fields.port(BODY_MOBILITY_FIELD.name), undefined);
    assert.ok(world.fields.port(BODIES_FIELD.name));
    const zero = world.takeSnapshot();
    world.advance(2);
    world.restoreSnapshot(zero.bytes);
    assert.equal(world.hash(), zero.hash);
  } finally {
    physics.dispose();
  }
});

test('a fixed step that is no framework rate is refused, naming the nearest levels', () => {
  assert.equal(rateLevelOf(1 / 60), 0);
  assert.equal(rateLevelOf(1 / 240), 2);
  assert.throws(() => rateLevelOf(1 / 100), /1\/60 s \(level 0\) or 1\/120 s \(level 1\)/);
  const { physics } = scene({ step: 1 / 90 });
  assert.throws(() => new PhysicsWorld().add(new RigidSolver(), { physics }), RangeError);
  physics.dispose();
});

test('the kernel state snapshots and restores with the world, and a world of other capacities is refused by name', () => {
  const first = scene(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: first.physics });
  world.advance(20);
  const saved = world.takeSnapshot();
  world.advance(70); // frame 70: 50 steps after the snapshot
  const ran = first.physics.kernel.hash;
  // The same world again, restored to frame 20 and run on, ends with the same bits.
  const second = scene(),
    again = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: second.physics });
  again.restoreSnapshot(saved.bytes);
  assert.equal(again.hash(), saved.hash);
  for (let i = 0; i < 50; i++) second.physics.step();
  assert.equal(second.physics.kernel.hash, ran);
  // A world built with room for more bodies has other column capacities: refused before a byte is written.
  const third = scene({ bodies: 4096 }),
    other = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: third.physics }),
    before = other.hash();
  assert.throws(
    () => other.restoreSnapshot(saved.bytes),
    (error) => error.name === 'MargoError' && error.code === 'state' && /positionX\[\d+\]/.test(error.message),
  );
  assert.equal(other.hash(), before);
  for (const s of [first, second, third]) s.physics.dispose();
});

test('a Physics stepped 240 times a second steps at level 2 in a world, and to the bits it gives alone', () => {
  // A solver's level was read from describe(), which the world asks before init (which learns the Physics's step), so
  // every RigidSolver stepped at level 0 and a Physics at 1/240 s was refused ("the world asked for 1/60 s").
  const make = () => {
    const physics = new Physics(null, { fixedTimestep: 1 / 240 });
    physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
    return physics;
  };
  const alone = make(),
    inWorld = make(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics: inWorld });
  world.advance(30);
  for (let i = 0; i < 120; i++) alone.step();
  assert.equal(inWorld.stepCount, 120, 'four rigid steps a frame');
  assert.equal(inWorld.kernel.hash, alone.kernel.hash);
});

test("a seek by restore rewinds the Physics's step count, so a load clocked by it and advance() go on as a continuous run", () => {
  // KB-PHYS-STEPCOUNTSEEK1: the step count lives on the Physics, outside the kernel's columns, so a restore left it where
  // the run had reached and everything clocked by stepCount * fixedTimestep read the wrong time after a seek. The box is
  // pushed by a gust that is a function of that time, as a wind or a sail's is.
  const clocked = () => {
    const made = scene(),
      { physics, box } = made;
    physics.on('beforestep', () => {
      const time = physics.stepCount * physics.fixedTimestep;
      box.applyImpulse([0.02 * Math.sin(5 * time), 0, 0.01 * Math.cos(3 * time)]);
    });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics });
    return { world, physics, box };
  };
  const straight = clocked();
  straight.world.advance(90);
  const seek = clocked();
  seek.world.advance(12);
  const saved = seek.world.takeSnapshot();
  seek.world.advance(60);
  seek.world.restoreSnapshot(saved.bytes);
  // The world went back to frame 12: the next advance runs frames 13 to 90 again.
  seek.world.advance(90);
  assert.equal(seek.physics.stepCount, straight.physics.stepCount);
  assert.equal(seek.physics.stepCount, 90);
  assert.deepEqual(seek.box.position, straight.box.position);
  assert.deepEqual(seek.box.linearVelocity, straight.box.linearVelocity);
  assert.equal(seek.world.hash(), straight.world.hash());
  straight.physics.dispose();
  seek.physics.dispose();
});

test("a Physics made on the world's arena keeps its state in the world's memory, and steps and restores to the same bits", () => {
  const alone = scene(),
    // The kernel has a plain-memory build so far: the world is made on a plain memory.
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) }),
    inWorld = scene({ arena: world.arena });
  const solver = new RigidSolver();
  world.add(solver, { physics: inWorld.physics });
  assert.equal(inWorld.physics.kernel.memory, world.memory);
  assert.ok(
    solver.stateRegions().every((region) => region.memory === undefined),
    'no memory of its own to name',
  );
  world.advance(20);
  const saved = world.takeSnapshot();
  world.advance(70); // frame 70
  for (let i = 0; i < 70; i++) alone.physics.step();
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash);
  const ran = world.hash();
  world.restoreSnapshot(saved.bytes);
  assert.equal(world.hash(), saved.hash);
  world.advance(70);
  assert.equal(world.hash(), ran);
  alone.physics.dispose();
  inWorld.physics.dispose();
});
