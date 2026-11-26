// Hydrodynamic loads on bodies (SEA-12): Morison's coefficients follow DNV-RP-C205; Lamb's ellipsoid integrals give its
// added-mass tables; a pile's wave loads, a sphere's terminal speed and a cylinder's vortex shedding match their worked numbers;
// bodies held by the load solver accelerate with their added mass, sink at their terminal speed, float at their displacement
// and drift at the leeway of their windage; a fixed pile sheds vortices at St U / D; a quay wall's pressures are Sainflou's
// and Goda's; a thruster's wash on the bed is PIANC's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import {
  LoadSolver,
  QuayWall,
  cylinderAddedMass,
  cylinderCoefficients,
  ellipsoidAddedMass,
  ellipsoidAlphas,
  equivalentEllipsoid,
  goda,
  liftMagnification,
  morison,
  reynoldsDrag,
  sainflou,
  SEA_WATER_VISCOSITY,
  sheddingFrequency,
  sphereDrag,
  standingWave,
  steadyDrag,
  tangentialDrag,
  thrusterEfflux,
  wakeAmplification,
  washOnBed,
} from '../dist/loads.js';
import { FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../dist/world.js';

await Physics.load();
const near = (a, b, t) => Math.abs(a / b - 1) <= t;

test("Morison's coefficients follow DNV-RP-C205: C_DS by roughness, psi(KC), C_A(KC), Eames's tangential drag", () => {
  assert.equal(steadyDrag(0), 0.65);
  assert.equal(steadyDrag(0.05), 1.05);
  assert.ok(Math.abs(steadyDrag(1e-3) - 0.85) < 1e-12);
  // The research's table: smooth KC 0.5, 1, 5, 10: C_D 0.518, 0.193, 0.388, 0.713; rough KC 10 1.329; k/D 1e-3 KC 10 1.021.
  for (const [kc, k, cd] of [
    [0.5, 0, 0.518],
    [1, 0, 0.193],
    [5, 0, 0.388],
    [10, 0, 0.713],
    [10, 0.05, 1.329],
    [10, 1e-3, 1.021],
  ])
    assert.ok(Math.abs(cylinderCoefficients(kc, k).drag - cd) < 1e-3, `KC ${kc}, k/D ${k}`);
  assert.equal(cylinderAddedMass(2), 1);
  assert.ok(Math.abs(cylinderAddedMass(10) - 0.692) < 1e-3 && Math.abs(cylinderAddedMass(20, 1.05) - 0.252) < 1e-3);
  assert.ok(Math.abs(cylinderAddedMass(20) - 0.6) < 1e-12);
  assert.ok(Math.abs(wakeAmplification(12, 0.65) - wakeAmplification(11.999999, 0.65)) < 1e-5, 'continuous at KC 12');
  // A current above 0.4 of the waves' velocity: the steady drag alone.
  assert.equal(cylinderCoefficients(10, 0, 1, 1).drag, 0.65);
  // Eames: 0.0487 at 45 degrees, 0.0146 at 80 (of C_Dn 1).
  const at = (deg) => tangentialDrag(1, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180));
  assert.ok(Math.abs(at(45) - 0.0487) < 1e-4 && Math.abs(at(80) - 0.0146) < 1e-4);
});

test("Lamb's ellipsoid integrals give DNV's added-mass table; a mesh's equivalent ellipsoid has its moments", () => {
  const sphere = ellipsoidAddedMass([1, 1, 1]);
  for (const c of sphere) assert.ok(Math.abs(c - 0.5) < 1e-6);
  const [along2, across2] = ellipsoidAddedMass([2, 1, 1]),
    [along8, across8] = ellipsoidAddedMass([8, 1, 1]);
  assert.ok(Math.abs(along2 - 0.21) < 1e-3 && Math.abs(across2 - 0.704) < 1e-3, `${along2} ${across2}`);
  assert.ok(Math.abs(along8 - 0.029) < 1e-3 && Math.abs(across8 - 0.945) < 1e-3, `${along8} ${across8}`);
  const alphas = ellipsoidAlphas([3, 2, 0.5]);
  assert.ok(Math.abs(alphas[0] + alphas[1] + alphas[2] - 2) < 1e-6, 'the alphas sum to 2');
  // A box 2 by 4 by 6 turned 30 degrees about y: its ellipsoid has semi-axes sqrt(5/3) of the half extents, along its sides.
  const box = boxMesh([2, 4, 6]),
    c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6),
    turned = { indices: box.indices, vertices: box.vertices.map((v, i) => v) },
    v = turned.vertices;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i],
      z = v[i + 2];
    v[i] = c * x + s * z + 5;
    v[i + 2] = -s * x + c * z;
  }
  const e = equivalentEllipsoid(turned),
    sorted = [...e.axes].sort((a, b) => a - b);
  assert.ok(Math.abs(e.volume - 48) < 1e-9 && Math.abs(e.centre[0] - 5) < 1e-9);
  for (const [got, want] of [
    [sorted[0], Math.sqrt(5 / 3)],
    [sorted[1], 2 * Math.sqrt(5 / 3)],
    [sorted[2], 3 * Math.sqrt(5 / 3)],
  ])
    assert.ok(Math.abs(got - want) < 1e-9, `${got} against ${want}`);
  const longest = e.directions[e.axes.indexOf(sorted[2])];
  assert.ok(Math.abs(Math.abs(longest[0] * s + longest[2] * c) - 1) < 1e-9, `the long axis ${longest}`);
});

test("a pile's wave load, a sphere's drag and a cylinder's shedding match their worked numbers", () => {
  // A 1 m pile at still water in a 2 m, 8 s wave in 20 m: u_m 0.884 m/s, a_m 0.694 m/s^2, KC 7.07: inertia 1,018 N/m, drag
  // 209 N/m.
  const { drag, addedMass } = cylinderCoefficients(7.07, 0),
    inertia = morison(1025.9, 1, drag, addedMass, 0, 0.694),
    dragOnly = morison(1025.9, 1, drag, addedMass, 0.884, 0);
  assert.ok(near(inertia, 1018, 0.01) && near(dragOnly, 209, 0.01), `${inertia} ${dragOnly}`);
  // Morrison's sphere: 24.67 at Re 1, 0.4841 at 1e3, 0.1415 at 1e6.
  assert.ok(
    near(sphereDrag(1), 24.67, 1e-3) && near(sphereDrag(1e3), 0.4841, 1e-3) && near(sphereDrag(1e6), 0.1415, 1e-3),
  );
  assert.ok(Math.abs(sheddingFrequency(1, 0.1) - 2) < 1e-12);
  // Facchinetti's lift magnification at A / eps = 40: 1, 1.521, 1.904, 2.309, 2.837.
  for (const [y, k] of [
    [0, 1],
    [0.1, 1.521],
    [0.25, 1.904],
    [0.5, 2.309],
    [1, 2.837],
  ])
    assert.ok(Math.abs(liftMagnification(y) - k) < 1e-3, `${y}: ${liftMagnification(y)}`);
});

test("a quay wall stands Sainflou's and Goda's pressures; a thruster's wash on its bed is PIANC's", () => {
  // H 1 m, T 6 s, 10 m of water, rho 1025.9: k 0.1298; the wall's pressures 10,060 and 5,115 Pa; force 66,770 N/m.
  const w = standingWave(1, 6, 10, { density: 1025.9, gravity: 9.81 });
  assert.ok(
    Math.abs(w.wavenumber - 0.1298) < 1e-4 && near(w.pressure(0), 10060, 2e-3) && near(w.pressure(-10), 5115, 2e-3),
  );
  assert.ok(near(w.force, 66770, 2e-3));
  const s = sainflou(1, 6, 10, { density: 1025.9, gravity: 9.81 });
  assert.ok(
    Math.abs(s.rise - 0.0754) < 1e-4 && near(s.p1, 10270, 2e-3) && near(s.p2, 5115, 2e-3) && near(s.p3, 9306, 2e-3),
  );
  const gd = goda(1, 6, 10, { density: 1025.9, gravity: 9.81 });
  assert.ok(Math.abs(gd.alpha1 - 0.6758) < 1e-4 && Math.abs(gd.alpha3 - 0.5082) < 1e-4 && near(gd.p1, 6801, 2e-3));
  assert.ok(near(gd.force, 56390, 2e-3));
  // A 1 MW thruster through a 2 m tunnel: V_0 7.175 m/s; on the bed 10 m off a quay, axis 3 m up: 3.091 m/s.
  const v0 = thrusterEfflux(1e6, 2, 1025.9);
  assert.ok(Math.abs(v0 - 7.175) < 2e-3 && Math.abs(washOnBed(v0, 2, 10, 3) - 3.091) < 2e-3);
});

test('a quay wall doubles the incident wave at its face, splashes over where it tops the edge, and feels the wash driven at it', () => {
  // A wall along z at x = 0 walked from z = 10 to -10, its water on its left (+x): an incident surface rising toward its north
  // end, a race driving at the face (-x) on its northern half.
  const wall = new QuayWall({ from: [0, 10], to: [0, -10], freeboard: 1, points: 20 }),
    incident = { elevation: (_x, z) => 0.3 + 0.03 * (10 - z) },
    race = { sample: (_x, _y, z) => ({ velocity: [z > 0 ? -2 : 0, 0, 0] }) },
    points = wall.sample(0, incident, race);
  assert.equal(points.length, 20);
  for (const p of points) {
    assert.ok(
      Math.abs(p.height - 2 * incident.elevation(0, p.position[1])) < 1e-12,
      'the standing wave doubles at the face',
    );
    assert.equal(p.over, p.height > 1);
    assert.equal(p.wash, p.position[1] > 0 ? 2 : 0);
  }
  assert.ok(points.some((p) => p.over) && points.some((p) => !p.over));
  // A wall that takes half: 1 + R.
  assert.ok(
    Math.abs(
      new QuayWall({ from: [0, 1], to: [0, -1], freeboard: 2, reflection: 0.5 }).sample(0, incident)[0].height /
        incident.elevation(0, 0.97) -
        1.5,
    ) < 0.01,
  );
  assert.throws(() => new QuayWall({ from: [0, 0], to: [0, 0], freeboard: 1 }), /two different points/);
});

/** A still sea (or one with a uniform current), with the Physics world it loads. */
function still(current = [0, 0, 0], elevation = () => 0) {
  return {
    cell: [0, 0, 0],
    density: 1025.9,
    elevation,
    pressure: () => 0,
    sample: () => ({
      height: 0,
      normal: [0, 1, 0],
      velocity: [...current],
      current: [...current],
      depth: 1e6,
      density: 1025.9,
    }),
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        out.velocity[0] = current[0];
        out.velocity[1] = current[1];
        out.velocity[2] = current[2];
        out.density = 1025.9;
        out.temperature = 288;
        return out;
      },
    },
  };
}

function world(sea, bodies, members = [], extra = {}, gravity = [0, -9.81, 0]) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity }),
    made = bodies.map((b) =>
      physics.addBody(null, {
        position: b.position ?? [0, -5, 0],
        rotation: b.rotation,
        linearDamping: b.damping,
        angularDamping: b.damping,
        colliders: b.collider,
        linearVelocity: b.velocity ?? [0, 0, 0],
      }),
    ),
    loads = new LoadSolver(),
    w = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity })
      .add(new RigidSolver(), { physics })
      .add(loads, {
        sea,
        bodies: bodies.map((b, i) => ({ row: made[i].row, ...b.load })),
        members: members.map((m) => ({ ...m, row: m.on === undefined ? undefined : made[m.on].row })),
        ...extra,
      })
      .couple(['loads', 'rigid'], 'staggered');
  return { physics, bodies: made, loads, world: w };
}

test('SEA-12 a heeled box and triangle mesh return the exact displaced volume and righting moment', () => {
  const [length, height, beam] = [3, 1, 1.8];
  const draft = 0.3;
  const [a, b] = [height / 2, beam / 2];
  const density = 1025.9;
  const gravity = 7.6;
  const probe = (theta, shape) => {
    const worldY = a - draft;
    const {
      bodies,
      loads,
      world: simulation,
    } = world(
      still(),
      [
        {
          position: [3, worldY, -2],
          rotation: [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)],
          collider: { shape: 'box', halfExtents: [length / 2, a, b], mass: density * draft * length * beam },
          load: { shape, drag: 0, addedMass: [0, 0, 0] },
        },
      ],
      [],
      {},
      [0, -gravity, 0],
    );
    simulation.advance(1);
    const { region } = loads.exportPorts(0)[0];
    const row = regionWords(simulation.arena.memory, region);
    const i = bodies[0].row * FORCE_WORDS;
    return [row[i + 1], row[i + 3]];
  };
  const mesh = boxMesh([length, height, beam]);
  const shapes = [{ box: [length / 2, a, b] }, { mesh }];
  const tolerance = 32 * 2 ** -23; // The rigid field carries the pose in float32.
  for (const shape of shapes) {
    // The mean waterline does not cross the top or the keel for these exact trapezoid sections.
    for (const heel of [-0.25, -0.1, 0.1, 0.25]) {
      const cosine = Math.cos(heel);
      const sine = Math.sin(heel);
      const heightAtCentre = (draft - a) / cosine;
      const slope = sine / cosine;
      const immersedHeight = a + heightAtCentre;
      const displaced = length * beam * immersedHeight;
      const centreZ = (slope * b * b) / (3 * immersedHeight);
      const centreY = (heightAtCentre * heightAtCentre + (slope * slope * b * b) / 3 - a * a) / (2 * immersedHeight);
      const expectedForce = density * gravity * displaced;
      const expectedMoment = -expectedForce * (centreY * sine + centreZ * cosine);
      const [force, moment] = probe(heel, shape);
      assert.ok(near(force, expectedForce, tolerance), `${force} N vs ${expectedForce} N at ${heel} rad`);
      assert.ok(near(moment, expectedMoment, tolerance), `${moment} N·m vs ${expectedMoment} N·m`);
      assert.ok(moment * heel < 0, 'buoyancy opposes the heel');
    }

    // Infinitesimal metacentric limit, independent of the finite-angle trapezoid calculation.
    const heel = 0.001;
    const bm = (beam * beam) / (12 * draft);
    const gm = bm + draft / 2 - a;
    const [force, moment] = probe(heel, shape);
    const gmMeasured = -moment / (force * Math.sin(heel));
    assert.ok(near(gmMeasured, gm, 5e-6), `${gmMeasured} m GM vs ${gm} m`);
  }
});

test('SEA-12 surface pressure integrates horizontal force and moment across a submerged box', () => {
  const rho = 1025.9;
  const g = 9.81;
  const acceleration = 2;
  const shear = 900;
  const halfExtents = [2, 1, 0.5];
  const volume = 8 * halfExtents[0] * halfExtents[1] * halfExtents[2];
  const sea = still();
  sea.pressure = (x, y, z) => -rho * g * y - rho * acceleration * x - shear * (y + 4) * z;
  sea.water.sample = (_x, _y, _z, t) => ({ velocity: [acceleration * t, 0, 0], density: rho, temperature: 288 });
  const {
    bodies,
    loads,
    world: simulation,
  } = world(sea, [
    {
      position: [0, -4, 0],
      collider: { shape: 'box', halfExtents, mass: 4000 },
      load: { shape: { box: halfExtents }, drag: 0, addedMass: [0, 0, 0], pressureModel: 'surface' },
    },
  ]);
  simulation.advance(1);
  const forces = regionWords(simulation.arena.memory, loads.exportPorts(0)[0].region);
  const at = bodies[0].row * FORCE_WORDS;
  // With -grad(p) over the volume, the incident acceleration is counted once.
  // Integral of (dy² - z²) over the box gives the roll moment of the cross term.
  const exact = [
    rho * acceleration * volume,
    rho * g * volume,
    0,
    (shear * volume * (halfExtents[1] ** 2 - halfExtents[2] ** 2)) / 3,
    0,
    0,
  ];
  const tolerance = 256 * Number.EPSILON * exact[1];
  for (const [index, expected] of exact.entries())
    assert.ok(
      Math.abs(forces[at + index] - expected) < tolerance,
      `row ${index}: ${forces[at + index]} vs ${expected}`,
    );
});

test('SEA-12 a sloping waterline applies mesh pressure when the body centre is dry', () => {
  const rho = 1025.9;
  const gravity = 9.81;
  const elevation = (x) => x;
  const sea = still([0, 0, 0], elevation);
  sea.pressure = (x, y) => rho * gravity * Math.max(0, x - y);
  const halfExtents = [1, 0.5, 0.5];
  const {
    bodies,
    loads,
    world: simulation,
  } = world(sea, [
    {
      position: [0, 0.75, 0],
      collider: { shape: 'box', halfExtents, mass: 100 },
      load: { shape: { box: halfExtents }, drag: 0, addedMass: [0, 0, 0], pressureModel: 'surface' },
    },
  ]);
  simulation.advance(1);
  const at = bodies[0].row * FORCE_WORDS;
  const row = regionWords(simulation.arena.memory, loads.exportPorts(0)[0].region);
  // The wet section is a triangle of leg 0.75, extruded through a 1 m span.
  const load = (rho * gravity * 0.75 ** 2) / 2;
  assert.ok(near(row[at], -load, 1e-12));
  assert.ok(near(row[at + 1], load, 1e-12));
  const centre = [0.75, -0.25];
  assert.ok(near(row[at + 5], (centre[0] + centre[1]) * load, 1e-12));
});

test('SEA-12 an inclined ellipsoid takes buoyancy through the transformed half-cap centroid', () => {
  const axes = [1.1, 0.3, 0.8];
  const heel = 0.37;
  const [a, b, c] = axes;
  const {
    bodies,
    loads,
    world: simulation,
  } = world(still(), [
    {
      position: [0, 0, 0],
      rotation: [Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)],
      collider: { shape: 'box', halfExtents: axes, mass: 1000 },
      load: { shape: { ellipsoid: axes }, drag: 0, addedMass: [0, 0, 0] },
    },
  ]);
  simulation.advance(1);
  const { region } = loads.exportPorts(0)[0];
  const forces = regionWords(simulation.arena.memory, region);
  const i = FORCE_WORDS * bodies[0].row;
  const expectedForce = 1025.9 * 9.81 * (2 / 3) * Math.PI * a * b * c;
  const cosine = Math.cos(heel);
  const sine = Math.sin(heel);
  const halfHeight = Math.hypot(b * cosine, c * sine);
  const armZ = (-3 / 8) * (((b * b - c * c) * sine * cosine) / halfHeight);
  assert.ok(near(forces[i + 1], expectedForce, 2 ** -21));
  assert.ok(near(forces[i + 3], -expectedForce * armZ, 2 ** -19));
});

test('SEA-12 a free rectangular float settles at the independently measured substantial heel', (t) => {
  // Hori and Hori (2023), §4.6. The float's dimensions and weight are inputs. The reported relative
  // density 0.458 implies a different weight at nominal freshwater density, so run both input cases.
  const halfExtents = [0.15, 0.05, 0.0575];
  const density = 1000;
  const g = 9.80665;
  const volume = 8 * halfExtents[0] * halfExtents[1] * halfExtents[2];
  const reference = 27.5;
  // The 2× Fig. 4.6 raster top edge spans about 187 px. A one-pixel coordinate reading error
  // per endpoint moves its direction by at most asin(2√2 / 187), plus half the printed tenth.
  const angularResolution = (Math.asin((2 * Math.SQRT2) / 187) * 180) / Math.PI + 0.05;
  const final = [];
  for (const mass of [18.09 / g, 0.458 * volume * density]) {
    for (const initialHeel of [12, 39]) {
      const halfAngle = (initialHeel * Math.PI) / 360;
      const { bodies, world: simulation } = world(
        { ...still(), density },
        [
          {
            position: [0, halfExtents[1] - mass / (density * 0.3 * 0.115), 0],
            rotation: [Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)],
            // Rigid damping only shortens settling. At rest it exerts no force or torque.
            damping: 4,
            collider: { shape: 'box', halfExtents, mass },
            load: { shape: { box: halfExtents }, drag: 0, addedMass: [0, 0, 0] },
          },
        ],
        [],
        {},
        [0, -g, 0],
      );
      simulation.advance(600);
      const body = bodies[0];
      assert.ok(Math.abs(body.angularVelocity[0]) < 1e-5);
      const [x, , , w] = body.rotation;
      const heel = (2 * Math.atan2(x, w) * 180) / Math.PI;
      assert.ok(Math.abs(heel - reference) <= angularResolution, `${heel}° vs ${reference}° ±${angularResolution}°`);
      final.push(heel.toFixed(4));
    }
  }
  t.diagnostic(`Final heel under the two reported load inputs: ${final.join(', ')}° vs photographed ${reference}°.`);
});

test('SEA-12 an open mesh or invalid triangle index produces an actionable coded error', () => {
  const mesh = boxMesh([1, 1, 1]);
  const code = { name: 'MargoError', code: 'unsupported' };
  assert.throws(() => equivalentEllipsoid({ ...mesh, indices: mesh.indices.slice(3) }), {
    ...code,
    message: /close the mesh.+#hydrodynamic-loads/,
  });
  const indices = mesh.indices.slice();
  indices[0] = mesh.vertices.length / 3;
  assert.throws(() => equivalentEllipsoid({ ...mesh, indices }), {
    ...code,
    message: /integer indices into the vertex array.+#hydrodynamic-loads/,
  });
});

test("a light sphere in water gathering speed is carried at (1 + C_A) / (m / (rho V) + C_A) of the water's acceleration", () => {
  // No gravity, drag off: water accelerating at 1 m/s^2 drives a sphere of a fifth of its displaced mass by its pressure
  // gradient (rho V a) and its added mass (rho C_A V a): (1 + 0.5) / (0.2 + 0.5) = 2.143 m/s^2; one as dense as the water at 1.
  const accelerating = (t) => [t, 0, 0],
    sea = {
      ...still(),
      water: {
        medium: 'water',
        cell: [0, 0, 0],
        sample: (_x, _y, _z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
          const v = accelerating(t);
          out.velocity[0] = v[0];
          out.velocity[1] = v[1];
          out.velocity[2] = v[2];
          out.density = 1025.9;
          out.temperature = 288;
          return out;
        },
      },
    },
    r = 0.1,
    volume = (4 / 3) * Math.PI * r ** 3;
  for (const [share, expected] of [
    [0.2, 1.5 / 0.7],
    [1, 1],
  ]) {
    const { bodies, world: w } = world(
      sea,
      [
        {
          collider: { shape: 'sphere', radius: r, mass: share * 1025.9 * volume },
          load: { shape: { sphere: r }, drag: 0 },
        },
      ],
      [],
      {},
      [0, 0, 0],
    );
    w.advance(60);
    assert.ok(
      Math.abs(bodies[0].linearVelocity[0] / expected - 1) < 0.02,
      `${bodies[0].linearVelocity[0]} against ${expected}`,
    );
  }
});

test('a steel ball sinks at its terminal speed; a crate floats at its displacement and drifts at its leeway', () => {
  // A 10 mm steel ball in water: 1.512 m/s at Re 1.51e4, C_D 0.393 (fresh water at 20 degrees: rho 998.2, nu 1e-6).
  const fresh = { ...still(), density: 998.2 },
    r = 0.005,
    ball = world(
      fresh,
      [
        {
          position: [0, -20, 0],
          collider: { shape: 'sphere', radius: r, mass: 7850 * (4 / 3) * Math.PI * r ** 3 },
          load: { shape: { sphere: r } },
        },
      ],
      [],
      { viscosity: 1e-6 },
    );
  ball.world.advance(60 * 3);
  assert.ok(near(-ball.bodies[0].linearVelocity[1], 1.512, 0.02), `${ball.bodies[0].linearVelocity[1]}`);
  // A box crate 2 by 1 by 1 m of 600 kg/m^3 settles 0.6 of its height under; a 10 m/s wind drifts it at a couple of percent.
  const crate = world(
    still(),
    [
      {
        position: [0, 0, 0],
        collider: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1200 },
        load: { shape: { box: [1, 0.5, 0.5] } },
      },
    ],
    [],
    {
      wind: {
        medium: 'air',
        cell: [0, 0, 0],
        sample: (_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
          out.velocity[0] = 0;
          out.velocity[1] = 0;
          out.velocity[2] = 10;
          out.density = 1.226;
          out.temperature = 288;
          return out;
        },
      },
    },
  );
  crate.world.advance(60 * 120);
  const drift = crate.bodies[0].linearVelocity[2];
  assert.ok(drift > 0.05 && drift < 0.4, `drift ${drift} m/s in a 10 m/s wind`);
  assert.ok(Math.abs(crate.bodies[0].position[1]) < 0.5, 'afloat');
});

test('SEA-12 member force integrates a 7.5 cm wetted length in either endpoint order', () => {
  const sea = still([0.4, 0, 0]);
  const from = [0, -0.075, 0];
  const to = [0, 1.925, 0];
  const diameter = 0.08;
  const member = { from, to, diameter, period: Infinity, roughness: 0 };
  const { loads, world: simulation } = world(sea, [], [member, { ...member, from: to, to: from }]);
  simulation.advance(1);
  const drag = reynoldsDrag((0.4 * diameter) / SEA_WATER_VISCOSITY, 0);
  const exact = 0.5 * sea.density * drag * diameter * 0.4 ** 2 * 0.075;
  for (const index of [0, 1]) assert.ok(near(loads.memberLoad(index).force[0], exact, 128 * Number.EPSILON));
});

test('SEA-12 a harmonically loaded member keeps one peak Keulegan–Carpenter number across phases', () => {
  let time = 0;
  const sea = still([0, 0, 0], (_x, _z, t) => {
    time = t;
    return 0;
  });
  const peak = 0.36;
  const period = 2;
  const diameter = 0.08;
  const omega = (2 * Math.PI) / period;
  sea.water.sample = (_x, _y, _z, t) => ({ velocity: [peak * Math.cos(omega * t), 0, 0], density: sea.density });
  const { loads, world: simulation } = world(
    sea,
    [],
    [{ from: [0, -3, 0], to: [0, -1, 0], diameter, period, roughness: 0 }],
  );
  const coefficients = cylinderCoefficients(
    (peak * period) / diameter,
    0,
    0,
    peak,
    (peak * diameter) / SEA_WATER_VISCOSITY,
  );
  const inertiaMax = sea.density * ((Math.PI * diameter ** 2) / 4) * (1 + coefficients.addedMass) * peak * omega;
  // The central derivative's relative truncation error is at most (omega * h)^2/6.
  const tolerance = 2 * inertiaMax * ((omega * 0.001) ** 2 / 6 + 128 * Number.EPSILON);
  for (const tick of [1, 15, 30, 45, 60, 80, 105, 120]) {
    simulation.advance(tick);
    const velocity = peak * Math.cos(omega * time);
    const acceleration = -omega * peak * Math.sin(omega * time);
    const exact = 2 * morison(sea.density, diameter, coefficients.drag, coefficients.addedMass, velocity, acceleration);
    const force = loads.memberLoad(0).force[0];
    assert.ok(Math.abs(force - exact) <= tolerance, `tick ${tick}: ${force} N vs ${exact} N`);
  }
});

test('SEA-12 smooth cylinders predict the held-out Sarpkaya 1976 force coefficients and measured peak', (t) => {
  // Appendix A, printed p.160, all runs inside the untapered KC overlap. Neither
  // this diameter nor any of these responses was used to construct the interpolation.
  // Rows: KC, measured CM, CD, peak CF and lambda* (%) from the load cell.
  const measured = [
    [7.18, 1.86, 1.03, 2.75, 9],
    [7.66, 1.78, 1.14, 2.59, 10],
    [8.33, 1.82, 1.04, 2.38, 10],
    [8.77, 1.74, 1.11, 2.26, 13],
    [9.36, 1.75, 1.05, 2.13, 12],
    [9.88, 1.7, 1.07, 1.99, 11],
    [10.66, 1.62, 1.04, 1.9, 9],
    [11.34, 1.66, 1.05, 1.73, 7],
    [12.06, 1.71, 0.98, 1.66, 10],
    [12.94, 1.66, 0.99, 1.5, 6],
  ];
  // Maximum calibration-cylinder span over the overlap is 0.6125 in CM and
  // 0.4465 in CD, at KC=11.95. Interpolate between the two measured beta values.
  // At KC=13.6 two calibration sweeps at beta=5260 differ by 0.07 and 0.08.
  // Add half of the table's last printed decimal place.
  const fraction = (4480 - 3123) / (5260 - 3123);
  const massBound = 0.6125 * fraction + 0.07 + 0.005;
  const dragBound = 0.4465 * fraction + 0.08 + 0.005;
  const period = 5;
  const steps = 60 * period;
  const diameter = 5.975 * 0.0254;
  const viscosity = (diameter * diameter) / (4480 * period);
  const omega = (2 * Math.PI) / period;
  let massError = 0;
  let dragError = 0;
  let dnvMassError = 0;
  let dnvDragError = 0;
  let peakError = 0;
  for (const [kc, measuredMass, measuredDrag, measuredPeak, peakResidual] of measured) {
    let time = 0;
    const sea = still([0, 0, 0], (_x, _z, t) => {
      time = t;
      return 0;
    });
    const speed = (kc * diameter) / period;
    sea.water.sample = (_x, _y, _z, t) => ({ velocity: [speed * Math.cos(omega * t), 0, 0], density: sea.density });
    const { loads, world: simulation } = world(
      sea,
      [],
      [{ from: [0, -2, 0], to: [0, -1, 0], diameter, coefficients: 'sarpkaya-1976', period }],
      { viscosity },
    );
    const forceScale = (sea.density * diameter * speed * speed) / 2;
    const inertiaScale = (Math.PI * Math.PI) / kc;
    let cmProjection = 0;
    let cmNorm = 0;
    let cdProjection = 0;
    let cdNorm = 0;
    let peak = 0;
    for (let tick = 1; tick <= steps; tick++) {
      simulation.advance(tick);
      const phase = omega * time;
      const inertiaBasis = -inertiaScale * Math.sin(phase);
      const dragBasis = Math.cos(phase) * Math.abs(Math.cos(phase));
      const force = loads.memberLoad(0).force[0] / forceScale;
      cmProjection += force * inertiaBasis;
      cmNorm += inertiaBasis * inertiaBasis;
      cdProjection += force * dragBasis;
      cdNorm += dragBasis * dragBasis;
      peak = Math.max(peak, Math.abs(force));
    }
    const cm = cmProjection / cmNorm;
    const cd = cdProjection / cdNorm;
    const dm = Math.abs(cm - measuredMass);
    const dd = Math.abs(cd - measuredDrag);
    assert.ok(dm <= massBound && dd <= dragBound, `KC ${kc}: C_M ${cm} and C_D ${cd}`);
    // Add the published Eq. (16) peak residual of the measured Morison fit,
    // the rounding of CF and lambda*, and the finite phase sampling error.
    const phaseBound = ((cm * inertiaScale + 2 * cd) * Math.PI) / steps;
    const peakBound =
      inertiaScale * massBound + dragBound + (measuredPeak * (peakResidual + 0.5)) / 100 + 0.005 + phaseBound;
    assert.ok(Math.abs(peak - measuredPeak) <= peakBound, `KC ${kc}: peak ${peak} vs ${measuredPeak}`);
    peakError = Math.max(peakError, Math.abs(peak - measuredPeak));
    const dnv = cylinderCoefficients(kc, 0, 0, speed, 4480 * kc);
    massError += dm;
    dragError += dd;
    dnvMassError += Math.abs(1 + dnv.addedMass - measuredMass);
    dnvDragError += Math.abs(dnv.drag - measuredDrag);
  }
  t.diagnostic(
    `Mean absolute coefficient errors (${measured.length} runs): C_M ${(massError / measured.length).toFixed(3)} vs ${(dnvMassError / measured.length).toFixed(3)} DNV, C_D ${(dragError / measured.length).toFixed(3)} vs ${(dnvDragError / measured.length).toFixed(3)} DNV. Maximum peak C_F error ${peakError.toFixed(3)}.`,
  );
  // This separately selectable calibration improves inline drag. The diagnostic also
  // reports the higher inertia error against DNV for the same held-out cylinder.
  assert.ok(dragError < dnvDragError);
});

test('a fixed pile in a 1 m/s current sheds vortices at St U / D: its lift swings at 2 Hz with C_L0 0.3', () => {
  const { loads, world: w } = world(
    still([1, 0, 0]),
    [],
    [{ from: [0, -5, 0], to: [0, -1, 0], diameter: 0.1, vortex: {} }],
  );
  const lifts = [];
  for (let t = 1; t <= 60 * 10; t++) {
    w.advance(t);
    lifts.push(loads.memberLoad(0).lift);
  }
  const tail = lifts.slice(60 * 5),
    top = Math.max(...tail),
    crossings = tail.filter((v, i) => i > 0 && tail[i - 1] < 0 && v >= 0).length;
  // The free wake cycle: q to 2, so C_L reaches C_L0 = 0.3; about 10 cycles in 5 s.
  assert.ok(Math.abs(top - 0.3) < 0.02, `C_L ${top}`);
  assert.ok(Math.abs(crossings - 10) <= 1, `${crossings} cycles`);
  // The drag holds the pile against the current: 1/2 rho C_D D U^2 over its 4 m.
  const fx = loads.memberLoad(0).force[0];
  assert.ok(fx > 0.5 * 1025.9 * 0.6 * 0.1 * 4 && fx < 0.5 * 1025.9 * 1.3 * 0.1 * 4, `${fx}`);
});

test('the load solver refuses what it cannot be made from, naming the fix', () => {
  assert.throws(() => world(undefined, []), /pass \{sea\}/);
  assert.throws(
    () => world(still(), [{ collider: { shape: 'sphere', radius: 1, mass: 1 }, load: { shape: { sphere: -1 } } }]),
    /radius/,
  );
  assert.throws(() => world(still(), [], [{ from: [0, 0, 0], to: [1, 0, 0], diameter: 0 }]), /diameter/);
  assert.throws(() => steadyDrag(-1), /roughness/);
  assert.throws(() => goda(0, 6, 10), /height/);
});

/** A box hull of `size` (x, y, z) about its centre, each face a 2 by 2 grid, wound outward. */
function boxMesh([sx, sy, sz]) {
  const h = [sx / 2, sy / 2, sz / 2],
    vertices = [],
    indices = [],
    n = 2;
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis),
      first = vertices.length / 3;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0];
        p[axis] = sign * h[axis];
        p[u] = -h[u] + (2 * h[u] * i) / n;
        p[v] = -h[v] + (2 * h[v] * j) / n;
        vertices.push(...p);
      }
    const at = (i, j) => first + i * (n + 1) + j;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          const p = t.map((k) => vertices.slice(3 * k, 3 * k + 3)),
            e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]),
            e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]),
            nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          indices.push(...(nrm[axis] * sign > 0 ? t : [t[0], t[2], t[1]]));
        }
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}
