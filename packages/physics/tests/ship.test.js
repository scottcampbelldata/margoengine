// Ships under way (SEA-09): the ITTC-1957 line and Holtrop and Mennen's resistance reproduce their worked example; a
// propeller's open-water curves, its four quadrants and its race keep momentum theory; the race's velocity field follows
// Hamill and Kee's zones; the MMG standard method turns and zig-zags KVLCC2 as Yasukawa and Yoshimura's simulation does; squat
// gives the published worked case; a tunnel thruster keeps its momentum bound; a rigid body held by the ship solver follows the
// MMG ship, sinks by its squat in shallow water through the HullSolver, feels a quay, makes wake sources and boils its race up
// for the foam.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { WakeSolver } from '../dist/sea.js';
import { HullSolver } from '../dist/seakeeping.js';
import {
  KVLCC2_L7,
  KVLCC2_PROPELLER,
  Manoeuvring,
  Propeller,
  ShipSolver,
  holtropMennen,
  huuska,
  icorels,
  ittc1957,
  raceVelocity,
  rudderLiftSlope,
  scaleModel,
  squat,
  thrusterThrust,
} from '../dist/ship.js';
import { PhysicsWorld, RigidSolver } from '../dist/world.js';

await Physics.load();
const DEG = Math.PI / 180;
const near = (a, b, tolerance) => Math.abs(a / b - 1) <= tolerance;

test("the ITTC-1957 line and Holtrop and Mennen's worked example (205 m, 25 kn) to their printed figures", () => {
  assert.ok(Math.abs(ittc1957(1e7) - 0.003) < 1e-15);
  assert.ok(Math.abs(ittc1957(2.2187e9) - 0.0013898) < 1e-7);
  const r = holtropMennen(
    {
      length: 205,
      beam: 32,
      draughtFore: 10,
      draughtAft: 10,
      volume: 37500,
      lcb: -0.75,
      midship: 0.98,
      waterplane: 0.75,
      bulb: { area: 20, centre: 4 },
      transom: 16,
      appendages: [{ area: 50, factor: 1.5 }],
      stern: 10,
      propeller: { diameter: 8, blades: 4, clearance: 0.2 },
    },
    25 * 0.514444,
    { gravity: 9.81 },
  );
  // Holtrop and Mennen 1982, section 5: kN and coefficients as printed.
  for (const [got, printed, tolerance] of [
    [r.total / 1e3, 1793.26, 1e-3],
    [r.friction / 1e3, 869.63, 1e-3],
    [r.formFactor, 1.156, 1e-3],
    [r.appendages / 1e3, 8.83, 2e-3],
    [r.wave / 1e3, 557.11, 1e-3],
    [r.correlation / 1e3, 221.98, 1e-3],
    [r.wettedArea, 7381.45, 1e-5],
    [r.froude, 0.2868, 1e-3],
    [r.wake, 0.2584, 1e-3],
    [r.thrustDeduction, 0.1747, 1e-3],
    [r.bladeArea, 0.7393, 1e-3],
    [r.relativeRotative, 0.9931, 1e-3],
    [r.power / 1e3, 23063, 1e-3],
  ])
    assert.ok(near(got, printed, tolerance), `${got} against ${printed}`);
  assert.equal(r.transom, 0);
});

test("a propeller keeps its open-water curves, momentum theory's race and continuity through its four quadrants", () => {
  const D = 0.216,
    p = new Propeller(D, KVLCC2_PROPELLER),
    rho = 1000;
  // K_T vanishes at J = 0.768; eta_0 at J = 0.4 is 0.5115.
  assert.ok(Math.abs(p.zeroThrust - 0.768) < 1e-4);
  assert.ok(Math.abs(p.efficiency(0.4) - 0.5115) < 1e-4);
  const n = 10,
    at = p.load(n, 0.4 * n * D, rho);
  assert.ok(Math.abs(at.thrust - rho * n * n * D ** 4 * 0.16082) < 1e-9 * at.thrust);
  // The far wake: V_a sqrt(1 + 8 K_T / (pi J^2)); at bollard 1.596 n D sqrt(K_T) (Blaauw and van de Kaa's 1.59).
  assert.ok(Math.abs(at.race / (0.4 * n * D) - Math.sqrt(1 + (8 * 0.16082) / (Math.PI * 0.16))) < 1e-12);
  const bollard = p.load(n, 0, rho);
  assert.ok(Math.abs(bollard.race / (n * D * Math.sqrt(KVLCC2_PROPELLER.thrust[0])) - Math.sqrt(8 / Math.PI)) < 1e-12);
  // Continuous through bollard pull and zero thrust into the other quadrants; astern at bollard pushes back as hard.
  for (const j of [0, p.zeroThrust]) {
    const a = p.load(n, (j - 1e-7) * n * D, rho).thrust,
      b = p.load(n, (j + 1e-7) * n * D, rho).thrust;
    assert.ok(Math.abs(a - b) < 1e-4 * bollard.thrust, `a step at J = ${j}`);
  }
  assert.ok(Math.abs(p.load(-n, 0, rho).thrust + bollard.thrust) < 1e-9 * bollard.thrust);
  assert.ok(p.load(-n, 0.3 * n * D, rho).thrust < 0, 'astern under way still pulls astern');
  assert.ok(p.load(n, 2 * n * D, rho).thrust < 0, 'past zero thrust it brakes');
  assert.throws(() => new Propeller(0), /diameter/);
});

test("the race keeps Hamill and Kee's zones: V_0 to 0.35 D, joined at 3.25 D, Gaussian in r / X beyond", () => {
  const race = { position: [0, -2, 0], direction: [-1, 0, 0], diameter: 1, pitch: 1, efflux: 4, hub: 0.18 },
    ring = 0.67 * (0.5 - 0.09);
  assert.ok(Math.abs(raceVelocity(race, [-0.3, -2 + ring, 0])[0] + 4) < 1e-12, 'V_0 on the ring near the propeller');
  assert.deepEqual(raceVelocity(race, [0.5, -2, 0]), [0, 0, 0]);
  const inside = -raceVelocity(race, [-3.2499, -2, 0])[0],
    outside = -raceVelocity(race, [-3.2501, -2, 0])[0];
  // The zone's eq. 7 on its axis less its ring falls, against eq. 20: the axis speeds join within the published 3 percent at
  // the ring; on the axis the zone's profile has its centre's share.
  const ringInside = -raceVelocity(race, [-3.2499, -2 + ring, 0])[0];
  assert.ok(Math.abs(ringInside / outside - 0.481 / 0.493) < 0.03, `${ringInside} ${outside}`);
  assert.ok(inside < ringInside);
  const X = 8,
    axis = -raceVelocity(race, [-X, -2, 0])[0],
    off = -raceVelocity(race, [-X, -2 + 0.2 * X, 0])[0];
  assert.ok(Math.abs(off / axis - Math.exp(-22.2 * 0.04)) < 1e-12);
  assert.ok(Math.abs(rudderLiftSlope(1.827) - 2.747) < 1e-3);
});

test("KVLCC2 turns and zig-zags as Yasukawa and Yoshimura's MMG simulation does (L7 model, 15.5 kn full scale)", () => {
  const scale = 320 / 7,
    speed = (15.5 * 0.514444) / Math.sqrt(scale),
    rate = 1.76 * DEG * Math.sqrt(scale),
    ship = () => {
      const s = new Manoeuvring(KVLCC2_L7, { u: speed }, { rudderRate: rate });
      s.revolutions = s.selfPropulsion(speed);
      return s;
    },
    turn = (delta) => {
      const s = ship();
      s.order = delta * DEG;
      let advance, diameter;
      while (diameter === undefined) {
        s.step(0.02);
        const h = Math.abs(s.state.heading);
        if (advance === undefined && h >= Math.PI / 2) advance = s.state.x / 7;
        if (h >= Math.PI) diameter = Math.abs(s.state.z) / 7;
      }
      return [advance, diameter];
    },
    zigzag = (a) => {
      const s = ship(),
        A = a * DEG,
        out = [];
      s.order = A;
      let sign = 1,
        peak = 0;
      while (out.length < 2 && s.time < 600) {
        s.step(0.02);
        const h = s.state.heading;
        if (sign > 0 && h >= A && s.order > 0) {
          s.order = -A;
          peak = h;
        } else if (sign > 0 && s.order < 0) {
          if (h > peak) peak = h;
          else if (h < peak) {
            out.push((peak - A) / DEG);
            sign = -1;
            peak = h;
          }
        } else if (sign < 0 && h <= -A && s.order < 0) {
          s.order = A;
          peak = h;
        } else if (sign < 0 && s.order > 0) {
          if (h < peak) peak = h;
          else if (h > peak) {
            out.push((-A - peak) / DEG);
            sign = 1;
          }
        }
      }
      return out;
    };
  // Their table 4 (simulated): advance 3.31 L and tactical diameter 3.36 L at +35 degrees, 3.26 and 3.26 at -35. Ours used
  // R'_0 = 0.022 of the 3 m model (the 7 m model's extrapolated resistance is not printed): within 7 percent.
  const [a1, d1] = turn(35),
    [a2, d2] = turn(-35);
  for (const [got, printed] of [
    [a1, 3.31],
    [d1, 3.36],
    [a2, 3.26],
    [d2, 3.26],
  ])
    assert.ok(near(got, printed, 0.075), `${got} against ${printed}`);
  // Their table 5: 10/10 overshoots 5.2 and 15.8 degrees, 20/20 first 10.9.
  const [first10, second10] = zigzag(10),
    [first20] = zigzag(20);
  assert.ok(
    near(first10, 5.2, 0.1) && near(second10, 15.8, 0.1) && near(first20, 10.9, 0.1),
    `${first10} ${second10} ${first20}`,
  );
  // Froude scaling keeps the non-dimensional manoeuvre: the 320 m ship at 15.5 kn turns in the same lengths.
  const full = new Manoeuvring(scaleModel(KVLCC2_L7, scale), { u: 15.5 * 0.514444 }, { rudderRate: 1.76 * DEG });
  full.revolutions = full.selfPropulsion(15.5 * 0.514444);
  full.order = 35 * DEG;
  while (Math.abs(full.state.heading) < Math.PI / 2) full.step(0.1);
  assert.ok(near(full.state.x / 320, a1, 0.01), `${full.state.x / 320} against ${a1}`);
});

test('squat: the published canal case, ICORELS 0.34186 m and Huuska 0.52909 m; Tuck scaling Fn^2 / sqrt(1 - Fn^2)', () => {
  // A 118 m cargo ship (B 17.1, T 7.76, C_B 0.667) at 8 kn in a canal 123 m wide and 10 m deep: Fn_h 0.415606 as printed.
  const c = {
    length: 118,
    beam: 17.1,
    draught: 7.76,
    block: 0.667,
    speed: 0.415606 * Math.sqrt(98.1),
    depth: 10,
    gravity: 9.81,
  };
  assert.ok(Math.abs(icorels(c) - 0.34186) < 1e-4);
  assert.ok(Math.abs(huuska(c, 1230) - 0.52909) < 1e-4);
  const slow = squat({ ...c, speed: 2 }),
    fast = squat({ ...c, speed: 4 }),
    shape = (v) => {
      const f = v / Math.sqrt(9.81 * 10);
      return (f * f) / Math.sqrt(1 - f * f);
    };
  assert.ok(Math.abs(fast.mean / slow.mean - shape(4) / shape(2)) < 1e-12);
  assert.ok(fast.trim > 0 && fast.bow > fast.mean);
  assert.throws(() => squat({ ...c, speed: 8 }), /0\.7/);
});

test('a tunnel thruster keeps its momentum bound: 234 kN for 1,000 kW through a 2 m tunnel', () => {
  assert.ok(Math.abs(thrusterThrust(1e6, 2) / 1e3 - 234) < 0.5);
  assert.throws(() => thrusterThrust(-1, 2), /power/);
});

/** A world of one KVLCC2 L7 box hull (no gravity: the plane alone) under a ShipSolver, at 60 Hz. */
function plane(extra = {}, options = {}) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    M = KVLCC2_L7,
    speed = options.speed ?? 0,
    body = physics.addBody(null, {
      position: options.at ?? [0, 0, 0],
      linearVelocity: [speed, 0, 0],
      colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(ships, {
        ships: [{ row: body.row, model: { ...M, centre: 0 }, rudderRate: 11.9 * DEG, ...extra }],
        ...options.params,
      })
      .couple(['ship', 'rigid'], 'staggered');
  return { physics, body, ships, world };
}

test('a rigid body held by the ship solver follows the MMG ship through a turn', () => {
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    { body, ships, world } = plane({}, { speed }),
    M = KVLCC2_L7,
    reference = new Manoeuvring(
      { ...M, centre: 0, gyration: Math.sqrt((M.length ** 2 + M.beam ** 2) / 12) },
      { u: speed },
      { rudderRate: 11.9 * DEG },
    ),
    n = reference.selfPropulsion(speed);
  reference.revolutions = n;
  reference.order = 35 * DEG;
  ships.control(0).revolutions = n;
  ships.control(0).rudder = 35 * DEG;
  for (let t = 1; t <= 60 * 30; t++) {
    world.advance(t);
    reference.step(1 / 60);
  }
  const p = body.position;
  // 30 s on, 23 m along a turning path: within 5 cm.
  assert.ok(
    Math.hypot(p[0] - reference.state.x, p[2] - reference.state.z) < 0.05,
    `${p} against ${reference.state.x}, ${reference.state.z}`,
  );
  assert.ok(Math.abs(ships.status(0).rudder - 35 * DEG) < 1e-12);
  // Its race runs aft as a water flow behind the propeller.
  const race = ships.status(0).race,
    behind = race.position.map((v, k) => v + 2 * race.diameter * race.direction[k]),
    flow = ships.water.sample(behind[0], behind[1], behind[2], 0).velocity;
  assert.ok(flow[0] * race.direction[0] + flow[2] * race.direction[2] > 0.1);
  assert.ok(ships.wash(0).length === 1 && ships.sources(0).length >= 3);
});

test("a ship under way presses its hull's draught on the water: a WakeSolver behind it makes its wake", () => {
  const speed = 1.18,
    { ships, world, body } = plane({}, { speed }),
    wake = new WakeSolver();
  world.add(wake, { cells: [128, 64], cellSize: 0.5, centre: [16, 0], sources: (t) => ships.sources(t) });
  ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  world.advance(60 * 12);
  const x = body.position[0];
  let behind = 0,
    beside = 0;
  for (let k = 0; k < 40; k++) behind = Math.max(behind, Math.abs(wake.sample(x - 6 - 0.25 * k, 0).height));
  for (let k = 0; k < 20; k++) beside = Math.max(beside, Math.abs(wake.sample(x - 6 - 0.5 * k, 4).height));
  assert.ok(behind > 2e-3, `the wake behind: ${behind} m`);
  assert.ok(beside > 2e-4, `its waves spread to the side: ${beside} m`);
});

test('a bow thruster turns a ship at rest; a quay alongside draws a ship under way toward it', () => {
  const { body, ships, world } = plane({ thruster: { diameter: 0.05, power: 50 } });
  ships.control(0).thruster = 1;
  world.advance(120);
  assert.ok(body.angularVelocity[1] < 0, 'the bow to starboard: yaw clockwise seen from above');
  assert.ok(ships.status(0).thruster > 0);
  const speed = 0.8,
    quay = plane({}, { speed, params: { walls: [{ from: [-20, 1.2], to: [20, 1.2] }], depth: 0.7 } });
  quay.ships.control(0).revolutions = quay.ships.revolutionsFor(0, speed);
  quay.world.advance(60);
  assert.ok(quay.ships.status(0).suction > 0, 'toward the quay on its starboard side');
  assert.ok(quay.body.linearVelocity[2] > 0);
});

test('in shallow water the hull sinks by its squat through the HullSolver on the drawn-down sea', () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    M = KVLCC2_L7,
    depth = 0.6,
    speed = 0.6,
    T = M.draught,
    D = 2 * T,
    body = physics.addBody(null, {
      position: [0, D / 2 - T, 0],
      linearVelocity: [speed, 0, 0],
      colliders: { shape: 'box', halfExtents: [M.length / 2, D / 2, M.beam / 2], mass: 1025 * M.length * M.beam * T },
    }),
    mesh = boxMesh([M.length, D, M.beam]),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(ships, {
        ships: [{ row: body.row, model: { ...M, centre: 0 }, midship: [0, T - D / 2, 0], addedMass: false }],
        depth,
      })
      .add(new HullSolver(), {
        hulls: [{ row: body.row, mesh }],
        sea: ships.sea({ elevation: () => 0, density: 1025 }),
      })
      .couple(['ship', 'hull', 'rigid'], 'staggered');
  ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  world.advance(60 * 20);
  const s = ships.status(0),
    sunk = D / 2 - T - body.position[1];
  assert.ok(s.sinkage > 0.003, `${s.sinkage}`);
  assert.ok(Math.abs(sunk / s.sinkage - 1) < 0.15, `sank ${sunk} for a squat of ${s.sinkage}`);
  assert.ok(Math.abs(ships.drawdown(s.midship[0], s.midship[2]) - s.sinkage) < 1e-12);
});

test('the ship solver refuses what it cannot be made from, naming the fix', () => {
  assert.throws(() => plane({ row: -1 }), /body row/);
  assert.throws(() => plane({ rudderRate: 0 }), /rudder's rate/);
  assert.throws(() => plane({}, { params: { depth: -2 } }), /depth/);
  assert.throws(() => plane({}, { params: { walls: [{ from: [0], to: [1, 1] }] } }), /wall/);
  assert.throws(() => new ShipSolver().control?.(0), /no ship/);
});

/** A box hull of `size` (x, y, z) about its centre, each face a 4 by 4 grid, wound outward. */
function boxMesh([sx, sy, sz]) {
  const h = [sx / 2, sy / 2, sz / 2],
    vertices = [],
    indices = [],
    n = 4;
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
