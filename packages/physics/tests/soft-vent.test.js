// Venting and bursting (P8, SOFT-06): `body.openVent({particle, area})` lets a gas shell's gas out as an ideal gas through an
// orifice (src/soft-vent.ts) and pushes the shell back by its jet; a membrane's `burstStretch` bursts it. The flow is held to
// the closed forms of compressible orifice flow, the blowdown of a vessel to its exponential while choked, the jet's push to
// the momentum the shell gains, and the burst to the stretch it was given.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc, ventFlow, ventStep, ventThrust } from '../dist/soft.js';

await Physics.load();

const AMBIENT = 101325;
const air = (area, dischargeCoefficient = 0.61) => ({
  particle: 0,
  area,
  dischargeCoefficient,
  gasConstant: 287.05,
  temperature: 293.15,
  heatCapacityRatio: 1.4,
});

function icosphere(r, levels) {
  const t = (1 + Math.sqrt(5)) / 2;
  const positions = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => p.map((v) => v / Math.hypot(...p)));
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let level = 0; level < levels; level++) {
    const middle = new Map(),
      mid = (a, b) => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (!middle.has(key)) {
          const p = [0, 1, 2].map((k) => positions[a][k] + positions[b][k]),
            n = Math.hypot(...p);
          middle.set(key, positions.push(p.map((v) => v / n)) - 1);
        }
        return middle.get(key);
      },
      next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { positions: positions.flat().map((v) => v * r), indices: faces.flat() };
}

test('orifice flow: the choked flow, its continuity at the critical ratio, and the small-drop limit Cd A sqrt(2 rho dp)', () => {
  const vent = air(1e-4),
    rt = 287.05 * 293.15,
    critical = (2 / 2.4) ** 3.5;
  // Choked: Cd A p0 sqrt(gamma / RT) (2 / (gamma + 1))^3 for air.
  const p0 = 5 * AMBIENT;
  const choked = 0.61 * 1e-4 * p0 * Math.sqrt(1.4 / rt) * (2 / 2.4) ** 3;
  assert.ok(Math.abs(ventFlow(vent, p0, AMBIENT) - choked) <= 1e-12 * choked);
  // The two laws meet at the critical ratio.
  const at = AMBIENT / critical;
  const below = ventFlow(vent, at * (1 - 1e-9), AMBIENT),
    above = ventFlow(vent, at * (1 + 1e-9), AMBIENT);
  assert.ok(Math.abs(above - below) <= 1e-6 * above, `${below} and ${above} at the critical ratio`);
  // A small drop dp: the flow is Cd A sqrt(2 rho dp) to first order in dp / p (rho = p / RT inside).
  for (const dp of [10, 100]) {
    const inside = AMBIENT + dp,
      bernoulli = 0.61 * 1e-4 * Math.sqrt((2 * inside * dp) / rt),
      flow = ventFlow(vent, inside, AMBIENT);
    // The next term is of relative size (3 / (2 gamma) - 1 / 2) dp / p, under 0.6 dp / p.
    assert.ok(
      Math.abs(flow - bernoulli) <= 0.6 * (dp / inside) * bernoulli,
      `${flow} against ${bernoulli} at ${dp} Pa`,
    );
  }
  assert.equal(ventFlow(vent, AMBIENT, AMBIENT), 0, 'no flow without a drop');
  assert.equal(ventFlow(vent, 0.9 * AMBIENT, AMBIENT), 0, 'a vent lets nothing in');
});

test('a vessel blows down along its exponential while choked, and stops at the air outside', () => {
  const vent = air(2e-5),
    volume = 1e-3,
    rt = 287.05 * 293.15,
    rate = (0.61 * 2e-5 * Math.sqrt(1.4 * rt) * (2 / 2.4) ** 3) / volume;
  let product = 6 * AMBIENT * volume;
  for (let t = 1 / 60; t <= 0.5; t += 1 / 60) {
    product = ventStep([vent], product, volume, AMBIENT, 1 / 60).product;
    const p = product / volume,
      exact = 6 * AMBIENT * Math.exp(-rate * t);
    if (exact < AMBIENT / 0.5283) break;
    // Fourth-order Runge-Kutta over 8 parts of a step: the error is (rate h)^5 / 120 a part, far below 1e-9.
    assert.ok(Math.abs(p - exact) <= 1e-9 * exact, `${p} Pa against ${exact} Pa at ${t} s`);
  }
  for (let k = 0; k < 600; k++) product = ventStep([vent], product, volume, AMBIENT, 1 / 60).product;
  assert.ok(Math.abs(product / volume - AMBIENT) < 1, 'it ends at the air outside, not below it');
});

test("a loose balloon vented at one point flies off the other way, gaining the jet's impulse", async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 120 });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(
    SoftBodyDesc.volume(icosphere(0.1, 2), {
      pressure: 3 * AMBIENT,
      density: 50,
      membrane: { shearModulus: 30e6, thickness: 1e-3 },
    }).setAirDrag(false),
  );
  for (let i = 0; i < 60; i++) physics.step();
  // The particle at the top (largest y).
  const ys = ball.particlePositions().filter((_, k) => k % 3 === 1),
    top = ys.indexOf(Math.max(...ys));
  ball.openVent({ particle: top, area: 5e-5 });
  const momentum = () => {
    const v = ball.particleVelocities(),
      m = ball.mass() / ball.numParticles();
    let py = 0;
    for (let k = 1; k < v.length; k += 3) py += v[k] * m;
    return py;
  };
  const start = momentum();
  let impulse = 0;
  for (let i = 0; i < 60; i++) {
    const before = ball.gasState(),
      vent = ball.openVents()[0];
    physics.step();
    const after = ball.gasState(),
      gone = (before.pressure * before.volume - after.pressure * after.volume) / (287.05 * 293.15),
      mean = (before.pressure + after.pressure) / 2;
    impulse += ventThrust(vent, mean, AMBIENT, gone * 120) / 120;
  }
  const gained = momentum() - start;
  assert.ok(gained < 0, 'the jet leaves upward, so the balloon moves down');
  // The shell's momentum carries the jet's impulse; the soft kernel's float32 springs keep it within 1e-3 (docs/limits.md),
  // and the volume the shell has moves by under 1% over a step, which the thrust's mean pressure takes at its middle.
  assert.ok(Math.abs(-gained - impulse) <= 0.02 * impulse, `momentum ${-gained} N s against the jet's ${impulse} N s`);
  assert.ok(ball.gasState().pressure < 3 * AMBIENT, 'it lost gas');
});

test('a membrane past its burst stretch bursts: it reports, lets its gas go, and stays finite', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 120 });
  const soft = await SoftBodies.attach(physics);
  const events = [];
  soft.onBurst((event) => events.push(event));
  // A fill that the closed form holds at a stretch of 1.25, against a sheet that bursts at 1.2.
  const ball = soft.create(
    SoftBodyDesc.volume(icosphere(0.1, 2), {
      pressure: 190_000,
      density: 50,
      membrane: { shearModulus: 300e3, thickness: 0.5e-3, burstStretch: 1.2 },
    })
      .setAirDrag(false)
      .setLinearDamping(5),
  );
  for (let i = 0; i < 240 && !events.length; i++) physics.step();
  assert.equal(events.length, 1, 'it burst once');
  assert.equal(events[0].body, ball);
  assert.ok(events[0].triangles.length > 0 && events[0].pressure > AMBIENT);
  assert.ok(ball.isBurst());
  assert.equal(ball.gasState(), null, 'its gas is gone');
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(ball.particlePositions().every(Number.isFinite), 'it stays finite');
  assert.equal(events.length, 1, 'a burst sheet does not burst again');
});

test('vents and bursts it cannot use are refused with coded errors', async () => {
  const physics = new Physics(null);
  const soft = await SoftBodies.attach(physics);
  const held = soft.create(SoftBodyDesc.volume(icosphere(0.1, 1)));
  const gas = soft.create(SoftBodyDesc.volume(icosphere(0.1, 1), { pressure: 120_000 }).setTranslation([1, 0, 0]));
  const refused = (fn, pattern) =>
    assert.throws(
      fn,
      (e) => e.code === 'unsupported' && pattern.test(e.message) && /errors#soft-volumes/.test(e.message),
    );
  refused(() => held.openVent({ particle: 0, area: 1e-4 }), /gas shell/);
  refused(() => gas.openVent({ particle: -1, area: 1e-4 }), /particle/);
  refused(() => gas.openVent({ particle: 0, area: 0 }), /area/);
  refused(() => gas.openVent({ particle: 0, area: 1e-4, dischargeCoefficient: 1.5 }), /at most 1/);
  refused(() => gas.openVent({ particle: 0, area: 1e-4, heatCapacityRatio: 1 }), /heatCapacityRatio/);
  gas.openVent({ particle: 0, area: 1e-4 });
  refused(() => gas.openVent({ particle: 1, area: 1e-4, temperature: 400 }), /one gas/);
  refused(
    () =>
      SoftBodyDesc.volume(icosphere(0.1, 1), {
        pressure: 120_000,
        membrane: { shearModulus: 1e5, thickness: 1e-3, burstStretch: 1 },
      }),
    /burstStretch/,
  );
});

test('a venting balloon replays bit for bit after a snapshot and restore', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(
    SoftBodyDesc.volume(icosphere(0.1, 1), { pressure: 2 * AMBIENT, membrane: { shearModulus: 3e6, thickness: 1e-3 } }),
  );
  ball.openVent({ particle: 3, area: 2e-5 });
  for (let i = 0; i < 10; i++) physics.step();
  const saved = soft.takeSnapshot();
  for (let i = 0; i < 20; i++) physics.step();
  const expected = soft.hash(),
    pressure = ball.gasState().pressure;
  soft.restoreSnapshot(saved);
  for (let i = 0; i < 20; i++) physics.step();
  assert.equal(soft.hash(), expected, 'the restored world vents to the same bits');
  assert.equal(ball.gasState().pressure, pressure);
});
