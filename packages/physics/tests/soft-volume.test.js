// Soft volumes (P8, SOFT-04 and SOFT-06; three.js `physics_ammo_volume`): SoftBodyDesc.volume welds any closed mesh into a
// deformable body that holds its volume or a gas, bounces on the ground, trades momentum with rigid bodies, takes impulses
// and forces as a body of its mass, feels the air on its windward side, hangs from an anchor, replays after a snapshot,
// draws in the shared debug view, and refuses a mesh it cannot use with a coded error.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { Physics } from '../dist/index.js';
import { PhysicsDebugView } from '../dist/debug-view.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../dist/world.js';

await Physics.load();

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
/** The body's linear momentum, summed over its particles (each of mass M / n: `volume` shares the mass evenly). */
const momentum = (body) => {
  const v = body.particleVelocities(),
    m = body.mass() / body.numParticles(),
    p = [0, 0, 0];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) p[a] += v[i + a] * m;
  return p;
};
/**
 * A UV sphere as a glTF exporter writes one: (w + 1) x (h + 1) vertices, a seam where u wraps and a vertex per segment at
 * each pole, so welding has seams and poles to close. Triangles wound counter-clockwise seen from outside.
 */
const sphereGeometry = (r, w, h) => {
  const positions = [],
    uvs = [],
    indices = [];
  for (let iy = 0; iy <= h; iy++)
    for (let ix = 0; ix <= w; ix++) {
      const phi = (2 * Math.PI * ix) / w,
        theta = (Math.PI * iy) / h;
      positions.push(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
      uvs.push(ix / w, 1 - iy / h);
    }
  const at = (ix, iy) => iy * (w + 1) + ix;
  for (let iy = 0; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const [a, b, c, d] = [at(ix + 1, iy), at(ix, iy), at(ix, iy + 1), at(ix + 1, iy + 1)];
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== h - 1) indices.push(b, c, d);
    }
  return { positions, uvs, indices };
};
const lowest = (body) => Math.min(...body.particlePositions().filter((_, i) => i % 3 === 1));
const ground = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });

test('the quick start: a soft ball dropped on the ground bounces, then rests holding its volume', async () => {
  const physics = new Physics(null);
  ground(physics);
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.4, 16, 12)).setTranslation([0, 1.5, 0]));
  const rest = ball.surfaceVolume();
  let low = Infinity,
    rebound = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    const y = ball.centerOfMass()[1];
    if (y < low) low = y;
    else rebound = Math.max(rebound, y - low);
  }
  assert.ok(low < 0.4, `it squashed on landing (its centre went to ${low}, under its 0.4 m radius)`);
  assert.ok(rebound > 0.05, `it bounced back up ${rebound} m`);
  near(ball.surfaceVolume() / rest, 1, 2e-3, 'it holds its volume at rest');
  // At rest on the ground: the surface keeps its contact thickness (0.01 m) off the floor, no more.
  const bottom = lowest(ball);
  assert.ok(bottom > 0 && bottom < 0.02, `its lowest point rests ${bottom} m above the ground`);
  assert.ok(!ball.particlePositions().some(Number.isNaN));
});

test('a ball on flat ground keeps no face contact its corners already hold (KB-SOFT-FACEROWS1)', async () => {
  // Three corners held a radius above one flat face hold the whole triangle between them (the distance to a plane is
  // affine), so only the triangles at the rim of the contact patch need a face row. The kernel marks a flat face -1, and
  // the check once looked for 0 (a sharp edge), so every lower triangle kept its row, some twice: 480 rows on this ball,
  // and the exact contact and friction solves grow with their square. The bound: each triangle that can face the ground
  // (the lower half, 176 of 352) at most once.
  const physics = new Physics(null);
  ground(physics);
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.4, 16, 12)).setTranslation([0, 1.5, 0]));
  steps(physics, 240);
  const rows = soft.capacity[6];
  assert.ok(rows > 0, 'the rim still has its face contacts');
  assert.ok(
    rows <= ball.sourceMesh.indices.length / 6,
    `at most ${ball.sourceMesh.indices.length / 6} face rows, not ${rows}`,
  );
});

test('volume welds a mesh split at its seams into one closed surface of the right volume and mass', async () => {
  const physics = new Physics(null);
  const soft = await SoftBodies.attach(physics);
  // A UV sphere of 16 x 12: 17 x 13 vertices, one particle for each of the 16 x 11 rings' points and each pole.
  const mesh = sphereGeometry(0.5, 16, 12),
    ball = soft.create(SoftBodyDesc.volume(mesh));
  assert.equal(ball.numParticles(), 16 * 11 + 2);
  assert.equal(ball.sourceMesh.particles.length, 17 * 13);
  assert.deepEqual([...ball.sourceMesh.indices], mesh.indices);
  assert.deepEqual([...ball.sourceMesh.uvs], mesh.uvs.map(Math.fround), 'the geometry uvs are kept for drawing');
  // A loaded glTF primitive (model.primitives[i]): 20 floats a vertex, position first and TEXCOORD_0 at 12 and 13.
  const packed = new Float32Array((mesh.positions.length / 3) * 20);
  for (let v = 0; v < packed.length / 20; v++) {
    packed.set(mesh.positions.slice(v * 3, v * 3 + 3), v * 20);
    packed.set(mesh.uvs.slice(v * 2, v * 2 + 2), v * 20 + 12);
  }
  const primitive = soft.create(
    SoftBodyDesc.volume({ vertices: packed, indices: Uint32Array.from(mesh.indices), definition: {} }).setTranslation([
      6, 0, 0,
    ]),
  );
  assert.equal(primitive.numParticles(), ball.numParticles(), 'a glTF primitive is read at its 20-float stride');
  assert.deepEqual([...primitive.sourceMesh.uvs], [...ball.sourceMesh.uvs], 'and its TEXCOORD_0 kept');
  // The polyhedron's volume, summed here from the source triangles on their own.
  let volume = 0;
  const q = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t + k] * 3);
    volume +=
      (q[a] * (q[b + 1] * q[c + 2] - q[b + 2] * q[c + 1]) -
        q[a + 1] * (q[b] * q[c + 2] - q[b + 2] * q[c]) +
        q[a + 2] * (q[b] * q[c + 1] - q[b + 1] * q[c])) /
      6;
  }
  near(ball.surfaceVolume(), volume, 1e-6, 'the welded surface encloses what the mesh does');
  near(ball.mass(), 1000 * volume, 1e-3, 'water density by default');
  // A core Geometry (position and normal, 6 floats a vertex): 24 vertices, 8 corners.
  const brick = soft.create(SoftBodyDesc.volume(box(0.5, 0.2, 0.1), { density: 400 }).setTranslation([3, 0, 0]));
  assert.equal(brick.numParticles(), 8);
  near(brick.surfaceVolume(), 0.01, 1e-8, 'a core box');
  near(brick.mass(), 4, 1e-5, 'density times volume');
  // Each source vertex follows its particle.
  const p = brick.particlePositions(),
    { particles } = brick.sourceMesh;
  const geometry = box(0.5, 0.2, 0.1);
  for (let v = 0; v < particles.length; v++)
    for (let a = 0; a < 3; a++)
      near(p[particles[v] * 3 + a], geometry.vertices[v * 6 + a] + (a === 0 ? 3 : 0), 1e-6, 'vertex');
});

test('an impulse moves a soft volume at J / M, and its own forces, gas included, move it nowhere', async () => {
  // The bound: the soft kernel keeps positions in float32, and the damped springs' sub-ulp corrections round away unevenly
  // between particles in different binades, which loses up to 1e-3 of the momentum over a few seconds (KB-SOFT-F32MOMENTUM1,
  // docs/limits.md). Momentum is read from the centre of mass, which the velocities' own float32 noise does not touch.
  const RELATIVE = 1e-3;
  for (const pressure of [undefined, 150_000]) {
    const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
    const soft = await SoftBodies.attach(physics);
    const ball = soft.create(
      SoftBodyDesc.volume(sphereGeometry(0.4, 16, 12), { density: 100, pressure }).setAirDrag(false),
    );
    const mass = ball.mass(),
      start = ball.centerOfMass();
    ball.applyImpulse([3, 0, -1]);
    near(momentum(ball)[0], 3, 1e-5, 'the impulse is the change of momentum');
    // A second of its own springs, volume and (with a fill above the 101,325 Pa outside) gas pushing out: the pressure on a
    // closed surface sums to no force, so the centre of mass keeps going at J / M.
    steps(physics, 60);
    const centre = ball.centerOfMass(),
      moved = [0, 1, 2].map((a) => (centre[a] - start[a]) * mass);
    near(moved[0], 3, 3 * RELATIVE, `momentum along x over a second (pressure ${pressure})`);
    near(moved[2], -1, 3 * RELATIVE, 'momentum along z');
    near(moved[1], 0, 3 * RELATIVE, 'and none across');
    if (pressure) assert.ok(ball.gasState().volume > ball.surfaceVolume() * 0.999, 'the gas state is live');
    // A force for half a second gives F t of momentum, and stops when reset.
    ball.addForce([0, 6, 0]);
    steps(physics, 30);
    ball.resetForces();
    const from = ball.centerOfMass()[1];
    steps(physics, 30);
    near((ball.centerOfMass()[1] - from) * 2 * mass, 3, 3 * RELATIVE, 'F t of momentum from a force');
  }
});

test('a soft volume and a rigid box trade momentum both ways when they collide', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.4, 16, 12), { density: 50 }).setAirDrag(false));
  const crate = physics.addBody(null, {
    position: [1, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], mass: 2 },
  });
  ball.applyImpulse([3 * ball.mass(), 0, 0]);
  const before = momentum(ball)[0];
  steps(physics, 60);
  const after = momentum(ball)[0],
    pushed = 2 * crate.linearVelocity[0];
  assert.ok(pushed > 0.1 * before, `the ball pushed the crate (${pushed} of ${before} N s)`);
  assert.ok(after < before, 'and the crate slowed the ball');
  near(after + pushed, before, 1e-4 * before, 'the momentum the ball lost is the momentum the crate took');
});

test('a closed volume feels the air on its windward side: a sphere drags as C_D 0.525 (KB-SOFT-CLOSEDDRAG1)', async () => {
  // The windward-face model gives a sphere C_D = 1.05 / 2 = 0.525 (Hoerner 1965's cube 1.05 over its windward half);
  // Achenbach 1972 measured 0.47 below the drag crisis. Before this, every face took a flat plate's 1.17 both ways round,
  // C_D 1.17 on a ball, 2.5 times the measured drag. Quadratic drag from v0 for t: 1/v - 1/v0 = rho C_D A t / (2 M).
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.5, 32, 24), { density: 20 }));
  ball.applyImpulse([5 * ball.mass(), 0, 0]);
  steps(physics, 60);
  const v = momentum(ball)[0] / ball.mass(),
    drag = (2 * ball.mass() * (1 / v - 1 / 5)) / (1.225 * Math.PI * 0.25 * 1);
  // 32 x 24 facets: within 2 percent of the smooth sphere's integral.
  near(drag, 0.525, 0.0105, 'drag coefficient of the ball');
});

test('anchoring and stiffness: a pinned particle holds the ball up, and a softer ball squashes more', async () => {
  const physics = new Physics(null);
  ground(physics);
  const soft = await SoftBodies.attach(physics);
  const hung = SoftBodyDesc.volume(sphereGeometry(0.3, 12, 8), { density: 100 }).setTranslation([0, 2, 0]);
  // Particle 0 is the top pole of the sphere.
  const ball = soft.create(hung.setPinnedParticles([0]));
  const top = ball.particlePosition(0);
  const softBall = soft.create(
    SoftBodyDesc.volume(sphereGeometry(0.3, 12, 8), { stiffness: 4 }).setTranslation([2, 0.4, 0]),
  );
  const firm = soft.create(
    SoftBodyDesc.volume(sphereGeometry(0.3, 12, 8), { stiffness: 40 }).setTranslation([-2, 0.4, 0]),
  );
  steps(physics, 180);
  assert.deepEqual(ball.particlePosition(0), top, 'the pinned particle does not move');
  assert.ok(ball.centerOfMass()[1] < top[1] - 0.25, 'the ball hangs below its anchor');
  const height = (b) => Math.max(...b.particlePositions().filter((_, i) => i % 3 === 1)) - lowest(b);
  assert.ok(height(softBall) < height(firm) - 0.01, `4 Hz stands ${height(softBall)} m, 40 Hz ${height(firm)} m`);
});

test('a soft volume on a rigid box replays bit for bit after a snapshot and restore', async () => {
  const make = async () => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60 });
    ground(physics);
    physics.addBody(null, {
      position: [0, 0.25, 0],
      colliders: { shape: 'box', halfExtents: [0.4, 0.25, 0.4], mass: 3 },
    });
    const soft = await SoftBodies.attach(physics);
    soft.create(SoftBodyDesc.volume(sphereGeometry(0.3, 12, 8)).setTranslation([0.1, 1.4, 0]));
    soft.create(SoftBodyDesc.volume(box(0.4, 0.4, 0.4), { pressure: 110_000 }).setTranslation([-1, 1, 0]));
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new SoftSolver(), { soft })
      .couple(['soft', 'rigid'], 'staggered');
    return world;
  };
  const a = await make(),
    b = await make();
  a.advance(20);
  b.advance(20);
  assert.equal(a.hash(), b.hash(), 'two runs that did the same agree');
  const saved = a.takeSnapshot();
  a.advance(30);
  const expected = a.hash();
  a.restoreSnapshot(saved.bytes);
  assert.equal(a.hash(), saved.hash);
  a.advance(30);
  assert.equal(a.hash(), expected, 'the restored world steps to the same bits');
});

test('the debug view draws a soft volume: its edges, contacts and a centre cross white at its rest volume', async () => {
  const physics = new Physics(null);
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.3, 12, 8)));
  const view = new PhysicsDebugView(physics, { world: false });
  view.add(ball);
  const { vertices, colors } = view.collect();
  // 12 x 8 sphere: 12 * 7 + 12 * 8 - ... edges of the welded surface, plus the three lines of the cross.
  assert.equal(vertices.length / 6, ball.structuralEdges() + 3, 'one line an edge, three for the cross');
  assert.deepEqual([...colors.slice(-4)], [1, 1, 1, 1], 'white at its rest volume');
  assert.throws(
    () => ball.debugRender({ stressRange: 0 }),
    (e) => e.name === 'MargoError' && /errors#soft-volumes/.test(e.message),
  );
});

test('volume refuses a mesh it cannot use with a coded error naming the fix', async () => {
  const sphere = sphereGeometry(0.3, 12, 8);
  const coded = (fn, pattern) =>
    assert.throws(
      fn,
      (e) =>
        e.name === 'MargoError' &&
        e.code === 'unsupported' &&
        pattern.test(e.message) &&
        /errors#soft-volumes/.test(e.message),
    );
  coded(
    () => SoftBodyDesc.volume({ positions: sphere.positions, indices: sphere.indices.slice(0, -3) }),
    /closed mesh/,
  );
  const inward = Array.from(sphere.indices);
  for (let t = 0; t < inward.length; t += 3) [inward[t + 1], inward[t + 2]] = [inward[t + 2], inward[t + 1]];
  coded(() => SoftBodyDesc.volume({ positions: sphere.positions, indices: inward }), /face inward/);
  coded(() => SoftBodyDesc.volume({ vertices: [0, 0, 0, 1], indices: [0, 0, 0], stride: 3 }), /whole vertices/);
  coded(() => SoftBodyDesc.volume({ positions: [0, 0, 0, NaN, 0, 0, 0, 1, 0], indices: [0, 1, 2] }), /finite/);
  coded(() => SoftBodyDesc.volume({ positions: sphere.positions, indices: [0, 1, 999] }), /not a vertex/);
  coded(() => SoftBodyDesc.volume(sphere, { stiffness: -1 }), /stiffness/);
  coded(() => SoftBodyDesc.volume(sphere, { density: 0 }), /density/);
  coded(() => SoftBodyDesc.volume(null), /needs a mesh/);
  // A mesh whose seams are farther apart than the weld stays open.
  coded(() => SoftBodyDesc.volume(sphere, { weld: 0 }), /closed mesh|face inward/);
});

/** The volume of a closed triangle mesh below y = 0, by the divergence theorem with the field (0, y, 0) over each face's
 * part below the plane (clipped), the waterplane adding nothing: the test's own measure, apart from the solver's. */
const volumeBelow = (p, tri) => {
  let V = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const poly = [0, 1, 2].map((k) => [p[tri[t + k] * 3], p[tri[t + k] * 3 + 1], p[tri[t + k] * 3 + 2]]),
      out = [];
    for (let i = 0; i < 3; i++) {
      const a = poly[i],
        b = poly[(i + 1) % 3];
      if (a[1] <= 0) out.push(a);
      if (a[1] <= 0 !== b[1] <= 0) {
        const s = a[1] / (a[1] - b[1]);
        out.push(a.map((v, j) => v + s * (b[j] - v)));
      }
    }
    for (let i = 1; i + 1 < out.length; i++) {
      const [a, b, c] = [out[0], out[i], out[i + 1]],
        u = b.map((v, j) => v - a[j]),
        w = c.map((v, j) => v - a[j]);
      V += (((a[1] + b[1] + c[1]) / 3) * (u[2] * w[0] - u[0] * w[2])) / 2;
    }
  }
  return V;
};

test('in water a soft volume floats where Archimedes says: the water it displaces weighs what it does', async () => {
  // The exact balance at rest: rho_w V_below = M, whatever the ball's shape as it settles. The bound: what is left of its
  // heave after 8 s (its centre's acceleration a, from its last three steps) moves the balance by |a| / g, plus 1e-4 for
  // float32 positions. Before this a closed body was buoyed particle by particle, by the share of its surface under
  // water, which for a sphere is its wetted area (h / 2R), not its submerged volume (h^2 (3R - h) / 4R^3).
  for (const density of [300, 700, 500]) {
    const physics = new Physics(null, { fixedTimestep: 1 / 60 });
    const soft = await SoftBodies.attach(physics);
    soft.water = { density: 1025 };
    const ball = soft.create(
      SoftBodyDesc.volume(sphereGeometry(0.3, 24, 16), { density })
        .setTranslation([0, 0.1, 0])
        .setLinearDamping(3),
    );
    const heights = [];
    for (let i = 0; i < 480; i++) {
      physics.step();
      heights.push(ball.centerOfMass()[1]);
    }
    const [a, b, c] = heights.slice(-3),
      accel = Math.abs(a - 2 * b + c) * 3600,
      balance = (1025 * volumeBelow(ball.particlePositions(), ball.triangles())) / ball.mass();
    near(balance, 1, accel / 9.81 + 1e-4, `density ${density}: rho_w V_below / M`);
    near(ball.displacedVolume(), volumeBelow(ball.particlePositions(), ball.triangles()), 1e-4, 'displacedVolume');
  }
});

test('a soft volume in a wind takes the push of the air on its windward side (ATMO to SOFT, one way)', async () => {
  // A ball held in a steady 10 m/s wind takes C_D 0.525 of the dynamic pressure on its cross-section (the windward-face
  // model of KB-SOFT-CLOSEDDRAG1): F = 0.5 rho C_D pi R^2 v^2, against what its first step from rest moves its centre,
  // F dt^2 / M (semi-implicit Euler).
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const soft = await SoftBodies.attach(physics);
  soft.wind = [10, 0, 0];
  // Heavy enough (200 kg/m^3) that the step's implicit drag, which keeps a light face from passing the wind, takes under 0.5%.
  const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.5, 32, 24), { density: 200 }));
  const start = ball.centerOfMass()[0];
  physics.step();
  const moved = ball.centerOfMass()[0] - start,
    force = (moved * ball.mass()) / (1 / 60) ** 2,
    expected = 0.5 * 1.225 * 0.525 * Math.PI * 0.25 * 100;
  near(
    force,
    expected,
    0.03 * expected,
    'the wind force on the ball (32 x 24 facets: 2%; the implicit step and float32: 1%)',
  );
});
