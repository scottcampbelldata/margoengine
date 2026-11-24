// Soft bodies on the soft kernel: a rope against the catenary, a cloth against its own length, coupling with rigid
// bodies, tearing, replay and the particle API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc, SoftBodyMaterial } from '../dist/soft.js';

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
    assert.ok(box.position[1] - 0.1 > middle[1], 'the box stays on top of the cloth');
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
