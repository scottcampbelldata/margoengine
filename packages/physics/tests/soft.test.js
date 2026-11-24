// Soft bodies on the soft kernel: a rope against the catenary, a cloth against its own length, coupling with rigid
// bodies, tearing, replay and the particle API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc, SoftBodyMaterial, SoftMeshBinding } from '../dist/soft.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const create = async (options = {}) => {
  const physics = new Physics(null, options);
  return { physics, soft: await SoftBodies.attach(physics) };
};
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
// The catenary's parameter a for a rope of length `length` hung over `span`: length = 2 a sinh(span / 2a).
const catenaryA = (span, length) => {
  let lo = 0.05,
    hi = 1000;
  for (let i = 0; i < 200; i++) {
    const a = (lo + hi) / 2;
    if (2 * a * Math.sinh(span / (2 * a)) > length) lo = a;
    else hi = a;
  }
  return (lo + hi) / 2;
};
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

test('a rope pinned at both ends hangs as a catenary', async () => {
  const { physics, soft } = await create();
  const n = 40,
    span = 4,
    length = 5;
  // The rope is `length` long and its ends are `span` apart, so it hangs in a catenary: build it straight at its real length,
  // then bring the ends together.
  const real = SoftBodyDesc.rope([-length / 2, 0, 0], [length / 2, 0, 0], n, { bending: false }).setPinnedParticles([
    0,
    n - 1,
  ]);
  const body = soft.create(real);
  body.setParticlePosition(0, [-span / 2, 0, 0]);
  body.setParticlePosition(n - 1, [span / 2, 0, 0]);
  body.setLinearDamping(2);
  steps(physics, 600);
  const a = catenaryA(span, length),
    sag = a * (Math.cosh(span / (2 * a)) - 1);
  const positions = body.particlePositions();
  near(-positions[(((n - 1) / 2) | 0) * 3 + 1], sag, sag * 0.03, 'sag at the middle');
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1];
    near(y, -(a * (Math.cosh(span / (2 * a)) - Math.cosh(x / a))), 0.06, `particle ${i} height`);
  }
  const e = body.edges();
  for (let k = 0; k < e.length; k += 2) {
    const a0 = e[k],
      b0 = e[k + 1];
    const d = Math.hypot(
      positions[a0 * 3] - positions[b0 * 3],
      positions[a0 * 3 + 1] - positions[b0 * 3 + 1],
      positions[a0 * 3 + 2] - positions[b0 * 3 + 2],
    );
    near(d, length / (n - 1), (length / (n - 1)) * 0.03, `edge ${k / 2} length`);
  }
});

test('a cloth pinned along one edge hangs straight down and keeps its edge lengths', async () => {
  const { physics, soft } = await create();
  const nu = 8,
    nv = 8,
    d = 0.1;
  const cloth = soft.create(
    SoftBodyDesc.cloth([0, 2, 0], [d, 0, 0], [0, 0, d], nu, nv)
      .setPinnedParticles(Array.from({ length: nu }, (_, i) => i * nv))
      .setLinearDamping(2),
  );
  // The cloth starts flat at y = 2 and the pinned edge is the j = 0 row, so it swings down about that edge.
  steps(physics, 900);
  const p = cloth.particlePositions();
  for (let i = 0; i < nu; i++)
    for (let j = 1; j < nv; j++)
      near(p[(i * nv + j) * 3 + 1], 2 - j * d, 0.05, `particle ${i},${j} hangs at its depth`);
  const e = cloth.edges();
  let worst = 0;
  for (let k = 0; k < e.length; k += 2) {
    const a = e[k] * 3,
      b = e[k + 1] * 3,
      len = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    // Shear edges are d * sqrt(2) long, structural ones d.
    const rest = Math.abs(len - d) < Math.abs(len - d * Math.SQRT2) ? d : d * Math.SQRT2;
    worst = Math.max(worst, Math.abs(len - rest) / rest);
  }
  assert.ok(worst < 0.03, `an edge strays ${worst * 100}% from its length`);
});

test('a falling box is held by a cloth and the cloth sags more under a heavier box', async () => {
  const sagUnder = async (density) => {
    const { physics, soft } = await create();
    const n = 12,
      d = 0.1;
    const cloth = soft.create(
      SoftBodyDesc.cloth([-0.55, 1, -0.55], [d, 0, 0], [0, 0, d], n, n)
        .setPinnedParticles([0, n - 1, (n - 1) * n, n * n - 1])
        .setSoftness(40, 1)
        .setLinearDamping(3)
        .setParticleMass(0.02)
        .setParticleRadius(0.04),
    );
    const box = physics.addBody(null, {
      position: [0, 1.4, 0],
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], density },
    });
    steps(physics, 400);
    const middle = cloth.particlePosition(((n / 2) | 0) * n + ((n / 2) | 0));
    // The contacts are found at the start of each step, so a heavy box sinks a little into soft cloth before the cloth stops it: it
    // stays above the middle particle, which is what holds it up.
    assert.ok(box.position[1] > middle[1] + 0.04, 'the box stays on top of the cloth');
    assert.ok(Math.abs(box.linearVelocity[1]) < 0.5, 'the box has come to rest on it');
    return middle[1];
  };
  const light = await sagUnder(100),
    heavy = await sagUnder(800);
  assert.ok(heavy < light - 0.05, `heavy ${heavy} sags below light ${light}`);
});

test('a rope end takes a kinematic target, is released and the rope lies on the floor', async () => {
  const { physics, soft } = await create();
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10], friction: 1 },
  });
  void floor;
  const rope = soft.create(SoftBodyDesc.rope([0, 1, 0], [1, 1, 0], 10, { bending: false }).setPinnedParticles([0]));
  rope.setParticleKinematicTarget(0, [0, 1, 0.02]);
  steps(physics, 1);
  near(rope.particlePosition(0)[2], 0.02, 1e-6, 'the target is reached');
  assert.equal(rope.isParticlePinned(0), true);
  rope.setParticlePinned(0, false);
  assert.equal(rope.isParticlePinned(0), false);
  steps(physics, 600);
  // Released, it falls onto the floor and lies there at its particle radius, still as long as it was.
  const p = rope.particlePositions();
  for (let i = 0; i < 10; i++) assert.ok(p[i * 3 + 1] > -0.01, `particle ${i} is above the floor`);
  const resting = rope
    .particlePositions()
    .filter((_, k) => k % 3 === 1)
    .every((y) => y < 0.2);
  assert.ok(resting, 'the rope has settled on the floor');
});

test('a rope under load tears once, reports it and stays torn', async () => {
  const { physics, soft } = await create();
  const heavy = SoftBodyDesc.rope([0, 3, 0], [0, 1, 0], 6, { bending: false })
    .setPinnedParticles([0])
    .setParticleMass(2)
    .setSoftness(8, 0.5)
    .setEdgeTearResistance(0.02);
  const rope = soft.create(heavy);
  const events = [];
  soft.onTear((event) => events.push(event));
  steps(physics, 600);
  assert.ok(events.length > 0, 'a tear was reported');
  const torn = new Set(events.flatMap((e) => e.edges));
  for (const e of torn) assert.equal(rope.isEdgeTorn(e), true);
  assert.equal(
    torn.size,
    events.reduce((n, e) => n + e.edges.length, 0),
    'each edge is reported once',
  );
  const before = rope.particlePositions();
  steps(physics, 30);
  assert.equal(
    torn.size,
    events.reduce((n, e) => n + e.edges.length, 0),
    'no edge is reported twice',
  );
  assert.notDeepEqual([...before], [...rope.particlePositions()], 'the pieces keep moving');
});

test('two runs of the same scene end in the same state', async () => {
  const run = async () => {
    const { physics, soft } = await create();
    soft.create(SoftBodyDesc.cloth([0, 1, 0], [0.1, 0, 0], [0, 0, 0.1], 6, 6).setPinnedParticles([0, 5]));
    physics.addBody(null, { position: [0.2, 1.5, 0.2], colliders: { shape: 'sphere', radius: 0.15 } });
    steps(physics, 120);
    return soft.hash();
  };
  assert.equal(await run(), await run());
});

test('removing a body leaves the others as they were', async () => {
  const { physics, soft } = await create();
  const a = soft.create(SoftBodyDesc.rope([0, 3, 0], [1, 3, 0], 5).setPinnedParticles([0]));
  const b = soft.create(SoftBodyDesc.rope([0, 5, 0], [1, 5, 0], 7).setPinnedParticles([0]));
  steps(physics, 20);
  const before = [...b.particlePositions()],
    velocities = [...b.particleVelocities()];
  soft.remove(a);
  assert.equal(a.valid, false);
  assert.throws(() => a.particlePosition(0), /removed/);
  assert.equal(soft.list().length, 1);
  assert.equal(b.handle, 0);
  assert.deepEqual([...b.particlePositions()], before);
  assert.deepEqual([...b.particleVelocities()], velocities);
  steps(physics, 20);
  assert.ok(b.particlePosition(6)[1] < 5, 'it still falls');
});

test('forces, impulses and the material act as documented', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const body = soft.create(
    SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 5, { bending: false }).setMass(5).setPinnedParticles([0]),
  );
  body.applyImpulse([0, 0, 5]);
  // 5 N s over 4 free and 1 pinned particle of 1 kg each: 1 m/s of velocity change on the free ones.
  near(body.particleVelocity(2)[2], 1, 1e-6, 'free particle takes impulse / total mass');
  near(body.particleVelocity(0)[2], 0, 1e-9, 'a pinned particle ignores it');
  body.applyParticleImpulse(3, [2, 0, 0]);
  near(body.particleVelocity(3)[0], 2, 1e-6, 'particle impulse / particle mass');
  const material = new SoftBodyMaterial();
  material.edgeSoftness = { naturalFrequency: -1, dampingRatio: 1 };
  assert.throws(() => body.setMaterial(material), RangeError);
  assert.throws(() => SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 1), RangeError);
  assert.throws(() => new SoftBodyDesc([0, 0, 0, 1, 0, 0]).setEdges([0, 0]), RangeError);
  assert.throws(() => new SoftBodyDesc([0, 0, 0]).setPinnedParticles([3]), RangeError);
  void physics;
});

// A unit cube of eight vertices and twelve triangles.
const cubeMesh = () => {
  const vertices = [];
  for (const z of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const x of [-0.5, 0.5]) vertices.push(x, y, z);
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const indices = [
    ...q(0, 2, 3, 1),
    ...q(4, 5, 7, 6),
    ...q(0, 1, 5, 4),
    ...q(2, 6, 7, 3),
    ...q(0, 4, 6, 2),
    ...q(1, 3, 7, 5),
  ];
  return { vertices, indices };
};
const pairSpread = (positions, rest) => {
  let worst = 0;
  const n = rest.length / 3;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const was = Math.hypot(
        rest[i * 3] - rest[j * 3],
        rest[i * 3 + 1] - rest[j * 3 + 1],
        rest[i * 3 + 2] - rest[j * 3 + 2],
      );
      const now = Math.hypot(
        positions[i * 3] - positions[j * 3],
        positions[i * 3 + 1] - positions[j * 3 + 1],
        positions[i * 3 + 2] - positions[j * 3 + 2],
      );
      worst = Math.max(worst, Math.abs(now - was));
    }
  return worst;
};

test('a trimesh keeps its edges, bend edges and triangles, and holds its shape as it lands', async () => {
  const { physics, soft } = await create();
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const { vertices, indices } = cubeMesh();
  const desc = SoftBodyDesc.trimesh(vertices, indices).setParticleRadius(0.05).setTranslation([0, 2, 0.1]);
  const cube = soft.create(desc);
  assert.equal(cube.edges().length / 2, 18);
  assert.ok(cube.bendEdges().length > 0);
  assert.deepEqual([...cube.triangles()], indices);
  // Tumble it as it falls: give two corners a push.
  cube.applyParticleImpulse(0, [0, 0, 1.5]);
  cube.applyParticleImpulse(7, [1.5, 0, 0]);
  steps(physics, 300);
  const p = cube.particlePositions();
  assert.ok(pairSpread(p, vertices) < 0.03, `the cube drifts by ${pairSpread(p, vertices)}`);
  let low = Infinity;
  for (let i = 0; i < 8; i++) low = Math.min(low, p[i * 3 + 1]);
  near(low, 0.05, 0.04, 'a corner rests on the floor');
});

test('softening shape matching lets a trimesh sag and spring back', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const { vertices, indices } = cubeMesh();
  const material = new SoftBodyMaterial();
  material.edgeSoftness = { naturalFrequency: 0, dampingRatio: 1 };
  material.shapeMatchingSoftness = { naturalFrequency: 4, dampingRatio: 0.2 };
  const cube = soft.create(SoftBodyDesc.trimesh(vertices, indices, { bending: false }).setMaterial(material));
  cube.setParticlePosition(7, [0.9, 0.9, 0.9]);
  // Edges are rigid here, so pulling one corner out stretches nothing: only shape matching moves it back.
  cube.setMaterial(
    Object.assign(new SoftBodyMaterial(), { shapeMatchingSoftness: { naturalFrequency: 4, dampingRatio: 0.2 } }),
  );
  const start = pairSpread(cube.particlePositions(), vertices);
  steps(physics, 360);
  const end = pairSpread(cube.particlePositions(), vertices);
  assert.ok(start > 0.2, `it starts deformed (${start})`);
  assert.ok(end < start * 0.35, `it settles back: ${end} from ${start}`);
});

test('a convex hull rests on cloth through the probe, and a surface collider makes the cloth visible to queries', async () => {
  const drop = async (surface) => {
    const { physics, soft } = await create();
    const n = 12,
      d = 0.1;
    const cloth = soft.create(
      SoftBodyDesc.cloth([-0.55, 1, -0.55], [d, 0, 0], [0, 0, d], n, n)
        .setPinnedParticles([0, n - 1, (n - 1) * n, n * n - 1])
        .setLinearDamping(3)
        .setParticleMass(0.02)
        .setParticleRadius(0.04),
    );
    assert.equal(cloth.triangles().length, (n - 1) * (n - 1) * 6);
    if (surface) soft.createSurfaceCollider(cloth, { friction: 0.8 });
    // An octahedron: a convex hull, which the old primitive-only contacts did not see.
    const hull = physics.addBody(null, {
      position: [0, 1.5, 0],
      colliders: {
        shape: 'convexHull',
        points: [0.15, 0, 0, -0.15, 0, 0, 0, 0.15, 0, 0, -0.15, 0, 0, 0, 0.15, 0, 0, -0.15],
        density: 400,
      },
    });
    steps(physics, 300);
    // A ray from above at a corner of the cloth, away from the hull.
    const ray = physics.raycast([0.4, 3, 0.4], [0, -1, 0], { maxDistance: 10 });
    return { hullY: hull.position[1], clothY: cloth.particlePosition(6 * n + 6)[1], ray, cloth, soft };
  };
  const without = await drop(false),
    withSurface = await drop(true);
  for (const run of [without, withSurface])
    assert.ok(run.hullY > run.clothY, `the hull rests on the cloth: ${run.hullY} over ${run.clothY}`);
  assert.equal(without.ray, null, 'with no surface collider a ray goes through the cloth');
  assert.ok(withSurface.ray, 'with one the ray hits it');
  near(withSurface.ray.point[1], 1, 0.15, 'at the cloth near its corner');
  withSurface.soft.remove(withSurface.cloth);
  assert.equal(withSurface.cloth.surface, null);
});

test('particles meet a heightfield and never end below its surface', async () => {
  const { physics, soft } = await create();
  const rows = 10,
    columns = 10,
    size = 10,
    heights = [];
  // A symmetric hill, so the answer does not depend on the order of the height columns.
  const hill = (x, z) => 0.8 * Math.max(0, 1 - Math.hypot(x, z) / 3);
  for (let c = 0; c <= columns; c++)
    for (let r = 0; r <= rows; r++) heights.push(hill((c / columns - 0.5) * size, (r / rows - 0.5) * size));
  physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'heightfield', rows, columns, heights, scale: [size, 1, size], friction: 1 },
  });
  const rope = soft.create(SoftBodyDesc.rope([-1.5, 2, 0.2], [1.5, 2, 0.2], 16).setParticleRadius(0.05));
  steps(physics, 360);
  const p = rope.particlePositions();
  for (let i = 0; i < 16; i++) {
    const surface = hill(p[i * 3], p[i * 3 + 2]);
    assert.ok(p[i * 3 + 1] > surface - 0.03, `particle ${i} at ${p[i * 3 + 1]} is below the hill (${surface})`);
  }
  assert.ok(Math.max(...[...p].filter((_, k) => k % 3 === 1)) > 0.6, 'the rope lies over the hill');
});

test('particles meet a triangle mesh and rest on its tilted face', async () => {
  const { physics, soft } = await create();
  const tilt = 0.25;
  // A square slab of two triangles, tilted about z, 6 m wide: normal (-sin, cos, 0).
  const c = Math.cos(tilt),
    s = Math.sin(tilt);
  const corner = (x, z) => [x * c, x * s, z];
  const vertices = [...corner(-3, -3), ...corner(3, -3), ...corner(3, 3), ...corner(-3, 3)];
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 0, 0],
    colliders: { shape: 'trimesh', vertices, indices: [0, 2, 1, 0, 3, 2], friction: 2 },
  });
  const rope = soft.create(SoftBodyDesc.rope([-1, 2, 0], [1, 2, 0], 10).setParticleRadius(0.04).setLinearDamping(1));
  steps(physics, 300);
  const p = rope.particlePositions();
  for (let i = 0; i < 10; i++) {
    const distance = p[i * 3 + 1] * c - p[i * 3] * s;
    assert.ok(distance > 0.04 - 0.01, `particle ${i} is ${distance} above the plane`);
    assert.ok(distance < 0.04 + 0.05, `particle ${i} lies on it (${distance})`);
  }
});

test('cloth falling on cloth stays above it with self contacts, and falls through without', async () => {
  const run = async (selfContacts, upperOrigin) => {
    const { physics, soft } = await create();
    const make = (origin, n, pinned) => {
      const desc = SoftBodyDesc.cloth(origin, [0.1, 0, 0], [0, 0, 0.1], n, n)
        .setParticleMass(0.05)
        .setLinearDamping(2)
        .setParticleRadius(0.025)
        .setSelfContacts(selfContacts);
      return soft.create(pinned ? desc.setPinnedParticles(Array.from({ length: n * n }, (_, i) => i)) : desc);
    };
    make([-0.55, 0.5, -0.55], 12, true);
    const upper = make(upperOrigin, 8, false);
    steps(physics, 240);
    let lowest = Infinity;
    for (let i = 0; i < 64; i++) lowest = Math.min(lowest, upper.particlePosition(i)[1]);
    return lowest;
  };
  const held = await run(true, [-0.3, 1, -0.3]),
    through = await run(false, [-0.3, 1, -0.3]);
  assert.ok(held > 0.5 + 0.02, `with self contacts the upper sheet rests on the lower: lowest ${held}`);
  // Sheets whose vertices lie exactly over one another are the hard case for a contact search.
  const aligned = await run(true, [-0.35, 1, -0.35]);
  assert.ok(aligned > 0.5 + 0.02, `aligned sheets hold too: lowest ${aligned}`);
  assert.ok(through < 0.4, `without them it falls through: lowest ${through}`);
});

test('self contacts need triangles', async () => {
  const { soft } = await create();
  assert.throws(() => soft.create(new SoftBodyDesc([0, 0, 0]).setSelfContacts(true)), RangeError);
  assert.throws(
    () => SoftBodyDesc.cloth([0, 0, 0], [1, 0, 0], [0, 0, 1], 2, 2).setSelfContacts(true, { friction: -1 }),
    RangeError,
  );
});

test('a fast particle does not pass through a thin wall', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [3, 1, 0],
    colliders: { shape: 'box', halfExtents: [0.01, 2, 2], friction: 0 },
  });
  const ball = soft.create(new SoftBodyDesc([0, 1, 0]).setParticleRadius(0.02));
  // 60 m/s moves it a metre a step: the 2 cm wall is crossed inside one step.
  ball.setParticleVelocity(0, [60, 0, 0]);
  steps(physics, 20);
  const x = ball.particlePosition(0)[0];
  assert.ok(x < 3, `it is held on this side of the wall: ${x}`);
});

test('a fast paddle carries a particle along instead of passing it', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const paddle = physics.addBody(null, {
    type: 'kinematicVelocity',
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.01, 1], friction: 0 },
  });
  const ball = soft.create(new SoftBodyDesc([0, 0.5, 0]).setParticleRadius(0.02));
  // 40 m/s up: it moves two thirds of a metre a step, past the particle's 0.5 m in one step.
  paddle.setLinearVelocity([0, 40, 0]);
  steps(physics, 4);
  assert.ok(
    ball.particlePosition(0)[1] > paddle.position[1],
    `the particle is on top of the paddle: ${ball.particlePosition(0)[1]} over ${paddle.position[1]}`,
  );
});

test('collision groups decide which colliders the particles meet', async () => {
  const run = async (groups) => {
    const { physics, soft } = await create();
    // A floor in group 1 that meets group 1.
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [5, 0.5, 5], collisionGroups: 0x00010001 },
    });
    const ball = soft.create(new SoftBodyDesc([0, 1, 0]).setParticleRadius(0.02).setCollisionGroups(groups));
    steps(physics, 120);
    return ball.particlePosition(0)[1];
  };
  assert.ok((await run(0x00010001)) > 0, 'a particle of the same group rests on the floor');
  assert.ok((await run(0x00020002)) < -1, 'a particle of another group falls through it');
  const desc = new SoftBodyDesc([0, 0, 0]);
  assert.throws(() => desc.setCollisionGroups(-1), RangeError);
});

test('a crate hangs from a rope: the rope carries its weight and the crate stays at the rope end', async () => {
  const { physics, soft } = await create();
  const crate = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], density: 250 },
  });
  const mass = crate.mass;
  const rope = soft.create(
    SoftBodyDesc.rope([0, 6, 0], [0, 2.2, 0], 20, { bending: false })
      .setPinnedParticles([0])
      .setParticleMass(0.1)
      .setLinearDamping(1)
      .setParticleRadius(0.01),
  );
  rope.attachParticle(19, crate);
  steps(physics, 600);
  const end = rope.particlePosition(19),
    length = Math.hypot(...[0, 1, 2].map((a) => [0, 6, 0][a] - end[a]));
  // The rope is 3.8 m long and nearly inextensible: the crate hangs at its end, 3.8 m under the pin, and stays still.
  near(length, 3.8, 0.1, 'the rope end is a rope length below the pin');
  // The rope was pinned to the crate where it started, 0.2 m above the crate's centre.
  near(crate.position[1], end[1] - 0.2, 0.1, 'the crate hangs 0.2 m under the rope end');
  assert.ok(Math.hypot(...crate.linearVelocity) < 0.3, `the crate has come to rest: ${crate.linearVelocity}`);
  assert.ok(mass > 1, 'the crate is heavy against the rope');
  assert.equal(rope.detachParticle(19, crate), true);
  assert.equal(rope.detachParticle(19, crate), false);
  const before = crate.position[1];
  steps(physics, 30);
  assert.ok(crate.position[1] < before - 0.5, 'once let go the crate falls');
});

test('a pinned particle drags a light crate along, and a fixed body holds a particle where it is', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const crate = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], density: 100 },
  });
  const rope = soft.create(
    SoftBodyDesc.rope([0, 0, 0], [3, 0, 0], 12, { bending: false }).setParticleMass(0.01).setParticleRadius(0.01),
  );
  rope.attachParticle(0, crate);
  // Walk the far end away at 1 m/s: the rope pulls the crate after it.
  for (let i = 0; i < 120; i++) {
    rope.setParticleKinematicTarget(11, [3 + (i + 1) / 60, 0, 0]);
    physics.step();
  }
  assert.ok(crate.position[0] > 1.2, `the crate was dragged: ${crate.position[0]}`);
  const fixed = physics.addBody(null, {
    type: 'fixed',
    position: [0, 5, 0],
    colliders: { shape: 'sphere', radius: 0.1 },
  });
  const lone = soft.create(new SoftBodyDesc([0.3, 5, 0]).setParticleRadius(0.01));
  lone.attachParticle(0, fixed);
  steps(physics, 60);
  near(lone.particlePosition(0)[0], 0.3, 0.01, 'a fixed body keeps its particle at the anchor');
  assert.throws(() => lone.attachParticle(3, fixed), RangeError);
});

test('a sphere keeps its volume as it lands and squashes, and a volume factor inflates it', async () => {
  const { physics, soft } = await create();
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5], friction: 1 },
  });
  const material = new SoftBodyMaterial();
  material.edgeSoftness = { naturalFrequency: 6, dampingRatio: 0.3 };
  material.bendSoftness = { naturalFrequency: 4, dampingRatio: 0.3 };
  const ball = soft.create(
    SoftBodyDesc.sphere([0, 1.2, 0], 0.5, { detail: 2 }).setMaterial(material).setParticleMass(0.01),
  );
  const rest = ball.surfaceVolume();
  near(rest, (4 / 3) * Math.PI * 0.125, 0.04, 'an icosphere of radius 0.5 encloses about 4/3 pi r cubed');
  let lowest = Infinity;
  for (let i = 0; i < 240; i++) {
    physics.step();
    if (i % 4 === 0) {
      const p = ball.particlePositions();
      for (let k = 0; k < p.length; k += 3) lowest = Math.min(lowest, p[k + 1]);
      near(ball.surfaceVolume(), rest, rest * 0.03, `volume at step ${i}`);
    }
  }
  assert.ok(lowest < 0.1, `it came down to the floor: ${lowest}`);
  // Inflate to twice the volume.
  ball.setVolumeFactor(2);
  steps(physics, 120);
  near(ball.surfaceVolume(), 2 * rest, rest * 0.06, 'inflated to twice its volume');
  assert.throws(
    () => soft.create(SoftBodyDesc.cloth([0, 0, 0], [1, 0, 0], [0, 0, 1], 2, 2).setVolumeFactor(1)),
    RangeError,
    'a flat sheet has no volume',
  );
});

test('a body whose triangles face inward cannot hold a volume', async () => {
  const { soft } = await create();
  const desc = SoftBodyDesc.sphere([0, 0, 0], 1, { detail: 0 });
  const flipped = SoftBodyDesc.trimesh(
    desc.positions,
    desc.triangles.map((v, k, a) => (k % 3 === 1 ? a[k + 1] : k % 3 === 2 ? a[k - 1] : v)),
  ).setVolumeFactor(1);
  assert.throws(() => soft.create(flipped), RangeError);
});

test('the stretch of a rope under a heavy load does not depend on the iterations, the substeps or the mass ratio', async () => {
  const hang = async (iterations, substeps, particleMass) => {
    const physics = new Physics(null, {});
    const soft = await SoftBodies.attach(physics, { iterations, substeps });
    const crate = physics.addBody(null, {
      position: [0, 2, 0],
      colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], density: 250 },
    });
    const rope = soft.create(
      SoftBodyDesc.rope([0, 6, 0], [0, 2.2, 0], 20, { bending: false })
        .setPinnedParticles([0])
        .setParticleMass(particleMass)
        .setLinearDamping(1)
        .setParticleRadius(0.01),
    );
    rope.attachParticle(19, crate);
    steps(physics, 300);
    const end = rope.particlePosition(19);
    return { length: Math.hypot(end[0], 6 - end[1], end[2]), crate: crate.position[1] };
  };
  // The crate is 16 kg: a particle of 0.01 kg makes the load 1,600 times the rope's own weight per particle.
  const runs = [];
  for (const [iterations, substeps, particleMass] of [
    [1, 4, 0.01],
    [2, 8, 0.01],
    [8, 8, 0.01],
    [2, 16, 0.01],
    [2, 8, 0.5],
    [4, 4, 0.1],
  ])
    runs.push(await hang(iterations, substeps, particleMass));
  for (const run of runs) {
    near(run.length, runs[1].length, 0.004, 'the rope end is as far from the pin in every setting');
    near(run.crate, runs[1].crate, 0.004, 'and the crate as high');
  }
  near(runs[1].length, 3.8, 0.04, 'and it is a rope length away: the rope does not stretch');
});

test('an anisotropic cloth stretches along the warp and the weft in the ratio of their stiffnesses', async () => {
  // A strip two particles wide hung from its top row, along `u` (the warp) or along `v` (the weft), under its own weight.
  const hang = async (along, warpHz, weftHz) => {
    const { physics, soft } = await create();
    const n = 12,
      d = 0.1;
    const material = new SoftBodyMaterial();
    material.warpSoftness = { naturalFrequency: warpHz, dampingRatio: 1 };
    material.weftSoftness = { naturalFrequency: weftHz, dampingRatio: 1 };
    // The diagonals and the bending are far softer than the threads, so what stretches is the thread tested.
    material.shearSoftness = { naturalFrequency: 1, dampingRatio: 1 };
    material.bendSoftness = { naturalFrequency: 0.5, dampingRatio: 1 };
    // `along === 'warp'`: the strip's long side is `u`; else it is `v`.
    const desc =
      along === 'warp'
        ? SoftBodyDesc.clothAnisotropic([0, 3, 0], [0, -d, 0], [0, 0, d], n, 2)
        : SoftBodyDesc.clothAnisotropic([0, 3, 0], [0, 0, d], [0, -d, 0], 2, n);
    const body = soft.create(
      desc
        .setMaterial(material)
        .setParticleMass(0.5)
        .setLinearDamping(2)
        .setParticleRadius(0.005)
        .setPinnedParticles(along === 'warp' ? [0, 1] : [0, n]),
    );
    steps(physics, 600);
    const p = body.particlePositions();
    return 3 - p[(along === 'warp' ? (n - 1) * 2 : n - 1) * 3 + 1] - (n - 1) * d;
  };
  // Warp 20 Hz and weft 10 Hz: the weft is a quarter as stiff, so it extends four times as far.
  const warp = await hang('warp', 20, 10),
    weft = await hang('weft', 20, 10);
  assert.ok(warp > 0.002 && weft > 0.002, `both threads stretch under the weight: ${warp}, ${weft}`);
  near(weft / warp, 4, 0.8, 'the weft stretches four times as far as the warp');
  // Isotropic settings are the plain cloth.
  const plain = await hang('warp', 15, 15),
    same = await hang('weft', 15, 15);
  near(same / plain, 1, 0.1, 'equal threads stretch alike');
});

test('a sheared cloth stays within its shear stiffness', async () => {
  const shear = async (hz) => {
    const { physics, soft } = await create({ gravity: [0, 0, 0] });
    const n = 6,
      d = 0.1;
    const material = new SoftBodyMaterial();
    material.warpSoftness = { naturalFrequency: 0, dampingRatio: 1 };
    material.weftSoftness = { naturalFrequency: 0, dampingRatio: 1 };
    material.shearSoftness = { naturalFrequency: hz, dampingRatio: 1 };
    material.bendSoftness = { naturalFrequency: 0.5, dampingRatio: 1 };
    const body = soft.create(
      SoftBodyDesc.clothAnisotropic([0, 0, 0], [d, 0, 0], [0, d, 0], n, n)
        .setMaterial(material)
        .setParticleMass(0.5)
        .setLinearDamping(3)
        .setParticleRadius(0.005)
        .setPinnedParticles(Array.from({ length: n }, (_, j) => j)),
    );
    // Push the free edge along the weft, sideways across the pinned one: a shear (the sheet's rigid threads cannot stretch).
    for (let step = 0; step < 300; step++) {
      for (let j = 0; j < n; j++) body.addParticleForce((n - 1) * n + j, [0, 0.05, 0]);
      physics.step();
    }
    const p = body.particlePositions();
    return p[((n - 1) * n + 2) * 3 + 1] - p[2 * 3 + 1];
  };
  const stiff = await shear(12),
    soft = await shear(6);
  assert.ok(stiff > 0.001, `it shears: ${stiff}`);
  near(soft / stiff, 4, 1.2, 'half the shear frequency shears four times as far');
});

test('a tension-only rope does not push when slack and pulls when taut', async () => {
  const run = async (tensionOnly, softHz, to) => {
    const { physics, soft } = await create({ gravity: [0, 0, 0] });
    let desc = new SoftBodyDesc([0, 1, 0, 1, 1, 0]).setEdges([0, 1]).setParticleRadius(0.01);
    if (softHz) desc = desc.setSoftness(softHz, 1);
    if (tensionOnly) desc = desc.setTensionOnly();
    const rope = soft.create(desc);
    rope.setParticlePosition(1, to);
    steps(physics, 120);
    const a = rope.particlePosition(0),
      b = rope.particlePosition(1);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  for (const hz of [0, 8]) {
    // Squeezed to half its length: a rope that resists both ways pushes back out, a tension-only one stays as it was.
    assert.ok((await run(false, hz, [0.5, 1, 0])) > 0.9, `an ordinary edge springs back (${hz} Hz)`);
    near(await run(true, hz, [0.5, 1, 0]), 0.5, 0.02, `a slack tension-only edge does not push (${hz} Hz)`);
    // Pulled to half again its length: both pull it back.
    near(await run(true, hz, [1.5, 1, 0]), 1, 0.05, `a taut tension-only edge pulls (${hz} Hz)`);
  }
  const { soft } = await create();
  assert.throws(() => new SoftBodyDesc([0, 0, 0, 1, 0, 0]).setEdges([0, 1]).setTensionOnly([5]), RangeError);
  void soft;
});

test('impulses, radial impulses and forces move the particles as documented', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const lone = (x, mass) => soft.create(new SoftBodyDesc([x, 0, 0]).setParticleMass(mass).setParticleRadius(0.01));
  const a = lone(1, 2),
    b = lone(0, 1);
  // A radial impulse of 4 at distance 1 with a radius of 2 and a mass of 2: 4 * (1 - 1/2) / 2 = 1 m/s outward; none at the centre.
  a.applyRadialImpulse([0, 0, 0], 4, 2);
  b.applyRadialImpulse([0, 0, 0], 4, 2);
  near(a.particleVelocity(0)[0], 1, 1e-6, 'a radial impulse falls off linearly and is divided by the mass');
  near(b.particleVelocity(0)[0], 0, 1e-9, 'the particle at the centre gets nothing');
  const c = lone(5, 2);
  c.applyRadialImpulse([0, 0, 0], 4, 2);
  near(c.particleVelocity(0)[0], 0, 1e-9, 'outside the radius nothing');
  const d = lone(5, 2);
  d.applyRadialImpulse([0, 0, 0], 4, 0);
  near(d.particleVelocity(0)[0], 2, 1e-6, 'a radius of zero pushes every particle fully');
  const e = lone(0.5, 4);
  e.applyImpulseAtPoint([8, 0, 0], [0, 0, 0], 1);
  near(e.particleVelocity(0)[0], 1, 1e-6, 'an impulse at a point falls off linearly: 8 * (1 - 0.5) / 4');
  const f = lone(9, 4);
  f.applyImpulseAtPoint([8, 0, 0], [0, 0, 0], 0);
  near(f.particleVelocity(0)[0], 2, 1e-6, 'a radius of zero gives every particle the whole impulse');
  // Forces: 4 N on a 4 kg body, shared by mass, is 1 m/s^2; 2 N on one 1 kg particle is 2 m/s^2; reset stops them.
  const body = soft.create(
    SoftBodyDesc.rope([0, 3, 0], [3, 3, 0], 4, { bending: false }).setEdges([]).setBendEdges([]).setParticleMass(1),
  );
  body.addForce([4, 0, 0]);
  body.addParticleForce(2, [2, 0, 0]);
  steps(physics, 60);
  near(body.particleVelocity(0)[0], 1, 0.02, 'a body force is shared by mass');
  near(body.particleVelocity(2)[0], 3, 0.04, 'a particle force adds to it: 1 + 2 m/s');
  body.resetForces();
  const before = body.particleVelocity(0)[0];
  steps(physics, 30);
  near(body.particleVelocity(0)[0], before, 1e-4, 'reset forces stops the push');
});

test('bend edges resist bending by their spring, and builders sew, merge and place bodies as documented', async () => {
  const sag = async (bendHz) => {
    const { physics, soft } = await create();
    const material = new SoftBodyMaterial();
    material.bendSoftness = { naturalFrequency: bendHz, dampingRatio: 1 };
    const rope = soft.create(
      SoftBodyDesc.rope([0, 3, 0], [2, 3, 0], 21)
        .setMaterial(material)
        .setPinnedParticles([0, 1])
        .setLinearDamping(3)
        .setParticleMass(0.2),
    );
    steps(physics, 300);
    return 3 - rope.particlePosition(20)[1];
  };
  // A bend edge joins a particle to the one two along, so its pull is second order in the angle: the effect is small but it is there.
  const soft_ = await sag(0.5),
    stiff = await sag(200);
  assert.ok(soft_ > stiff + 0.04, `a stiffer bend spring holds the rope end higher: ${soft_} against ${stiff}`);
  const { soft } = await create({ gravity: [0, 0, 0] });
  // Two ropes merged, then sewn end to end: the sewn edge's rest length is the gap at that moment.
  const first = SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 3, { bending: false });
  const second = SoftBodyDesc.rope([1.5, 0, 0], [2.5, 0, 0], 3, { bending: false });
  first.append(second).addEdges([2, 3]);
  const joined = soft.create(first);
  assert.equal(joined.numParticles(), 6);
  assert.equal(joined.edges().length / 2, 5);
  const sewn = joined.edges();
  assert.deepEqual([...sewn.slice(-2)], [2, 3]);
  // Masses, gravity scale and translation.
  const heavy = soft.create(
    new SoftBodyDesc([0, 0, 0, 2, 0, 0]).setMasses([1, 3]).setTranslation([0, 5, 0]).setGravityScale(0),
  );
  near(heavy.mass(), 4, 1e-6, 'setMasses sets each particle');
  near(heavy.centerOfMass()[0], 1.5, 1e-6, 'the centre of mass follows the masses');
  near(heavy.particlePosition(0)[1], 5, 1e-6, 'setTranslation moves the particles');
  assert.throws(() => new SoftBodyDesc([0, 0, 0]).setMasses([1, 2]), RangeError);
});

test('the builders take Rapier signatures: anisotropic cloth springs, a tube by radii, a sphere by subdivisions', async () => {
  const { soft } = await create({ gravity: [0, 0, 0] });
  const spring = { naturalFrequency: 12, dampingRatio: 0.5 };
  const cloth = soft.create(
    SoftBodyDesc.clothAnisotropic(
      [0, 0, 0],
      [0.1, 0, 0],
      [0, 0.1, 0],
      4,
      3,
      spring,
      { naturalFrequency: 6, dampingRatio: 1 },
      { naturalFrequency: 3, dampingRatio: 1 },
    ),
  );
  near(cloth.getMaterial().warpSoftness.naturalFrequency, 12, 0, 'the warp spring is set by the builder');
  near(cloth.getMaterial().shearSoftness.naturalFrequency, 3, 0, 'and the shear');
  // A tube of 6 particles around and 4 rings along it, from radius 0.3 to 0.1 over 2 m along y.
  const tube = soft.create(SoftBodyDesc.clothTube([0, 0, 0], [0, 2, 0], 0.3, 0.1, 6, 4));
  assert.equal(tube.numParticles(), 24);
  const p = tube.particlePositions();
  for (let ring = 0; ring < 4; ring++)
    for (let a = 0; a < 6; a++) {
      const k = (ring * 6 + a) * 3,
        radius = 0.3 + (0.1 - 0.3) * (ring / 3);
      near(p[k + 1], (2 * ring) / 3, 1e-5, `ring ${ring} sits at its height`);
      near(Math.hypot(p[k], p[k + 2]), radius, 1e-5, `ring ${ring} has its radius`);
    }
  const ball = soft.create(SoftBodyDesc.sphere([0, 0, 0], 1, 1));
  assert.equal(ball.numParticles(), 42);
});

test('a deformable collider bound to a soft body follows it: direct, direct by position and skinned', async () => {
  const { physics, soft } = await create();
  const top = (collider) => collider.aabb().max[1];
  const bottom = (collider) => collider.aabb().min[1];
  // A free 4 x 4 cloth falling; a thin mesh made of its four corner particles, bound directly.
  const cloth = soft.create(SoftBodyDesc.cloth([0, 5, 0], [0.1, 0, 0], [0, 0, 0.1], 4, 4).setParticleMass(0.05));
  const corners = [0, 3, 12, 15];
  const quad = { vertices: [0, 5, 0, 0.3, 5, 0, 0, 5, 0.3, 0.3, 5, 0.3], indices: [0, 1, 2, 1, 3, 2] };
  const direct = soft.createDeformableCollider(cloth, quad, SoftMeshBinding.direct(corners));
  const byPosition = soft.createDeformableCollider(
    cloth,
    { vertices: quad.vertices.map((v, k) => (k % 3 === 1 ? v + 0.002 : v)), indices: quad.indices },
    SoftMeshBinding.directByPosition(0.01),
  );
  steps(physics, 30);
  const fell = 5 - cloth.particlePosition(0)[1];
  assert.ok(fell > 0.3, `the cloth fell: ${fell}`);
  near(top(direct), cloth.particlePosition(0)[1], 0.06, 'a directly bound mesh follows its particles down');
  near(top(byPosition), cloth.particlePosition(0)[1], 0.06, 'and so does one bound by position');
  assert.throws(
    () =>
      soft.createDeformableCollider(
        cloth,
        { vertices: [9, 9, 9, 9, 9, 10, 9, 10, 9], indices: [0, 1, 2] },
        SoftMeshBinding.directByPosition(0.01),
      ),
    RangeError,
  );
  assert.throws(() => soft.createDeformableCollider(cloth, quad, SoftMeshBinding.direct([0, 1])), RangeError);
  assert.throws(
    () => soft.createDeformableCollider(cloth, quad, SoftMeshBinding.skinned()),
    RangeError,
    'a cloth has no cells',
  );

  // A block of cells hanging from its top face; a triangle skinned to three particles and one at a cell's centre.
  const block = soft.create(SoftBodyDesc.box([2, 1, 0], [0.4, 0.2, 0.2], [2, 1, 1]));
  const rest = block.particlePositions();
  const skinned = soft.createDeformableCollider(
    block,
    { vertices: [...rest.slice(0, 3), ...rest.slice(3, 6), ...rest.slice(6, 9)], indices: [0, 1, 2] },
    SoftMeshBinding.skinned(),
  );
  steps(physics, 60);
  const now = block.particlePositions();
  const ys = [now[1], now[4], now[7]];
  near(skinned.aabb().min[1], Math.min(...ys), 0.05, 'a skinned vertex at a particle rides it');
  near(skinned.aabb().max[1], Math.max(...ys), 0.05, 'to the other extreme too');
  soft.remove(cloth);
  assert.equal(direct.valid, false, 'a deformable collider goes with its body');
});

test('a body with a skin collides by its skin', async () => {
  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const block = soft.create(
    SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [2, 2, 2]).setSkin(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
      [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5],
    ),
  );
  const collider = soft.createSurfaceCollider(block);
  physics.step();
  const hit = physics.raycast([0.5, 3, 0.5], [0, -1, 0], { maxDistance: 10 });
  assert.ok(hit, 'a ray from above meets the skin');
  near(hit.point[1], 1, 0.02, 'at its top face');
  assert.equal(collider.shape, 'trimesh');
});

test('dominance decides who gives way: the soft body holds against a lower group, and a higher group goes through', async () => {
  const drop = async (softGroup, boxGroup) => {
    const { physics, soft } = await create();
    const n = 12,
      d = 0.1;
    const cloth = soft.create(
      SoftBodyDesc.cloth([-0.55, 1, -0.55], [d, 0, 0], [0, 0, d], n, n)
        .setPinnedParticles([0, n - 1, (n - 1) * n, n * n - 1])
        .setLinearDamping(3)
        .setParticleMass(0.02)
        .setParticleRadius(0.04)
        .setDominanceGroup(softGroup),
    );
    const box = physics.addBody(null, {
      position: [0, 1.4, 0],
      dominance: boxGroup,
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], density: 400 },
    });
    steps(physics, 300);
    return { box: box.position[1], cloth: cloth.particlePosition(6 * n + 6)[1] };
  };
  const equal = await drop(0, 0),
    softWins = await drop(5, 0),
    boxWins = await drop(0, 5);
  assert.ok(
    softWins.cloth > equal.cloth + 0.03,
    `a dominant cloth sags less under the box: ${softWins.cloth} against ${equal.cloth}`,
  );
  assert.ok(softWins.box > 0.8, `and the box rests on it: ${softWins.box}`);
  assert.ok(boxWins.box < 0.2, `a dominant box is not held by the cloth and falls past it: ${boxWins.box}`);
  assert.throws(() => new SoftBodyDesc([0, 0, 0]).setDominanceGroup(300), RangeError);
});

test('extra solver iterations stiffen a sheet, a surface collider can be made with the body, and a closed surface is oriented', async () => {
  const hang = async (extra) => {
    const { physics, soft } = await create({ gravity: [0, -9.81, 0] });
    const n = 10;
    const cloth = soft.create(
      SoftBodyDesc.cloth([0, 3, 0], [0.1, 0, 0], [0, -0.1, 0], n, n)
        .setPinnedParticles(Array.from({ length: n }, (_, i) => i * n))
        .setParticleMass(0.2)
        .setLinearDamping(1)
        .setAdditionalSolverIterations(extra),
    );
    steps(physics, 200);
    return 3 - cloth.particlePosition((n - 1) * n + n - 1)[1];
  };
  const loose = await hang(0),
    tight = await hang(30);
  assert.ok(tight < loose, `more passes hold the sheet shorter: ${tight} against ${loose}`);
  assert.throws(() => new SoftBodyDesc([0, 0, 0]).setAdditionalSolverIterations(-1), RangeError);

  const { physics, soft } = await create({ gravity: [0, 0, 0] });
  const plain = soft.create(SoftBodyDesc.cloth([0, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3));
  assert.equal(plain.surface, null, 'no surface collider unless asked');
  const withSurface = soft.create(
    SoftBodyDesc.cloth([3, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3).setSurfaceCollider({ friction: 0.5 }),
  );
  assert.ok(withSurface.surface, 'the body made with one has it');
  const oriented = soft.create(SoftBodyDesc.sphere([10, 0, 0], 1, 1).setSurfaceCollider());
  const shell = soft.create(SoftBodyDesc.sphere([20, 0, 0], 1, 1).setOriented(false).setSurfaceCollider());
  physics.step();
  assert.ok(physics.intersectPoint([10, 0, 0]).length > 0, 'a point inside a closed, oriented surface is found inside');
  assert.equal(physics.intersectPoint([20, 0, 0]).length, 0, 'inside a shell it is not');
  void oriented;
  void shell;
});
