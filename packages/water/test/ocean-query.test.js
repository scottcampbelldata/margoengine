// FFTOcean's CPU height query (SEA-02) against closed forms: deep-water dispersion, the kinematic surface condition and
// determinism; and the drawn water as the physics framework's sea, floating a body with LoadSolver (SEA-12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FFTOcean } from '../dist/fft.js';
import { seaSurface } from '../dist/sea-state.js';
import { Physics } from '../../physics/dist/index.js';
import { LoadSolver } from '../../physics/dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../../physics/dist/world.js';

const g = 9.81;

test('one ring of waves keeps deep-water dispersion: half a period of 2 pi / sqrt(g k) turns the sea upside down', () => {
  // A band holding only the patch's longest wave (|k| = 2 pi / 64 m, the four modes on the axes) has one frequency
  // omega = sqrt(g k), so h(t + pi / omega) = -h(t) and h(t + 2 pi / omega) = h(t) at every point (Airy's deep water).
  const L = 64,
    ocean = new FFTOcean({ resolution: 16, choppiness: 0, cascades: [{ length: L, maxWavelength: L, minWavelength: L * 0.999 }] }),
    omega = Math.sqrt((g * 2 * Math.PI) / L),
    t = 2,
    half = Math.PI / omega;
  let peak = 0;
  for (const [x, z] of [[0, 0], [7, -3], [-20, 11], [31, 5]]) {
    const h0 = ocean.sample(x, z, t).height,
      h1 = ocean.sample(x, z, t + half).height,
      h2 = ocean.sample(x, z, t + 2 * half).height;
    peak = Math.max(peak, Math.abs(h0));
    // Bound: the query time is binary32 like the GPU's (2^-24 of 8.4 s, times omega and the 3 m amplitude) and the
    // grid is stored in binary32 (2^-24 of 3 m): under 1e-5 m.
    assert.ok(Math.abs(h1 + h0) < 1e-5, `half period at ${x}, ${z}: ${h0} then ${h1}`);
    assert.ok(Math.abs(h2 - h0) < 1e-5, `full period at ${x}, ${z}: ${h0} then ${h2}`);
  }
  assert.ok(peak > 0.05, `the ring carries waves (${peak} m)`);
});

test('the surface moves as its height changes: vertical velocity is dh/dt (the kinematic condition)', () => {
  const ocean = new FFTOcean({ resolution: 32, choppiness: 0, seed: 7 }),
    e = 1 / 64;
  for (const [x, z] of [[3, 4], [-40, 12], [100, -7]]) {
    const v = ocean.sample(x, z, 3).velocity[1],
      dh = (ocean.sample(x, z, 3 + e).height - ocean.sample(x, z, 3 - e).height) / (2 * e);
    // Central difference error (e^2 / 6) h''' with |h'''| <= omega^3 a summed: under 2 % of the speed for these seas.
    assert.ok(Math.abs(v - dh) <= 0.02 * Math.abs(v) + 1e-4, `at ${x}, ${z}: ${v} against ${dh}`);
  }
});

test('the same settings give the same bits; a wind set and set back gives the first sea again', () => {
  const options = { resolution: 32, windSpeed: 12, choppiness: 1.2, seed: 99 },
    a = new FFTOcean(options),
    b = new FFTOcean(options),
    points = [[0, 0], [13.5, -2], [-250, 80]];
  const read = (o) => points.map(([x, z]) => o.sample(x, z, 5.5));
  assert.deepEqual(read(a), read(b));
  const first = read(a);
  a.setWind({ speed: 20, direction: [0, 1] });
  assert.notDeepEqual(read(a), first);
  a.setWind({ speed: 12, direction: [1, 0.3] });
  assert.deepEqual(read(a), first);
});

test('seaSurface floats a body on the drawn ocean through LoadSolver', async () => {
  await Physics.load();
  const ocean = new FFTOcean({ resolution: 16, amplitude: 0.0001, choppiness: 0 }),
    sea = seaSurface(ocean),
    r = 0.3,
    // Half the sphere's volume of sea water: Archimedes puts its centre on the surface.
    mass = (1025 * (4 / 3) * Math.PI * r ** 3) / 2,
    level = sea.elevation(0, 0, 0);
  const float = (y) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -g, 0] }),
      body = physics.addBody(null, { position: [0, y, 0], colliders: { shape: 'sphere', radius: r, mass } }),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -g, 0] }).add(new RigidSolver(), { physics });
    world.add(new LoadSolver(), { sea, bodies: [{ row: body.row, shape: { sphere: r } }] });
    return { physics, body, world };
  };
  // Held under, it rises; set at its draft, it stays there (world.advance takes the frame to reach).
  const under = float(level - 0.2);
  under.world.advance(10);
  assert.ok(under.body.linearVelocity[1] > 0.1, 'buoyancy lifts the held-under sphere');
  under.physics[Symbol.dispose]();
  const afloat = float(level);
  for (let frame = 60; frame <= 600; frame += 60) {
    afloat.world.advance(frame);
    // The still-water draft: the surface's 0.1 mm waves are all that move it.
    assert.ok(Math.abs(afloat.body.position[1] - level) < 2e-3, `frame ${frame}: centre ${afloat.body.position[1]} m, surface ${level} m`);
  }
  afloat.physics[Symbol.dispose]();
  assert.equal(sea.pressure(0, level - 2, 0, 0), 1025 * g * 2);
  assert.equal(sea.water.sample(0, level + 1, 0, 0).density, 0);
  assert.throws(() => seaSurface({}), { name: 'MargoError', code: 'unsupported', message: /errors#ocean/ });
  assert.throws(() => seaSurface(ocean, { density: 0 }), { name: 'MargoError', code: 'unsupported' });
});
