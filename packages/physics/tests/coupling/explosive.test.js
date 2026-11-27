// ExplosionSolver (FIRE-05) in a world: the same at any frame rate, a snapshot and restore re-runs it bit for bit, its
// `explosions` field reaches a solver that reads it (as the blast, crater and plume solvers do), and its case fragments
// keep the case's mass, leave with no net momentum at Gurney's speed and fly as the closed form says.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPLOSION_WORDS, ExplosionSolver, FRAGMENT_WORDS, gurneyVelocity, metalSpeed } from '../../dist/explosive.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const charges = [
  { position: [0, 1, 0], time: 0.05, mass: 10, case: { mass: 20, fragments: 64 } },
  { position: [30, 0, 0], time: 0.2, mass: 1000, depth: 4 },
];

/** A solver that reads the explosions field: what the blast solver will see, the air energy of every charge gone off. */
class Listener {
  constructor(field) {
    this.field = field;
    this.id = 'listener';
    this.region = null;
  }
  describe() {
    return { id: this.id, rate: 0, stableRate: () => 0, fields: [{ field: this.field, access: 'read' }] };
  }
  init(host) {
    this.host = host;
    this.region = host.allocate('heard', 8, 'f64', 1);
  }
  step(context) {
    const port = context.inputs.get(this.field.name);
    const rows = new Float64Array(this.host.memory.buffer, port.region.byteOffset, port.region.byteLength / 8);
    let air = 0;
    for (let i = 0; i < rows.length; i += EXPLOSION_WORDS) if (rows[i + 9] === 1) air += rows[i + 5];
    new Float64Array(this.host.memory.buffer, this.region.byteOffset, 1)[0] = air;
  }
  heard() {
    return new Float64Array(this.host.memory.buffer, this.region.byteOffset, 1)[0];
  }
  exportPorts() {
    return [];
  }
  importPorts() {}
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

const make = (rate = { num: 24, den: 1 }) => {
  const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] });
  const solver = new ExplosionSolver();
  world.add(solver, { charges });
  return world;
};

test('ExplosionSolver steps the same at 24, 30 and 60 frames a second', () => {
  frameRateIndependent(make, { seconds: 1 });
});

test('ExplosionSolver: a snapshot and restore re-runs it bit for bit', () => {
  seekEqualsContinuous(() => make());
});

test('the explosions field reaches a solver that reads it: each charge’s air energy once it has gone off, and not before', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
  const solver = new ExplosionSolver();
  world.add(solver, { charges });
  const listener = new Listener(solver.explosionsField);
  world.add(listener, {});
  world.advance(2);
  assert.equal(listener.heard(), 0, 'nothing has gone off at 1/30 s');
  world.advance(6);
  assert.equal(listener.heard(), solver.charge(0).air, 'the first charge at 0.05 s');
  world.advance(18);
  assert.equal(listener.heard(), solver.charge(0).air + solver.charge(1).air, 'and the buried one at 0.2 s');
  assert.ok(solver.charge(1).air < 0.2 * solver.charge(1).energy, 'the buried charge sends little into the air');
});

test('the case fragments carry the case mass, leave with no net momentum at Gurney’s speed, and a buried case stays put', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
  const solver = new ExplosionSolver();
  world.add(solver, { charges });
  const f = solver.fragments();
  assert.equal(f.length, 64 * FRAGMENT_WORDS, 'only the surface charge throws fragments');
  let mass = 0;
  const p = [0, 0, 0];
  const speed = metalSpeed(
    gurneyVelocity({ name: 'TNT', heatOfDetonation: 1.09 * 4.184e6, gurney: 2370 }),
    'cylinder',
    2,
  );
  for (let i = 0; i < f.length; i += FRAGMENT_WORDS) {
    mass += f[i + 6];
    for (let k = 0; k < 3; k++) p[k] += f[i + 6] * f[i + 3 + k];
    const v = Math.hypot(f[i + 3], f[i + 4], f[i + 5]);
    assert.ok(Math.abs(v - speed) < 1e-9 * speed, `fragment speed ${v} against ${speed}`);
    // A cylinder's fragments fly across its axis (up).
    assert.ok(Math.abs(f[i + 4]) < 1e-9 * speed);
  }
  assert.ok(Math.abs(mass - 20) < 1e-12, `case mass ${mass}`);
  for (const k of [0, 1, 2]) assert.ok(Math.abs(p[k]) < 1e-9 * 20 * speed, `momentum ${p}`);
});

test("the fragment masses follow Mott's distribution: sqrt(m) is exponentially distributed", () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
  const solver = new ExplosionSolver();
  world.add(solver, { charges: [{ position: [0, 1, 0], mass: 10, case: { mass: 20, fragments: 2000 } }] });
  const f = solver.fragments();
  const roots = [];
  for (let i = 0; i < f.length; i += 2 * FRAGMENT_WORDS) roots.push(Math.sqrt(f[i + 6]));
  roots.sort((a, b) => a - b);
  const mean = roots.reduce((a, b) => a + b, 0) / roots.length;
  // Kolmogorov-Smirnov distance to the exponential of the same mean; 1000 draws: 1.63 / sqrt(1000) at the 1 % level.
  let ks = 0;
  roots.forEach((x, i) => {
    const cdf = 1 - Math.exp(-x / mean);
    ks = Math.max(ks, Math.abs(cdf - i / roots.length), Math.abs(cdf - (i + 1) / roots.length));
  });
  assert.ok(ks < 1.63 / Math.sqrt(roots.length), `KS distance ${ks}`);
});

test('with no drag a fragment flies the closed-form arc, and with drag it lands shorter', () => {
  const flight = (dragCoefficient) => {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
    const solver = new ExplosionSolver();
    world.add(solver, {
      charges: [{ position: [0, 100, 0], mass: 1, case: { mass: 2, fragments: 2, dragCoefficient } }],
    });
    world.advance(60);
    return solver.fragments();
  };
  const free = flight(0);
  // The step integrates gravity after the velocity (semi-implicit Euler): after n steps of h the drop is g h^2 n(n+1)/2.
  const n = 60,
    h = 1 / 60,
    drop = 9.81 * h * h * ((n * (n + 1)) / 2);
  for (let i = 0; i < free.length; i += FRAGMENT_WORDS) {
    assert.ok(Math.abs(free[i + 1] - (100 - drop)) < 1e-9, `height ${free[i + 1]} against ${100 - drop}`);
  }
  const dragged = flight(1);
  assert.ok(Math.hypot(dragged[0], dragged[2]) < Math.hypot(free[0], free[2]) * 0.9, 'drag shortens the flight');
});

test('bad charges are refused with the fix', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(() => world.add(new ExplosionSolver('a'), { charges: [] }), TypeError);
  assert.throws(() => world.add(new ExplosionSolver('b'), { charges: [{ position: [0, 0, 0] }] }), /mass .* or energy/);
  assert.throws(
    () => world.add(new ExplosionSolver('c'), { charges: [{ position: [0, 0, 0], mass: 1, case: { mass: 100 } }] }),
    /0\.2 to 10/,
  );
  assert.throws(
    () =>
      world.add(new ExplosionSolver('d'), {
        charges: [{ position: [0, 0, 0], mass: 1, case: { mass: 1, fragments: 3 } }],
      }),
    RangeError,
  );
});
