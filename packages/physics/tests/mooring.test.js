// A mooring line or anchor chain as lumped masses (`MooringLine`): the seabed's friction against the stopping distance of a
// line sliding on it, tension only, a snap load on a clump weight against the energy of a mass caught by a spring, breaking,
// a buoy's lift, the elastic catenary with its grounded length, and the measured top tensions of the 33 m chain of
// Bergdahl, Palm, Eskilsson and Lindahl (2016).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MooringLine } from '../dist/rod.js';

const g = 9.81;

/** Still water of density `rho` whose surface is at height `surface`. */
function still(rho = 1000, surface = 50) {
  return {
    density: rho,
    elevation: () => surface,
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
        out.density = rho;
        out.temperature = 288;
        return out;
      },
    },
  };
}

test('a line sliding on the seabed stops where friction along it, or across it, takes its speed', () => {
  // A free 10 m line lying on the bed, every node sliding at 2 m/s: Coulomb friction takes mu g a second off its speed, so it
  // stops after v^2 / (2 mu g), along the line with mu 0.4 and across it with 0.8. The substeps' semi-implicit Euler is short
  // by about v h / 2: measured 0.08 %, held to 0.2 %.
  for (const [direction, mu] of [
    [[1, 0, 0], 0.4],
    [[0, 0, 1], 0.8],
  ]) {
    const line = new MooringLine({
      start: [0, 0, 0],
      end: [10, 0, 0],
      length: 10,
      massPerLength: 1,
      axialStiffness: 1e5,
      segments: 20,
      fixed: 'none',
      seabed: { friction: 0.4, lateralFriction: 0.8 },
      velocity: direction.map((c) => 2 * c),
    });
    for (let i = 0; i < 300; i++) line.step(1 / 60);
    const p = line.position(10),
      moved = Math.hypot(p[0] - 5, p[2]),
      exact = 4 / (2 * mu * g);
    assert.ok(Math.abs(moved / exact - 1) < 2e-3, `slid ${moved} m, Coulomb ${exact} m`);
    assert.ok(Math.abs(p[1]) < 1e-12, 'it stays on the bed');
    assert.ok(Math.hypot(...line.velocity(10)) < 1e-12, 'and stops dead');
  }
});

test('a line takes tension only: pushed together it goes slack and pushes nothing back', () => {
  const line = new MooringLine({
    start: [0, 0, 0],
    end: [10, 0, 0],
    length: 10,
    massPerLength: 1,
    axialStiffness: 1e5,
    gravity: [0, 0, 0],
  });
  for (let i = 1; i <= 60; i++) {
    line.setEnd('end', [10 - i / 60, 0, 0]);
    line.step(1 / 60);
    for (let s = 0; s < line.segments; s++) assert.equal(line.tension(s), 0, `segment ${s} at step ${i}`);
    assert.deepEqual(line.endForce('end'), [0, 0, 0]);
  }
});

test('a clump weight caught by a slack line snaps it to the closed form, and past its rated load the line parts', () => {
  // A 10 kg clump falling at v = sqrt(2 g 2 m) as the 2 m line above it comes straight: a mass caught by a spring of k =
  // EA / L, its peak tension M g + sqrt((M g)^2 + k M v^2) from its energy. The line weighs a ten-millionth of the clump, so
  // its own stress wave adds nothing; measured within 0.02 % of the closed form, held to 0.1 %.
  const M = 10,
    k = 1e4,
    L = 2,
    v = Math.sqrt(2 * g * L),
    exact = M * g + Math.sqrt((M * g) ** 2 + k * M * v * v);
  const drop = (breakingLoad) =>
    new MooringLine({
      start: [0, 0, 0],
      end: [0, -L, 0],
      length: L,
      massPerLength: 1e-6,
      axialStiffness: k * L,
      segments: 10,
      fixed: 'start',
      damping: 0,
      clumps: [{ node: 10, mass: M }],
      velocity: [0, -v, 0],
      breakingLoad,
    });
  const line = drop();
  let peak = 0;
  for (let i = 0; i < 120; i++) {
    line.step(1 / 1200);
    peak = Math.max(peak, line.tension(0));
  }
  assert.ok(Math.abs(peak / exact - 1) < 1e-3, `snapped to ${peak} N, the closed form ${exact} N`);
  assert.equal(line.broken, -1);
  // A real line (0.01 kg/m, its own damping) rated at 1 kN parts on the way up the snap; the piece below the break, clump and
  // line, then falls freely as a whole: its pulls are internal, so its momentum gains (M + m) g t exactly.
  const weak = new MooringLine({
    start: [0, 0, 0],
    end: [0, -L, 0],
    length: L,
    massPerLength: 0.01,
    axialStiffness: k * L,
    segments: 10,
    fixed: 'start',
    clumps: [{ node: 10, mass: M }],
    velocity: [0, -v, 0],
    breakingLoad: 1000,
  });
  for (let i = 0; i < 60 && weak.broken < 0; i++) weak.step(1 / 1200);
  assert.ok(weak.broken >= 0, 'the line parted');
  const mass = (i) => (i === 10 ? M + 0.001 : 0.002),
    momentum = () => {
      let p = 0;
      for (let i = weak.broken + 1; i <= 10; i++) p += mass(i) * weak.velocity(i)[1];
      return p;
    },
    held = (() => {
      let m = 0;
      for (let i = weak.broken + 1; i <= 10; i++) m += mass(i);
      return m;
    })(),
    before = momentum();
  for (let i = 0; i < 120; i++) weak.step(1 / 1200);
  const gained = before - momentum();
  assert.ok(Math.abs(gained / (held * g * 0.1) - 1) < 1e-9, `the parted piece gained ${gained} N s, (M + m) g t`);
  assert.equal(weak.tension(weak.broken), 0, 'the parted segment carries nothing');
});

test("a buoy on a line pulls its anchor up by its lift less the line's weight in water", () => {
  // A 10 m steel line from the bed up to a buoy of 0.1 m^3 and 20 kg in still water: at rest the anchor holds the buoy's
  // net lift less the line's weight in water, (rho V - M) g - (m - rho A) g L; measured within 0.001 %, held to 0.1 %.
  const rho = 1025,
    m = 2,
    A = m / 7850,
    line = new MooringLine({
      start: [0, 0, 0],
      end: [0, 10, 0],
      length: 10,
      massPerLength: m,
      axialStiffness: 1e7,
      segments: 20,
      fixed: 'start',
      water: still(rho),
      clumps: [{ node: 20, mass: 20, volume: 0.1 }],
    });
  for (let i = 0; i < 1200; i++) line.step(1 / 60);
  const pull = line.endForce('start')[1],
    exact = (rho * 0.1 - 20) * g - (m - rho * A) * g * 10;
  assert.ok(Math.abs(pull / exact - 1) < 1e-3, `the anchor holds ${pull} N, the closed form ${exact} N`);
});

test('a chain settles as the elastic catenary with its grounded length on the seabed', () => {
  // 100 m of 10 kg/m steel chain in sea water from an anchor on a frictionless bed to a fairlead 90 m off and 20 m up.
  // The elastic catenary with a grounded length (Irvine 1981): with w its weight in water, H the horizontal tension and V
  // the fairlead's vertical pull, L - V / w + (H / w) asinh(V / H) + H L / EA = 90 and (H / w)(sqrt(1 + (V / H)^2) - 1) +
  // V^2 / (2 EA w) = 20. At 100 segments the settled pull is within 0.3 % of it (the touchdown falls between nodes, and
  // the grounded part slides slowly on a bed without friction); held to 1 %.
  const rho = 1025,
    m = 10,
    EA = 1e7,
    L = 100,
    X = 90,
    h = 20,
    w = (m - (rho * m) / 7850) * g;
  const line = new MooringLine({
    start: [0, 0, 0],
    end: [X, h, 0],
    length: L,
    massPerLength: m,
    axialStiffness: EA,
    segments: 100,
    water: still(rho),
    seabed: {},
    drag: { normal: 2.4, tangential: 1.15 },
  });
  for (let i = 0; i < 3600; i++) line.step(1 / 60);
  const [fx, fy] = line.endForce('end'),
    pullAt = (H) => {
      let lo = 0,
        hi = w * L;
      for (let k = 0; k < 200; k++) {
        const V = (lo + hi) / 2;
        if ((H / w) * (Math.sqrt(1 + (V / H) ** 2) - 1) + (V * V) / (2 * EA * w) > h) hi = V;
        else lo = V;
      }
      return (lo + hi) / 2;
    };
  let lo = 1,
    hi = 1e6;
  for (let k = 0; k < 200; k++) {
    const H = Math.sqrt(lo * hi),
      V = pullAt(H);
    if (L - V / w + (H / w) * Math.asinh(V / H) + (H * L) / EA > X) hi = H;
    else lo = H;
  }
  const H = Math.sqrt(lo * hi),
    V = pullAt(H);
  assert.ok(Math.abs(-fx / H - 1) < 0.01, `horizontal pull ${-fx} N, the catenary ${H} N`);
  assert.ok(Math.abs(-fy / V - 1) < 0.01, `vertical pull ${-fy} N, the catenary ${V} N`);
  const grounded = L - V / w;
  let resting = 0;
  for (let i = 0; i <= 100; i++) if (line.position(i)[1] < 1e-9) resting++;
  assert.ok(Math.abs(resting - grounded) <= 2, `${resting} m rests on the bed, the catenary grounds ${grounded} m`);
});

test("a chain's top driven round a circle pulls as the measured 33 m chain did", (t) => {
  // L. Bergdahl, J. Palm, C. Eskilsson and J. Lindahl, "Dynamically scaled model experiment of a mooring cable", J. Mar. Sci.
  // Eng. 4(1):5 (2016), https://doi.org/10.3390/jmse4010005 (open): 33 m of chain (0.0818 kg/m, EA 10 kN, steel bar 2.2 mm)
  // from an anchor on the basin floor to a sheave 32.554 m off and 3.3 m up, the water 3 m deep; the top driven clockwise
  // (Fig. 3, the anchor to the left) round circles of radius 0.075 to 0.2 m at periods of 1.25 to 3.5 s. Their Table 7: the
  // mean of the maximum top tension once steady, read to +-5 %. The line's inputs are their Table 8 (drag across 2.5 and
  // along 0.5 on the bar diameter, added mass 3.8 on the steel's volume, bed friction 0.3). Over the 30 cases the rod's
  // mean error is 2.7 % (+1.6 % on average), 23 within the reading error, the other seven at 5.0 to 7.4 %, at the two
  // smallest radii and the longest periods, where the peak is least; held to a mean of 3.5 % and 8 % each.
  const measured = {
      1.25: [42.5, 46.8, 54.1, 60.4, 70.3],
      1.5: [41.0, 45.3, 51.5, 59.0, 68.0],
      2.0: [36.0, 39.5, 47.5, 54.1, 62.3],
      2.5: [31.1, 35.4, 42.5, 49.0, 57.3],
      3.0: [29.5, 33.1, 39.3, 45.8, 54.0],
      3.5: [27.8, 31.5, 37.5, 42.5, 50.1],
    },
    radii = [0.075, 0.1, 0.125, 0.15, 0.2],
    sheave = [32.554, 3.3, 0],
    errors = [];
  for (const [period, row] of Object.entries(measured))
    row.forEach((tension, j) => {
      const T = Number(period),
        r = radii[j],
        w = (2 * Math.PI) / T,
        at = (time) => [sheave[0] + r * Math.cos(-w * time), sheave[1] + r * Math.sin(-w * time), 0],
        line = new MooringLine({
          start: [0, 0, 0],
          end: at(0),
          length: 33,
          massPerLength: 0.0818,
          axialStiffness: 1e4,
          segments: 66,
          density: 7800,
          diameter: 0.0022,
          drag: { normal: 2.5, tangential: 0.5 },
          addedMass: 3.8,
          water: still(1000, 3),
          seabed: { friction: 0.3 },
        }),
        dt = 1 / 200;
      for (let i = 0; i < 2000; i++) line.step(dt);
      let time = 0,
        sum = 0;
      for (let c = 0; c < 8; c++) {
        let peak = 0;
        for (let i = 0; i < Math.round(T / dt); i++) {
          time += dt;
          line.setEnd('end', at(time));
          line.step(dt);
          peak = Math.max(peak, Math.hypot(...line.endForce('end')));
        }
        if (c >= 4) sum += peak / 4;
      }
      errors.push(sum / tension - 1);
      assert.ok(Math.abs(sum / tension - 1) < 0.08, `period ${T} s, radius ${r} m: ${sum} N, measured ${tension} N`);
    });
  const mean = errors.reduce((a, e) => a + Math.abs(e), 0) / errors.length;
  t.diagnostic(
    `mean |error| ${(mean * 100).toFixed(2)} %, worst ${(Math.max(...errors.map(Math.abs)) * 100).toFixed(2)} %`,
  );
  assert.ok(mean < 0.035, `mean error ${mean}`);
});

test('a mooring line refuses what it cannot be made of, naming the fix', () => {
  const refused = (message) => ({ name: 'MargoError', code: 'unsupported', message: new RegExp(`${message}.+#rods`) });
  const base = { start: [0, 0, 0], end: [10, 0, 0], length: 10, massPerLength: 1, axialStiffness: 1e5 };
  assert.throws(() => new MooringLine({ ...base, length: 9 }), refused('cannot reach'));
  assert.throws(() => new MooringLine({ ...base, segments: 1 }), refused('2 to 4096 segments'));
  assert.throws(() => new MooringLine({ ...base, massPerLength: 0 }), refused('massPerLength is above 0'));
  assert.throws(() => new MooringLine({ ...base, clumps: [{ node: 41, mass: 1 }] }), refused('clump hangs at a node'));
  assert.throws(() => new MooringLine({ ...base, fixed: 'start' }).setEnd('end', [0, 0, 0]), refused('is free'));
  assert.throws(() => new MooringLine(base).step(0), refused('finite time'));
});
