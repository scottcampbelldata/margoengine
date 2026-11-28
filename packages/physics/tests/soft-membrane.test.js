// A soft volume's membrane shell (P8, SOFT-04 and SOFT-06, point 2): `SoftBodyDesc.volume(mesh, {pressure, membrane})` makes
// the shell an incompressible neo-Hookean sheet (soft-kernel/src/membrane.rs) that balances its gas. A sphere of rest radius R
// stretched by lambda all round holds the overpressure p = 2 mu H / R (1 / lambda - 1 / lambda^7) (Adkins and Rivlin 1952;
// Treloar 1975), so its stiffness against its own pressure is the closed form's, rising to its peak at 7^(1/6) and held out
// at a second sheet the calibration never saw.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../dist/world.js';

await Physics.load();

const AMBIENT = 101325;

/** An icosphere of radius r: an icosahedron split `levels` times, each new vertex pushed onto the sphere. Outward wound. */
function icosphere(r, levels) {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions = [
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
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
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

const meshArea = ({ positions: p, indices }) => {
  let area = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    const u = [0, 1, 2].map((j) => b[j] - a[j]),
      v = [0, 1, 2].map((j) => c[j] - a[j]);
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return area;
};

const meshVolume = ({ positions: p, indices }) => {
  let volume = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return volume;
};

/** The closed form's overpressure at a stretch, for a sphere whose rest area over volume is that of the mesh (3 / R). */
const overpressure = (mu, thickness, areaOverVolume, lambda) =>
  ((2 * mu * thickness * areaOverVolume) / 3) * (1 / lambda - 1 / lambda ** 7);

/**
 * Inflates a membrane ball whose fill, at its rest volume, is the pressure that holds it at `lambda` in the closed form, and
 * returns the stretch it settles at, (V / V0)^(1/3), and the pressure it then holds.
 */
async function settle({ mu, thickness, lambda, levels = 3, radius = 0.1 }) {
  const mesh = icosphere(radius, levels);
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 120 });
  const soft = await SoftBodies.attach(physics);
  const v0 = meshVolume(mesh);
  const areaOverVolume = meshArea(mesh) / v0;
  // p_fill V0 = (p_ambient + overpressure) V0 lambda^3: the fill that holds it at lambda.
  const fill = (AMBIENT + overpressure(mu, thickness, areaOverVolume, lambda)) * lambda ** 3;
  const ball = soft.create(
    SoftBodyDesc.volume(mesh, { pressure: fill, density: 50, membrane: { shearModulus: mu, thickness } })
      .setAirDrag(false)
      .setLinearDamping(20),
  );
  for (let i = 0; i < 600; i++) physics.step();
  const state = ball.gasState();
  return { stretch: Math.cbrt(state.volume / v0), held: state.pressure - AMBIENT, areaOverVolume, soft, ball };
}

// The bound: a ball dilated uniformly is the closed form's exactly, the mesh's own area over volume standing for 3 / R, so
// what is left is the passes' convergence and float32 positions (an ulp of 0.1 m is 7e-9 m, a stretch of 7e-8): the stretch
// within 1e-4 and the pressure it holds within 1e-3 of the closed form at that stretch. Measured: 1e-7 and 2e-5.
const STRETCH = 1e-4,
  PRESSURE = 1e-3;

test("a membrane ball's stiffness against its own pressure is the closed form's on the rising branch", async () => {
  const mu = 300e3,
    thickness = 0.5e-3;
  const points = [];
  for (const lambda of [1.1, 1.12, 1.25]) {
    const { stretch, held, areaOverVolume } = await settle({ mu, thickness, lambda });
    assert.ok(Math.abs(stretch - lambda) <= STRETCH, `stretch ${stretch} against ${lambda}`);
    const expected = overpressure(mu, thickness, areaOverVolume, stretch);
    assert.ok(Math.abs(held - expected) <= PRESSURE * expected, `overpressure ${held} Pa against ${expected} Pa`);
    points.push({ stretch, held, areaOverVolume });
  }
  // dp / dlambda = 2 mu H / R (7 / lambda^8 - 1 / lambda^2), between the two near fills.
  const [a, b] = points,
    slope = (b.held - a.held) / (b.stretch - a.stretch),
    mid = (a.stretch + b.stretch) / 2,
    closed = ((2 * mu * thickness * a.areaOverVolume) / 3) * (7 / mid ** 8 - 1 / mid ** 2);
  assert.ok(Math.abs(slope - closed) <= 0.01 * closed, `stiffness ${slope} Pa per unit stretch against ${closed}`);
});

test('held out: a thinner, stiffer, smaller sheet near its peak on a coarser mesh', async () => {
  const mu = 1e6,
    thickness = 0.2e-3;
  const { stretch, held, areaOverVolume } = await settle({ mu, thickness, lambda: 1.35, levels: 2, radius: 0.05 });
  assert.ok(Math.abs(stretch - 1.35) <= STRETCH, `stretch ${stretch}`);
  const expected = overpressure(mu, thickness, areaOverVolume, stretch);
  assert.ok(Math.abs(held - expected) <= PRESSURE * expected, `overpressure ${held} Pa against ${expected} Pa`);
  // Near the peak, 7^(1/6), the pressure is within 1% of its greatest value 2 mu H / R (7^(-1/6) - 7^(-7/6)).
  const peak = overpressure(mu, thickness, areaOverVolume, 7 ** (1 / 6));
  assert.ok(held < peak && held > 0.99 * peak, `${held} Pa against the peak ${peak} Pa`);
});

test('a membrane ball dropped on the ground bounces, stays finite and rests on it', async () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 120 });
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(
    SoftBodyDesc.volume(icosphere(0.1, 2), {
      pressure: 140_000,
      density: 100,
      membrane: { shearModulus: 300e3, thickness: 0.5e-3 },
    }).setTranslation([0, 0.5, 0]),
  );
  let lowest = Infinity;
  for (let i = 0; i < 240; i++) {
    physics.step();
    const y = ball.particlePositions().filter((_, k) => k % 3 === 1);
    assert.ok(y.every(Number.isFinite), `finite at step ${i}`);
    lowest = Math.min(lowest, ...y);
  }
  assert.ok(lowest > -0.02, `it does not pass through the ground (${lowest})`);
  const state = ball.gasState();
  assert.ok(state.pressure > AMBIENT && Number.isFinite(state.volume), 'it holds its gas');
});

test('a membrane ball replays bit for bit after a snapshot and restore', async () => {
  const make = async () => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60 });
    physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
    const soft = await SoftBodies.attach(physics);
    soft.create(
      SoftBodyDesc.volume(icosphere(0.1, 1), { pressure: 130_000, membrane: { shearModulus: 300e3, thickness: 0.5e-3 } })
        .setTranslation([0, 0.3, 0]),
    );
    return new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new SoftSolver(), { soft })
      .couple(['soft', 'rigid'], 'staggered');
  };
  const a = await make(),
    b = await make();
  a.advance(20);
  b.advance(20);
  assert.equal(a.hash(), b.hash(), 'two runs that did the same agree');
  const saved = a.takeSnapshot();
  a.advance(30);
  const expected = a.hash();
  a.restoreSnapshot(saved.bytes);
  a.advance(30);
  assert.equal(a.hash(), expected, 'the restored world steps to the same bits');
});

test('a membrane it cannot use is refused with a coded error', () => {
  const mesh = icosphere(0.1, 1),
    sheet = { shearModulus: 300e3, thickness: 0.5e-3 };
  const refused = (options, pattern) =>
    assert.throws(
      () => SoftBodyDesc.volume(mesh, options),
      (error) => error.code === 'unsupported' && pattern.test(error.message) && /errors#soft-volumes/.test(error.message),
    );
  refused({ membrane: sheet }, /gas fill/);
  refused({ membrane: sheet, pressure: 120_000, tier: 'cells' }, /gas fill/);
  refused({ membrane: { shearModulus: -1, thickness: 0.001 }, pressure: 120_000 }, /shearModulus/);
  refused({ membrane: { shearModulus: 1e5, thickness: Number.NaN }, pressure: 120_000 }, /thickness/);
});
