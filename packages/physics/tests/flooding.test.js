// Flooding (SEA-10): a hull's compartments taking in the sea through their openings, the air they hold, the cargo they
// lose, checked against the hydraulics each step solves (Torricelli's draining, the weir, Boyle's law, conservation) on a
// hull held still.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCHARGE, Flooding, volumeBelow } from '../dist/seakeeping.js';
import { BREACH_CARGO } from '../dist/seakeeping.js';

/** A box from (x0, y0, z0) to (x1, y1, z1), its twelve triangles wound outward. */
function cuboid([x0, y0, z0], [x1, y1, z1]) {
  return {
    vertices: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

const G = 9.81,
  RHO = 1025,
  still = { elevation: () => 0 },
  upright = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** Runs `flooding` held upright in still water for `seconds` at `rate` steps a second, calling `each(result, t)`. */
function run(flooding, seconds, rate = 60, each = () => {}, sea = still) {
  const state = new Float64Array(flooding.words);
  flooding.initialise(state);
  const dt = 1 / rate,
    steps = Math.round(seconds * rate);
  for (let i = 0; i < steps; i++)
    each(flooding.step(state, upright, sea, (i + 0.5) * dt, dt, RHO, G), (i + 1) * dt, state);
  return state;
}

test('Flooding rejects a bad second sea query without changing state, output or the accepted plane table', () => {
  const make = () =>
    new Flooding(
      [{ mesh: cuboid([-2, -1.5, -1], [2, 0.5, 1]), water: 0.5 }],
      [
        { from: 0, to: 'outside', centre: [-1, -1.5, 0], normal: [0, -1, 0], width: 0.1, height: 0.1 },
        { from: 0, to: 'outside', centre: [1, 0.5, 0], normal: [0, 1, 0], width: 0.15, height: 0.15 },
      ],
    );
  const flood = make(),
    reference = make();
  const state = new Float64Array(flood.words),
    refState = new Float64Array(reference.words);
  flood.initialise(state);
  reference.initialise(refState);
  const dt = 1 / 60;
  const output = flood.step(state, upright, still, 0, dt, RHO, G);
  reference.step(refState, upright, still, 0, dt, RHO, G);
  const acceptedState = state.slice(),
    acceptedOutput = structuredClone(output);
  const acceptedLevel = flood.levelOf(0, state[0]);
  const moved = { position: [1, 0.2, 3], rotation: [0, 0, 0.2, Math.sqrt(0.96)] };
  let calls = 0;
  const invalid = { elevation: () => (++calls === 2 ? NaN : 0) };
  assert.throws(() => flood.step(state, moved, invalid, dt, dt, RHO, G), {
    code: 'failed',
    message: /Return a finite local height.*#hull-flooding/,
  });
  assert.equal(calls, 2);
  assert.throws(() => flood.step(state, moved, still, dt, dt, RHO, Infinity), {
    code: 'unsupported',
    message: /positive step and density, and nonnegative gravity.*#hull-flooding/,
  });
  assert.deepEqual(state, acceptedState);
  assert.deepEqual(output, acceptedOutput);
  assert.equal(flood.levelOf(0, state[0]), acceptedLevel);
  assert.equal(flood.convergenceWarning, undefined);
  assert.deepEqual(
    flood.step(state, moved, still, dt, dt, RHO, G),
    reference.step(refState, moved, still, dt, dt, RHO, G),
  );
  assert.deepEqual(state, refState);
});

test('Flooding preserves carried water and its mass when the prescribed gravity is zero', () => {
  const mesh = cuboid([-1, -1, -1], [1, 1, 1]);
  const flood = new Flooding([{ mesh, permeability: 1, water: 0.5 }], []);
  const before = new Float64Array(flood.words);
  flood.initialise(before);
  const state = before.slice();
  const result = flood.step(state, upright, still, 0, 1 / 60, RHO, 0);
  assert.deepEqual(state, before);
  assert.equal(result.level[0], -0.875);
  assert.equal(result.mass[0], 0.5 * RHO);
  assert.equal(flood.convergenceWarning, undefined);
});

test('volumeBelow: a cube cut level and on a slant, its volume and centre exact', () => {
  const cube = cuboid([0, 0, 0], [1, 1, 1]),
    moment = [0, 0, 0],
    level = volumeBelow(cube, [0, 1, 0], 0.3, moment);
  assert.ok(Math.abs(level - 0.3) < 1e-14);
  assert.deepEqual(
    moment.map((m) => Math.round((m / level) * 1e12) / 1e12),
    [0.5, 0.15, 0.5],
  );
  // The plane x + y = 1: half the cube, a prism whose triangle has its centre at (1/3, 1/3).
  const r = Math.SQRT1_2,
    slant = volumeBelow(cube, [r, r, 0], r, moment);
  assert.ok(Math.abs(slant - 0.5) < 1e-14, `${slant}`);
  for (const [k, want] of [
    [0, 1 / 3],
    [1, 1 / 3],
    [2, 0.5],
  ])
    assert.ok(Math.abs(moment[k] / slant - want) < 1e-14, `centre ${k}: ${moment[k] / slant}`);
  assert.ok(Math.abs(volumeBelow(cube, [0, 1, 0], Infinity) - 1) < 1e-14);
});

test('Flooding: the midplane of a stair cut does not draw water from an empty upper compartment', () => {
  const flood = new Flooding(
    [{ mesh: cuboid([0, -1, 0], [1, 0, 1]) }, { mesh: cuboid([0, 0.01, 0], [1, 1, 1]) }],
    [{ from: 0, to: 1, centre: [0.5, 0.005, 0.5], normal: [0, 1, 0], width: 0.1, height: 0.1 }],
  );
  const state = new Float64Array(flood.words);
  flood.initialise(state);
  const result = flood.step(state, upright, still, 0, 1 / 60, RHO, G);
  assert.equal(result.level[1], 0.01);
  assert.equal(result.water[0], 0);
  assert.equal(state[0], 0);
  assert.equal(state[3], 0);
});

test('Flooding: a vented box filling through a hole in its bottom follows Torricelli, first order in the step', () => {
  // A 2 by 2 by 2 m box, its bottom 1.5 m under the sea, a 0.1 m square hole in it and a vent in its top: the head h over
  // the water inside falls as sqrt(h) = sqrt(h0) - k t / 2, k = Cd a sqrt(2 g) / (permeability A). Backward Euler lags
  // the exact curve by O(dt): measured 6.0e-4 m at 60 steps a second at 280 s (of 1.5 m), half that at 120.
  const make = () =>
      new Flooding(
        [{ mesh: cuboid([-1, -1.5, -1], [1, 0.5, 1]) }],
        [
          { from: 0, to: 'outside', centre: [0, -1.5, 0], normal: [0, -1, 0], width: 0.1, height: 0.1 },
          { from: 0, to: 'outside', centre: [0, 0.5, 0], normal: [0, 1, 0], width: 0.3, height: 0.3 },
        ],
      ),
    k = (DISCHARGE * 0.01 * Math.sqrt(2 * G)) / (0.95 * 4),
    exact = (t) => Math.max(0, Math.sqrt(1.5) - (k * t) / 2) ** 2,
    error = (rate) => {
      let last = 0;
      run(make(), 280, rate, (r, t) => {
        if (Math.abs(t - 280) < 1e-9) last = -r.level[0] - exact(280);
        // Water comes in at the hole (out negative) and the air leaves by the vent.
        assert.ok(r.water[0] <= 0 && r.air[1] >= 0);
        // Each step's water and air settle well inside the sweeps' limit (it says so when they do not).
        assert.ok(r.sweeps[0] > 0 && r.sweeps[0] < 50 && r.sweeps[1] < 50, `sweeps ${r.sweeps[0]}, ${r.sweeps[1]}`);
      });
      return last;
    },
    e60 = error(60),
    e120 = error(120);
  assert.ok(e60 > 0 && e60 < 1e-3, `at 60 steps a second ${e60} m`);
  assert.ok(Math.abs(e60 / e120 - 2) < 0.1, `halving the step takes ${e60 / e120} off the error`);
  // Filled to the sea by the time Torricelli says (344.6 s), and still.
  let level = -1;
  run(make(), 360, 60, (r) => (level = r.level[0]));
  assert.ok(Math.abs(level) < 1e-9, `${level}`);
});

test('Flooding: a side opening half under the sea takes in the weir flow (2/3) Cd w sqrt(2 g) h^(3/2)', () => {
  // A 2 by 1 m opening in the side of a 100 m square compartment, its middle at the sea's level: the half under the sea
  // runs in with the head over each depth; the strips' integral is exact.
  const flooding = new Flooding(
    [{ mesh: cuboid([-50, -5, -50], [50, 5, 50]) }],
    [{ from: 0, to: 'outside', centre: [50, 0, 0], normal: [1, 0, 0], width: 2, height: 1 }],
  );
  const state = run(flooding, 1 / 60),
    // The water's step squeezes the air inside (Boyle, its mass as it was), a head of (p - atm) / (rho g) against the
    // sea's, so the water runs in over 0.5 m less that.
    free = 0.95 * 1e5,
    squeezed = ((101325 / 1.225) * 1.225 * free) / (free - state[0]),
    r = flooding.result,
    head = 0.5 - (squeezed - 101325) / (RHO * G),
    weir = (2 / 3) * DISCHARGE * 2 * Math.sqrt(2 * G) * head ** 1.5;
  assert.ok(squeezed > 101325 && head > 0.49);
  assert.ok(Math.abs(-r.water[0] - weir) < 1e-12 * weir, `${-r.water[0]} m^3/s against the weir's ${weir}`);
});

test("Flooding: a box with no vent keeps a pocket of air that stops the sea where Boyle's law says", () => {
  // A 2 m cube 1 m under the sea, a hole in its bottom: the sea comes in until the air's pressure, atm V0 / V_air (it
  // cannot leave), equals the sea's at the water inside, atm + rho g (0 - L).
  const flooding = new Flooding(
      [{ mesh: cuboid([-1, -3, -1], [1, -1, 1]) }],
      [{ from: 0, to: 'outside', centre: [0, -3, 0], normal: [0, -1, 0], width: 0.3, height: 0.3 }],
    ),
    atm = 101325,
    area = 0.95 * 4,
    free = 0.95 * 8,
    balance = (L) => (atm * free) / (area * (-1 - L)) - (atm + RHO * G * -L);
  let lo = -3,
    hi = -1 - 1e-9;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (balance(mid) < 0) lo = mid;
    else hi = mid;
  }
  let level = 0,
    air = 0;
  const state = run(flooding, 120, 60, (r) => {
    level = r.level[0];
    air = r.air[0];
  });
  assert.ok(Math.abs(level - lo) < 1e-9, `level ${level} against Boyle's ${lo}`);
  assert.equal(air, 0, 'no air leaves');
  assert.ok(Math.abs(state[1] - 1.225 * free) < 1e-12, 'its mass is kept');
});

test('Flooding: water spreading through two compartments is conserved, and no level passes another', () => {
  // Compartment A takes the sea through a hole in its bottom and passes it to B through a door low in the bulkhead
  // between them; both vented. Backward Euler keeps B under A under the sea at every step. The volumes are the solved
  // ones and the flows those at the solved state, which agree to the solve's last bits; where the levels meet (from about
  // 116 s) a flow goes as sqrt(dh), so a level an ulp off reads as 1e-8 m^3/s: the water held matches the water taken
  // within 1e-6 of it (measured 1.5e-7 after 34 s of equal levels).
  const flooding = new Flooding(
    [{ mesh: cuboid([0, -2, 0], [2, 1, 2]) }, { mesh: cuboid([2, -2, 0], [5, 1, 2]) }],
    [
      { from: 0, to: 'outside', centre: [1, -2, 1], normal: [0, -1, 0], width: 0.3, height: 0.3 },
      { from: 0, to: 1, centre: [2, -1.8, 1], normal: [1, 0, 0], width: 0.4, height: 0.4 },
      { from: 0, to: 'outside', centre: [1, 1, 1], normal: [0, 1, 0], width: 0.2, height: 0.2 },
      { from: 1, to: 'outside', centre: [3.5, 1, 1], normal: [0, 1, 0], width: 0.2, height: 0.2 },
    ],
  );
  let taken = 0,
    worst = 0;
  const state = run(flooding, 150, 60, (r, t, s) => {
    taken -= r.water[0] / 60;
    assert.ok(r.level[1] <= r.level[0] + 1e-12 && r.level[0] <= 1e-12, `levels ${r.level[0]}, ${r.level[1]}`);
    worst = Math.max(worst, Math.abs(s[0] + s[3] - taken));
    if (t < 110)
      assert.ok(Math.abs(s[0] + s[3] - taken) < 1e-12 * taken, `the water held is the water taken at ${t} s`);
  });
  assert.ok(worst < 1e-6 * taken, `held and taken ${worst} m^3 apart`);
  assert.ok(Math.abs(flooding.result.level[0]) < 1e-6 && Math.abs(flooding.result.level[1]) < 1e-6);
  assert.ok(state[0] > 0 && state[3] > 0);
});

test('Flooding: a full compartment passes the sea on to the one above it', () => {
  // A double bottom under a hold: the sea comes into the double bottom by a breach, fills it (its air out by the manhole
  // in its top) and rises through the manhole into the hold, vented above the sea, to the sea's level.
  const flooding = new Flooding(
    [{ mesh: cuboid([0, -4, 0], [4, -3, 4]) }, { mesh: cuboid([0, -3, 0], [4, 1, 4]) }],
    [
      { from: 0, to: 'outside', centre: [2, -4, 2], normal: [0, -1, 0], width: 0.5, height: 0.5 },
      { from: 0, to: 1, centre: [2, -3, 2], normal: [0, 1, 0], width: 0.6, height: 0.6 },
      { from: 1, to: 'outside', centre: [2, 1, 2], normal: [0, 1, 0], width: 0.3, height: 0.3 },
    ],
  );
  run(flooding, 600);
  const r = flooding.result;
  assert.ok(Math.abs(r.level[1]) < 1e-6, `the hold's water stands at ${r.level[1]}`);
  assert.ok(r.level[0] >= -3 - 1e-9, `the double bottom is full to ${r.level[0]}`);
});

test('Flooding: a hatch gives way at its head and an opening keeps its times', () => {
  // A door 0.2 m high, its middle 0.5 m under the sea, into an empty compartment: 0.6 m of head across its foot.
  const make = (opening) =>
      new Flooding(
        [{ mesh: cuboid([-1, -2, -1], [1, 1, 1]) }],
        [{ from: 0, to: 'outside', centre: [1, -0.5, 0], normal: [1, 0, 0], width: 0.2, height: 0.2, ...opening }],
      ),
    opened = (opening, seconds) => {
      const open = [];
      run(make(opening), seconds, 60, (r) => open.push(r.open[0]));
      return open;
    };
  assert.ok(
    opened({ collapse: 0.55 }, 1).every((o) => o === 1),
    'gives way at once under 0.6 m',
  );
  assert.ok(
    opened({ collapse: 0.65 }, 1).every((o) => o === 0),
    'holds under 0.6 m',
  );
  const timed = opened({ opens: 0.5, closes: 0.75 }, 1);
  assert.deepEqual([timed[28], timed[30], timed[44], timed[45]], [0, 1, 1, 0]);
});

test('Flooding: iron ore pellets pour out of a breach by Beverloo dry and by Wilson et al. under water', () => {
  // A 4 m hold half full of 12 mm pellets, a 0.2 m square breach in its side 1.5 m under the cargo's top.
  const cargo = { material: 'ironOre', mass: 32 * 0.6 * 5200, diameter: 0.012 },
    hold = cuboid([-2, -2, -2], [2, 2, 2]),
    breach = { from: 0, to: 'outside', centre: [2, -1.5, 0], normal: [1, 0, 0], width: 0.2, height: 0.2 },
    D = Math.sqrt((4 * 0.04) / Math.PI),
    d = 0.012;
  // Dry: the sea far below.
  const dry = new Flooding([{ mesh: hold, cargo }], [breach]);
  run(dry, 1 / 60, 60, () => {}, { elevation: () => -10 });
  const beverloo = 0.58 * 0.6 * 5200 * Math.sqrt(G) * (D - 1.5 * d) ** 2.5;
  assert.ok(
    Math.abs(dry.result.cargo[0] - beverloo) < 1e-9 * beverloo,
    `${dry.result.cargo[0]} kg/s against ${beverloo}`,
  );
  // Under water, the hold flooded to the sea's level (no water through the breach): the grains fall at their terminal
  // speed in water (Ferguson and Church 2004, natural grains: C1 = 18, C2 = 1).
  const wet = new Flooding([{ mesh: hold, cargo, water: 0.95 * 32 }], [breach]);
  run(wet, 1 / 60);
  const r = (5200 - RHO) / RHO,
    vt = (r * G * d * d) / (18e-6 + Math.sqrt(0.75 * r * G * d ** 3)),
    wilson = 0.67 ** 2 * 5200 * vt * (D - 2.4 * d) ** 2;
  assert.ok(Math.abs(wet.result.water[0]) < 1e-9, 'no water through the breach');
  assert.ok(Math.abs(wet.result.cargo[0] - wilson) < 1e-6 * wilson, `${wet.result.cargo[0]} kg/s against ${wilson}`);
  assert.equal(BREACH_CARGO.indexOf('ironOre'), 4);
});

test('Flooding refuses what it cannot flood, naming the fix', () => {
  const box = cuboid([0, 0, 0], [1, 1, 1]);
  assert.throws(() => new Flooding([], []), /one or more compartments/);
  assert.throws(() => new Flooding([{ mesh: box, permeability: 0 }], []), /permeability/);
  assert.throws(() => new Flooding([{ mesh: box, water: 2 }], []), /less than its space/);
  assert.throws(
    () =>
      new Flooding([{ mesh: box }], [{ from: 0, to: 0, centre: [0, 0, 0], normal: [1, 0, 0], width: 1, height: 1 }]),
    /another or 'outside'/,
  );
  assert.throws(
    () =>
      new Flooding(
        [{ mesh: box }],
        [{ from: 0, to: 'outside', centre: [0, 0, 0], normal: [0, 0, 0], width: 1, height: 1 }],
      ),
    /normal/,
  );
  assert.throws(() => new Flooding([{ mesh: box, cargo: { material: 'gold', mass: 1 } }], []), /one of none/);
});
