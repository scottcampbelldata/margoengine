// Soft bodies on the soft kernel: a rope against the catenary, a cloth against its own length, coupling with rigid
// bodies, tearing, replay and the particle API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import {
  FABRICS,
  fabricTensileStiffness,
  SoftBodies,
  SoftBodyDesc,
  SoftBodyMaterial,
  SoftMeshBinding,
} from '../dist/soft.js';

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

test('an inextensible sheet holds its threads within 0.1 percent at any pass count and load, a surface collider can be made with the body, and a closed surface is oriented', async () => {
  // Threads held inextensible (no tensile spring) are solved exactly, loops and all, to the strain Goldenthal et al. hold
  // cloth to: the same at no extra passes and thirty, and with a load a thousand times a particle's mass at the corner. (The
  // sweep this replaced left a sheet longer the fewer passes it had, which this test once measured as a feature.)
  const strainOf = async (extra, load) => {
    const { physics, soft } = await create({ gravity: [0, -9.81, 0] });
    const n = 10,
      d = 0.1;
    const material = new SoftBodyMaterial();
    material.tensile = null;
    const masses = new Array(n * n).fill(0.2);
    masses[n * n - 1] = 0.2 * load;
    const cloth = soft.create(
      SoftBodyDesc.cloth([0, 3, 0], [d, 0, 0], [0, -d, 0], n, n)
        .setMaterial(material)
        .setPinnedParticles(Array.from({ length: n }, (_, i) => i * n))
        .setMasses(masses)
        .setLinearDamping(1)
        .setAdditionalSolverIterations(extra),
    );
    let worst = 0;
    for (let s = 0; s < 200; s++) {
      physics.step();
      const p = cloth.particlePositions();
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const a = i * n + j;
          for (const b of [j + 1 < n ? a + 1 : -1, i + 1 < n ? a + n : -1]) {
            if (b < 0) continue;
            const l = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
            worst = Math.max(worst, l / d - 1);
          }
        }
    }
    return worst;
  };
  for (const extra of [0, 30])
    for (const load of [1, 1000]) {
      const strain = await strainOf(extra, load);
      // The tolerance, and what an f32 length of 10 cm holds besides.
      assert.ok(strain <= 1e-3 + 1e-6, `${extra} extra passes, load ${load}: a thread strains ${strain}`);
    }
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

test('a still body falls asleep, stays where it is, and wakes when it is touched or a collider moves past it', async () => {
  const { physics, soft } = await create();
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5], friction: 1 },
  });
  const ball = soft.create(
    SoftBodyDesc.sphere([0, 0.5, 0], 0.3, { detail: 1 }).setSoftness(30, 1).setParticleMass(0.02).setLinearDamping(2),
  );
  const never = soft.create(SoftBodyDesc.rope([3, 0.05, 0], [4, 0.05, 0], 5).setCanSleep(false).setLinearDamping(3));
  assert.equal(ball.canSleep, true);
  const settle = (limit) => {
    for (let i = 0; i < limit && !ball.sleeping; i++) physics.step();
  };
  settle(1200);
  assert.equal(ball.sleeping, true, 'a body at rest sleeps once it has been still for two seconds');
  assert.equal(never.sleeping, false, 'a body that may not sleep stays awake');
  const rested = [...ball.particlePositions()];
  steps(physics, 60);
  assert.deepEqual([...ball.particlePositions()], rested, 'a sleeping body does not move');
  // An impulse wakes it.
  ball.applyImpulse([0, 0.5, 0]);
  assert.equal(ball.sleeping, false);
  steps(physics, 20);
  assert.notDeepEqual([...ball.particlePositions()], rested, 'and it moves');
  // Let it settle again, then a rigid body that rolls over it wakes it.
  settle(1200);
  assert.equal(ball.sleeping, true);
  const crate = physics.addBody(null, {
    position: [0.9, 0.35, 0],
    colliders: { shape: 'sphere', radius: 0.3, density: 500 },
  });
  crate.setLinearVelocity([-3, 0, 0]);
  steps(physics, 30);
  assert.equal(ball.sleeping, false, 'a moving collider wakes the body it touches');
  ball.sleep();
  assert.equal(ball.sleeping, true);
  ball.canSleep = false;
  assert.equal(ball.sleeping, false, 'a body that may not sleep is awake');
});

test('a contact hook edits or drops the contacts of colliders that ask for it', async () => {
  const { physics, soft } = await create();
  // A platform at y = 1 that a particle passes going up and lands on coming down: a one-way platform.
  const platform = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.9, 0],
    colliders: { shape: 'box', halfExtents: [3, 0.1, 3], friction: 0.5 },
  });
  const seen = [];
  soft.setContactHook((contact) => {
    seen.push(contact.particleVelocity[1]);
    if (contact.particleVelocity[1] > 0) contact.enabled = false;
  });
  const ball = soft.create(new SoftBodyDesc([0, 0.2, 0]).setParticleRadius(0.02));
  ball.setParticleVelocity(0, [0, 8, 0]);
  steps(physics, 30);
  // Without the hook asking, the platform is met by an upward ball; with it, nothing yet: the collider does not ask.
  assert.equal(seen.length, 0, 'a collider that does not ask is not hooked');
  assert.ok(ball.particlePosition(0)[1] < 1, 'the ball is stopped under the platform');
  platform.colliders[0].setActiveHooks({ modifyContacts: true });
  ball.setParticleVelocity(0, [0, 8, 0]);
  ball.setParticlePosition(0, [0, 0.2, 0]);
  steps(physics, 120);
  assert.ok(seen.length > 0, 'a collider that asks is hooked');
  near(
    ball.particlePosition(0)[1],
    1.02,
    0.03,
    'the ball passes up through the platform and comes to rest on top of it',
  );
  soft.setContactHook(null);
});

test('a body made with no configuration rests on rigid geometry, with no surface collider needed', async () => {
  const { physics, soft } = await create();
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  const cloth = soft.create(SoftBodyDesc.cloth([-0.4, 2, -0.4], [0.1, 0, 0], [0, 0, 0.1], 9, 9));
  const ball = soft.create(SoftBodyDesc.sphere([2, 3, 0], 0.3, { detail: 1 }));
  physics.addBody(null, {
    type: 'fixed',
    position: [2, 0, 0],
    colliders: { shape: 'cylinder', halfHeight: 0.2, radius: 4 },
  });
  steps(physics, 300);
  assert.equal(cloth.surface, null, 'there is no surface collider unless asked');
  let lowest = Infinity;
  const p = cloth.particlePositions();
  for (let k = 1; k < p.length; k += 3) lowest = Math.min(lowest, p[k]);
  assert.ok(lowest > 0.95, `the cloth rests on the box and does not fall through it: ${lowest}`);
  const q = ball.particlePositions();
  let low = Infinity;
  for (let k = 1; k < q.length; k += 3) low = Math.min(low, q[k]);
  assert.ok(low > 0.15, `the ball rests on the cylinder: ${low}`);
});

// The height of a cloth's surface over the point (x, z): the triangle of the sheet whose shadow on the ground holds the point,
// read at its barycentric coordinates there; null where the cloth does not reach.
const clothHeight = (cloth, x, z) => {
  const p = cloth.particlePositions(),
    t = cloth.triangles();
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3],
      d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d,
      v = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d,
      w = 1 - u - v;
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * p[a + 1] + v * p[b + 1] + w * p[c + 1];
  }
  return null;
};

test('small and thin rigid bodies dropped on a default cloth rest on it for five seconds and never pass through it', async () => {
  const n = 12,
    d = 0.1;
  const shapes = {
    // Over the middle of a cell (the widest gap between four particles), of an edge, and a thin rod lying between two rows.
    box: { position: [0, 1.5, 0], colliders: { shape: 'box', halfExtents: [0.02, 0.02, 0.02], density: 400 } },
    rod: {
      position: [-0.3, 1.5, 0.05],
      rotation: [0.7071068, 0, 0, 0.7071068],
      colliders: { shape: 'capsule', halfHeight: 0.25, radius: 0.005, density: 400 },
    },
    bead: { position: [0.3, 1.5, 0], colliders: { shape: 'sphere', radius: 0.01, density: 400 } },
    '1 kg box': { position: [0, 1.5, 0.35], colliders: { shape: 'box', halfExtents: [0.05, 0.05, 0.05], mass: 1 } },
    // The rod under standard gravity rolls down the sagging sheet a radian or two a step; the side of the sheet it met was read
    // from a normal that rolling carries round the rod, and at step 163 the sheet was met from below and the rod thrown through
    // it (KB-SOFT-TUNNEL1).
    'rod at standard gravity': {
      gravity: [0, -9.80665, 0],
      position: [-0.3, 1.5, 0.05],
      rotation: [0.7071068, 0, 0, 0.7071068],
      colliders: { shape: 'capsule', halfHeight: 0.25, radius: 0.005, density: 400 },
    },
  };
  for (const [name, { gravity, ...options }] of Object.entries(shapes)) {
    const { physics, soft } = await create(gravity ? { gravity } : {});
    // A default cloth: no radius, no surface collider, no damping (it rings for the whole run), only its four corners pinned.
    const cloth = soft.create(
      SoftBodyDesc.cloth([-0.55, 1, -0.55], [d, 0, 0], [0, 0, d], n, n).setPinnedParticles([
        0,
        n - 1,
        (n - 1) * n,
        n * n - 1,
      ]),
    );
    const body = physics.addBody(null, options);
    let landed = -1;
    for (let i = 0; i < 330; i++) {
      physics.step();
      const [x, y, z] = body.position,
        under = clothHeight(cloth, x, z);
      assert.ok(under !== null, `step ${i}: the ${name} left the cloth at ${body.position}`);
      // Never below the sheet under it: the body's centre stays over the surface its triangles make.
      assert.ok(
        y > under,
        `step ${i}: the ${name} went through the cloth: its centre ${y} under the sheet at ${under}`,
      );
      assert.ok(Math.hypot(...body.linearVelocity) < 40, `step ${i}: the ${name} was thrown: ${body.linearVelocity}`);
      if (landed < 0 && y < under + 0.2) landed = i;
    }
    assert.ok(landed >= 0 && landed < 30, `the ${name} came down on the cloth (step ${landed})`);
  }
});

// A cloth half over a sharp box edge: does friction hold it? At the edge the cloth turns through 90 degrees, so the edge
// presses on it with sqrt(2) times the mean of the tensions either side, and its friction can hold the difference: with the
// hanging half's weight W/2 pulling and the top half's friction mu W/2 holding, it holds while
//   W/2 - mu W/2 <= mu sqrt(2) (W/2 + mu W/2) / 2,  i.e. mu >= mu_crit = 0.487
// (the root of 0.354 mu^2 + 0.854 mu - 0.5). The estimate idealises the edge as a point and the cloth as a string with no
// bending stiffness; a rounded contact, bending and the landing's momentum move the real threshold by tens of percent, so a
// coefficient near 0.49 (the 0.5 this test once used) cannot be decided either way. These cases sit well clear of it: at
// twice mu_crit the cloth must hold, at under half of it it must slide off.
const drape = async (mu) => {
  const { physics, soft } = await create();
  // A box whose top edge runs along x = 0 at y = 1, and a free cloth 55 cm wide falling on it with half its width past the edge.
  physics.addBody(null, {
    type: 'fixed',
    position: [-0.3, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.3, 0.5, 0.3], friction: mu },
  });
  const n = 12,
    d = 0.05;
  const cloth = soft.create(SoftBodyDesc.cloth([-0.3, 1.2, -0.275], [d, 0, 0], [0, 0, d], n, n));
  let fastest = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    const p = cloth.particlePositions(),
      v = cloth.particleVelocities();
    for (let k = 0; k < p.length; k += 3) {
      // Inside the box: within its footprint and between its bottom (y = 0) and its top (y = 1).
      const inside =
        p[k] < -0.001 && p[k] > -0.599 && p[k + 1] < 0.999 && p[k + 1] > 0.001 && Math.abs(p[k + 2]) < 0.299;
      assert.ok(
        !inside,
        `mu ${mu}, step ${i}: particle ${k / 3} is inside the box at ${p[k]}, ${p[k + 1]}, ${p[k + 2]}`,
      );
      if (i > 40) fastest = Math.max(fastest, Math.hypot(v[k], v[k + 1], v[k + 2]));
    }
  }
  const p = cloth.particlePositions();
  let lowest = Infinity,
    highest = -Infinity;
  for (let k = 1; k < p.length; k += 3) {
    lowest = Math.min(lowest, p[k]);
    highest = Math.max(highest, p[k]);
  }
  return { fastest, lowest, highest };
};

test('a cloth over a sharp box edge with friction twice what holds it hangs over the edge, never enters the box and does not pop', async () => {
  const { fastest, lowest, highest } = await drape(1.0);
  // Once it has landed nothing jumps (no particle snags on the edge and springs off), and it hangs past the edge.
  assert.ok(fastest < 1, `no particle pops once the cloth has landed: ${fastest} m/s`);
  assert.ok(highest > 1 && highest < 1.1, `the part on the box lies on its top: ${highest}`);
  assert.ok(lowest < 0.85, `the part past the edge hangs down over it: ${lowest}`);
});

test('a cloth over a sharp box edge with under half the friction that holds it slides off, never through the box', async () => {
  const { highest } = await drape(0.2);
  assert.ok(highest < 0, `it slid off the box and fell: its highest particle is at ${highest}`);
});

test('a contact is stable at a mass ratio of a thousand either way, and a cloth holds a body or tears, never lets it through', async () => {
  const run = async (particleMass, boxMass, tear = 0) => {
    const { physics, soft } = await create();
    const n = 12,
      d = 0.1;
    const desc = SoftBodyDesc.cloth([-0.55, 1, -0.55], [d, 0, 0], [0, 0, d], n, n)
      .setPinnedParticles([0, n - 1, (n - 1) * n, n * n - 1])
      .setParticleMass(particleMass);
    if (tear > 0) desc.setEdgeTearResistance(tear);
    const cloth = soft.create(desc);
    let tore = false;
    soft.onTear(() => (tore = true));
    const box = physics.addBody(null, {
      position: [0, 1.4, 0],
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass: boxMass },
    });
    let fastest = 0,
      touched = false,
      clear = 0;
    const centre = [];
    for (let i = 0; i < 300; i++) {
      physics.step();
      fastest = Math.max(fastest, box.linearVelocity[1]);
      const [x, y, z] = box.position,
        under = clothHeight(cloth, x, z),
        p = cloth.particlePositions();
      // The sheet's middle: the four particles round its centre.
      centre.push([5 * n + 5, 5 * n + 6, 6 * n + 5, 6 * n + 6].reduce((sum, k) => sum + p[k * 3 + 1], 0) / 4);
      // How far the box's underside is above the sheet under it, once it has come down on it.
      if (under !== null) {
        if (box.linearVelocity[1] > 0) touched = true;
        if (touched) clear = Math.max(clear, y - 0.1 - under);
      }
      // An intact cloth never lets the box between its particles: while the box is over it, its centre stays over the sheet.
      if (!tore && under !== null)
        assert.ok(
          y > under,
          `particles ${particleMass} kg, box ${boxMass} kg: step ${i}: the box passed through the cloth (${y} under ${under})`,
        );
    }
    return {
      y: box.position[1],
      fastest,
      tore,
      under: clothHeight(cloth, box.position[0], box.position[2]),
      centre,
      clear,
    };
  };
  for (const [particleMass, boxMass] of [
    [1, 1000],
    [1, 0.001],
    [0.001, 1],
    [1, 1],
  ]) {
    const result = await run(particleMass, boxMass);
    assert.ok(Number.isFinite(result.y), `particles ${particleMass} kg, box ${boxMass} kg stays a number: ${result.y}`);
    assert.ok(result.fastest < 6, `and is never thrown upward: ${result.fastest} m/s`);
    // Held: it ends on the cloth, over the sheet.
    assert.ok(
      result.under !== null && result.y > result.under,
      `and is held on the cloth: ${result.y} over ${result.under}`,
    );
    if (boxMass === 0.001) {
      // The pebble on a sheet of 144 kg must leave it for a while. The sheet rings after its drop: from its middle's own
      // motion, a crest, the trough after it and the next crest give its amplitude A and period T. A pebble resting on it
      // leaves it at a crest when the sheet's downward acceleration there, omega^2 A for omega = 2 pi / T, exceeds g. The
      // sheet then falls away faster than the pebble can follow (contacts push and never pull). So the pebble hops, clear
      // of every contact's reach (twice the faces' thickness, the circumradius 0.1 / sqrt(2) of a cell's triangle), and comes
      // back down onto the sheet, never under it and never thrown.
      const y = result.centre,
        extremes = [];
      for (let i = 1; i + 1 < y.length; i++)
        if ((y[i] > y[i - 1] && y[i] >= y[i + 1]) || (y[i] < y[i - 1] && y[i] <= y[i + 1])) extremes.push(i);
      // The drop's lowest point is the first extreme; the ringing starts at the crest after it.
      const [crest, trough, next] = [extremes[1], extremes[2], extremes[3]],
        period = (next - crest) / 60,
        amplitude = (y[crest] + y[next] - 2 * y[trough]) / 4,
        omega = (2 * Math.PI) / period;
      assert.ok(y[crest] > y[trough] && y[next] > y[trough], 'the ringing is found: a crest, a trough, a crest');
      assert.ok(
        omega * omega * amplitude > 9.81,
        `the sheet's crest outpaces gravity: omega^2 A ${omega * omega * amplitude}`,
      );
      assert.ok(result.clear > 2 * (0.1 / Math.SQRT2), `so the pebble leaves it: ${result.clear} m clear`);
    }
  }
  // A cloth that tears past a strain lets the tonne through by tearing, not by passing it between its particles.
  const torn = await run(1, 1000, 0.05);
  assert.ok(torn.tore, 'a cloth with a tear strain tears under a tonne');
});

test('a light box pinched between two closing cloths leaves no faster than they close', async () => {
  // No gravity: two 0.6 m curtains of 1 kg particles 0.3 m apart close on a box 0.1 m across at v each way. Every contact is
  // inelastic (its velocity pass takes out the speed along its normal), so a wall gives the box no more speed along its
  // normal than it had, and the most two walls give a box between them is the speed they close at, 2 v. That holds while
  // they pinch it: until they have closed the 0.2 m between them and the box and as long again, 0.2 / v seconds. (After that,
  // a 1 g box riding 160 kg of crumpling cloth goes where the cloth whips it.) A light box (1 g) is where it went wrong: its
  // contacts with the two sides hold it twice over, a singular system whose multipliers ran away until the contacts' rows
  // were damped (rigid.rs, ROW_DAMPING); the sharper repro of that is the 1 g box on a 144 kg sheet, in the mass-ratio test.
  for (const [boxMass, v] of [
    [0.001, 1],
    [0.001, 3],
    [1, 1],
  ]) {
    const { physics, soft } = await create({ gravity: [0, 0, 0] });
    const n = 9,
      d = 0.075;
    const curtains = [-1, 1].map((side) =>
      soft.create(SoftBodyDesc.cloth([side * 0.15, -0.3, -0.3], [0, d, 0], [0, 0, d], n, n).setParticleMass(1)),
    );
    const box = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.05, 0.05, 0.05], mass: boxMass },
    });
    curtains.forEach((curtain, k) => {
      for (let p = 0; p < n * n; p++) curtain.applyParticleImpulse(p, [(k === 0 ? 1 : -1) * v, 0, 0]);
    });
    const pinch = Math.ceil((0.2 / v) * 60);
    let fastest = 0;
    for (let i = 0; i < pinch; i++) {
      physics.step();
      fastest = Math.max(fastest, Math.hypot(...box.linearVelocity));
      assert.ok(
        box.position.every(Number.isFinite),
        `box ${boxMass} kg at ${v} m/s: step ${i}: the box stays a number`,
      );
    }
    assert.ok(
      fastest <= 2 * v,
      `box ${boxMass} kg, walls at ${v} m/s each: its fastest, ${fastest} m/s, is within ${2 * v}`,
    );
  }
});

test('a soft body is drawn between steps by alpha, as rigid bodies are, and a teleport leaves no trail (PA-06)', async () => {
  const { physics, soft } = await create();
  const cloth = soft.create(SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, 0, 0.1], 4, 4).setPinnedParticles([0]));
  steps(physics, 10);
  const before = cloth.particlePositions();
  // A frame of 2.5 steps: two steps run and half a step is left, so the world's alpha is a half.
  const dt = 1 / 60;
  assert.equal(physics.update(dt * 2.5), 2);
  const mid = cloth.particlePositions();
  physics.step();
  const after = cloth.particlePositions();
  near(physics.alpha, 0.5, 1e-9, 'alpha');
  // Drawn now (after one more step), between where the last step began (`mid`) and where it ended.
  const drawn = cloth.interpolatedPositions(0.25);
  for (let k = 0; k < drawn.length; k++) near(drawn[k], mid[k] + 0.25 * (after[k] - mid[k]), 1e-6, `coordinate ${k}`);
  assert.deepEqual(cloth.interpolatedPositions(1), after, 'alpha 1 is the stepped state');
  assert.deepEqual(cloth.interpolatedPositions(0), mid, 'alpha 0 is where the step began');
  assert.deepEqual(cloth.interpolatedPositions(7), after, 'alpha is held to 0..1');
  assert.ok(
    before.some((v, k) => v !== mid[k]),
    'the cloth moved',
  );
  // A teleport is drawn where it went, at any alpha.
  cloth.setParticlePosition(5, [10, 10, 10]);
  for (const a of [0, 0.5, 1]) assert.deepEqual(Array.from(cloth.interpolatedPositions(a).slice(15, 18)), [10, 10, 10]);
  // Into a buffer of one's own, and refused with the wrong length or a bad alpha.
  const out = new Float32Array(cloth.numParticles() * 3);
  assert.equal(cloth.interpolatedPositions(0.5, out), out);
  assert.throws(() => cloth.interpolatedPositions(0.5, new Float32Array(2)), /three numbers a particle/);
  assert.throws(() => cloth.interpolatedPositions(Number.NaN), /alpha/);
});

test('a cloth linked to a rigid body keeps its momentum when its free particles are kicked (KB-SOFT-ATTACHKICK1)', async () => {
  // The repro: no gravity, a 4 by 7 cloth whose first row (seven particles) is linked to a 50 kg box, the 21 others kicked 0.1 N s
  // along x before each step. The links and the cloth's rigid edges are solved in one system with the box as an unknown, so
  // the box and the cloth together hold exactly what was applied; with the edges swept apart from the links, and the edge
  // between two linked particles a redundant row, they held thousands of times it. A woven cloth and a mesh of the same
  // triangles both; the air is left out, which would rightly take momentum away. The mesh also without shape matching: its
  // rigid edges then hold its interior twice over in its plane (a flat mesh has more edges than its plane has freedoms), a
  // singular system whose multipliers ran away until the rows were damped (rigid.rs, ROW_DAMPING); it flew apart in five steps.
  for (const [mesh, matching] of [
    [false, true],
    [true, true],
    [true, false],
  ]) {
    const { physics, soft } = await create({ gravity: [0, 0, 0] });
    const nu = 4,
      nv = 7,
      d = 0.1;
    const sheet = SoftBodyDesc.cloth([0, 0, 0], [d, 0, 0], [0, 0, d], nu, nv);
    const desc = (mesh ? SoftBodyDesc.trimesh(sheet.positions, sheet.triangles).setShapeMatching(matching) : sheet)
      .setParticleMass(1)
      .setAirDrag(false);
    const cloth = soft.create(desc);
    const box = physics.addBody(null, {
      position: [0.15, 0, -0.2],
      colliders: { shape: 'box', halfExtents: [0.2, 0.05, 0.05], mass: 50 },
    });
    const linked = Array.from({ length: nv }, (_, j) => j);
    for (const p of linked) cloth.attachParticle(p, box);
    const free = Array.from({ length: nu * nv }, (_, p) => p).filter((p) => !linked.includes(p));
    for (let s = 0; s < 30; s++) {
      for (const p of free) cloth.applyParticleImpulse(p, [0.1, 0, 0]);
      physics.step();
    }
    const v = cloth.particleVelocities(),
      momentum = [0, 1, 2].map((k) => {
        let sum = 50 * box.linearVelocity[k];
        for (let p = 0; p < nu * nv; p++) sum += v[p * 3 + k];
        return sum;
      }),
      applied = 0.1 * free.length * 30;
    // f32 velocities of 29 particles and a body over 30 steps: a few parts in ten thousand.
    near(
      momentum[0],
      applied,
      1e-3 * applied,
      `${mesh ? (matching ? 'mesh' : 'mesh, no shape matching') : 'woven'}: momentum along the kicks`,
    );
    near(
      momentum[1],
      0,
      1e-3 * applied,
      `${mesh ? (matching ? 'mesh' : 'mesh, no shape matching') : 'woven'}: no momentum up`,
    );
    near(
      momentum[2],
      0,
      1e-3 * applied,
      `${mesh ? (matching ? 'mesh' : 'mesh, no shape matching') : 'woven'}: no momentum across`,
    );
  }
});

test("a strip of the default fabric hung between its ends sags as an elastic cable of the fabric's measured stiffness", async () => {
  // A 1 m strip of cotton shirting (the default: its measured weight and its warp's KES-F stretch) pinned at both ends, its
  // warp along the span. A shallow elastic cable with no slack sags until the length the sag needs, 8 d^2 / (3 L), is the
  // stretch its tension H = w L^2 / (8 d) gives, H L / EA (Irvine, *Cable Structures*, 1981, chapter 2), so
  //   d = L (3 w L / (64 EA))^(1/3), with w / EA = rho_A g / K
  // per width: the areal density over the fabric's tensile stiffness, the same for every thread. Its error: the shallow-cable
  // forms neglect terms of (d / L)^2 (0.05 percent here), twenty segments of the curve differ from it by about 1 / N^2 (0.25
  // percent), and the strip is let settle for ten seconds of yarn and air damping; within 1 percent.
  const { physics, soft } = await create();
  const nu = 21,
    l = 0.05,
    span = (nu - 1) * l;
  const cloth = soft.create(
    SoftBodyDesc.cloth([0, 1, 0], [l, 0, 0], [0, 0, l], nu, 2).setPinnedParticles([
      0,
      1,
      (nu - 1) * 2,
      (nu - 1) * 2 + 1,
    ]),
  );
  steps(physics, 600);
  const sag = 1 - cloth.particlePosition(((nu - 1) / 2) * 2)[1];
  const stiffness = fabricTensileStiffness(FABRICS.cottonShirting.tensile.warp),
    expected = span * Math.cbrt((3 * FABRICS.cottonShirting.arealDensity * 9.81 * span) / (64 * stiffness));
  near(sag, expected, 0.01 * expected, 'the mid-span sag');
});
