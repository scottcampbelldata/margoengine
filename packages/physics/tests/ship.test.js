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
  VortexCavity,
  cavityRadius,
  collapseTime,
  coreDeficit,
  empiricalModel,
  headingGains,
  ankudinovShallow,
  bankLoads,
  bSeriesCurves,
  wageningenB,
  liWuAddedMass,
  shallowWater,
  inceptionIndex,
  raceNumbers,
  resolvedRace,
  KCS_MODEL,
  KVLCC2_L7,
  KVLCC2_PROPELLER,
  Manoeuvring,
  Propeller,
  ShipSolver,
  holtropMennen,
  B4_70_FOUR_QUADRANT,
  fourQuadrantCoefficients,
  yachtWater,
  SailingSolver,
  velocityPrediction,
  yachtWettedArea,
  bladeCoefficients,
  RowingSolver,
  savitsky,
  PlaningSolver,
  addedResistance,
  besselI1,
  besselK1,
  driftLoads,
  iceResistance,
  huuska,
  icorels,
  ittc1957,
  raceVelocity,
  rudderLiftSlope,
  scaleModel,
  squat,
  thrusterThrust,
  thrusterAhead,
  THRUSTER_MERIT,
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
  // Beveridge (1971): the static merit coefficient C = T^(3/2) / (P sqrt(rho A)) is 2 for the bound, so a thruster of C has
  // (C / 2)^(2/3) of it; the default, his 800-hp LST unit's 0.82, gives back C = 0.82 from its own thrust and power.
  const T = THRUSTER_MERIT * thrusterThrust(1e6, 2),
    C = T ** 1.5 / (1e6 * Math.sqrt(1025 * Math.PI));
  assert.ok(Math.abs(C - 0.82) < 1e-9, `${C}`);
  assert.ok(Math.abs(THRUSTER_MERIT - (0.82 / 2) ** (2 / 3)) < 1e-15);
  // With way on, force and moment follow Chislett's captive tanker (Beveridge's Figure 2b): the force at its least, 0.30,
  // near U / U_j 0.6, the moment at its least, 0.55, near 0.4, and both whole again at rest.
  assert.deepEqual(thrusterAhead(0), [1, 1]);
  assert.deepEqual(thrusterAhead(0.6), [0.3, 0.62]);
  assert.deepEqual(thrusterAhead(0.4), [0.37, 0.55]);
  assert.ok(Math.abs(thrusterAhead(0.7)[0] - 0.315) < 1e-12);
  assert.deepEqual(thrusterAhead(5), [0.53, 1.07]);
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

test('SEA-15 a live tunnel water jet reverses, keeps nozzle momentum and restores from a snapshot', (t) => {
  // Xia and Lam (2009), Tables 1 and 3: independently measured round water-jet exit and far-field decay.
  const density = 1000;
  const diameter = 0.005;
  const measuredExit = 1.02;
  const area = (Math.PI * diameter * diameter) / 4;
  const thrust = density * area * measuredExit ** 2;
  const power = (thrust / (THRUSTER_MERIT * Math.cbrt(4 * density * area))) ** 1.5;
  const position = 1,
    halfSpan = 0.2,
    depth = 0.2;
  const config = { thruster: { diameter, power, position }, thrusterOutlet: { halfSpan, depth } };
  const { world, ships } = plane(config, { params: { density } });
  const controls = ships.control(0);
  const sample = (x, y, z) => {
    const flow = ships.water.sample(x, y, z, 0).velocity;
    const race = ships.status(0).race;
    if (!race) return flow;
    // A windmilling main screw can still generate flow after the hull moves. Isolate the tunnel contribution.
    const axial = resolvedRace(race, [x, y, z]);
    return flow.map((speed, i) => speed - axial[i]);
  };
  assert.deepEqual(sample(position, -depth, -halfSpan), [0, 0, 0]);
  controls.thruster = 1;
  world.advance(1);
  const exit = sample(position, -depth, -halfSpan);
  assert.ok(Math.abs(exit[2] + measuredExit) < 32 * Number.EPSILON * measuredExit);
  assert.deepEqual(exit.slice(0, 2), [0, 0]);
  assert.ok(Math.abs(ships.status(0).thruster - thrust) < 32 * Number.EPSILON * thrust);
  assert.deepEqual(sample(position, -depth, halfSpan), [0, 0, 0]);
  const distance = 20 * diameter;
  const centre = -sample(position, -depth, -halfSpan - distance)[2];
  const measured = (measuredExit * 5.5) / 20;
  const width = distance / 12.4;
  assert.ok(Math.abs(centre * width - (measuredExit * diameter) / 2) < 32 * Number.EPSILON * diameter);
  const halfVelocity = -sample(position + Math.sqrt(2 * Math.log(2)) * width, -depth, -halfSpan - distance)[2];
  assert.ok(Math.abs(2 * halfVelocity - centre) < 32 * Number.EPSILON);
  assert.ok(Math.abs(centre - measured) < measured, 'decaying jet is closer to the LDA curve than no jet');
  t.diagnostic(
    `At 20 diameters: ${(centre / measuredExit).toFixed(3)} simulated, ${(measured / measuredExit).toFixed(3)} from the measured turbulent-jet fit.`,
  );
  const snapshot = world.takeSnapshot();
  controls.thruster = -1;
  world.advance(2);
  assert.ok(sample(position, -depth, halfSpan + distance)[2] > 0);
  assert.deepEqual(sample(position, -depth, -halfSpan - distance), [0, 0, 0]);
  world.restoreSnapshot(snapshot.bytes);
  assert.deepEqual(sample(position, -depth, -halfSpan), exit);
  controls.thruster = 0;
  world.advance(2);
  assert.deepEqual(sample(position, -depth, -halfSpan - distance), [0, 0, 0]);

  const unpowered = plane({ ...config, thruster: { ...config.thruster, power: 0 } }, { params: { density } });
  unpowered.ships.control(0).thruster = 1;
  unpowered.world.advance(1);
  assert.equal(unpowered.ships.status(0).thruster, 0);
  assert.deepEqual(unpowered.ships.water.sample(position, -depth, -halfSpan, 0).velocity, [0, 0, 0]);
});

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

test('a HullSolver on a ship leaves the surge, sway and yaw the ship claims: a kick decays as the MMG ship alone, not doubly damped', () => {
  // The same 7 m hull kicked in sway, then in yaw, at 0.6 m/s: once held by the ship solver alone (no gravity, its MMG model
  // the whole of the water's load), once floating under a HullSolver as well. The ship's derivatives hold the hull's sway
  // and yaw damping and its added mass, so the hull solver leaves its radiation and added mass in those rows out.
  const M = KVLCC2_L7,
    T = M.draught,
    D = 2 * T,
    speed = 0.6,
    run = (floating, kick) => {
      const physics = new Physics(null, { fixedTimestep: 1 / 60, ...(floating ? {} : { gravity: [0, 0, 0] }) }),
        body = physics.addBody(null, {
          position: [0, floating ? D / 2 - T : 0, 0],
          linearVelocity: [speed, 0, kick.sway],
          angularVelocity: [0, kick.yaw, 0],
          colliders: {
            shape: 'box',
            halfExtents: [M.length / 2, D / 2, M.beam / 2],
            mass: 1025 * M.length * M.beam * T,
          },
        }),
        ships = new ShipSolver(),
        world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(ships, {
          ships: [
            { row: body.row, model: { ...M, centre: 0, volume: M.length * M.beam * T }, midship: [0, T - D / 2, 0] },
          ],
        });
      if (floating)
        world
          .add(new HullSolver(), {
            hulls: [{ row: body.row, mesh: boxMesh([M.length, D, M.beam]) }],
            sea: ships.sea({ elevation: () => 0, density: 1025 }),
          })
          .couple(['ship', 'hull', 'rigid'], 'staggered');
      else world.couple(['ship', 'rigid'], 'staggered');
      ships.control(0).revolutions = ships.revolutionsFor(0, speed);
      const out = [];
      for (let s = 1; s <= 4; s++) {
        world.advance(60 * s);
        // The sway in the body's frame: the velocity turned back by the heading.
        const v = body.linearVelocity,
          heading = Math.atan2(
            -2 * (body.rotation[0] * body.rotation[2] - body.rotation[3] * body.rotation[1]),
            1 - 2 * (body.rotation[1] ** 2 + body.rotation[2] ** 2),
          );
        out.push({ sway: v[2] * Math.cos(heading) + v[0] * Math.sin(heading), yaw: body.angularVelocity[1] });
      }
      return out;
    };
  for (const kick of [
    { sway: 0.08, yaw: 0 },
    { sway: 0, yaw: 0.02 },
  ]) {
    const alone = run(false, kick),
      both = run(true, kick);
    for (let s = 0; s < 4; s++) {
      assert.ok(
        Math.abs(both[s].sway - alone[s].sway) < 0.01 * 0.08,
        `sway ${both[s].sway} against ${alone[s].sway} at ${s + 1} s`,
      );
      assert.ok(
        Math.abs(both[s].yaw - alone[s].yaw) < 0.01 * 0.02,
        `yaw ${both[s].yaw} against ${alone[s].yaw} at ${s + 1} s`,
      );
    }
    // And the kick does decay, by the MMG model's damping.
    if (kick.sway) assert.ok(alone[1].sway < 0.95 * kick.sway, `${alone[1].sway}`);
    else assert.ok(alone[1].yaw < 0.85 * kick.yaw, `${alone[1].yaw}`);
  }
});

test("the resolved race: its circulation from the torque, Pennings's propeller within 6 percent, and momentum theory's contraction", () => {
  // Pennings (2016): 2 blades, D 0.15 m, n 38 Hz, J 0.56, K_T 0.18, K_Q 0.027; a boundary-element mean circulation of 0.1287.
  const rho = 1000,
    D = 0.15,
    n = 38,
    V = 0.56 * n * D,
    CT = (8 * 0.18) / (Math.PI * 0.56 * 0.56),
    efflux = V * (Math.sqrt(1 + CT) - 1),
    race = {
      position: [0, -1, 0],
      direction: [-1, 0, 0],
      diameter: D,
      pitch: 1,
      efflux,
      hub: 0.2 * D,
      blades: 2,
      revolutions: n,
      torque: rho * n * n * D ** 5 * 0.027,
      thrust: rho * n * n * D ** 4 * 0.18,
      inflow: V,
      density: rho,
    },
    numbers = raceNumbers(race);
  assert.ok(Math.abs(numbers.circulation / 0.1287 - 1) < 0.06, `${numbers.circulation}`);
  // Contraction (R_w / R)^2 = (V + u_a) / (V + 2 u_a); at bollard pull 1 / sqrt 2.
  assert.ok(Math.abs(numbers.contraction ** 2 - (V + efflux / 2) / (V + efflux)) < 1e-12);
  assert.ok(Math.abs(raceNumbers({ ...race, inflow: 0 }).contraction - Math.SQRT1_2) < 1e-12);
  // The water turns with the blades: a right-handed screw ahead turns its race clockwise seen from astern, so a point above
  // the shaft moves to port (+z when the race leaves along -x and starboard is -z... here: up x direction gives the sense).
  const above = resolvedRace(race, [-0.5 * D, -1 + 0.3 * D, 0]),
    below = resolvedRace(race, [-0.5 * D, -1 - 0.3 * D, 0]);
  assert.ok(above[2] * below[2] < 0, 'it swirls about the shaft');
  const reversed = resolvedRace({ ...race, revolutions: -n }, [-0.5 * D, -1 + 0.3 * D, 0]);
  assert.ok(reversed[2] * above[2] < 0, 'astern it swirls the other way');
  // The swirl falls as x^-2 in the established jet.
  const swirlAt = (x) => Math.abs(resolvedRace(race, [-x * D, -1 + 0.1 * x * D, 0])[2]);
  assert.ok(swirlAt(8) < 0.3 * swirlAt(4) && swirlAt(4) > 0);
});

test("a rudder turns the race by its side force over the race's momentum flux, tan phi = F / (rho A_w V_w^2)", () => {
  const race = {
      position: [0, -3, 0],
      direction: [-1, 0, 0],
      diameter: 2,
      pitch: 1,
      efflux: 4,
      blades: 4,
      revolutions: 3,
      torque: 0,
      thrust: 1e5,
      inflow: 0,
      density: 1025,
    },
    momentum = 1025 * Math.PI * (Math.SQRT1_2 * 1) ** 2 * 16,
    force = 0.3 * momentum,
    turned = { ...race, rudder: { distance: 1, force: [0, 0, force] } },
    { turn } = raceNumbers(turned);
  assert.ok(Math.abs(Math.tan(turn) - 0.3) < 1e-9);
  // In the established jet 16 m aft (its profile peaked on its axis), the axis has moved off the shaft toward -z, the water
  // pushed opposite the rudder's force, by 15 m tan phi past the rudder.
  let best = -1,
    at = 0;
  for (let z = -8; z <= 8; z += 0.02) {
    const v = resolvedRace(turned, [-16, -3, z]),
      u = Math.hypot(v[0], v[2]);
    if (u > best) [best, at] = [u, z];
  }
  assert.ok(Math.abs(at - -15 * Math.sin(turn)) < 0.3, `axis at ${at} against ${-15 * Math.sin(turn)}`);
});

test("vortex cavitation: a Lamb-Oseen core's deficit, Pennings's wing inception at 2.97, and Amini's hysteresis", () => {
  // The core deficit's integral is ln 2.
  assert.ok(Math.abs(coreDeficit(1, 1, 1) * 4 * Math.PI ** 2 - Math.LN2) < 1e-12);
  // Pennings's wing: circulation 0.10 m^2/s, peak-velocity radius 1.7 mm (a = 1.7 / 1.1209 mm), W 7.17 m/s: 2.97.
  assert.ok(Math.abs(inceptionIndex(0.1, 1.7e-3 / 1.1209, 7.17) - 2.97) < 0.005);
  // The cavity grows as the pressure falls, inside the potential vortex's bound Gamma / (2 pi W sqrt(sigma)).
  const a = 1.7e-3 / 1.1209,
    at = (sigma) => cavityRadius(0.1, a, 1705 + sigma * 0.5 * 1000 * 7.17 ** 2, 1705, 1000);
  assert.ok(at(1.07) > at(1.55) && at(1.55) > at(2.0) && at(2.0) > 0);
  for (const sigma of [1.07, 1.55, 2.0]) assert.ok(at(sigma) < 0.1 / (2 * Math.PI * 7.17 * Math.sqrt(sigma)));
  assert.equal(at(4), 0, 'no cavity above inception');
  // Amini et al. (2019): in air-saturated water a cavity forms at 1.7 and holds to 4.0; in degassed water it goes at 1.7.
  const gassy = new VortexCavity(1),
    clean = new VortexCavity(0);
  for (const [sigma, want] of [
    [2.5, false],
    [1.6, true],
    [3.5, true],
    [4.1, false],
  ])
    assert.equal(gassy.update(sigma, 1.7), want, `gassy at ${sigma}`);
  assert.equal(clean.update(1.6, 1.7), true);
  assert.equal(clean.update(1.8, 1.7), false);
  // Rayleigh: a 5 mm bubble under 100 kPa collapses in 0.458 ms.
  assert.ok(Math.abs(collapseTime(5e-3, 1e5, 1000) - 4.575e-4) < 2e-6);
});

test("a hull's manoeuvring from its dimensions: Kijima's KVLCC2 to his formulas, and its turns against MARIN's free-running tests", () => {
  const kvlcc2 = empiricalModel({
    length: 320,
    beam: 58,
    draught: 20.8,
    block: 0.81,
    lcb: 3.48,
    propeller: { diameter: 9.86 },
    rudder: { area: 112.5, span: 15.8 },
    speed: 15.5 * 0.514444,
  });
  // Kijima (1990) in MMG's v' form, KVLCC2 at G = midship: the research's hand-checked values.
  for (const [got, want] of [
    [kvlcc2.sway[0], -0.4097],
    [kvlcc2.sway[1] - kvlcc2.addedMass[0], 0.0734],
    [kvlcc2.yaw[0], -0.13],
    [kvlcc2.yaw[1], -0.0533],
    [kvlcc2.sway[2], -0.6703],
    [kvlcc2.sway[5], 0.0296],
    [kvlcc2.sway[3], -0.2143],
    [kvlcc2.sway[4], -0.4054],
    [kvlcc2.yaw[2], -0.0006],
    [kvlcc2.yaw[5], -0.0166],
    [kvlcc2.yaw[3], -0.138],
    [kvlcc2.yaw[4], 0.0952],
  ])
    assert.ok(Math.abs(got - want) < 1e-4, `${got} against ${want}`);
  assert.equal(kvlcc2.form, 'kijima');
  assert.ok(kvlcc2.range.kijima && kvlcc2.range.outside.length === 0);
  // Clarke's added masses and Holtrop's thrust deduction against the captive data: 0.223, 0.011, 0.220.
  assert.ok(Math.abs(kvlcc2.addedMass[1] / 0.223 - 1) < 0.1 && Math.abs(kvlcc2.addedMass[2] / 0.011 - 1) < 0.15);
  assert.ok(Math.abs(kvlcc2.propeller.thrustDeduction - 0.22) < 0.01);
  // Fully empirical, it turns within 30 percent of MARIN's free-running KVLCC2 (advance 3.25 L, tactical diameter 3.34 L).
  const speed = 15.5 * 0.514444,
    s = new Manoeuvring(kvlcc2, { u: speed }, { rudderRate: 1.76 * DEG });
  s.revolutions = s.selfPropulsion(speed);
  s.order = 35 * DEG;
  let advance;
  while (Math.abs(s.state.heading) < Math.PI) {
    s.step(0.2);
    if (advance === undefined && Math.abs(s.state.heading) >= Math.PI / 2) advance = s.state.x / 320;
  }
  const diameter = Math.abs(s.state.z) / 320;
  assert.ok(near(advance, 3.25, 0.3) && near(diameter, 3.34, 0.3), `${advance} ${diameter}`);
  // A Great Lakes freighter (222 m, L/B 9.5, C_B 0.88) lies outside Kijima's hulls, and says so.
  const laker = empiricalModel({
    length: 222,
    beam: 23.4,
    draught: 8.2,
    block: 0.88,
    propeller: { diameter: 6 },
    rudder: { area: 30, span: 7 },
  });
  assert.ok(!laker.range.kijima && laker.range.outside.some((t) => t.startsWith('L/B')));
  assert.throws(
    () =>
      empiricalModel({
        length: 100,
        beam: 10,
        draught: 5,
        block: 0.8,
        trim: -1,
        propeller: { diameter: 3 },
        rudder: { area: 5, span: 3 },
      }),
    /trim/,
  );
});

test('a heavily loaded screw near the surface cavitates and releases its cavities as air where its tip vortices break down', () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    M = KVLCC2_L7,
    body = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(ships, { ships: [{ row: body.row, model: { ...M, centre: 0 } }] })
      .couple(['ship', 'rigid'], 'staggered');
  // Gently: no cavity. At a model's racing revolutions the tip speed outruns the core's pressure.
  ships.control(0).revolutions = 5;
  world.advance(30);
  assert.equal(ships.status(0).cavity.cavitating, false);
  assert.equal(ships.aeration(0).length, 0);
  ships.control(0).revolutions = 60;
  world.advance(60);
  const c = ships.status(0).cavity;
  assert.ok(c.cavitating && c.radius > 0 && c.sigma <= c.inception * (4 / 1.7), JSON.stringify(c));
  const air = ships.aeration(0);
  assert.equal(air.length, 1);
  assert.ok(air[0].rate > 0 && air[0].position[0] < body.position[0]);
});

test('the ship solver refuses what it cannot be made from, naming the fix', () => {
  assert.throws(() => plane({ row: -1 }), /body row/);
  assert.throws(() => plane({ rudderRate: 0 }), /rudder's rate/);
  assert.throws(() => plane({}, { params: { depth: -2 } }), /depth/);
  assert.throws(() => plane({}, { params: { walls: [{ from: [0], to: [1, 1] }] } }), /wall/);
  assert.throws(() => new ShipSolver().control?.(0), /no ship/);
  // Every refusal of the ship entry is a coded MargoError that links to its entry on the errors page.
  const coded = (fn, text) =>
    assert.throws(
      fn,
      (e) =>
        e.name === 'MargoError' && e.code === 'unsupported' && text.test(e.message) && /errors#ships$/.test(e.message),
    );
  coded(() => plane({ row: -1 }), /body row/);
  coded(() => plane({ autopilot: { bandwidth: 0 } }), /bandwidth/);
  coded(() => new Manoeuvring({ ...KVLCC2_L7, length: 0 }), /length/);
  coded(() => new Manoeuvring(KVLCC2_L7).linearize(0), /speed/);
  coded(() => holtropMennen({ ...{ length: -1 } }, 5), /./);
  coded(() => squat({ length: 0 }), /./);
  const { ships, world } = plane({}, { speed: 1 });
  ships.control(0).track = { waypoints: [[0, 0]] };
  coded(() => world.advance(1), /two or more waypoints/);
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

test("the autopilot places the closed loop's poles on the ship's own model, and holds a course-unstable KVLCC2 on a new heading", () => {
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    M = KVLCC2_L7,
    reference = new Manoeuvring(
      { ...M, centre: 0, gyration: Math.sqrt((M.length ** 2 + M.beam ** 2) / 12) },
      { u: speed },
    ),
    { a, b } = reference.linearize(speed);
  // KVLCC2 is course-unstable: the sway-yaw matrix has an eigenvalue above 0.
  const trace = a[0] + a[3],
    det = a[0] * a[3] - a[1] * a[2],
    top = (trace + Math.sqrt(trace * trace - 4 * det)) / 2;
  assert.ok(top > 0, `largest eigenvalue ${top}`);
  // The gains put the characteristic polynomial of [v, r, e, ∫e] at (s + w)^2 (s^2 + 2 z w s + w^2), to rounding.
  const w = (0.5 * speed) / M.length,
    k = headingGains(a, b, w, 0.8),
    // det(sI - (A - B k)) for A = [[a0, a1, 0, 0], [a2, a3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], by its coefficients.
    A = [
      [a[0] - b[0] * k.v, a[1] - b[0] * k.r, -b[0] * k.heading, -b[0] * k.integral],
      [a[2] - b[1] * k.v, a[3] - b[1] * k.r, -b[1] * k.heading, -b[1] * k.integral],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ],
    // Faddeev-LeVerrier: the characteristic polynomial's coefficients from traces of powers.
    mul = (x, y) => x.map((row, i) => row.map((_, j) => row.reduce((s, _v, n) => s + x[i][n] * y[n][j], 0))),
    tr = (x) => x[0][0] + x[1][1] + x[2][2] + x[3][3],
    A2 = mul(A, A),
    A3 = mul(A2, A),
    A4 = mul(A3, A),
    p1 = tr(A),
    p2 = tr(A2),
    p3 = tr(A3),
    p4 = tr(A4),
    c3 = -p1,
    c2 = -(c3 * p1 + p2) / 2,
    c1 = -(c2 * p1 + c3 * p2 + p3) / 3,
    c0 = -(c1 * p1 + c2 * p2 + c3 * p3 + p4) / 4,
    want = [2 * w + 1.6 * w, 2 * w * w + 3.2 * w * w, 2 * w ** 3 + 1.6 * w ** 3, w ** 4];
  [c3, c2, c1, c0].forEach((c, i) =>
    assert.ok(Math.abs(c / want[i] - 1) < 1e-6, `coefficient ${i}: ${c} against ${want[i]}`),
  );
  // Held on the water: a heading 30 degrees to starboard reached and held, the rudder within its limit.
  const { body, ships, world } = plane({}, { speed });
  ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  ships.control(0).heading = 30 * DEG;
  let most = 0;
  for (let t = 1; t <= 60 * 180; t++) {
    world.advance(t);
    most = Math.max(most, ships.status(0).heading);
  }
  const s = ships.status(0);
  assert.ok(Math.abs(s.heading - 30 * DEG) < 0.2 * DEG, `heading ${s.heading / DEG}`);
  assert.ok(Math.abs(s.r) < 1e-3 && Math.abs(s.rudder) < 35 * DEG);
  // Damped: the overshoot of a ζ 0.8 loop stays small.
  assert.ok(most < 34 * DEG, `overshoot to ${most / DEG} degrees`);
  assert.equal(ships.status(0).headingOrdered, 30 * DEG);
  void body;
});

test('the autopilot follows a track of waypoints by line of sight, and crabs into a steady crosswind', () => {
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    L = KVLCC2_L7.length,
    { body, ships, world } = plane({}, { speed });
  ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  // East 20 L, then south-east 40 L more: the second leg 45 degrees to starboard.
  ships.control(0).track = {
    waypoints: [
      [0, 0],
      [20 * L, 0],
      [20 * L + 28.28 * L, 28.28 * L],
    ],
  };
  // A steady push to port from a crosswind, a twentieth of the ship's resistance.
  const push = 0.05 * 0.5 * 1025 * L * KVLCC2_L7.draught * speed * speed * KVLCC2_L7.resistance;
  // Held from now on: a body's added force stays until it is reset.
  body.addForce([0, 0, -push]);
  let worst = 0,
    turned = 0,
    last = 0;
  for (let t = 1; t <= 60 * Math.ceil((64 * L) / speed); t++) {
    world.advance(t);
    const s = ships.status(0);
    if (s.track.leg === 1 && !turned) turned = t;
    // Settled on the second leg: its second half, once the drift is crabbed into.
    if (s.track.leg === 1 && turned && t > turned + 60 * ((20 * L) / speed))
      worst = Math.max(worst, Math.abs(s.track.crossTrack));
    if (s.track.leg === 1) last = s.track.crossTrack;
  }
  const s = ships.status(0);
  assert.ok(turned > 0, 'it reached the second leg');
  assert.ok(s.track.done, 'and passed the last waypoint');
  // Performance targets, not physics bounds: over the leg's second half the turn's swing dies within a tenth of a length,
  // and by the leg's end the crosswind is crabbed into, within a fiftieth of a length of the line (0.01 L measured).
  assert.ok(worst > 0 && worst < 0.1 * L, `cross-track ${worst / L} L`);
  assert.ok(Math.abs(last) < 0.02 * L, `cross-track at the leg's end ${last / L} L`);
});

test("a hull given to the ship runs on Holtrop and Mennen's resistance: self-propelled at a speed, it holds that speed", () => {
  const M = scaleModel(KVLCC2_L7, 320 / 7),
    hull = {
      length: 320,
      beam: 58,
      draughtFore: 20.8,
      draughtAft: 20.8,
      volume: 312622,
      lcb: 3.48,
      midship: 0.998,
      waterplane: 0.9,
      propeller: { diameter: 9.86, blades: 4 },
    },
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    speed = 15.5 * 0.514444,
    body = physics.addBody(null, {
      linearVelocity: [speed, 0, 0],
      colliders: { shape: 'box', halfExtents: [160, 20.8, 29], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(ships, { ships: [{ row: body.row, model: { ...M, centre: 0 }, hull }] })
      .couple(['ship', 'rigid'], 'staggered');
  ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  ships.control(0).heading = 0;
  for (let t = 1; t <= 60 * 300; t++) world.advance(t);
  const s = ships.status(0),
    resisted = holtropMennen(hull, s.u).total,
    pushed = s.forces.thrust * (1 - M.propeller.thrustDeduction);
  assert.ok(Math.abs(s.u / speed - 1) < 0.005, `${s.u} against ${speed} m/s`);
  assert.ok(Math.abs(pushed / resisted - 1) < 0.01, `thrust ${pushed} against Holtrop ${resisted} N`);
  // And the speed is not R'_0's: the same revolutions on the constant coefficient settle elsewhere.
  const plain = new Manoeuvring({ ...M, centre: 0 }),
    other = plain.selfPropulsion(speed);
  assert.notEqual(Math.round(other * 1e6), Math.round(ships.control(0).revolutions * 1e6));
});

test("in shallow water a hull's derivatives and added masses are Ankudinov's, and it turns wider as the water shoals", () => {
  const M = KVLCC2_L7,
    T = M.draught,
    hull = { length: M.length, beam: M.beam, draught: T, block: M.volume / (M.length * M.beam * T) };
  // Deep water, or ten draughts and more, gives the model back.
  assert.equal(shallowWater(M, Infinity), M);
  assert.equal(shallowWater(M, 10 * T), M);
  // At h / T 1.5 the factors are Ankudinov et al.'s eqs. 4 to 8 as Vantorre reprints them, worked here by hand.
  const g = 0.5,
    K0 = 1 + 0.0775 / g ** 2 - 0.011 / g ** 3 + 0.000068 / g ** 5,
    K1 = -0.0643 / g + 0.0724 / g ** 2 - 0.0113 / g ** 3 + 0.0000767 / g ** 5,
    K2 = 0.0342 / g,
    b = (hull.block * hull.beam * (1 + hull.beam / M.length) ** 2) / T,
    fnv = K0 + K1 * b + K2 * b * b,
    f = ankudinovShallow(1.5, hull);
  assert.ok(Math.abs(f.fnv - fnv) < 1e-12 && Math.abs(f.fyv - (1.5 * fnv - 0.5)) < 1e-12);
  assert.ok(Math.abs(f.fnr - (K0 + 0.5 * K1 * b + (K2 * b * b) / 3)) < 1e-12);
  const [ax] = liWuAddedMass(1.5, hull),
    shallow = shallowWater(M, 1.5 * T);
  assert.ok(
    Math.abs(ax - (1 + (3.77 + 1.14 * (hull.beam / T) - 0.233 * (M.length / T) - 3.43 * hull.block) / 0.5 ** 1.3)) <
      1e-12,
  );
  assert.ok(
    Math.abs(shallow.sway[0] / M.sway[0] - f.fyv) < 1e-12 && Math.abs(shallow.yaw[1] / M.yaw[1] - f.fnr) < 1e-12,
  );
  assert.ok(Math.abs(shallow.addedMass[1] / M.addedMass[1] - f.gv) < 1e-12);
  // Held at h / T 1.2 below it.
  assert.deepEqual(shallowWater(M, 1.05 * T), shallowWater(M, 1.2 * T));
  // The tanker hard over at 15.5 knots full scale (Froude): its tactical diameter grows as the keel nears the bed.
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    diameter = (model) => {
      const ship = new Manoeuvring({ ...model, centre: 0 }, { u: speed }, { rudderRate: 11.9 * DEG });
      ship.revolutions = new Manoeuvring({ ...M, centre: 0 }).selfPropulsion(speed);
      ship.order = 35 * DEG;
      while (ship.state.heading < Math.PI && ship.time < 2000) ship.step(0.02);
      return ship.state.z / M.length;
    },
    deep = diameter(M),
    sizes = [2, 1.5, 1.2].map((ratio) => diameter(shallowWater(M, ratio * T)));
  assert.ok(deep < sizes[0] && sizes[0] < sizes[1] && sizes[1] < sizes[2], `${deep} ${sizes}`);
  assert.throws(
    () => shallowWater(M, 0),
    (e) => e.code === 'unsupported' && /depth/.test(e.message),
  );
});

test("a bank alongside draws a ship in and turns its bow away, and pushes it off in very shallow water: Vantorre's regression", () => {
  // Vantorre et al. (MARSIM 2003), model C: the bulk carrier of their tests, 3.672 m, inside the regression's range (their
  // container carrier D has B/T 3.06, a shade past the 3.0 they give).
  const D = { length: 3.672, beam: 0.504, draught: 0.191, block: 0.828, diameter: 0.12 },
    u = 0.069 * Math.sqrt(9.81 * D.length),
    at = (ratio, yB = 0.3, thrust = 0) => bankLoads(D, yB, ratio * D.draught, u, thrust, 1000, 9.81);
  assert.ok(at(1.5).inRange);
  // At usual depths the bank attracts the ship (toward a starboard bank: +Y) and turns its bow away (-N).
  for (const ratio of [1.2, 1.35, 1.5, 2, 2.5]) assert.ok(at(ratio).Y > 0 && at(ratio).N < 0, `h/T ${ratio}`);
  // In very shallow water the attraction turns into repulsion, at the critical h/T the paper gives, 1.1 to 1.3.
  assert.ok(at(1.1).Y < 0);
  let lo = 1.1,
    hi = 1.5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid).Y < 0) lo = mid;
    else hi = mid;
  }
  assert.ok(lo > 1.1 && lo < 1.3, `the force turns at h/T ${lo}`);
  // A bank to port mirrors one to starboard; a ship on a canal's centreline feels none.
  const s = at(1.5, 0.3),
    p = at(1.5, -0.3);
  assert.ok(Math.abs(s.Y + p.Y) < 1e-12 && Math.abs(s.N + p.N) < 1e-12);
  assert.deepEqual(at(1.5, 0), { Y: 0, N: 0, inRange: true });
  // The propeller ahead adds its own part, which grows with its thrust; going astern the hull's part is left out.
  assert.notEqual(at(1.5, 0.3, 20).Y, s.Y);
  assert.equal(bankLoads(D, 0.3, 1.5 * D.draught, -u, 0, 1000, 9.81).Y, 0);
  // KVLCC2's L/B 5.5 is outside the regression's 6 to 7.3, and says so.
  assert.equal(
    bankLoads({ length: 320, beam: 58, draught: 20.8, block: 0.81, diameter: 9.86 }, 0.3, 40, 7, 0).inRange,
    false,
  );
  assert.throws(
    () => bankLoads(D, 0.3, 0.1, u, 0),
    (e) => e.code === 'unsupported' && /deeper than its draught/.test(e.message),
  );
});

test("a Wageningen B-series propeller's open water by Oosterveld and van Oossanen's polynomials, and MMG's curves fitted to it", () => {
  const b470 = { blades: 4, area: 0.7, pitch: 1 },
    { kt, kq } = wageningenB(b470, 0.5);
  // The 39 and 47 terms as transcribed, evaluated by hand for a B4-70 at P/D 1.0, J 0.5.
  assert.ok(Math.abs(kt - 0.27103) < 1e-5 && Math.abs(kq - 0.043433) < 1e-6, `${kt} ${kq}`);
  // The Reynolds correction against the paper's Figures 4 to 6 (B5-75, P/D 1.0, J 0.5, R_n 2e9: about +0.0016 and -0.0024,
  // read from the figures to about 0.0003).
  const b575 = { blades: 5, area: 0.75, pitch: 1 },
    base = wageningenB(b575, 0.5),
    high = wageningenB({ ...b575, reynolds: 2e9 }, 0.5);
  assert.ok(Math.abs(high.kt - base.kt - 0.0016) < 3e-4 && Math.abs(high.kq - base.kq + 0.0024) < 3e-4);
  // MMG's quadratic curves fitted from bollard pull to zero thrust (J 1.062), within 0.005 in K_T and in 10 K_Q.
  const curves = bSeriesCurves(b470);
  assert.ok(Math.abs(curves.zeroThrust - 1.062) < 1e-3 && curves.error < 0.005, `${curves.zeroThrust} ${curves.error}`);
  // A ship on them: KVLCC2 with a B4-70 of its own diameter self-propels at 15.5 knots full scale.
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    M = { ...KVLCC2_L7, propeller: { ...KVLCC2_L7.propeller, curves } },
    ship = new Manoeuvring(M, { u: speed });
  ship.revolutions = ship.selfPropulsion(speed);
  for (let t = 0; t < 3000; t++) ship.step(0.02);
  assert.ok(Math.abs(ship.state.u / speed - 1) < 0.01, `${ship.state.u}`);
  assert.throws(
    () => wageningenB({ blades: 8, area: 0.7, pitch: 1 }, 0.5),
    (e) => e.code === 'unsupported' && /2 to 7 blades/.test(e.message),
  );
});

/** A 35 degree turn of `model` at `speed` m/s to `side` (1 starboard, -1 port): advance and tactical diameter over L, heel and yaw rate. */
function turn(model, speed, side, rudderRate, dt = 0.01) {
  const s = new Manoeuvring(model, { u: speed }, { rudderRate });
  s.revolutions = s.selfPropulsion(speed);
  s.order = side * 35 * DEG;
  const L = model.length;
  let advance,
    diameter,
    peak = 0;
  while (diameter === undefined && s.time < 600) {
    s.step(dt);
    peak = Math.max(peak, -side * s.state.heel);
    const h = Math.abs(s.state.heading);
    if (advance === undefined && h >= Math.PI / 2) advance = s.state.x / L;
    if (h >= Math.PI) diameter = Math.abs(s.state.z) / L;
  }
  // The steady turn: its heel averaged over the roll's ringing, its speed and yaw rate.
  const start = s.time;
  let sum = 0,
    n = 0;
  while (s.time < start + 60) {
    s.step(dt);
    if (s.time > start + 20) (sum += s.state.heel), n++;
  }
  return {
    advance,
    diameter,
    peak,
    heel: (-side * sum) / n,
    speed: Math.hypot(s.state.u, s.state.v) / speed,
    r: Math.abs(s.state.r),
  };
}

test("KCS heels outward in its turn and turns tighter for it, as SIMMAN's free-running tests show (Fukui et al.'s roll)", () => {
  // KCS at Fn 0.26 (24 kn), GM 0.60 m, rudder 2.32 deg/s full scale: MARIN and KRISO's free-running models (Yun et al.
  // 2021, Tables 1 to 5, both sides averaged) turned with advance 2.92 to 2.99 L and tactical diameter 2.70 to 2.79 L, heeled
  // out 15.0 to 17.0 degrees at most and 4.6 to 5.1 degrees steady, at 10.5 to 11.9 kn and 1.11 to 1.22 deg/s.
  const scale = 230 / KCS_MODEL.length,
    speed = 0.26 * Math.sqrt(9.81 * KCS_MODEL.length),
    rate = 2.32 * DEG * Math.sqrt(scale),
    starboard = turn(KCS_MODEL, speed, 1, rate),
    port = turn(KCS_MODEL, speed, -1, rate),
    upright = turn({ ...KCS_MODEL, heel: undefined }, speed, 1, rate),
    mean = (k) => (starboard[k] + port[k]) / 2,
    within = (value, lo, hi, tolerance) => value >= lo * (1 - tolerance) && value <= hi * (1 + tolerance);
  assert.ok(
    within(starboard.advance, 2.92, 2.99, 0.01) && within(starboard.diameter, 2.7, 2.79, 0.01),
    JSON.stringify(starboard),
  );
  // Both sides: the propeller's wake changes with drift by KVLCC2's constants (KCS's are not published), so the sides differ.
  assert.ok(
    within(mean('advance'), 2.92, 2.99, 0.03) && within(mean('diameter'), 2.7, 2.79, 0.03),
    JSON.stringify(port),
  );
  // It heels outward, the most as it starts to turn, then steady. Its rudder's roll lever and its roll damping, which
  // Fukui et al. do not print, were fitted to MARIN's largest and final roll (16.98 and 5.09 degrees); against the data not
  // fitted: KRISO's largest roll, 15.0 to 15.5, within 12 percent, and the steady roll of both sides within 10 percent of
  // the measured 4.58 to 5.09.
  assert.ok(
    Math.abs(starboard.peak / DEG / 16.98 - 1) < 0.03 && within(mean('peak') / DEG, 15, 15.5, 0.12),
    `${starboard.peak / DEG} ${port.peak / DEG}`,
  );
  assert.ok(within(mean('heel') / DEG, 4.58, 5.09, 0.1), `${starboard.heel / DEG} ${port.heel / DEG}`);
  // Upright it turns 8 percent wider (Fukui et al. fig. 18).
  assert.ok(upright.diameter > 1.05 * starboard.diameter && upright.peak === 0, JSON.stringify(upright));
  assert.ok(within(mean('speed') * 24, 10.5, 11.9, 0.05), `${mean('speed') * 24} kn`);
  assert.ok(
    within(mean('r') / DEG / Math.sqrt(scale), 1.11, 1.22, 0.05),
    `${mean('r') / DEG / Math.sqrt(scale)} deg/s`,
  );
  // KVLCC2 (GM 5.71 m, KG 18.6 m; its side force at half its draught) barely heels: the fourth degree matters little for it
  // (ITTC 2011, p. 143), and both sides of the L7 model turn within 3 percent of SIMMAN's free-running tests (advance 3.08 to
  // 3.25 L, tactical diameter 3.08 to 3.34 L: Quadvlieg et al. 2014, SIMMAN 2008, MARIN).
  const k = 320 / 7,
    tanker = { ...KVLCC2_L7, heel: { metacentricHeight: 5.71 / k, gravityDepth: (20.8 - 18.6) / k } },
    kSpeed = (15.5 * 0.514444) / Math.sqrt(k),
    a = turn(tanker, kSpeed, 1, 1.76 * DEG * Math.sqrt(k), 0.02),
    b = turn(tanker, kSpeed, -1, 1.76 * DEG * Math.sqrt(k), 0.02),
    flat = turn(KVLCC2_L7, kSpeed, 1, 1.76 * DEG * Math.sqrt(k), 0.02);
  assert.ok(a.peak / DEG < 2 && Math.abs(a.diameter / flat.diameter - 1) < 0.02, JSON.stringify([a, flat]));
  assert.ok(
    within((a.advance + b.advance) / 2, 3.08, 3.25, 0.03) && within((a.diameter + b.diameter) / 2, 3.08, 3.34, 0.03),
    JSON.stringify(b),
  );
});

test('a rigid body held by the ship solver heels in its turn as the four-degree MMG ship does', () => {
  const M = KCS_MODEL,
    kx = Math.sqrt((4 * M.draught ** 2 + M.beam ** 2) / 12),
    model = {
      ...M,
      centre: 0,
      gyration: Math.sqrt((M.length ** 2 + M.beam ** 2) / 12),
      heel: { ...M.heel, gyration: kx },
    },
    speed = 0.26 * Math.sqrt(9.81 * M.length),
    rate = 2.32 * DEG * Math.sqrt(230 / M.length),
    // The world's gravity holds the ship upright through its GM; the rigid bodies' own has none (no buoyancy here).
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    body = physics.addBody(null, {
      linearVelocity: [speed, 0, 0],
      colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(ships, { ships: [{ row: body.row, model, rudderRate: rate }] })
      .couple(['ship', 'rigid'], 'staggered'),
    reference = new Manoeuvring(model, { u: speed }, { rudderRate: rate, gravity: 9.81 }),
    n = reference.selfPropulsion(speed);
  reference.revolutions = n;
  reference.order = 35 * DEG;
  ships.control(0).revolutions = n;
  ships.control(0).rudder = 35 * DEG;
  let first = 0,
    worst = 0,
    peak = 0;
  for (let t = 1; t <= 60 * 12; t++) {
    world.advance(t);
    reference.step(1 / 60);
    const off = Math.abs(ships.status(0).heel - reference.state.heel);
    if (t <= 60 * 4) first = Math.max(first, off);
    worst = Math.max(worst, off);
    peak = Math.max(peak, -reference.state.heel);
  }
  // Through the peak heel of 16 degrees in the first 4 s within 1 degree; over 12 s (four roll periods, the body's restoring
  // moment taken a step behind) within 2.5; and on the same path.
  assert.ok(
    peak > 15 * DEG && first < 1 * DEG && worst < 2.5 * DEG,
    `${first / DEG}, ${worst / DEG} of ${peak / DEG} degrees`,
  );
  const p = body.position;
  assert.ok(Math.hypot(p[0] - reference.state.x, p[2] - reference.state.z) < 0.02 * M.length, `${p}`);
  // A ship that heels needs gravity for its restoring moment, and a roll held by 'model' or 'hull'.
  const flat = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    other = flat.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.1, 0.15], mass: 40 } });
  assert.throws(
    () =>
      new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] })
        .add(new RigidSolver(), { physics: flat })
        .add(new ShipSolver(), { ships: [{ row: other.row, model }] }),
    (e) => e.code === 'unsupported' && /no gravity/.test(e.message),
  );
  assert.throws(
    () =>
      new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(new RigidSolver(), { physics: flat })
        .add(new ShipSolver(), { ships: [{ row: other.row, model, roll: 'keel' }] }),
    (e) => e.code === 'unsupported' && /'model' or 'hull'/.test(e.message),
  );
  assert.throws(
    () => new Manoeuvring({ ...M, heel: { ...M.heel, metacentricHeight: 0 } }),
    (e) => e.code === 'unsupported' && /metacentric height above 0/.test(e.message),
  );
});

test("level ice resists a ship by Riska et al.'s regression: Hu and Zhou's printed values, and MT Uikku's basin tests within their scatter", () => {
  // MT Uikku (L 150 m, B 21.3 m, T 9.5 m, bow 39 m, parallel midbody 65 m, stem 30 degrees) in the Aalto ice basin at 1:31.56,
  // full-scale values (Hu and Zhou 2015, Tables 3 to 7): ice thickness, speed, measured mean and standard deviation, kN, and
  // Riska's resistance as they print it.
  const uikku = { length: 150, beam: 21.3, draught: 9.5, stem: 30 * DEG, bow: 39, parallel: 65 };
  for (const [h, V, mean, spread, printed] of [
    [0.77, 0.2, 470, 120, 610],
    [0.76, 0.5, 560, 120, 630],
    [0.96, 0.2, 670, 220, 800],
    [0.95, 0.5, 720, 200, 840],
  ]) {
    const r = iceResistance(uikku, h, V).resistance / 1000;
    // Within 1.5 percent of the values they print, which are rounded to 10 kN.
    assert.ok(Math.abs(r / printed - 1) < 0.015, `${r} against Riska's ${printed} kN as printed`);
    // The regression runs 14 to 30 percent above the basin's means, within 1.2 of their standard deviations.
    assert.ok(r > mean && r - mean <= 1.2 * spread, `${r} against ${mean} +- ${spread} kN measured`);
  }
  assert.equal(iceResistance(uikku, 0, 3).resistance, 0);
  assert.throws(
    () => iceResistance({ ...uikku, stem: 0 }, 1, 1),
    (e) => e.code === 'unsupported' && /stem angle/.test(e.message),
  );
  // Under the solver: KVLCC2's model steams from open water into ice a centimetre thick and slows to where its thrust meets
  // the open water's resistance and the ice's; with the screw slowed below the ice's breaking part it stays stopped in it.
  const speed = (15.5 * 0.514444) / Math.sqrt(320 / 7),
    iceHull = { stem: 30 * DEG, bow: 1.5, parallel: 3 },
    thickness = (x) => (x > 10 ? 0.01 : 0),
    { body, ships, world } = plane({ iceHull }, { speed, params: { ice: { thickness } } }),
    open = plane({ iceHull }, { speed });
  ships.control(0).revolutions = open.ships.control(0).revolutions = ships.revolutionsFor(0, speed);
  for (let t = 1; t <= 60 * 60; t++) {
    world.advance(t);
    open.world.advance(t);
  }
  const s = ships.status(0),
    r = iceResistance({ length: 7, beam: 1.27, draught: 0.46, ...iceHull }, 0.01, s.u).resistance;
  assert.ok(body.position[0] > 10 && s.u < 0.9 * open.ships.status(0).u, `${s.u} against ${open.ships.status(0).u}`);
  assert.ok(Math.abs(s.ice / r - 1) < 1e-6, `${s.ice} against ${r}`);
  const held = plane({ iceHull }, { params: { ice: { thickness: 0.05 } } });
  held.ships.control(0).revolutions = 2;
  for (let t = 1; t <= 600; t++) held.world.advance(t);
  assert.ok(
    Math.abs(held.body.linearVelocity[0]) < 1e-6 && held.ships.status(0).ice > 0,
    `${held.body.linearVelocity}`,
  );
  assert.throws(
    () => plane({ iceHull: { stem: 2, bow: 1, parallel: 1 } }),
    (e) => e.code === 'unsupported' && /stem angle/.test(e.message),
  );
});

test("waves' mean drift: S175's beam-sea sway and head-sea added resistance as Yasukawa and Adnan measured them, KVLCC2's as Lee et al. and Sadat-Hosseini et al. did", () => {
  // The modified Bessel functions to Abramowitz and Stegun's tables.
  assert.ok(Math.abs(besselI1(1) - 0.565159) < 1e-6 && Math.abs(besselK1(1) - 0.601907) < 1e-6);
  assert.ok(Math.abs(besselI1(5) / 24.33564 - 1) < 1e-6 && Math.abs(besselK1(3) / 0.0401564 - 1) < 1e-5);
  const g = 9.81,
    rho = 1025,
    omega = (L, r) => Math.sqrt((2 * Math.PI * g) / (r * L)),
    // S175 (Yasukawa 2006, Table 1; k_yy 0.269 L) at Fn 0.15, upright, H / L 0.02 (Yasukawa and Adnan 2006, Figs. 8 and 9,
    // read from the figures to about 3 percent): added resistance over rho g zeta^2 B^2 / L in head seas, sway force in
    // beam seas from starboard.
    s175 = { length: 175, beam: 25.4, draught: 9.5, block: 0.572, pitchGyration: 0.269 },
    U = 0.15 * Math.sqrt(g * 175),
    unit = (rho * g * 25.4 ** 2) / 175;
  for (const [r, measured] of [
    [1.0, 8.25],
    [1.2, 6.0],
    [1.5, 2.6],
  ]) {
    const sigma = addedResistance(s175, 1, omega(175, r), 0, U, g, rho) / unit;
    assert.ok(Math.abs(sigma / measured - 1) < 0.15, `S175 head seas at lambda/L ${r}: ${sigma} against ${measured}`);
  }
  for (const [r, measured] of [
    [0.5, -10.9],
    [0.7, -5.2],
    [1.0, -1.0],
  ]) {
    const beam = driftLoads(
      s175,
      { amplitude: 1, period: (2 * Math.PI) / omega(175, r), direction: -Math.PI / 2 },
      0,
      U,
      g,
      rho,
    );
    assert.ok(
      Math.abs(beam.Y / unit / measured - 1) < 0.25,
      `S175 beam seas at lambda/L ${r}: ${beam.Y / unit} against ${measured}`,
    );
    // From starboard the waves push the ship to port, and their added resistance is SNNM's for beam seas.
    const side = addedResistance(s175, 1, omega(175, r), Math.PI / 2, U, g, rho);
    assert.ok(beam.X < 0 && Math.abs(beam.X / -side - 1) < 1e-6, `${beam.X} ${side}`);
  }
  // KVLCC2 at Fn 0.142 in head seas (Hizir et al. 2019, Fig. 6, read from the figure): the measured band of Lee et al. 2013
  // (H / L 0.010 and 0.015) and Sadat-Hosseini et al. 2013, from the peak to long waves.
  const kvlcc2 = { length: 320, beam: 58, draught: 20.8, block: 0.8098 },
    Uk = 0.142 * Math.sqrt(g * 320),
    unitK = (rho * g * 58 ** 2) / 320;
  let sum = 0;
  const band = [
    [1.0, 5.35, 7.15],
    [1.2, 6.05, 6.9],
    [1.4, 3.6, 4.35],
    [1.6, 1.95, 2.05],
    [2.0, 0.55, 0.95],
  ];
  for (const [r, lo, hi] of band) {
    const sigma = addedResistance(kvlcc2, 1, omega(320, r), 0, Uk, g, rho) / unitK,
      off = sigma > hi ? sigma / hi - 1 : sigma < lo ? 1 - sigma / lo : 0;
    assert.ok(off < 0.35, `KVLCC2 at lambda/L ${r}: ${sigma} against ${lo} to ${hi}`);
    sum += off;
  }
  // Off the band by 8 percent on average, 33 percent at lambda/L 1.6 (docs/limits.md).
  assert.ok(sum / band.length < 0.1, `${sum / band.length}`);
  assert.throws(
    () => driftLoads(s175, { amplitude: 1, period: 0, direction: 0 }, 0, U),
    (e) => e.code === 'unsupported' && /period above 0/.test(e.message),
  );
});

test("KVLCC2 turns in an irregular head sea as Hasnan et al.'s free-running model did: its approach speed, advance, tactical diameter and drift", () => {
  // Hasnan, Yasukawa et al. 2019 (Tables 7, 9 and 11): KVLCC2 at the screw's 15.5 kn calm-water revolutions met a
  // Bretschneider sea of H_1/3 4.4 m and T_1 10.6 s (as measured), cos^4 spread, from ahead; it slowed to 13.0 kn and
  // turned at 35 degrees with advance 2.86 to 2.95 L, tactical diameter 2.99 to 3.18 L, and drifted 0.56 to 0.58 L between
  // its headings at 90 and 450 degrees (0.23 to 0.31 L in calm water).
  const k = 320 / 7,
    v0 = (15.5 * 0.514444) / Math.sqrt(k),
    waves = { significantHeight: 4.4 / k, period: 10.6 / Math.sqrt(k), direction: Math.PI, spread: 4 },
    rate = 2.32 * DEG * Math.sqrt(k),
    n = new Manoeuvring(KVLCC2_L7, { u: v0 }).selfPropulsion(v0),
    straight = new Manoeuvring(KVLCC2_L7, { u: v0 }, { rudderRate: rate, waves });
  straight.revolutions = n;
  while (straight.time < 300) straight.step(0.05);
  const knots = (Math.hypot(straight.state.u, straight.state.v) / v0) * 15.5;
  assert.ok(Math.abs(knots / 13 - 1) < 0.08, `${knots} kn against 13.0`);
  for (const side of [1, -1]) {
    const m = new Manoeuvring(KVLCC2_L7, { u: straight.state.u }, { rudderRate: rate, waves });
    m.revolutions = n;
    m.order = side * 35 * DEG;
    let advance, diameter;
    const marks = [];
    while (m.time < 2000 && marks.length < 2) {
      m.step(0.05);
      const h = Math.abs(m.state.heading);
      if (advance === undefined && h >= Math.PI / 2) advance = m.state.x / 7;
      if (diameter === undefined && h >= Math.PI) diameter = Math.abs(m.state.z) / 7;
      if (h >= Math.PI / 2 + 2 * Math.PI * marks.length) marks.push([m.state.x, m.state.z]);
    }
    const drift = Math.hypot(marks[1][0] - marks[0][0], marks[1][1] - marks[0][1]) / 7;
    assert.ok(advance > 2.86 * 0.97 && advance < 2.95 * 1.03, `advance ${advance}`);
    assert.ok(diameter > 2.99 * 0.97 && diameter < 3.18 * 1.03, `tactical diameter ${diameter}`);
    // 15 percent short of the measured drift (docs/limits.md), within twice its 9 percent spread between runs.
    assert.ok(drift > 0.56 * 0.8 && drift < 0.58 * 1.2, `drift ${drift}`);
  }
});

test("a planing hull's steady run by Savitsky's equations: Shoemaker's model 29 in the tank", () => {
  // NACA TN 509 model 29 (b 16 in, deadrise 20 degrees, 80 lb, fresh water) as Alourdas 2016 tabulates it: measured trim 4.0
  // degrees at both speeds, drag 15.20 lb at 18.01 kn and 16.0 lb at 20.92 kn.
  const lb = 4.4482216,
    inch = 0.0254,
    kn = 0.514444;
  for (const [speed, lcg, trim, drag] of [
    [18.01, 18.5, 4.0, 15.2],
    [20.92, 18.3, 4.0, 16.0],
  ]) {
    const run = savitsky({ beam: 16 * inch, deadrise: 20 * DEG, mass: (80 * lb) / 9.81, lcg: lcg * inch }, speed * kn, {
      density: 999,
      viscosity: 1.14e-6,
      gravity: 9.81,
      roughness: 0,
    });
    assert.ok(Math.abs(run.resistance / lb / drag - 1) < 0.04, `drag ${run.resistance / lb} lb against ${drag}`);
    assert.ok(Math.abs(run.trim / DEG / trim - 1) < 0.15 && run.inRange, `trim ${run.trim / DEG} against ${trim}`);
  }
  assert.throws(
    () => savitsky({ beam: 0.4, deadrise: 2, mass: 36, lcg: 0.47 }, 9),
    (e) => e.code === 'unsupported' && /deadrise/.test(e.message),
  );
});

test('a planing boat on a rigid body runs at the trim and wetted length Fridsma measured, and porpoises where his did', () => {
  // Fridsma 1969 (Fig. 11): a prismatic model 1.143 m long, beam 0.2286 m, deadrise 20 degrees, C_Delta 0.608, pitch gyration
  // 0.25 L, its centre of gravity 60, 65 and 70 percent of its length aft of the bow; trim, degrees, and mean wetted length
  // over the beam, read from the figure (+-0.2 degrees, +-0.05). At 70 percent and C_v 3.99 it porpoised.
  const g = 9.81,
    B = 0.2286,
    L = 5 * B,
    beta = 20 * DEG,
    mass = 0.608 * 999 * B ** 3,
    hz = 480,
    run = (aft, cv) => {
      const lcg = (1 - aft) * L,
        vcg = (B / 4) * Math.tan(beta),
        V = cv * Math.sqrt(g * B),
        t0 = 4 * DEG,
        y0 = -0.03 + lcg * Math.sin(t0) + vcg * Math.cos(t0),
        physics = new Physics(null, { fixedTimestep: 1 / hz, gravity: [0, -g, 0] }),
        body = physics.addBody(null, {
          position: [0, y0, 0],
          rotation: [0, 0, Math.sin(t0 / 2), Math.cos(t0 / 2)],
          linearVelocity: [V, 0, 0],
          // A box 0.866 L long has the pitch gyration 0.25 L.
          colliders: { shape: 'box', halfExtents: [0.433 * L, 0.02, B / 2], mass },
        }),
        planing = new PlaningSolver(),
        world = new PhysicsWorld({ rate: { num: hz, den: 1 }, gravity: [0, -g, 0] })
          .add(new RigidSolver(), { physics })
          .add(planing, {
            boats: [
              { row: body.row, beam: B, deadrise: beta, length: L, transom: [-lcg, -vcg, 0], propeller: [0, 0, 0] },
            ],
            density: 999,
            viscosity: 1.14e-6,
            roughness: 0,
            level: 3,
          })
          .couple(['planing', 'rigid'], 'staggered');
      // Towed: the thrust found to hold the speed over 20 s, then held for 25 s.
      let thrust = 0.11 * mass * g,
        held = 0,
        n = 0;
      const trims = [],
        lambdas = [];
      for (let t = 1; t <= hz * 45; t++) {
        const s = planing.status(0);
        if (t < hz * 20) {
          thrust = Math.max(0, thrust + (1.5 * mass * (V - s.speed)) / hz);
          if (t > hz * 15) (held += thrust), n++;
        } else if (t === hz * 20) thrust = held / n;
        planing.control(0).thrust = thrust;
        world.advance(t);
        if (t > hz * 35) trims.push(planing.status(0).trim / DEG), lambdas.push(planing.status(0).lambda);
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      return { trim: mean(trims), lambda: mean(lambdas), swing: Math.max(...trims) - Math.min(...trims) };
    };
  for (const [aft, cv, trim, lambda] of [
    [0.6, 2.0, 3.8, 3.95],
    [0.6, 3.33, 4.2, 3.1],
    [0.65, 2.0, 5.5, 3.45],
    [0.65, 2.66, 5.7, 2.8],
    [0.65, 3.99, 4.3, 2.45],
    [0.7, 2.0, 8.1, 2.7],
    [0.7, 3.33, 5.5, 2.15],
  ]) {
    const r = run(aft, cv);
    assert.ok(Math.abs(r.trim / trim - 1) < 0.1, `${aft} ${cv}: trim ${r.trim} against ${trim}`);
    assert.ok(Math.abs(r.lambda / lambda - 1) < 0.12, `${aft} ${cv}: wetted length ${r.lambda} against ${lambda}`);
    // Day and Haag's porpoising: a pitch swing of 2 degrees or more.
    assert.ok(r.swing < 2, `${aft} ${cv}: swings ${r.swing} degrees`);
  }
  assert.ok(run(0.7, 3.99).swing > 2);
});

test("oars: Caplan and Gardner's Macon blade, Coppel et al.'s eight, and a single scull against Holt et al.'s racing measurements", () => {
  // The blade's coefficients through the measured points (Coppel et al. 2009, Table 1).
  for (const [a, lift, drag] of [
    [20, 0.7, 0.22],
    [90, 0.04, 1.85],
    [135, -1.19, 1.25],
  ]) {
    const c = bladeCoefficients(a * DEG);
    assert.ok(Math.abs(c.lift - lift) < 1e-9 && Math.abs(c.drag - drag) < 1e-9, `${a}: ${c.lift} ${c.drag}`);
  }
  assert.ok(bladeCoefficients(0).drag === 0);
  const row = (boat, stroke, speed, mass, halfLength) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, 0, 0] }),
      // Pitch and roll held: the hull's buoyancy that holds them is not in this world.
      body = physics.addBody(null, {
        linearVelocity: [speed, 0, 0],
        enabledRotations: [false, true, false],
        colliders: { shape: 'box', halfExtents: [halfLength, 0.2, 0.2], mass },
      }),
      rowing = new RowingSolver(),
      world = new PhysicsWorld({ rate: { num: 240, den: 1 } })
        .add(new RigidSolver(), { physics })
        .add(rowing, { boats: [{ row: body.row, ...boat }], level: 2 })
        .couple(['rowing', 'rigid'], 'staggered');
    Object.assign(rowing.control(0), stroke);
    let sum = 0,
      power = 0,
      useful = 0,
      n = 0,
      lo = Infinity,
      hi = -Infinity;
    for (let t = 1; t <= 240 * 30; t++) {
      world.advance(t);
      const s = rowing.status(0);
      if (t > 240 * 20) {
        sum += s.hull;
        power += s.rowingPower;
        useful += s.propulsivePower;
        n++;
        lo = Math.min(lo, s.hull);
        hi = Math.max(hi, s.hull);
      }
    }
    return { speed: sum / n, power: power / n, efficiency: useful / power, range: hi - lo, body };
  };
  // Coppel et al.'s heavyweight eight: crew 740 kg, boat and cox 146 kg, 30 strokes a minute, drive 0.92 s, catch -55 and
  // finish 35 degrees, outboard 2.365 m, Macon blades, Wellicome's drag with Hoerner's air: their model ran at 5.25 m/s.
  const oars = [];
  for (let i = 0; i < 8; i++)
    oars.push({
      pin: [4.2 - 2.8 * Math.floor(i / 2), 0.2, (i % 2 ? 1 : -1) * 0.84],
      side: i % 2 ? 1 : -1,
      outboard: 2.365,
    });
  const eight = row(
    { oars, crew: 740, drag: (v) => 13.05 * v * v - 11.22 * v + 24.93 + 8 * 0.348 * v * v },
    { rate: 30, drive: 0.92, catchAngle: -55 * DEG, finishAngle: 35 * DEG },
    5,
    886,
    8.5,
  );
  // 7 percent below theirs: the blade goes in only once it moves aft through the water (docs/limits.md).
  assert.ok(Math.abs(eight.speed / 5.25 - 1) < 0.08, `eight ${eight.speed} m/s against 5.25`);
  assert.ok(Math.abs(eight.body.position[2]) < 1e-6, 'a balanced rig runs straight');
  // A men's single at 35.1 strokes a minute, catch -62 and finish 43.5 degrees (Holt et al. 2020, 2021: 4.60 +- 0.10 m/s,
  // a 2.27 m/s swing within the stroke), Kleshnev's drag 3.19 N s^2/m^2, a sculler of 85.8 kg in 17 kg of boat and oars;
  // the blades 0.08 m^2 at 1.80 m and a 0.85 s drive are assumptions. Kleshnev measured singles' blades 78.5 +- 3.1 percent
  // efficient.
  const single = row(
    {
      oars: [
        { pin: [0, 0.2, 0.8], side: 1, outboard: 1.8, area: 0.08 },
        { pin: [0, 0.2, -0.8], side: -1, outboard: 1.8, area: 0.08 },
      ],
      crew: 85.8,
      drag: 3.19,
    },
    { rate: 35.1, drive: 0.85, catchAngle: -62 * DEG, finishAngle: 43.5 * DEG },
    4.5,
    103,
    4,
  );
  assert.ok(Math.abs(single.speed / 4.6 - 1) < 0.05, `single ${single.speed} m/s against 4.60`);
  assert.ok(Math.abs(single.range / 2.27 - 1) < 0.1, `swing ${single.range} against 2.27`);
  assert.ok(single.efficiency > 0.785 - 2 * 0.031 && single.efficiency < 0.785 + 2 * 0.031, `${single.efficiency}`);
  assert.throws(
    () => row({ oars: [{ pin: [0, 0, 1], side: 2, outboard: 2 }], crew: 80, drag: 3 }, {}, 0, 100, 4),
    (e) => e.code === 'unsupported' && /side: 1/.test(e.message),
  );
});

test("a sailing yacht by the Delft series and the ORC's sails: Sysser 44's wetted area, the YD-41's ORC polar, and a yacht on a rigid body at its VPP speed", () => {
  const kn = 0.514444;
  // Sysser 44 (Kleijweg, Table C.1): the wetted-area regression against its measured 23.83 m^2.
  const sysser = {
    length: 10,
    beam: 3.013,
    draught: 0.681,
    volume: 8.087,
    waterplane: 20.13,
    lcb: 5.329,
    lcf: 5.625,
    prismatic: 0.554,
    midship: 0.712,
    keel: { draught: 1.9, volume: 0.2, root: 1.4, tip: 0.8, thickness: 0.12, centre: 0.7 },
    rudder: { area: 0.6, chord: 0.5, thickness: 0.12 },
  };
  assert.ok(Math.abs(yachtWettedArea(sysser) / 23.83 - 1) < 0.01, `${yachtWettedArea(sysser)}`);
  // The YD-41 (Larsson and Eliasson's design as Teixeira tabulates it) against its ORC certificate's polar (Teixeira, Table
  // XIII-1, computed by the ORC's VPP from the measured hull). Its keel and rudder geometry and GM 2.5 m (BM from the
  // waterplane, KG from its ballast) are assumptions; Teixeira's own Delft-series VPP came within 16 percent.
  const hull = {
      length: 11.9,
      beam: 3.18,
      draught: 0.4,
      volume: 6.05,
      waterplane: 26.8,
      lcb: 6.44,
      lcf: 6.82,
      prismatic: 0.56,
      midship: 0.72,
      keel: { draught: 2.3, volume: 0.25, root: 1.6, tip: 0.9, thickness: 0.12, centre: 0.9 },
      rudder: { area: 0.9, chord: 0.6, thickness: 0.12 },
    },
    rig = { I: 16.2, J: 5.1, P: 16.7, E: 5.6, boom: 1.8, freeboard: 1, mass: 6200, metacentricHeight: 2.5 },
    winds = [6, 8, 10, 12, 14, 16, 20, 24],
    polar = {
      52: [5.79, 6.98, 7.67, 7.99, 8.13, 8.21, 8.3, 8.27],
      60: [6.12, 7.29, 7.94, 8.27, 8.43, 8.54, 8.65, 8.66],
      75: [6.37, 7.5, 8.14, 8.56, 8.89, 9.11, 9.35, 9.45],
      90: [6.22, 7.41, 8.11, 8.6, 9.07, 9.49, 10.08, 10.4],
      110: [5.45, 6.69, 7.68, 8.31, 8.84, 9.4, 10.6, 11.31],
      120: [5.01, 6.34, 7.4, 8.11, 8.65, 9.2, 10.48, 12.04],
      135: [4.31, 5.59, 6.68, 7.57, 8.19, 8.7, 9.83, 11.27],
      150: [3.62, 4.76, 5.78, 6.64, 7.41, 8.0, 8.9, 9.9],
    };
  let sum = 0,
    n = 0;
  for (const [twa, speeds] of Object.entries(polar))
    winds.forEach((tws, i) => {
      const run = velocityPrediction(hull, rig, tws * kn, Number(twa) * DEG),
        off = Math.abs(run.speed / kn / speeds[i] - 1);
      assert.ok(off < 0.15, `${twa} degrees in ${tws} kn: ${run.speed / kn} kn against ${speeds[i]}`);
      sum += off;
      n++;
    });
  assert.ok(sum / n < 0.06, `${sum / n}`);
  // On a rigid body (pitch held: nothing floats it here) under the solver, reaching across a 12 kn wind and close-hauled,
  // the yacht settles to the VPP's speed and heel at the true wind angle its helm holds it at.
  for (const twa of [90, 52]) {
    const tws = 12 * kn,
      physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
      body = physics.addBody(null, {
        linearVelocity: [3, 0, 0],
        enabledRotations: [true, true, false],
        colliders: { shape: 'box', halfExtents: [6, 2, 1.6], mass: 6200 },
      }),
      sailing = new SailingSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(new RigidSolver(), { physics })
        .add(sailing, {
          yachts: [{ row: body.row, hull, rig }],
          wind: [-tws * Math.cos(twa * DEG), 0, -tws * Math.sin(twa * DEG)],
        })
        .couple(['sailing', 'rigid'], 'staggered');
    sailing.control(0).heading = 0;
    for (let t = 1; t <= 60 * 120; t++) world.advance(t);
    const s = sailing.status(0),
      vpp = velocityPrediction(hull, rig, tws, twa * DEG - s.heading);
    assert.ok(
      Math.abs(s.speed / vpp.speed - 1) < 0.05,
      `${twa}: ${s.speed / kn} kn against the VPP's ${vpp.speed / kn}`,
    );
    // Heeled to port, the wind from starboard.
    assert.ok(Math.abs(-s.heel - vpp.heel) < 2.5 * DEG, `${twa}: heel ${s.heel / DEG} against ${vpp.heel / DEG}`);
  }
});

test("the ships' work counts are deterministic and grow with the fleet, and the telegraph holds a speed order through ice", () => {
  // Two ships against one: each step evaluates each ship's MMG forces once and tests each wall once per ship.
  const fleet = (count) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
      rows = [];
    for (let i = 0; i < count; i++)
      rows.push(
        physics.addBody(null, {
          position: [0, 0, 20 * i],
          linearVelocity: [1, 0, 0],
          colliders: { shape: 'box', halfExtents: [3.5, 0.46, 0.635], mass: 1025 * KVLCC2_L7.volume },
        }).row,
      );
    const ships = new ShipSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(new RigidSolver(), { physics })
        .add(ships, {
          ships: rows.map((row) => ({ row, model: { ...KVLCC2_L7, centre: 0 } })),
          walls: [{ from: [-50, -10], to: [50, -10] }],
        })
        .couple(['ship', 'rigid'], 'staggered');
    for (const [i] of rows.entries()) ships.control(i).revolutions = 8;
    world.advance(10);
    return ships.workCounts();
  };
  const one = fleet(1),
    two = fleet(2);
  assert.deepEqual(one, { ships: 1, forceEvaluations: 1, driftTables: 0, wallTests: 1, shallowModels: 0 });
  assert.deepEqual(two, { ships: 2, forceEvaluations: 2, driftTables: 0, wallTests: 2, shallowModels: 0 });
  // The telegraph: ordered 1.0 m/s, the model steams at it in open water and holds it as it enters ice a centimetre thick.
  const iceHull = { stem: 30 * DEG, bow: 1.5, parallel: 3 },
    { ships, world } = plane({ iceHull }, { speed: 0.6, params: { ice: { thickness: (x) => (x > 80 ? 0.01 : 0) } } });
  ships.control(0).speed = 1;
  let open = 0;
  for (let t = 1; t <= 60 * 200; t++) {
    world.advance(t);
    if (t === 60 * 70) open = ships.status(0).u;
  }
  const s = ships.status(0);
  assert.ok(Math.abs(open - 1) < 0.02, `open water ${open} m/s`);
  assert.ok(s.ice > 0 && Math.abs(s.u - 1) < 0.02, `in ice ${s.u} m/s`);
});

test("measured checks: Sysser 1 in the Delft tank, the yacht FAIR V at sea, and the B4-70's four quadrants against its open water", () => {
  // Sysser 1 (den Ouden 2022, DSYHS measurement data, 4TU.ResearchData, CC0; model scale): the bare hull's measured
  // resistance upright and at 20 degrees of heel (17.3 C), and with its keel and rudder upright (20 C), N, by speed, m/s.
  // Sysser 1 is one of the series the regression was fitted to: this checks the transcription and the sums, within 9 percent.
  const sysser1 = {
      length: 1.6,
      beam: 0.5072,
      draught: 0.12704,
      volume: 0.0376136,
      waterplane: 0.558566,
      lcb: 0.83664,
      lcf: 0.85328,
      prismatic: 0.56441,
      midship: 0.64641,
      keel: { draught: 0.12704 + 0.219, volume: 0.00262, root: 0.414, tip: 0.262, thickness: 0.15, centre: 0.09336 },
      rudder: { area: 0.0275, chord: 0.11, thickness: 0.12 },
    },
    cold = { density: 998.7, viscosity: 1.08e-6, gravity: 9.81 },
    warm = { density: 998.2, viscosity: 1.004e-6, gravity: 9.81 };
  for (const [v, r] of [
    [0.792, 1.1084],
    [0.99, 1.88482],
    [1.189, 3.01934],
    [1.387, 4.75255],
    [1.585, 9.79318],
    [1.783, 19.4122],
    [1.981, 32.7027],
  ])
    assert.ok(Math.abs(yachtWater(sysser1, v, 0, 0, cold).upright / r - 1) < 0.09, `upright at ${v} m/s`);
  for (const [v, r] of [
    [0.99, 1.77142],
    [1.189, 3.10665],
    [1.387, 5.0607],
    [1.585, 10.1243],
    [1.783, 19.6024],
  ]) {
    const w = yachtWater(sysser1, v, 20 * DEG, 0, cold);
    assert.ok(Math.abs((w.upright + w.heeled) / r - 1) < 0.08, `heeled at ${v} m/s`);
  }
  for (const [v, r] of [
    [0.8, 1.79466],
    [1.0, 2.88263],
    [1.2, 4.44764],
    [1.4, 6.93821],
    [1.6, 13.6077],
    [1.8, 26.6304],
  ])
    assert.ok(
      Math.abs(yachtWater(sysser1, v, 0, 0, warm).resistance / r - 1) < 0.08,
      `with keel and rudder at ${v} m/s`,
    );
  // FAIR V, a KIT-34 sloop sailed at sea (Masuyama et al. 1992, Table 1; Figs. 11 and 12, read from the figures to 0.15
  // m/s and 2 degrees): measured in true winds of 5 to 8 m/s, its speed and heel by true wind angle. The VPP at 5 and 8 m/s
  // spans the measured cluster's middle, and its heel the measured range. Its waterplane (C_W 0.7), LCF, keel and rudder
  // and the boom's height are assumptions; C_M is C_B / C_P.
  const fair = {
      length: 8.55,
      beam: 2.42,
      draught: 0.41,
      volume: 3.78 / 1.025,
      waterplane: 0.7 * 8.55 * 2.42,
      lcb: 4.275 + 0.238,
      lcf: 4.275 + 0.32,
      prismatic: 0.563,
      midship: 0.398 / 0.563,
      keel: { draught: 1.94, volume: 0.2, root: 1.2, tip: 0.7, thickness: 0.12, centre: 0.75 },
      rudder: { area: 0.6, chord: 0.5, thickness: 0.12 },
    },
    fairRig = { I: 11.8, J: 3.5, P: 13.3, E: 4.7, boom: 1.5, freeboard: 0.8, mass: 3780, metacentricHeight: 1.307 };
  for (const [twa, speedLo, speedHi, heelLo, heelHi] of [
    [42, 2.6, 3.1, 15, 30],
    [55, 3.2, 3.6, 15, 34],
    [82, 3.3, 3.6, 10, 25],
    [112, 3.3, 4.0, 3, 12],
    [142, 2.1, 3.4, 0, 5],
  ]) {
    const light = velocityPrediction(fair, fairRig, 5, twa * DEG),
      fresh = velocityPrediction(fair, fairRig, 8, twa * DEG),
      middle = 0.5 * (speedLo + speedHi);
    assert.ok(
      middle > light.speed - 0.15 && middle < fresh.speed + 0.15,
      `${twa}: ${light.speed} to ${fresh.speed} m/s`,
    );
    assert.ok(
      light.heel / DEG < heelHi && fresh.heel / DEG > heelLo,
      `${twa}: heel ${light.heel / DEG} to ${fresh.heel / DEG}`,
    );
  }
  // The B4-70 at P/D 1.0: NSWC's four-quadrant Fourier fit of MARIN's tests against Oosterveld and van Oossanen's
  // open-water polynomials (independent fits of the same series) in the first quadrant, within 0.012 in K_T and 0.03 in
  // 10 K_Q; astern at bollard pull it gives 0.76 of its thrust ahead, where Healey's idealisation gives all of it.
  const b470 = { blades: 4, area: 0.7, pitch: 1 };
  for (const J of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const [ct, cq] = fourQuadrantCoefficients(B4_70_FOUR_QUADRANT, Math.atan2(J, 0.7 * Math.PI)),
      s = (Math.PI * (J * J + 0.49 * Math.PI * Math.PI)) / 8,
      o = wageningenB(b470, J);
    assert.ok(
      Math.abs(ct * s - o.kt) < 0.012 && Math.abs(10 * cq * s - 10 * o.kq) < 0.03,
      `J ${J}: ${ct * s} ${10 * cq * s}`,
    );
  }
  const screw = new Propeller(1, { ...bSeriesCurves(b470), fourQuadrant: B4_70_FOUR_QUADRANT }),
    astern = screw.load(-10, 0).kt / screw.load(10, 0).kt;
  assert.ok(Math.abs(astern + 0.756) < 0.005, `${astern}`);
  assert.throws(
    () => new Propeller(1, { ...KVLCC2_PROPELLER, fourQuadrant: { thrust: [[1], []], torque: [[1], [1]] } }),
    (e) => e.code === 'unsupported' && /Four-quadrant/.test(e.message),
  );
});

test("banks and shallows against measurement: Vantorre et al.'s container ship by a wall, and KVLCC2's zigzags and turns in shallow water", () => {
  // Model D, the container carrier of Vantorre et al. 2003 (Fig. 4, read from the figure to 2 to 10 units), at Fn 0.065 with
  // its screw stopped: 1000 N' against y_B. The moment, which steers the ship, is within 35 percent at h/T 1.5 and 1.1 and
  // the sway force's sign is right there; at h/T 1.2, near the attraction-to-repulsion change, the force runs to repulsion
  // where the measured one stays near nothing (docs/limits.md). Their regression fits three hulls, this one of them.
  const D = { length: 3.864, beam: 0.55, draught: 0.18, block: 0.588, diameter: 0.12 },
    V = 0.065 * Math.sqrt(9.81 * D.length),
    q = 0.5 * 1000 * D.length * D.draught * V * V;
  for (const [hT, yB, Y, N] of [
    [1.5, 0.44, 24, -9.8],
    [1.5, 0.67, 41, -15],
    [1.5, 0.78, 51, -17.6],
    [1.1, 0.28, -60, -30],
    [1.1, 0.67, -188, -102],
    [1.1, 0.78, -232, -117],
  ]) {
    const r = bankLoads(D, yB, hT * D.draught, V, 0, 1000, 9.81),
      n = (1000 * r.N) / (q * D.length),
      y = (1000 * r.Y) / q;
    assert.ok(Math.abs(n / N - 1) < 0.35, `h/T ${hT}, y_B ${yB}: N' ${n} against ${N}`);
    assert.ok(
      Math.sign(y) === Math.sign(Y) && Math.abs(y / Y - 1) < 0.45,
      `h/T ${hT}, y_B ${yB}: Y' ${y} against ${Y}`,
    );
  }
  // KVLCC2 in shallow water at 7 kn (Yun et al. 2015, KRISO; Eloot et al. 2015, FHR): the first overshoot of a 20/5
  // zigzag falls from 8.0 degrees at h/T 1.5 to 3.8 and 4.7 at 1.2, and the turn to 40 degrees of heading runs further:
  // 1.61, 1.69 and 2.00 L at h/T 2.0, 1.5 and 1.2. The model follows the trend but is too course-stable in shallow water
  // (KB-SHIP-SHALLOW1): overshoots 2.1 and 3.3 degrees, turns 2.1 to 3.3 L.
  const k = 320 / 7,
    v0 = (7 * 0.514444) / Math.sqrt(k),
    rate = 2.32 * DEG * Math.sqrt(k),
    at = (hT) => {
      const model = shallowWater(KVLCC2_L7, hT * KVLCC2_L7.draught),
        z = new Manoeuvring(model, { u: v0 }, { rudderRate: rate });
      z.revolutions = z.selfPropulsion(v0);
      z.order = 20 * DEG;
      let flipped = false,
        overshoot = null;
      while (z.time < 2000 && overshoot === null) {
        z.step(0.05);
        if (!flipped && z.state.heading > 5 * DEG) (z.order = -20 * DEG), (flipped = true);
        if (flipped && z.state.r < 0) overshoot = z.state.heading / DEG - 5;
      }
      const t = new Manoeuvring(model, { u: v0 }, { rudderRate: rate });
      t.revolutions = t.selfPropulsion(v0);
      t.order = 35 * DEG;
      while (t.state.heading < 40 * DEG) t.step(0.05);
      return { overshoot, reach: t.state.x / 7 };
    },
    h12 = at(1.2),
    h15 = at(1.5),
    h20 = at(2);
  assert.ok(
    h12.overshoot < h15.overshoot && h12.reach > h15.reach && h15.reach > h20.reach,
    JSON.stringify([h12, h15, h20]),
  );
});
