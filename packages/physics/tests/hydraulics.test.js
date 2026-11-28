// HYDRO-07, @margoengine/physics/hydraulics: every check is against a closed form, an independent solution computed
// here, or a published value with the source named.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  criticalDepth,
  darcyFriction,
  equalize,
  froudeNumber,
  hingedBellows,
  HydraulicRam,
  hydraulicJump,
  joukowsky,
  normalDepth,
  orificeConductance,
  orificeFlow,
  peltonRunner,
  pipeFlow,
  pipeLoss,
  pipeWaveSpeed,
  plugTracer,
  ramFrameAt,
  siphon,
  solveNetwork,
  specificEnergy,
  venturi,
  venturiFlow,
  WATER,
  water,
  waterBulkModulus,
  waterDensity,
  waterVaporPressure,
  waterViscosity,
} from '@margoengine/physics/hydraulics';

const g = 9.80665;
function near(actual, expected, tolerance, what = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);
}
const rel = (actual, expected, r, what) => near(actual, expected, Math.abs(expected) * r, what);

test('water properties match their published tables', () => {
  // Kell (1975) table: 998.2063 at 20 °C (1968 scale), 999.9720 at 4 °C.
  near(waterDensity(20), 998.206, 0.003, 'density 20');
  near(waterDensity(4), 999.972, 0.001, 'density 4');
  // Kestin, Sokolov and Wakeham (1978): 1.0016 mPa s at 20 °C by definition, 0.6527 at 40 °C, 0.2818 at 100 °C.
  assert.equal(waterViscosity(20), 1.0016e-3);
  rel(waterViscosity(40), 0.6527e-3, 1e-3, 'viscosity 40');
  rel(waterViscosity(0), 1.7914e-3, 1e-3, 'viscosity 0');
  rel(waterViscosity(100), 0.2818e-3, 5e-3, 'viscosity 100');
  // Saturation pressure (Wagner and Pruss, IAPWS-95): 2.3392 kPa at 20 °C, 101.418 kPa at 100 °C. Buck (1981) is within
  // 0.05 percent to 50 °C and within 0.2 percent at the boiling point.
  rel(waterVaporPressure(20), 2339.2, 5e-4, 'vapour 20');
  rel(waterVaporPressure(100), 101418, 2e-3, 'vapour 100');
  // Bulk modulus from Kell's compressibility: 1/(45.89e-11) = 2.179 GPa at 20 °C; 1/(50.885e-11) = 1.965 GPa at 0 °C.
  rel(waterBulkModulus(20), 2.18e9, 3e-3, 'bulk 20');
  rel(waterBulkModulus(0), 1.9652e9, 1e-4, 'bulk 0');
  const w = water(20);
  assert.equal(w.kinematicViscosity, w.dynamicViscosity / w.density);
  assert.equal(WATER.density, w.density);
  assert.throws(() => water(120), RangeError);
});

test('Colebrook, Haaland and Churchill friction factors agree with the Moody chart', () => {
  // Independent Colebrook solution by fixed-point iteration with host maths.
  const colebrook = (re, e) => {
    let x = 8;
    for (let i = 0; i < 200; i++) x = -2 * Math.log10(e / 3.7 + (2.51 * x) / re);
    return 1 / (x * x);
  };
  for (const re of [4e3, 1e4, 1e5, 1e6, 1e7, 1e8])
    for (const e of [0, 1e-6, 1e-4, 1e-3, 1e-2, 0.05]) {
      const c = colebrook(re, e);
      rel(darcyFriction(re, e, 'colebrook'), c, 1e-12, `colebrook ${re} ${e}`);
      rel(darcyFriction(re, e, 'haaland'), c, 0.02, `haaland ${re} ${e}`);
      // Churchill's blend departs most near Re 4000; above 1e4 it is within 3 percent of Colebrook.
      if (re >= 1e4) rel(darcyFriction(re, e, 'churchill'), c, 0.03, `churchill ${re} ${e}`);
    }
  // Moody chart readings: smooth pipe at Re 1e5 f = 0.0180; rough e/D 0.01 fully rough f = 0.0379 (von Karman limit).
  near(darcyFriction(1e5, 0, 'colebrook'), 0.018, 0.0002);
  near(darcyFriction(1e8, 0.01, 'colebrook'), 1 / (2 * Math.log10(3.7 / 0.01)) ** 2, 1e-5);
  // Laminar branch is Hagen-Poiseuille, and Churchill tends to it.
  assert.equal(darcyFriction(1000, 0.01, 'colebrook'), 0.064);
  rel(darcyFriction(500, 0, 'churchill'), 64 / 500, 1e-6);
  assert.equal(darcyFriction(0), 0);
  assert.throws(() => darcyFriction(1e5, 0, 'blasius'), RangeError);
});

test('pipe flow solves the energy equation exactly for laminar Hagen-Poiseuille flow', () => {
  // h = (1 + K) v²/2g + 32 ν L v / (g D²): a quadratic in v with an exact root.
  const d = 0.004,
    length = 3,
    k = 0.5,
    h = 0.05,
    nu = WATER.kinematicViscosity;
  const a = (1 + k) / (2 * g),
    b = (32 * nu * length) / (g * d * d),
    v = (-b + Math.sqrt(b * b + 4 * a * h)) / (2 * a);
  const flow = pipeFlow({ head: h, diameter: d, length, minorLoss: k, friction: 'colebrook', gravity: g });
  assert.ok(flow.reynolds < 2000);
  rel(flow.speed, v, 1e-12, 'laminar speed');
  rel(flow.flow, (Math.PI * d * d * v) / 4, 1e-12);
  // A negative head reverses the flow by symmetry.
  rel(pipeFlow({ head: -h, diameter: d, length, minorLoss: k, friction: 'colebrook', gravity: g }).speed, -v, 1e-12);
  // Turbulent: the loss at the solved speed returns the head.
  const run = { diameter: 0.05, length: 120, roughness: 4.6e-5, minorLoss: 3, gravity: g };
  const t = pipeFlow({ ...run, head: 12 });
  rel(t.velocityHead + pipeLoss(run, t.speed).headLoss, 12, 1e-12, 'energy closes');
});

test('Torricelli efflux and basin equalisation follow their closed forms', () => {
  const free = orificeFlow({ area: 1e-3, head: 2, dischargeCoefficient: 1, gravity: g });
  rel(free.idealSpeed, Math.sqrt(2 * g * 2), 1e-15);
  rel(
    orificeFlow({ area: 1e-3, pressureDifference: 2 * WATER.density * g, gravity: g }).flow,
    0.61e-3 * free.idealSpeed,
    1e-12,
  );
  rel(
    orificeConductance(1e-3, 0.61) * Math.sqrt(1e4),
    orificeFlow({ area: 1e-3, pressureDifference: 1e4 }).flow,
    1e-12,
  );
  // Two finite basins integrated with RK4 against the closed form.
  const input = {
    area: 50,
    otherArea: 120,
    level: 1,
    otherLevel: 3,
    openingArea: 0.4,
    dischargeCoefficient: 0.62,
    gravity: g,
  };
  let d = 2;
  const k = 0.62 * 0.4 * Math.sqrt(2 * g) * (1 / 50 + 1 / 120),
    f = (x) => -k * Math.sqrt(Math.max(0, x)),
    dt = 1e-3;
  for (let t = 0; t < 20 - 1e-9; t += dt) {
    const k1 = f(d),
      k2 = f(d + (dt * k1) / 2),
      k3 = f(d + (dt * k2) / 2),
      k4 = f(d + dt * k3);
    d += (dt * (k1 + 2 * k2 + 2 * k3 + k4)) / 6;
  }
  const state = equalize({ ...input, time: 20 });
  near(state.otherLevel - state.level, d, 1e-9, 'difference');
  // Volume is conserved between the basins.
  near(state.level * 50 + state.otherLevel * 120, 1 * 50 + 3 * 120, 1e-9);
  const done = equalize({ ...input, time: 1e6 });
  near(done.level, (50 + 360) / 170, 1e-12);
  assert.equal(done.flow, 0);
  rel(state.duration, (2 * Math.sqrt(2)) / k, 1e-14);
  // Against a fixed river the basin reaches the river level.
  assert.equal(equalize({ area: 80, level: 0.9, otherLevel: 2.7, openingArea: 1.75, time: 1e5 }).level, 2.7);
});

test('a Venturi meter obeys Bernoulli and continuity, and reads its flow back', () => {
  const meter = { inletDiameter: 0.053, throatDiameter: 0.026, dischargeCoefficient: 1, gravity: g };
  const r = venturi({ ...meter, flow: 30 / 60000 });
  rel(r.pressureDrop, (WATER.density * (r.throatSpeed ** 2 - r.inletSpeed ** 2)) / 2, 1e-12, 'Bernoulli');
  rel(r.inletSpeed * Math.PI * 0.053 ** 2, r.throatSpeed * Math.PI * 0.026 ** 2, 1e-12, 'continuity');
  rel(r.dropHead, r.pressureDrop / (WATER.density * g), 1e-15);
  // ISO 5167-4 machined coefficient: the drop for the same flow rises by 1/C².
  const iso = venturi({ ...meter, dischargeCoefficient: 0.995, flow: 30 / 60000 });
  rel(iso.pressureDrop, r.pressureDrop / 0.995 ** 2, 1e-12);
  rel(venturiFlow({ ...meter, dischargeCoefficient: 0.995, pressureDrop: iso.pressureDrop }).flow, 30 / 60000, 1e-12);
  assert.throws(() => venturi({ inletDiameter: 0.02, throatDiameter: 0.03, flow: 1e-4 }), RangeError);
});

test('a plug-flow tracer inverts the conduit volume exactly', () => {
  const area = (x) => 0.001 + 0.0005 * x;
  const tracer = plugTracer(area, 0, 2, 64);
  rel(tracer.volume, 0.001 * 2 + 0.00025 * 4, 1e-12);
  for (const x of [0, 0.3, 1.1, 1.97, 2]) near(tracer.positionAt(tracer.volumeTo(x)), x, 1e-12, `x ${x}`);
});

test('a siphon carries its pipe flow and reaches the vapour limit at the textbook height', () => {
  const run = { diameter: 0.013, length: 1.2, roughness: 1.5e-6, minorLoss: 1.65, gravity: g };
  const s = siphon({ ...run, drop: 0.1, crownRise: 0.175, crownLength: 0.5, crownMinorLoss: 0.7 });
  const pipe = pipeFlow({ ...run, head: 0.1 });
  assert.equal(s.speed, pipe.speed);
  const toCrown = pipeLoss({ ...run, length: 0.5, minorLoss: 0.7 }, s.speed);
  rel(s.crownPressure, -WATER.density * g * (0.175 + toCrown.velocityHead + toCrown.headLoss), 1e-12);
  // No flow: the limit is (p_a - p_v) / (ρ g) = 10.1 m for water at 20 °C.
  const still = siphon({ ...run, drop: 0, crownRise: 1 });
  assert.equal(still.speed, 0);
  rel(still.crownLimit, (101325 - waterVaporPressure(20)) / (WATER.density * g), 1e-14);
  near(still.crownLimit, 10.11, 0.01);
  assert.equal(siphon({ ...run, drop: 0.1, crownRise: s.crownLimit + 0.01 }).cavitates, true);
  assert.equal(siphon({ ...run, drop: 0.1, crownRise: s.crownLimit - 0.01 }).cavitates, false);
});

test('Joukowsky surge: wave speed, ρ a Δv, and the lumped drive line that reproduces it', () => {
  // Steel pipe with expansion joints (Wylie and Streeter 1993, eq. 2.10).
  const K = waterBulkModulus(20),
    a = pipeWaveSpeed({ diameter: 0.5, wallThickness: 0.01, youngsModulus: 207e9 });
  rel(a, Math.sqrt(K / WATER.density / (1 + (K * 0.5) / (207e9 * 0.01))), 1e-14);
  assert.ok(a > 1150 && a < 1250);
  assert.ok(pipeWaveSpeed({ diameter: 0.5, wallThickness: 0.01, youngsModulus: 207e9, restraint: 'anchored' }) > a);
  rel(joukowsky(1200, 2), WATER.density * 2400, 1e-15);
  // A drive line whose compliance is the pipe's own, shut fast with nothing to deliver into: the junction pressure
  // rises by ρ a v₀ above the supply head.
  const area = Math.PI * 0.021 ** 2,
    wave = 600,
    head = 2;
  const ram = new HydraulicRam({
    supplyHead: head,
    driveLength: 20,
    driveDiameter: 0.042,
    waveSpeed: wave,
    waste: { conductance: 1e-4, tripFlow: 5e-3, closeTime: 1e-5, holdTime: 1, reopenPressure: -1e9, reopenTime: 1 },
    checkConductance: 0,
    deliveryConductance: 0,
    vessel: { volume: 0.001 },
    step: 2e-6,
    initial: { pressure: (4.9e-3 / 1e-4) ** 2, driveFlow: 4.9e-3 },
    gravity: g,
  });
  const run = ram.simulate(5, 0.5);
  const close = run.frames.findIndex((f) => f.phase === 1);
  assert.ok(close > 0, 'the waste valve tripped');
  const q0 = run.frames[close].driveFlow,
    p0 = run.frames[close].pressure,
    surge = run.frames.slice(close).reduce((m, f) => Math.max(m, f.pressure), -Infinity);
  // Linear oscillator about the supply pressure: peak = ρ g H + √((p0 - ρgH)² + (ρ a v0)²).
  const rhogh = WATER.density * g * head,
    jk = joukowsky(wave, q0 / area);
  rel(surge, rhogh + Math.hypot(p0 - rhogh, jk), 2e-3, 'lumped surge');
  rel(ram.compliance, (area * 20) / (WATER.density * wave * wave), 1e-14);
});

const RAM = {
  supplyHead: 1.6,
  driveLength: 8,
  driveDiameter: 0.042,
  driveResistance: 1.14e10,
  compliance: 7.5e-10,
  waste: {
    conductance: 1.9e-5,
    tripFlow: 0.000788,
    closeTime: 0.036,
    holdTime: 0.09,
    reopenPressure: 4900,
    reopenTime: 0.055,
  },
  checkConductance: 5.05e-6,
  deliveryConductance: 3.55e-6,
  vessel: { volume: 0.0023, exponent: 1.24 },
  initial: { pressure: 1700, driveFlow: 1e-4 },
  gravity: g,
};

test('a hydraulic ram settles into a cycle that conserves water and converges with the step', () => {
  const ram = new HydraulicRam(RAM);
  const cycle = ram.settle(4);
  const { drive, waste, delivered } = cycle.volumes;
  near(cycle.storedEnd - cycle.storedStart, drive - waste - delivered, 1e-12 * drive, 'water balance');
  assert.ok(cycle.efficiency > 0 && cycle.efficiency < 1, `efficiency ${cycle.efficiency}`);
  assert.ok(cycle.rankineEfficiency > 0 && cycle.rankineEfficiency < 1);
  // The delivery check only opens once the junction exceeds the air pressure, and the surge drives it.
  assert.ok(cycle.peakPressure > ram.airPressure(cycle.frames[0].vesselWater));
  assert.ok(cycle.frames.some((f) => f.phase === 2 && f.checkFlow > 0));
  // Halving the step changes the delivered flow by under 1 percent (the midpoint rule is second order).
  const fine = new HydraulicRam({ ...RAM, step: 0.000375 }).settle(4);
  rel(fine.meanDelivery, cycle.meanDelivery, 0.01, 'step convergence');
  // A higher lift delivers less water.
  assert.ok(ram.settle(5.5).meanDelivery < cycle.meanDelivery);
  assert.equal(ramFrameAt(cycle, cycle.period + 1e-9), cycle.frames[0]);
  assert.throws(() => ram.settle(4, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('Belanger conjugate depths conserve momentum and lose the textbook energy', () => {
  for (const [y1, v1] of [
    [0.028, 2.4],
    [0.028, 3.9],
    [0.1, 4],
    [0.5, 12],
  ]) {
    const j = hydraulicJump({ upstreamDepth: y1, upstreamSpeed: v1, gravity: g });
    const q = y1 * v1,
      force = (y) => (y * y) / 2 + (q * q) / (g * y);
    rel(force(j.downstreamDepth), force(y1), 1e-12, 'momentum');
    rel(specificEnergy(y1, v1, g) - specificEnergy(j.downstreamDepth, j.downstreamSpeed, g), j.headLoss, 1e-9, 'loss');
    assert.ok(j.downstreamFroude < 1);
    const f1 = v1 / Math.sqrt(g * y1);
    rel(j.rollerLength, (160 * Math.tanh(f1 / 20) - 12) * y1, 1e-12, 'Hager roller');
  }
  // Chow's (1959) example: y1 = 0.5 m, F1 = 6 gives y2/y1 = 8.0 and a steady jump.
  const chow = hydraulicJump({ upstreamDepth: 0.5, upstreamSpeed: 6 * Math.sqrt(g * 0.5), gravity: g });
  near(chow.downstreamDepth / 0.5, 8.0, 0.01);
  assert.equal(chow.type, 'steady');
  assert.throws(() => hydraulicJump({ upstreamDepth: 1, upstreamSpeed: 1 }), RangeError);
  near(criticalDepth(2, g) ** 3, 4 / g, 1e-12);
  near(froudeNumber(Math.sqrt(g * 2), 2, g), 1, 1e-15);
});

test('Manning normal depth meets the wide-channel closed form', () => {
  const n = 0.013,
    s = 0.001,
    width = 1e4,
    q = 2 * width;
  const wide = ((2 * n) / Math.sqrt(s)) ** 0.6;
  rel(normalDepth({ discharge: q, bottomWidth: width, slope: s, manningN: n }), wide, 2e-4);
  // A trapezoid: its depth returns the discharge.
  const y = normalDepth({ discharge: 10, bottomWidth: 3, slope: 5e-4, manningN: 0.022, sideSlope: 2 });
  const area = (3 + 2 * y) * y,
    radius = area / (3 + 2 * y * Math.sqrt(5));
  rel((area * radius ** (2 / 3) * Math.sqrt(5e-4)) / 0.022, 10, 1e-9);
});

test('a Pelton runner peaks at half the jet speed with the momentum-theory efficiency', () => {
  const base = {
    netHead: 8.6,
    nozzleDiameter: 0.017,
    pitchRadius: 0.167,
    nozzleCoefficient: 0.978,
    bucketRetention: 0.9,
    gravity: g,
  };
  const beta = (18 * Math.PI) / 180;
  const best = peltonRunner({ ...base, exitAngle: beta, rpm: 0 }).optimumRpm;
  const top = peltonRunner({ ...base, exitAngle: beta, rpm: best });
  rel(top.efficiency, (0.978 ** 2 * (1 + 0.9 * Math.cos(beta))) / 2, 1e-12, 'peak efficiency');
  assert.ok(peltonRunner({ ...base, exitAngle: beta, rpm: best * 0.95 }).efficiency < top.efficiency);
  assert.ok(peltonRunner({ ...base, exitAngle: beta, rpm: best * 1.05 }).efficiency < top.efficiency);
  const stall = peltonRunner({ ...base, exitAngle: beta, rpm: 0 });
  rel(stall.force, stall.massFlow * stall.jetSpeed * (1 + 0.9 * Math.cos(beta)), 1e-12, 'stall force');
  near(peltonRunner({ ...base, exitAngle: beta, rpm: top.runawayRpm }).torque, 0, 1e-12);
  rel(stall.jetSpeed, 0.978 * Math.sqrt(2 * g * 8.6), 1e-15);
});

test('a hinged bellows sweeps the exact ruled volume between its boards', () => {
  // Rectangle x in [0.1, 0.4], z in [-0.1, 0.1]: A = 0.06, M = 0.2 (0.4² - 0.1²)/2 = 0.015.
  const b = hingedBellows({
    outline: [
      [0.1, -0.1],
      [0.4, -0.1],
      [0.4, 0.1],
      [0.1, 0.1],
    ],
    gap: 0.03,
  });
  rel(b.area, 0.06, 1e-14);
  rel(b.firstMoment, 0.015, 1e-14);
  // Midpoint quadrature of the ruled map's Jacobian, g((1-s) + s cos θ) + x sin θ, over s and the outline.
  const theta = 0.4;
  let v = 0;
  const N = 400;
  for (let i = 0; i < N; i++)
    for (let k = 0; k < N; k++) {
      const x = 0.1 + (0.3 * (i + 0.5)) / N,
        s = (k + 0.5) / N;
      v += (0.03 * (1 - s + s * Math.cos(theta)) + x * Math.sin(theta)) * (0.3 / N) * 0.2 * (1 / N);
    }
  rel(b.volume(theta), v, 1e-9, 'volume');
  const h = 1e-6;
  rel(b.rate(theta, 2), ((b.volume(theta + h) - b.volume(theta - h)) / (2 * h)) * 2, 1e-7, 'rate');
  const opening = b.flow(theta, 1),
    closing = b.flow(theta, -1);
  assert.equal(opening.outlet, 0);
  assert.equal(closing.intake, 0);
  rel(opening.intake, closing.outlet, 1e-15);
});

test('a pipe network meets an independent three-reservoir solution, a series pipe and a pump curve', () => {
  const pipes = [
    { id: 'a', from: 'A', to: 'J', length: 1000, diameter: 0.3, roughness: 2.6e-4 },
    { id: 'b', from: 'J', to: 'B', length: 1500, diameter: 0.25, roughness: 2.6e-4 },
    { id: 'c', from: 'J', to: 'C', length: 800, diameter: 0.2, roughness: 2.6e-4 },
  ];
  const net = solveNetwork({
    nodes: [
      { id: 'A', kind: 'reservoir', head: 100 },
      { id: 'B', kind: 'reservoir', head: 80 },
      { id: 'C', kind: 'reservoir', head: 60 },
      { id: 'J', elevation: 50, demand: 0.01 },
    ],
    links: pipes,
    gravity: g,
  });
  // Independent: bisection on the junction head with each pipe's flow from pipeFlow (no exit loss).
  const q = (pipe, h) => pipeFlow({ ...pipe, head: h, exitLoss: 0, gravity: g }).flow;
  const balance = (hj) => q(pipes[0], 100 - hj) - q(pipes[1], hj - 80) - q(pipes[2], hj - 60) - 0.01;
  let lo = 60,
    hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (balance(mid) > 0) lo = mid;
    else hi = mid;
  }
  near(net.heads.J, lo, 1e-7, 'junction head');
  near(net.flows.a, q(pipes[0], 100 - lo), 1e-9);
  near(net.pressureHeads.J, lo - 50, 1e-7);
  assert.ok(net.continuityError < 1e-10);
  // A pump lifting into a tank through one pipe with a fixed friction factor: h0 - r Q² = Δz + k Q².
  const pump = solveNetwork({
    nodes: [
      { id: 'sump', kind: 'reservoir', head: 0 },
      { id: 'p', elevation: 0 },
      { id: 'tank', kind: 'reservoir', head: 20 },
    ],
    links: [
      { id: 'pump', kind: 'pump', from: 'sump', to: 'p', shutoffHead: 40, coefficient: 2000 },
      { id: 'main', from: 'p', to: 'tank', length: 500, diameter: 0.15, frictionFactor: 0.02, minorLoss: 1 },
    ],
    gravity: g,
  });
  const area = Math.PI * 0.15 ** 2 * 0.25,
    k = (0.02 * 500) / 0.15 / (2 * g * area * area) + 1 / (2 * g * area * area);
  rel(pump.flows.pump, Math.sqrt(20 / (2000 + k)), 1e-9, 'pump operating point');
  // A closed valve isolates a branch.
  const shut = solveNetwork({
    nodes: [{ id: 'R', kind: 'reservoir', head: 10 }, { id: 'J' }, { id: 'S', kind: 'reservoir', head: 0 }],
    links: [
      { id: 'p', from: 'R', to: 'J', length: 10, diameter: 0.05 },
      { id: 'v', kind: 'valve', from: 'J', to: 'S', area: 0 },
    ],
  });
  near(shut.flows.v, 0, 1e-8);
  near(shut.heads.J, 10, 1e-6);
  assert.throws(() => solveNetwork({ nodes: [{ id: 'J' }], links: [] }), RangeError);
});
