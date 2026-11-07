// The replay proof's scenes, with no import, so Node and every browser run the same file. `kernelScene` makes one for one
// the calls kernel/tests/replay.rs makes, so one list of hashes proves Wasm and native code agree. Every value it writes
// is exact in f32, and every choice comes from one integer stream.

/** Steps of a full replay, and how often a hash is taken. */
export const REPLAY_STEPS = 10_000;
export const REPLAY_EVERY = 100;

const DT = 1 / 60;
const GRAVITY = [
  [0, -9.81, 0],
  [0, 0, 0],
  [1, -2, 0.5],
  [0, 0, 0],
];

/** Every coordinate is exact in f32. */
const OCTAHEDRON = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const OCTAHEDRON_FACES = [
  [0, 2, 4],
  [2, 1, 4],
  [1, 3, 4],
  [3, 0, 4],
  [2, 0, 5],
  [1, 2, 5],
  [3, 1, 5],
  [0, 3, 5],
];

class Stream {
  constructor(seed) {
    this.state = seed;
  }
  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (this.state = x >>> 0);
  }
  below(n) {
    return this.next() % n;
  }
  /** From -4 to 4 in steps of 1/256. */
  value() {
    return (this.below(2049) - 1024) / 256;
  }
  /** From 0.25 to 1.125 in steps of 1/8. */
  size() {
    return 0.25 + this.below(8) / 8;
  }
}

/**
 * Runs the scene on a `KernelWorld` class and returns the hash taken every {@link REPLAY_EVERY} steps. It grows from one
 * row, adds and removes bodies, moves fixed ones by hand, drives kinematic ones, sets forces and impulses, changes gravity
 * and substeps, and lets islands sleep and wakes them.
 * @param visit Called after each step with the world and the step's number.
 */
export function kernelScene(KernelWorld, steps = REPLAY_STEPS, visit = () => {}) {
  const random = new Stream(0x4d415247),
    world = new KernelWorld(1, 1),
    c = world.columns,
    rows = [],
    hashes = [],
    hull = world.addHull(OCTAHEDRON, OCTAHEDRON_FACES);
  const spawn = () => {
    const kind = ['dynamic', 'dynamic', 'dynamic', 'dynamic', 'dynamic', 'fixed', 'kinematicPosition', 'kinematicVelocity'][
        random.below(8)
      ],
      row = world.addBody(kind),
      density = kind === 'dynamic' ? 1 + random.below(8) : 0;
    switch (random.below(5)) {
      case 0:
        world.addCollider(row, 'ball', [random.size()], { density });
        break;
      case 1:
        world.addCollider(row, 'box', [random.size(), random.size(), random.size()], { density });
        break;
      case 2:
        world.addCollider(row, 'capsule', [random.size(), random.size()], { density });
        break;
      case 3:
        world.addCollider(row, 'hull', [hull], { density });
        break;
      default:
        world.addCollider(row, 'box', [random.size(), random.size(), random.size()], { density });
        world.addCollider(row, 'ball', [random.size()], { position: [1, 0.5, 0], rotation: [0, 0, 0.6, 0.8], density });
    }
    c.positionX[row] = random.value() * 2;
    c.positionY[row] = random.value() * 2;
    c.positionZ[row] = random.value() * 2;
    c.targetX[row] = c.positionX[row];
    c.targetY[row] = c.positionY[row];
    c.targetZ[row] = c.positionZ[row];
    if (kind !== 'fixed' && kind !== 'kinematicPosition') {
      c.linearX[row] = random.value();
      c.linearY[row] = random.value();
      c.linearZ[row] = random.value();
      c.angularX[row] = random.value() * 2;
      c.angularY[row] = random.value() * 2;
      c.angularZ[row] = random.value() * 2;
    }
    const damping = random.below(4) === 0 ? 0 : 2;
    c.linearDamping[row] = damping;
    c.angularDamping[row] = damping;
    world.touch(row);
    rows.push(row);
  };
  for (let i = 0; i < 48; i++) spawn();
  // Joints of each kind between any two rows, so some form chains and rings; the removals below take them with their bodies.
  for (let i = 0; i < 20; i++) {
    const a = rows[random.below(rows.length)],
      b = rows[random.below(rows.length)];
    if (a === b) continue;
    const cone = 7 | (1 << 26) | ((1 << 6) << 4) | ((1 << 6) << 3),
      joint = world.addJoint(a, b, i < 16 ? [7, 7 | (6 << 3), 6 | (7 << 3), 63][i % 4] : cone);
    c.jointAnchorAX[joint] = random.value() / 4;
    c.jointAnchorAY[joint] = random.value() / 4;
    c.jointAnchorBZ[joint] = random.value() / 4;
    if (i >= 16) {
      c.jointMin3[joint] = -0.4;
      c.jointMax3[joint] = 0.4;
      c.jointMin4[joint] = -Infinity;
      c.jointMin5[joint] = 0.3;
      c.jointMax5[joint] = 0.8;
    } else if (i % 4 === 1) {
      world.setJointAxis(joint, [random.value(), 1, random.value()]);
      c.jointFlags[joint] |= (1 << 6) << 3;
      c.jointMin3[joint] = -1;
      c.jointMax3[joint] = 1;
    }
    if (i < 16 && i % 8 === 1) {
      c.jointFlags[joint] |= (1 << 12) << 3;
      c.jointTarget3[joint] = 0.5;
      c.jointStiffness3[joint] = 50;
      c.jointDamping3[joint] = 5;
      c.jointCap3[joint] = 100;
    }
  }
  for (let i = 0; i < steps; i++) {
    if (i % 512 === 0) {
      world.setGravity(...GRAVITY[(i / 512) % 4]);
      for (const row of rows) {
        world.wake(row);
        c.forceX[row] = c.forceY[row] = c.forceZ[row] = 0;
        c.torqueX[row] = c.torqueY[row] = c.torqueZ[row] = 0;
      }
    }
    if (i % 2048 === 0) world.substeps = 1 + ((i / 2048) % 4);
    if (i === 4096) world.reserve(300, 300);
    if (i % 97 === 0 && rows.length > 8) {
      const at = random.below(rows.length);
      world.removeBody(rows[at]);
      rows[at] = rows[rows.length - 1];
      rows.pop();
    }
    if (i % 101 === 0 && rows.length < 96) spawn();
    const pick = rows[random.below(rows.length)];
    if (i % 29 === 0) {
      world.wake(pick);
      c.impulseX[pick] = random.value();
      c.impulseY[pick] = random.value();
      c.angularImpulseZ[pick] = random.value();
    }
    if (i % 41 === 0) {
      world.wake(pick);
      c.forceY[pick] = c.forceY[pick] === 0 ? random.value() : 0;
      c.torqueX[pick] = c.torqueX[pick] === 0 ? random.value() : 0;
    }
    if (i % 503 === 0) world.sleep(pick);
    if (i % 509 === 0) world.setCanSleep(pick, i % 2 === 0);
    if (i % 211 === 0 && (c.flags[pick] & 6) === 0) {
      c.positionX[pick] = random.value();
      world.touch(pick);
    }
    for (const row of rows) {
      const x = c.positionX[row],
        y = c.positionY[row],
        z = c.positionZ[row];
      if (x > 16 || x < -16 || y > 16 || y < -16 || z > 16 || z < -16) {
        c.positionX[row] = random.value();
        c.positionY[row] = random.value();
        c.positionZ[row] = random.value();
        c.linearX[row] = c.linearY[row] = c.linearZ[row] = 0;
        world.touch(row);
      }
      if ((c.flags[row] & 6) === 4) {
        c.targetX[row] = c.positionX[row] + 0.0625;
        c.targetY[row] = c.positionY[row];
        c.targetZ[row] = c.positionZ[row];
        c.targetRotationY[row] = i % 64 < 32 ? 0.6 : 0;
        c.targetRotationW[row] = i % 64 < 32 ? 0.8 : 1;
      }
    }
    world.step(DT);
    if ((i + 1) % REPLAY_EVERY === 0) hashes.push(world.hash);
    visit(world, i);
  }
  return hashes;
}

/**
 * The same kind of scene through the `Physics` surface, on a world with no engine: every call a game makes on a step, in
 * the browser's own double-precision arithmetic before the kernel rounds it.
 */
export function physicsScene(Physics, steps = REPLAY_STEPS) {
  const random = new Stream(0x4d415248),
    physics = new Physics(null),
    bodies = [],
    hashes = [];
  const vector = (scale = 1) => [random.value() * scale, random.value() * scale, random.value() * scale];
  const spawn = () => {
    const type = ['dynamic', 'dynamic', 'dynamic', 'fixed', 'kinematicPosition', 'kinematicVelocity'][random.below(6)],
      moving = type === 'dynamic' || type === 'kinematicVelocity',
      colliders = [
        { shape: 'box', halfExtents: [random.size(), random.size(), random.size()] },
        { shape: 'sphere', radius: random.size(), offset: [0.5, 0, 0] },
        { shape: 'capsule', radius: random.size(), halfHeight: random.size(), rotation: [0.6, 0, 0, 0.8] },
      ].slice(random.below(2), 3 - random.below(2));
    bodies.push(
      physics.addBody(null, {
        type,
        position: vector(2),
        rotation: [0, 0.6, 0, 0.8],
        linearVelocity: moving ? vector() : undefined,
        angularVelocity: moving ? vector(2) : undefined,
        linearDamping: random.below(2) * 2,
        angularDamping: random.below(2) * 2,
        gravityScale: 0.5 + random.below(2) / 2,
        colliders,
      }),
    );
  };
  for (let i = 0; i < 32; i++) spawn();
  for (let i = 0; i < steps; i++) {
    if (i % 512 === 0) {
      physics.gravity = GRAVITY[(i / 512) % 4];
      for (const body of bodies) body.resetForces();
    }
    if (i % 97 === 0 && bodies.length > 8) {
      const at = random.below(bodies.length);
      bodies[at].remove();
      bodies[at] = bodies[bodies.length - 1];
      bodies.pop();
    }
    if (i % 101 === 0 && bodies.length < 64) spawn();
    const pick = bodies[random.below(bodies.length)];
    if (i % 7 === 0) pick.applyImpulse(vector(), vector(2));
    if (i % 11 === 0) pick.addForce(vector(), vector(2));
    if (i % 13 === 0) pick.applyTorqueImpulse(vector());
    if (i % 17 === 0) pick.addTorque(vector());
    if (i % 503 === 0) pick.sleep();
    for (const body of bodies) {
      const [x, y, z] = body.position;
      if (x > 16 || x < -16 || y > 16 || y < -16 || z > 16 || z < -16) {
        body.setPosition(vector());
        body.setLinearVelocity([0, 0, 0]);
      }
      if (body.type === 'kinematicPosition') {
        body.setNextPosition([x + 0.0625, y, z]);
        body.setNextRotation(i % 64 < 32 ? [0, 0.6, 0, 0.8] : [0, 0, 0, 1]);
      }
    }
    physics.step();
    if ((i + 1) % REPLAY_EVERY === 0) hashes.push(physics.kernel.hash);
  }
  physics.dispose();
  return hashes;
}
