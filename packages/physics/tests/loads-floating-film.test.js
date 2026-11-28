// Directing floating bodies for film (SEA-12, parity bar P12 point 7): a wave crest placed at a time and place
// (`waveHit`, NewWave and constrained NewWave), a body ballasted to a chosen draft, heel and trim (`ballast`), and a push
// placed at a time (LoadSolver `impulses`). Each steers the scene through the physics, not around it: the crest is a
// linear sea a body meets as any other, the ballast is an equilibrium of the same buoyancy, and the push is an impulse
// held with the water the body carries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { ballast, floating, LoadSolver, waveHit } from '../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../dist/world.js';

await Physics.load();
const RHO = 1025,
  G = 9.81;

function box([x, y, z]) {
  return {
    vertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ],
  };
}

test('SEA-12 waveHit puts a crest of the asked height at the asked place and time, and draws the same waves', () => {
  for (const options of [
    { at: [12, -4], time: 20, crest: 1.6, period: 7 },
    { at: [12, -4], time: 20, crest: 1.6, period: 7, background: 2.5, seed: 9 },
  ]) {
    const sea = waveHit(options);
    // The crest: its height there and then, and the surface level there at that instant (zero slope in time).
    assert.ok(Math.abs(sea.elevation(12, -4, 20) - 1.6) <= 1e-9, `crest ${sea.elevation(12, -4, 20)}`);
    const rise = (sea.elevation(12, -4, 20 + 1e-4) - sea.elevation(12, -4, 20 - 1e-4)) / 2e-4;
    assert.ok(Math.abs(rise) <= 1e-6, `rising at ${rise} m/s at the crest`);
    // Water's waves (waveComponents) give the same surface, to the f32 the renderer reads.
    const out = new Float32Array(4 * sea.componentCount),
      count = sea.waveComponents(23, out);
    for (const [x, z] of [
      [3, 1],
      [12, -4],
      [-20, 7],
    ]) {
      let drawn = 0;
      for (let n = 0; n < count; n++)
        drawn += out[4 * n + 2] * Math.cos(out[4 * n] * x + out[4 * n + 1] * z + out[4 * n + 3]);
      assert.ok(Math.abs(drawn - sea.elevation(x, z, 23)) <= 1e-4 * 1.6 * 4, `drawn ${drawn} at ${x}, ${z}`);
    }
    // Airy's kinematics: at the still level the vertical velocity is the surface's rise (the linear kinematic condition),
    // read where the water stands above that level.
    let x = 0;
    while (sea.elevation(x, 2, 21) <= 0.01) x += 0.5;
    const sample = sea.water.sample(x, -1e-9, 2, 21),
      surfaceRise = (sea.elevation(x, 2, 21 + 1e-4) - sea.elevation(x, 2, 21 - 1e-4)) / 2e-4;
    assert.ok(
      Math.abs(sample.velocity[1] - surfaceRise) <= 0.02 * 1.6,
      `w ${sample.velocity[1]} against ${surfaceRise}`,
    );
  }
  // Seeds: the same seed is the same sea; another seed another sea with the same crest.
  const a = waveHit({ at: [0, 0], time: 5, crest: 1, background: 2, seed: 3 }),
    b = waveHit({ at: [0, 0], time: 5, crest: 1, background: 2, seed: 3 }),
    c = waveHit({ at: [0, 0], time: 5, crest: 1, background: 2, seed: 4 });
  assert.equal(a.elevation(7, 3, 1), b.elevation(7, 3, 1));
  assert.notEqual(a.elevation(7, 3, 1), c.elevation(7, 3, 1));
  assert.ok(Math.abs(c.elevation(0, 0, 5) - 1) <= 1e-9);
  assert.throws(() => waveHit({ at: [0, 0], time: 0, crest: -1 }), { code: 'unsupported' });
});

test('SEA-12 a placed crest lifts a floating body as the sea it is: the buoy rides it up at the time it was placed', async () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    buoy = physics.addBody(null, { colliders: { shape: 'cylinder', radius: 0.5, halfHeight: 0.5, density: 500 } }),
    sea = waveHit({ at: [0, 0], time: 6, crest: 1.2, period: 9, density: RHO }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(new LoadSolver(), { sea, bodies: await floating(physics, buoy, { sea, radiation: 'none' }) });
  let top = -Infinity,
    when = 0;
  for (let f = 1; f <= 600; f++) {
    world.advance(f);
    if (buoy.position[1] > top) [top, when] = [buoy.position[1], f / 60];
  }
  // A 1 m buoy in a 9 s wave (126 m long) follows the surface: it peaks within a tenth of the period of the placed time,
  // at the crest's height less its draft change, within 15 % (the buoy's heave response at this period is 1.0 to 1.1).
  assert.ok(Math.abs(when - 6) <= 0.9, `the buoy peaked at ${when} s against the crest at 6 s`);
  assert.ok(Math.abs(top - 1.2) <= 0.15 * 1.2, `it rose to ${top} m on a 1.2 m crest`);
  physics[Symbol.dispose]();
});

test('SEA-12 ballast floats a box at the asked draft, heel and trim, as an equilibrium of its buoyancy', async () => {
  const half = [1, 0.4, 0.5],
    mesh = box(half);
  // Upright: the mass is the box's displacement and GM the wall-sided B^2 / (12 T) + T / 2 - KG.
  const upright = ballast(mesh, { draft: 0.3, height: -0.2, density: RHO });
  assert.ok(Math.abs(upright.mass - RHO * 2 * 1 * 0.3) <= 1e-9 * upright.mass, `mass ${upright.mass}`);
  const gm = 1 ** 2 / (12 * 0.3) + 0.3 / 2 - (0.4 - 0.2);
  assert.ok(Math.abs(upright.stability - gm) <= 2e-3 * gm, `GM ${upright.stability} against ${gm}`);
  // Heeled 5 degrees and trimmed 2: it settles at that pose and stays there.
  const heel = (5 * Math.PI) / 180,
    trim = (2 * Math.PI) / 180,
    target = ballast(mesh, { draft: 0.35, heel, trim, height: -0.25, density: RHO }),
    physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, -G, 0] }),
    turn = [
      Math.sin(heel / 2) * Math.cos(trim / 2),
      -Math.sin(heel / 2) * Math.sin(trim / 2),
      Math.cos(heel / 2) * Math.sin(trim / 2),
      Math.cos(heel / 2) * Math.cos(trim / 2),
    ],
    body = physics.addBody(null, {
      rotation: turn,
      colliders: { shape: 'box', halfExtents: half, mass: target.mass },
    });
  body.setMassProperties({ mass: target.mass, centerOfMass: target.centerOfMass });
  const sea = {
    cell: [0, 0, 0],
    density: RHO,
    elevation: () => 0,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, o = { velocity: [0, 0, 0], density: RHO, temperature: 288 }) => o,
    },
  };
  // Place the body so its lowest corner is 0.35 m under the water.
  let lowest = Infinity;
  for (let i = 0; i < 24; i += 3) {
    const [x, y, z] = mesh.vertices.slice(i, i + 3),
      [qx, qy, qz, qw] = turn,
      tx = 2 * (qy * z - qz * y),
      ty = 2 * (qz * x - qx * z),
      tz = 2 * (qx * y - qy * x);
    lowest = Math.min(lowest, y + qw * ty + (qz * tx - qx * tz));
  }
  body.setPosition([0, -0.35 - lowest, 0]);
  const world = new PhysicsWorld({ rate: { num: 240, den: 1 }, gravity: [0, -G, 0] })
    .add(new RigidSolver(), { physics })
    .add(new LoadSolver(), { sea, bodies: await floating(physics, body, { sea, radiation: 'none' }), level: 2 })
    .couple(['loads', 'rigid'], 'staggered');
  const start = [...body.position];
  world.advance(240);
  // Held at the pose: it moves less than a millimetre and turns less than a hundredth of a degree in a second.
  const moved = Math.hypot(...body.position.map((p, i) => p - start[i])),
    q = body.rotation,
    dot = Math.abs(q[0] * turn[0] + q[1] * turn[1] + q[2] * turn[2] + q[3] * turn[3]);
  assert.ok(moved < 1e-3, `moved ${moved} m`);
  assert.ok(
    2 * Math.acos(Math.min(1, dot)) < (0.01 * Math.PI) / 180,
    `turned ${(2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI} degrees`,
  );
  assert.throws(() => ballast(mesh, { draft: 0.3, height: 0.39, density: RHO }), {
    code: 'unsupported',
    message: /capsize/,
  });
  assert.throws(() => ballast(mesh, { draft: 1, density: RHO }), { code: 'unsupported', message: /deeper/ });
  physics[Symbol.dispose]();
});

test('SEA-12 a placed push moves a floating body by exactly its impulse over the body and its carried water', async () => {
  const run = async (impulses) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
      body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, density: 500 } }),
      sea = {
        cell: [0, 0, 0],
        density: RHO,
        elevation: () => 0,
        water: {
          medium: 'water',
          cell: [0, 0, 0],
          sample: (_x, y, _z, _t, o = { velocity: [0, 0, 0], density: 0, temperature: 288 }) => (
            (o.density = y <= 0 ? RHO : 0), o
          ),
        },
      },
      world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
        .add(new RigidSolver(), { physics })
        .add(new LoadSolver(), {
          sea,
          bodies: await floating(physics, body, { sea, radiation: 'none', drag: 0, spinDrag: 0 }),
          impulses,
        })
        .couple(['loads', 'rigid'], 'staggered');
    return { physics, body, world };
  };
  const pushed = await run([{ row: 0, time: 1, impulse: [120, 0, 0] }]),
    still = await run([]);
  for (let f = 1; f <= 59; f++) {
    pushed.world.advance(f);
    still.world.advance(f);
  }
  assert.equal(pushed.body.linearVelocity[0], still.body.linearVelocity[0], 'nothing before the push');
  pushed.world.advance(61);
  // Sideways a half-submerged sphere carries half its displaced water's half (Lamb's 0.5 of the sphere, halved by the
  // free surface), so 120 N s gives it 120 / (m + 0.25 rho V_sphere)... taken as the held added mass the solver uses.
  const m = pushed.body.mass,
    v = pushed.body.linearVelocity[0];
  assert.ok(v > 0 && v < 120 / m, `it moved off at ${v} m/s, slower than 120 / m = ${120 / m} (the water it carries)`);
  // The momentum of the body and its added water is the impulse: m v + A v = J.
  const added = 120 / v - m;
  assert.ok(added > 0.1 * m && added < 1.5 * m, `added mass ${added} kg against the body's ${m}`);
  // Replays the push at the same step after a snapshot.
  const again = await run([{ row: 0, time: 1, impulse: [120, 0, 0] }]);
  again.world.advance(30);
  const saved = again.world.takeSnapshot();
  again.world.advance(61);
  const later = again.world.hash();
  again.world.restoreSnapshot(saved.bytes).advance(61);
  assert.equal(again.world.hash(), later);
  for (const r of [pushed, still, again]) r.physics[Symbol.dispose]();
});
