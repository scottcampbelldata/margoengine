// Bubbles in the water (FW-4, BubbleSolver): rise speeds by Thorpe's and Keeling's formula (Stokes' law for the
// smallest); lifetimes by Castro's dissolution model at the Athena's stern (about 2 min for 100 um, 2.5 s for 10 um);
// the air's mass kept to round-off (taken in = held + dissolved + surfaced); a ship's air trailing behind its propeller,
// carried by the race, rising, surfacing and laying foam; bits a snapshot and a second run reproduce.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  airDensity,
  BUBBLE_RADII,
  BubbleSolver,
  dissolution,
  riseSpeed,
  shipAeration,
  spectrumShares,
} from '../dist/bubbles.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 9.81,
  NU = 1.05e-6;

test("a bubble rises at Thorpe's and Keeling's speed, Stokes' law when small", () => {
  // The formula's values as Deike and Melville print it, evaluated at nu = 1.05e-6: 0.50, 1.58, 3.49, 6.75 and 9.99 cm/s
  // at radii of 50, 100, 200, 500 um and 1 mm.
  for (const [r, cm] of [
    [50e-6, 0.5],
    [100e-6, 1.58],
    [200e-6, 3.49],
    [500e-6, 6.75],
    [1e-3, 9.99],
  ])
    assert.ok(Math.abs(riseSpeed(r) * 100 - cm) < 0.01 * cm + 0.005, `${r * 1e6} um: ${riseSpeed(r) * 100} cm/s`);
  // Stokes' law for a rigid sphere, 2 r^2 g / (9 nu), at 5 um.
  const r = 5e-6;
  assert.ok(Math.abs(riseSpeed(r) / ((2 * r * r * G) / (9 * NU)) - 1) < 0.02);
});

test("a bubble's air dissolves on Castro's time scales: about 2 min at 100 um and 2.5 s at 10 um, a metre down", () => {
  // Castro's time scale at the Athena's stern: the air's mass over the rate it leaves, m / m'.
  const scale = (r) => (airDensity(r, 1) * (4 / 3) * Math.PI * r ** 3) / dissolution(r, 1);
  assert.ok(Math.abs(scale(100e-6) / 120 - 1) < 0.25, `100 um: ${scale(100e-6)} s`);
  assert.ok(Math.abs(scale(10e-6) / 2.5 - 1) < 0.25, `10 um: ${scale(10e-6)} s`);
  // A bubble held at that depth lasts longer than its time scale, as it shrinks its transfer slows: 1.5 to 3 times.
  let r = 100e-6,
    each = airDensity(r, 1) * (4 / 3) * Math.PI * r ** 3,
    t = 0;
  while (each > 0 && t < 2000) {
    each -= dissolution(r, 1) * 0.05;
    if (each <= 0) break;
    r = Math.cbrt(each / (airDensity(r, 1) * (4 / 3) * Math.PI));
    t += 0.05;
  }
  assert.ok(t > 1.5 * scale(100e-6) && t < 3 * scale(100e-6), `lifetime ${t} s against ${scale(100e-6)}`);
});

test("the air's mass is kept: taken in = held + dissolved + surfaced", () => {
  const bubbles = new BubbleSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(bubbles, {
      sources: (t) => (t < 2 ? [{ position: [0, -0.6, 0], width: 0.4, depth: 0.2, rate: 1e-4 }] : []),
    });
  for (const f of [30, 120, 600]) {
    world.advance(f);
    const l = bubbles.ledger();
    assert.ok(l.taken > 0);
    assert.ok(Math.abs(l.taken - l.held - l.dissolved - l.surfaced) <= 1e-12 * l.taken, JSON.stringify(l));
  }
  const l = bubbles.ledger();
  assert.ok(l.surfaced > 0 && l.dissolved > 0, 'some air surfaced and some dissolved');
});

test("a ship's air trails behind its propeller in the race, rises, surfaces and lays foam", () => {
  // A ship's race boiling up 10 m astern, running aft (-x) at 3 m/s from a boil 1.5 m across; the race as the water's
  // flow: 3 m/s aft near the surface behind the boil, still elsewhere.
  const ship = { wash: () => [{ position: [-10, 0], direction: [-1, 0], speed: 3, radius: 0.75 }] },
    water = {
      medium: 'water',
      cell: [0, 0, 0],
      sample(x, y, _z, _t, out = { velocity: [0, 0, 0], density: 1025, temperature: 288 }) {
        out.velocity[0] = x < -9 && y > -3 ? -3 * Math.exp(y / 2) : 0;
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        return out;
      },
    },
    boxes = [],
    bubbles = new BubbleSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(bubbles, {
      sources: shipAeration(ship),
      water,
      foam: { addFoam: (min, max, w) => boxes.push([min, max, w]) },
    });
  world.advance(600);
  // The entrainment: 10 percent void, 0.1 m deep, 1.5 m across, at 3 m/s.
  assert.ok(Math.abs(shipAeration(ship)(0)[0].rate - 0.1 * 0.1 * 1.5 * 3) < 1e-12);
  const p = bubbles.parcelData();
  let behind = 0,
    total = 0;
  for (let i = 0; i < p.length; i += 7) {
    total++;
    if (p[i] < -10.5) behind++;
  }
  assert.ok(total > 100 && behind / total > 0.9, `${behind} of ${total} parcels astern of the boil`);
  assert.ok(boxes.length > 0, 'surfacing bubbles lay foam');
  assert.ok(bubbles.voidFraction(-20, -0.3, 0, 2) > 0, 'the plume holds air astern');
});

test('the radii share the air by Deane and Stokes', () => {
  const s = spectrumShares(BUBBLE_RADII);
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  // Under 1 mm the number density goes as r^(-3/2), so the volume per log-radius as r^(3/2): rising with the radius.
  for (let i = 1; i < s.length - 1; i++) assert.ok(s[i] > s[i - 1], `share ${i}`);
});

test('a snapshot restores the bubbles bit for bit, and a second run gives the same bits', () => {
  const make = () => {
    const bubbles = new BubbleSolver();
    return new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] }).add(bubbles, {
      sources: () => [{ position: [0, -1, 0], width: 1, depth: 0.2, rate: 2e-4 }],
    });
  };
  const a = make();
  a.advance(30);
  const saved = a.takeSnapshot();
  a.advance(90);
  const hash = a.hash();
  a.restoreSnapshot(saved.bytes);
  a.advance(90);
  assert.equal(a.hash(), hash);
  const b = make();
  b.advance(90);
  assert.equal(b.hash(), hash);
});

test('bad settings are refused, each naming its fix', () => {
  const w = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(() => w.add(new BubbleSolver('a'), {}), /sources/);
  assert.throws(() => w.add(new BubbleSolver('b'), { sources: () => [], radii: [2e-3, 1e-3] }), RangeError);
  assert.throws(() => w.add(new BubbleSolver('c'), { sources: () => [], capacity: 0 }), RangeError);
  assert.throws(() => w.add(new BubbleSolver('d'), { sources: () => [], foam: {} }), TypeError);
  assert.throws(() => shipAeration({ wash: () => [] }, { voidFraction: 2 }), RangeError);
});
