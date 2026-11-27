// One-call floating (SEA-12, parity bar P12): `floating(physics, body)` turns a body's own colliders into LoadSolver
// bodies. Every solid collider kind floats at its closed-form Archimedes draft (a box, a sphere, a capsule on its side, a
// cylinder, a cone, a convex hull, a closed triangle mesh, a compound and a turned collider); an upright cylinder takes
// the wall-sided metacentric moment; a box heaves and rolls at its natural periods; bodyLoad reports the centre of
// buoyancy of the closed forms; debugRender draws the waterline on the water; a mixed scene replays bit for bit; and what
// cannot float is refused with a coded error.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { ellipsoidAddedMass, FLOATING_SIDES, floating, LoadSolver } from '../dist/loads.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../dist/world.js';

await Physics.load();
const RHO = 1000,
  G = 9.81,
  RATE = 240;
const close = (actual, expected, relative, what) =>
  assert.ok(
    Math.abs(actual - expected) <= relative * Math.abs(expected),
    `${what}: ${actual} vs ${expected} (±${relative} relative)`,
  );

/** Still water at y = 0, or at `level(x, z)`. */
function water(level = () => 0) {
  return {
    cell: [0, 0, 0],
    density: RHO,
    elevation: (x, z) => level(x, z),
    pressure: (x, y, z) => RHO * G * Math.max(0, level(x, z) - y),
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
        out.density = RHO;
        out.temperature = 288;
        return out;
      },
    },
  };
}

function scene(specs, options = {}, sea = water()) {
  const physics = new Physics(null, { fixedTimestep: 1 / RATE, gravity: [0, -G, 0] }),
    bodies = specs.map((spec) => physics.addBody(null, spec)),
    loads = new LoadSolver(),
    world = new PhysicsWorld({ rate: { num: RATE, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(loads, { sea, bodies: floating(physics, bodies, options), level: 2 }) // 240 Hz: 60 Hz times 2^2
      .couple(['loads', 'rigid'], 'staggered');
  return { physics, bodies, loads, world };
}

const cap = (r, d) => (Math.PI * d * d * (3 * r - d)) / 3;
const segment = (r, d) => r * r * Math.acos((r - d) / r) - (r - d) * Math.sqrt(2 * r * d - d * d);

test('SEA-12 floating() floats every solid collider kind at its closed-form Archimedes draft', () => {
  const [hx, hy, hz] = [0.5, 0.25, 0.4];
  const r = 0.3;
  const a = 0.35; // the diamond hull's half diagonal
  const L = 0.6;
  const cases = [
    // [name, collider, centre height for the draft, closed-form displaced volume]
    ['box', { shape: 'box', halfExtents: [hx, hy, hz] }, hy - 0.2, 4 * hx * hz * 0.2],
    ['sphere', { shape: 'sphere', radius: r }, r - 0.18, cap(r, 0.18)],
    [
      'capsule on its side',
      { shape: 'capsule', radius: 0.2, halfHeight: 0.5, axis: 'x' },
      0.2 - 0.13,
      segment(0.2, 0.13) * 1 + cap(0.2, 0.13),
    ],
    ['cylinder', { shape: 'cylinder', radius: 0.25, halfHeight: 0.4 }, 0.4 - 0.3, Math.PI * 0.25 ** 2 * 0.3],
    [
      'cone',
      { shape: 'cone', radius: 0.3, halfHeight: 0.4 },
      0.4 - 0.5,
      ((Math.PI * 0.09 * 0.8) / 3) * (1 - (1 - 0.5 / 0.8) ** 3),
    ],
    [
      'convex hull',
      { shape: 'convexHull', points: [0, a, -L, 0, -a, -L, a, 0, -L, -a, 0, -L, 0, a, L, 0, -a, L, a, 0, L, -a, 0, L] },
      a - 0.21,
      0.21 * 0.21 * 2 * L,
    ],
    ['closed triangle mesh', { shape: 'trimesh', ...boxTriangles([hx, hy, hz]) }, hy - 0.2, 4 * hx * hz * 0.2],
    [
      'compound',
      {
        shape: 'compound',
        parts: [
          { shape: 'sphere', radius: 0.2, offset: [-0.6, 0, 0] },
          { shape: 'box', halfExtents: [0.2, 0.2, 0.2], offset: [0.6, 0.05, 0] },
        ],
      },
      0.2 - 0.15,
      cap(0.2, 0.15) + 0.4 * 0.4 * 0.1,
    ],
    [
      'turned box',
      { shape: 'box', halfExtents: [hy, hx, hz], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      hy - 0.2,
      4 * hx * hz * 0.2,
    ],
  ];
  for (const [name, collider, y, volume] of cases) {
    const { physics, loads, world } = scene([{ position: [0, y, 0], colliders: { ...collider, mass: RHO * volume } }]);
    world.advance(1);
    const load = loads.bodyLoad(0);
    let submerged = 0;
    for (let i = 0; i < floating(physics, physics.getBodies()).length; i++) submerged += loads.bodyLoad(i).submerged;
    assert.ok(load.active, name);
    // The rigid port carries the pose in float32: 2^-22 m on these heights, so 1e-5 of the draft.
    close(submerged, volume, 1e-5, `${name} displaced volume`);
    close(RHO * G * submerged, physics.getBodies()[0].mass * G, 1e-5, `${name} buoyancy against its weight`);
    physics[Symbol.dispose]();
  }
});

test("SEA-12 floating() with pressureModel 'surface' integrates the water's pressure over boxes and cylinders", () => {
  const { physics, loads, world } = scene(
    [
      { position: [0, 0.25 - 0.2, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.25, 0.4], mass: 160 } },
      { position: [3, 0.4 - 0.3, 0], colliders: { shape: 'cylinder', radius: 0.25, halfHeight: 0.4, mass: 50 } },
      { position: [-3, 0, 0], colliders: { shape: 'sphere', radius: 0.3, mass: 40 } },
    ],
    { pressureModel: 'surface' },
  );
  world.advance(1);
  // Still water: the pressure's integral is rho g times the displaced volume, straight up; the sphere stays compact.
  const volumes = [0.8 * 0.2, Math.PI * 0.25 ** 2 * 0.3, (2 / 3) * Math.PI * 0.3 ** 3];
  volumes.forEach((volume, i) => {
    close(loads.bodyLoad(i).buoyancy[1], RHO * G * volume, 1e-5, `entry ${i} buoyancy`);
    assert.ok(Math.abs(loads.bodyLoad(i).buoyancy[0]) < 1e-6 * RHO * G * volume);
  });
  assert.throws(() => floating(physics, physics.getBodies(), { pressureModel: 'panel' }), { code: 'unsupported' });
  physics[Symbol.dispose]();
});

test('SEA-12 a cylinder floats on its side within the bound its 64-sided section sets', () => {
  const r = 0.25,
    h = 0.5;
  const n = FLOATING_SIDES,
    step = (2 * Math.PI) / n,
    R = r * Math.sqrt(step / Math.sin(step));
  // The section's boundary lies between R cos(pi / n) and R from the axis; the chord at depth d is at most 2 R long.
  const deviation = Math.max(R - r, r - R * Math.cos(Math.PI / n));
  for (const d of [0.25, 0.1, 0.4]) {
    const volume = segment(r, d) * 2 * h;
    const { physics, loads, world } = scene([
      {
        position: [0, r - d, 0],
        colliders: {
          shape: 'cylinder',
          radius: r,
          halfHeight: h,
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          mass: 1,
        },
      },
    ]);
    world.advance(1);
    const bound = d === r ? 1e-5 * volume : 2 * R * deviation * 2 * h + 1e-5 * volume;
    const got = loads.bodyLoad(0).submerged;
    assert.ok(Math.abs(got - volume) <= bound, `draft ${d}: ${got} vs ${volume} ± ${bound}`);
    physics[Symbol.dispose]();
  }
});

test("SEA-12 an upright cylinder takes the wall-sided righting moment of its waterplane's metacentric height", () => {
  const r = 0.3,
    hh = 0.5,
    T = 0.4;
  // The waterplane is the 64-gon of the circle's area; its second moment by the polygon formula, then checked near the circle's.
  const n = FLOATING_SIDES,
    step = (2 * Math.PI) / n,
    R = r * Math.sqrt(step / Math.sin(step));
  let I = 0;
  for (let k = 0; k < n; k++) {
    const [x0, z0, x1, z1] = [
      R * Math.cos(k * step),
      R * Math.sin(k * step),
      R * Math.cos((k + 1) * step),
      R * Math.sin((k + 1) * step),
    ];
    I += ((x0 * z1 - x1 * z0) * (z0 * z0 + z0 * z1 + z1 * z1)) / 12;
  }
  close(I, (Math.PI * r ** 4) / 4, 1e-6, "the 64-gon's second moment against the circle's");
  const V = Math.PI * r * r * T,
    BM = I / V,
    KB = T / 2,
    KG = hh, // the solid cylinder's centre of mass is its centre, hh above the keel
    GM = KB + BM - KG;
  for (const heel of [0.002, 0.05]) {
    const { physics, bodies, loads, world } = scene(
      [
        {
          position: [0, hh - T, 0],
          rotation: [Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)],
          colliders: { shape: 'cylinder', radius: r, halfHeight: hh, mass: RHO * V },
        },
      ],
      { drag: 0, spinDrag: 0 },
    );
    world.advance(1);
    const { region } = loads.exportPorts(0).find((port) => port.field === BODY_FORCES_FIELD.name);
    const row = regionWords(world.arena.memory, region),
      moment = row[bodies[0].row * FORCE_WORDS + 3];
    // Wall-sided: GZ = sin(heel) (GM + BM tan^2(heel) / 2), about the centre of mass. The heeled body keeps its centre
    // height, so the draft at the axis is T / cos(heel) less (hh - T)(1 - cos heel) / cos heel: the volume moves, so the
    // check takes the displaced volume the solver integrates.
    const displaced = loads.bodyLoad(0).submerged;
    const draft = displaced / (Math.PI * r * r),
      gm = draft / 2 + I / displaced - KG;
    const expected = -RHO * G * displaced * Math.sin(heel) * (gm + ((I / displaced) * Math.tan(heel) ** 2) / 2);
    close(moment, expected, 2e-5, `righting moment at ${heel} rad`);
    if (heel === 0.002) close(-moment / (RHO * G * V * Math.sin(heel)), GM, 1e-3, 'GM at small heel');
    physics[Symbol.dispose]();
  }
});

test('SEA-12 a floating box heaves at 2 pi sqrt(m (1 + C_A) / (rho g A_wp)) and rolls at 2 pi sqrt(I / (m g GM))', () => {
  const [hx, hy, hz] = [0.6, 0.2, 0.3],
    T = 0.15,
    m = RHO * 4 * hx * hz * T;
  const period = (series) => {
    // Upward zero crossings about the mean, by linear interpolation; the mean period between the first and last.
    const mean = series.reduce((s, v) => s + v, 0) / series.length,
      crossings = [];
    for (let i = 1; i < series.length; i++)
      if (series[i - 1] < mean && series[i] >= mean)
        crossings.push(i - 1 + (mean - series[i - 1]) / (series[i] - series[i - 1]));
    return (crossings.at(-1) - crossings[0]) / (crossings.length - 1) / RATE;
  };
  // Heave: start 1 cm deep, no drag. The solver's added mass is Lamb's for the box's equivalent ellipsoid, times the wet
  // fraction; at the mean draft it is C_A rho V = C_A m.
  {
    const { physics, bodies, world } = scene(
      [{ position: [0, hy - T - 0.01, 0], colliders: { shape: 'box', halfExtents: [hx, hy, hz], mass: m } }],
      { drag: 0, spinDrag: 0 },
    );
    const heights = [];
    // advance(frame) runs the world up to that frame of its clock.
    for (let frame = 1; frame <= 4 * RATE; frame++) {
      world.advance(frame);
      heights.push(bodies[0].position[1]);
    }
    // C_A along y of the ellipsoid with the box's second moments (shapes.ts), measured here through the solver itself.
    const ca = ellipsoidAddedMass([hx * Math.sqrt(5 / 3), hy * Math.sqrt(5 / 3), hz * Math.sqrt(5 / 3)])[1];
    const expected = 2 * Math.PI * Math.sqrt((m * (1 + ca)) / (RHO * G * 4 * hx * hz));
    // Symplectic stepping shifts a period by (omega dt)^2 / 24 (2e-5 here); the added mass follows the wet fraction, which
    // swings 6.7 % about the mean over the 1 cm heave, a second-order shift of at most 0.067^2 = 4.5e-3 on the period.
    close(period(heights), expected, 5e-3, 'heave period');
    physics[Symbol.dispose]();
  }
  // Roll about x: half-beam hz, 0.03 rad, no drag and no rotational added inertia (the default).
  {
    const heel = 0.03;
    const { physics, bodies, world } = scene(
      [
        {
          position: [0, hy - T, 0],
          rotation: [Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)],
          colliders: { shape: 'box', halfExtents: [hx, hy, hz], mass: m },
        },
      ],
      { drag: 0, spinDrag: 0 },
    );
    const angles = [];
    for (let frame = 1; frame <= 6 * RATE; frame++) {
      world.advance(frame);
      const q = bodies[0].rotation;
      angles.push(2 * Math.atan2(q[0], q[3]));
    }
    const B = 2 * hz,
      GM = T / 2 + (B * B) / (12 * T) - hy,
      I = (m * ((2 * hy) ** 2 + B * B)) / 12;
    const expected = 2 * Math.PI * Math.sqrt(I / (m * G * GM));
    // The wall-sided stiffness grows by 1 + (BM / GM) tan^2(theta) / 2 at the turns (1.2e-3 here, so the period shortens
    // by under 6e-4 on average) and heave couples in at second order in the heel: a 1e-3 bound.
    close(period(angles), expected, 1e-3, 'roll period');
    physics[Symbol.dispose]();
  }
});

test('SEA-12 an undamped floating box neither gains nor loses heave or roll amplitude at 60 steps a second (KB-LOADS-HEAVEGAIN1)', () => {
  // Loads taken at the start of the step fed the motion: the heave amplitude grew 20 % a cycle at 60 steps a second (1.8 %
  // at 240). Taken (s - 1) / (2 s) of the step on, a restoring load is energy-neutral for the rigid step's substeps.
  const [hx, hy, hz] = [1, 0.2, 0.5],
    m = RHO * 4 * hx * hz * 0.16;
  for (const heel of [0, 0.05]) {
    const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
      body = physics.addBody(null, {
        position: [0, hy - 0.16 + (heel ? 0 : 0.06), 0],
        rotation: [Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)],
        colliders: { shape: 'box', halfExtents: [hx, hy, hz], mass: m },
      }),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
        .add(new RigidSolver(), { physics })
        .add(new LoadSolver(), { sea: water(), bodies: floating(physics, body, { drag: 0, spinDrag: 0 }) })
        .couple(['loads', 'rigid'], 'staggered');
    const swing = () => (heel ? 2 * Math.atan2(body.rotation[0], body.rotation[3]) : body.position[1] - (hy - 0.16));
    const peaks = [];
    let previous = swing();
    let rising = false;
    for (let frame = 1; frame <= 60 * 20; frame++) {
      world.advance(frame);
      const now = swing();
      if (rising && now < previous) peaks.push(previous);
      rising = now > previous;
      previous = now;
    }
    assert.ok(peaks.length >= 8, `${peaks.length} swings`);
    // A peak is sampled within a step of the true one: cos(omega dt / 2) of it, 0.997 for heave here.
    for (const peak of peaks)
      close(peak, heel || 0.06, 4e-3, `${heel ? 'roll' : 'heave'} amplitude after ${peaks.indexOf(peak) + 1} swings`);
    physics[Symbol.dispose]();
  }
});

test('SEA-12 bodyLoad reports the closed-form centre of buoyancy of a box and of a hull', () => {
  const a = 0.35,
    L = 0.6,
    d = 0.21;
  const { physics, loads, world } = scene([
    { position: [2, 0.25 - 0.1, -1], colliders: { shape: 'box', halfExtents: [0.5, 0.25, 0.4], mass: 1 } },
    {
      position: [-2, a - d, 1],
      colliders: {
        shape: 'convexHull',
        points: [0, a, -L, 0, -a, -L, a, 0, -L, -a, 0, -L, 0, a, L, 0, -a, L, a, 0, L, -a, 0, L],
        mass: 1,
      },
    },
  ]);
  world.advance(1);
  const box = loads.bodyLoad(0),
    hull = loads.bodyLoad(1);
  const near = (p, q, what) => p.forEach((v, k) => assert.ok(Math.abs(v - q[k]) < 2e-6, `${what}: ${p} vs ${q}`));
  // A box 0.1 m deep: the centre of buoyancy is half the draft below the surface, under the centre.
  near(box.centreOfBuoyancy, [2, -0.05, -1], 'box');
  // The hull's wet section is a triangle on its lower vertex: its centroid is two thirds of the draft above that vertex.
  near(hull.centreOfBuoyancy, [-2, -d / 3, 1], 'hull');
  close(hull.wet, (d * d * 2 * L) / (2 * a * a * 2 * L), 1e-5, 'hull wet fraction');
  close(box.buoyancy[1], RHO * G * 0.1 * 0.8, 1e-5, 'box buoyancy');
  physics[Symbol.dispose]();
});

test('SEA-12 debugRender draws the submerged edges below the water and the waterline on a wave', () => {
  const level = (x) => 0.05 * Math.sin(x);
  const { physics, loads, world } = scene(
    [
      { position: [0, -0.1, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.25, 0.4], mass: 300 } },
      { position: [3, 0, 0], colliders: { shape: 'sphere', radius: 0.3, mass: 50 } },
    ],
    {},
    water(level),
  );
  world.advance(1);
  const all = loads.debugRender(),
    bare = loads.debugRender({ forces: false, centreOfBuoyancy: false, submerged: false });
  assert.equal(all.vertices.length / 3, all.colors.length / 4);
  assert.ok(bare.vertices.length > 0 && bare.vertices.length < all.vertices.length);
  // Every waterline vertex lies on the wave, to the linear cut of a triangle edge on a gently curved surface.
  for (let i = 0; i < bare.vertices.length; i += 3) {
    const [x, y] = [bare.vertices[i], bare.vertices[i + 1]];
    assert.ok(Math.abs(y - level(x)) < 2e-3, `waterline point ${x}, ${y} is off the wave ${level(x)}`);
  }
  assert.throws(() => loads.debugRender({ forceScale: -1 }), { code: 'unsupported' });
  physics[Symbol.dispose]();
});

test('SEA-12 a floating scene of every kind replays to the same hash, and after a snapshot', () => {
  const run = () =>
    scene([
      {
        position: [0, 0.3, 0],
        rotation: [0.1, 0, 0, 0.995],
        colliders: { shape: 'box', halfExtents: [0.4, 0.2, 0.3], mass: 60 },
      },
      { position: [1.2, 0.2, 0], colliders: { shape: 'capsule', radius: 0.15, halfHeight: 0.3, axis: 'z', mass: 30 } },
      { position: [-1.2, 0.2, 0], colliders: { shape: 'cone', radius: 0.25, halfHeight: 0.3, mass: 12 } },
      { position: [0, 0.2, 1.2], colliders: { shape: 'cylinder', radius: 0.2, halfHeight: 0.3, mass: 25 } },
    ]);
  const one = run(),
    two = run();
  one.world.advance(120);
  two.world.advance(120);
  assert.equal(one.world.hash(), two.world.hash());
  const saved = one.world.takeSnapshot();
  one.world.advance(240);
  const later = one.world.hash();
  one.world.restoreSnapshot(saved.bytes).advance(240);
  assert.equal(one.world.hash(), later);
  for (const body of one.physics.getBodies()) assert.ok(body.position.every(Number.isFinite));
  one.physics[Symbol.dispose]();
  two.physics[Symbol.dispose]();
});

test('SEA-12 floating() refuses what has no closed volume, naming the fix', () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  const ground = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'heightfield', rows: 2, columns: 2, heights: new Array(9).fill(0), scale: [1, 1, 1] },
  });
  const rounded = physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], borderRadius: 0.05 },
  });
  const sensor = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, sensor: true } });
  for (const [body, words] of [
    [ground, /no closed volume/],
    [rounded, /rounded collider/],
    [sensor, /no solid collider/],
  ])
    assert.throws(
      () => floating(physics, body),
      (error) => error.code === 'unsupported' && words.test(error.message),
    );
  const other = new Physics(null, { fixedTimestep: 1 / 60 });
  assert.throws(() => floating(physics, other.addBody(null, { colliders: { shape: 'sphere', radius: 1 } })), {
    code: 'unsupported',
  });
  const loads = new LoadSolver();
  assert.throws(
    () =>
      new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(new RigidSolver(), { physics })
        .add(loads, { sea: water(), bodies: [{ row: 0, shape: { box: [1, 1, 1] }, rotation: [0, 0, 0, 2] }] }),
    { code: 'unsupported' },
  );
  assert.throws(() => loads.bodyLoad(5), { code: 'unsupported' });
  physics[Symbol.dispose]();
  other[Symbol.dispose]();
});

function boxTriangles([x, y, z]) {
  const vertices = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  ];
  return { vertices, indices };
}
