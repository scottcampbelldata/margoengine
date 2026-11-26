// Soft bodies in water (`SoftBodies.water`, SOFT-01): Morison's loads on ropes and cloth, checked against what they must
// give exactly: a rope as dense as the water hangs where it is, a heavier one sinks at the speed its drag allows, a
// pendulum in water swings at the period its carried water sets, a rope as dense as the water rides the water's
// oscillation, and a sheet sinks at its plate drag's speed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

const RHO = 1025;

/** A world with soft bodies in deep still water (its surface at y = 0), or in `flow`. */
async function inWater(flow) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    soft = await SoftBodies.attach(physics);
  soft.water = { elevation: () => 0, density: RHO, ...(flow ? { flow } : {}) };
  return { physics, soft, g: -physics.gravity[1] };
}

/**
 * A straight rope of `count` particles `spacing` apart along x at depth `depth`, `mass` a particle (half at its two ends,
 * which hold half a segment each, so the rope is even), of material `density`.
 */
function rope(soft, count, spacing, depth, mass, density) {
  const desc = SoftBodyDesc.rope([0, -depth, 0], [(count - 1) * spacing, -depth, 0], count)
    .setMasses(Array.from({ length: count }, (_, i) => (i === 0 || i === count - 1 ? mass / 2 : mass)))
    .setDensity(density)
    .setAirDrag(false);
  return soft.create(desc);
}

test('water: a rope as dense as the water stays where it is', async () => {
  const { physics, soft } = await inWater();
  // A 4 cm rope: each 0.1 m particle holds pi (0.02)^2 0.1 m^3 of material.
  const volume = Math.PI * 0.02 * 0.02 * 0.1,
    body = rope(soft, 21, 0.1, 5, RHO * volume, RHO);
  for (let f = 0; f < 120; f++) physics.step();
  for (let i = 0; i < 21; i++) assert.ok(Math.abs(body.particlePosition(i)[1] + 5) < 1e-4, `particle ${i}`);
});

test('water: a rope twice as dense as the water sinks broadside at the speed its cylinder drag allows', async () => {
  // Its weight in water on a metre, (rho_r - rho) g pi d^2 / 4, held by the drag across it, 1/2 rho C_D d v^2 (C_D 1.2):
  // v = sqrt((rho_r / rho - 1) g pi d / (2 C_D)). Measured at its middle 0.5 percent fast after 4 s: a bound of 1 percent.
  const { physics, soft, g } = await inWater(),
    d = 0.04,
    volume = (Math.PI * d * d * 0.1) / 4,
    body = rope(soft, 21, 0.1, 20, 2 * RHO * volume, 2 * RHO),
    terminal = Math.sqrt(((2 - 1) * g * Math.PI * d) / (2 * 1.2));
  for (let f = 0; f < 240; f++) physics.step();
  const v = -body.particleVelocity(10)[1];
  assert.ok(Math.abs(v / terminal - 1) < 0.01, `sinks at ${v} m/s against ${terminal}`);
});

test('water: a pendulum under water swings at the period its carried water and its buoyancy set', async () => {
  // A 1 m rope of two particles, the top one pinned, the bottom one 3 times as dense as the water: a pendulum of
  // period 2 pi sqrt(L (m + m_a) / ((m - rho V) g)), m_a the bottom particle's half of the segment's carried water (C_a 1,
  // of the cylinder both particles' volume makes along it, so rho V). Its drag damps it but barely moves the period at 2
  // degrees. Measured 0.5 percent short: a bound of 1.5 percent.
  const { physics, soft, g } = await inWater(),
    L = 1,
    density = 3 * RHO,
    m = 2,
    V = m / density,
    // The segment's cylinder: both particles' volume (the pinned one's too) over its length.
    sectionVolume = 2 * V,
    ma = (1 * RHO * sectionVolume) / 2,
    period = 2 * Math.PI * Math.sqrt((L * (m + ma)) / ((m - RHO * V) * g)),
    angle = (2 * Math.PI) / 180,
    body = soft.create(
      SoftBodyDesc.rope([0, -5, 0], [L * Math.sin(angle), -5 - L * Math.cos(angle), 0], 2)
        .setParticleMass(m)
        .setDensity(density)
        .setPinnedParticles([0])
        .setAirDrag(false),
    );
  let last = body.particlePosition(1)[0],
    crossings = [];
  for (let f = 1; f <= 60 * 12; f++) {
    physics.step();
    const x = body.particlePosition(1)[0];
    if (last > 0 && x <= 0) crossings.push(f - x / (x - last));
    last = x;
  }
  const measured = (crossings.at(-1) - crossings[0]) / (crossings.length - 1) / 60;
  assert.ok(Math.abs(measured / period - 1) < 0.015, `period ${measured} s against ${period}`);
});

test("water: a rope as dense as the water rides the water's oscillation", async () => {
  // A uniform current swinging along x as u = U sin(w t): a body as dense as the water, with its carried water, moves
  // with it (Morison: (m + m_a) a = (rho V + m_a) a_w, drag 0 at no relative speed), so it goes 2 U / w out and back.
  // Measured 1.3 percent over (the step's lag at 60 steps a second over the swing): a bound of 2 percent.
  const U = 0.5,
    w = 1,
    flow = {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, t, out = { velocity: [0, 0, 0], density: RHO, temperature: 288 }) => {
        out.velocity[0] = U * Math.sin(w * t);
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        return out;
      },
    },
    { physics, soft } = await inWater(flow),
    volume = Math.PI * 0.02 * 0.02 * 0.1,
    body = rope(soft, 11, 0.1, 5, RHO * volume, RHO);
  let lo = Infinity,
    hi = -Infinity;
  for (let f = 0; f < 60 * 2 * Math.PI; f++) {
    physics.step();
    const x = body.particlePosition(5)[0];
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  assert.ok(Math.abs((hi - lo) / ((2 * U) / w) - 1) < 0.02, `it went ${hi - lo} m against ${(2 * U) / w}`);
});

test('water: a weighted tarp held flat sinks at the speed its plate drag allows', async () => {
  // A 1 m square tarp of 50 kg, displacing nothing, held level by a stiff material: its weight m g held by
  // 1/2 rho C_N A v^2 (C_N 1.17). It carries about 490 kg of water (a disk of its area, (8/3) rho a^3), so it takes
  // seconds to come to that speed; flat at 5 s (within 0.15 m), it then starts to bow and flutter, as a plate falling
  // broadside does. Measured 0.24 percent slow at 5 s: a bound of 2 percent.
  const { physics, soft, g } = await inWater(),
    n = 11,
    // Each particle's mass its share of the sheet's area (a quarter at the corners, a half along the edges), so it is even.
    share = Array.from({ length: n * n }, (_, k) => {
      const i = Math.floor(k / n),
        j = k % n;
      return (i === 0 || i === n - 1 ? 0.5 : 1) * (j === 0 || j === n - 1 ? 0.5 : 1);
    }),
    sum = share.reduce((a, b) => a + b, 0),
    sheet = soft.create(
      SoftBodyDesc.cloth([-0.5, -10, -0.5], [0.1, 0, 0], [0, 0, 0.1], n, n)
        .setMasses(share.map((s) => (50 * s) / sum))
        .setSoftness(200, 1),
    ),
    terminal = Math.sqrt((2 * 50 * g) / (RHO * 1.17 * 1));
  for (let f = 0; f < 300; f++) physics.step();
  const v = -sheet.particleVelocity(Math.floor((n * n) / 2))[1];
  assert.ok(Math.abs(v / terminal - 1) < 0.02, `sinks at ${v} m/s against ${terminal}`);
});

test('water: a bad density is refused', () => {
  assert.throws(() => SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 3).setDensity(0), /density/);
});
