import assert from 'node:assert/strict';
import test from 'node:test';
import { GranularFlowSolver } from '../dist/granular-flow.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = 1 / 60;
const g = 9.81;
const gravity = [0, -g, 0];
const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}, bound ${tolerance}`);

function grid(columns, rows, dx = 1, dz = dx) {
  return { columns, rows, width: columns * dx, depth: rows * dz, centre: [0, 0] };
}

async function simulate(options, shared = false) {
  const flow = await GranularFlowSolver.load();
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(shared) }).add(flow, options);
  return { flow, world };
}

test('EARTH-02 preserves a resting stepped bank and sub-repose inclined layer', async () => {
  const bed = [0, 0.25, 0.5, 0.75, 1.5, 1.75, 2.5];
  const depth = [1, 1, 1, 1, 0.5, 0.5, 0];
  const { flow, world } = await simulate({ grid: grid(7, 1), bed, depth, friction: 0.35, turbulence: Infinity });
  const initial = bed.map((_, x) => flow.sample(x, 0));
  world.advance(90);
  assert.deepEqual(
    bed.map((_, x) => flow.sample(x, 0)),
    initial,
  );
});

test('EARTH-02 exactly holds a horizontal free surface over a dry crest without friction', async () => {
  const bed = [1, 0.75, 0.25, -0.5, 0, 1.5, 1.25, 0.25];
  const depth = bed.map((b) => Math.max(0, 1 - b));
  const { flow, world } = await simulate({ grid: grid(4, 2), bed, depth, friction: 0, turbulence: Infinity });
  const initial = bed.map((_, i) => flow.sample(i % 4, Math.floor(i / 4)));
  world.advance(120);
  assert.deepEqual(
    bed.map((_, i) => flow.sample(i % 4, Math.floor(i / 4))),
    initial,
  );
});

test('EARTH-02 wide flat layer matches the positive implicit root for Voellmy drag', async () => {
  const depth = 0.75;
  const u = 2;
  const xi = 120;
  const { flow, world } = await simulate({ grid: grid(9, 5), depth, velocity: [u, 0], friction: 0, turbulence: xi });
  world.advance(1);
  const a = (g * dt) / (xi * depth);
  const expected = (Math.sqrt(1 + 4 * a * u) - 1) / (2 * a);
  const middle = flow.sample(4, 2);
  near(middle.discharge[0] / middle.depth, expected, (32 * Number.EPSILON) / a);
  assert.equal(middle.depth, depth);
  assert.equal(middle.discharge[1], 0);
});

test('EARTH-02 runs downslope when prescribed pore pressure removes basal support', async () => {
  const slope = 0.25;
  const bed = Array.from({ length: 15 }, (_, x) => -slope * x);
  const opts = { grid: grid(15, 1), bed, depth: 1, friction: 0.35, turbulence: Infinity };
  const dry = await simulate(opts);
  const wet = await simulate({ ...opts, poreSupport: 1 });
  dry.world.advance(5);
  wet.world.advance(5);
  assert.equal(dry.flow.sample(7, 0).discharge[0], 0);
  const middle = wet.flow.sample(7, 0);
  assert.equal(middle.depth, 1);
  near(middle.discharge[0], g * (slope - 0.5 * slope * slope) * 5 * dt, 128 * Number.EPSILON);
});

test('EARTH-02 keeps a wet-dry moving front positive and conserves mass with a combined 2D CFL', async () => {
  const shape = grid(21, 13, 0.04, 0.06);
  const h = Array.from({ length: shape.columns * shape.rows }, (_, i) =>
    i % shape.columns < 6 && Math.floor(i / shape.columns) < 4 ? 0.55 : 0,
  );
  const { flow, world } = await simulate({ grid: shape, depth: h, velocity: [2, 0.2], friction: 0.15 });
  const start = flow.mass;
  world.advance(1);
  assert.ok(flow.lastSubsteps > 1);
  world.advance(29);
  near(flow.mass, start, 4096 * Number.EPSILON * start);
  assert.ok(flow.sample(10, 6).depth > 0);
  for (let z = 0; z < shape.rows; z++) {
    for (let x = 0; x < shape.columns; x++) {
      const cell = flow.sample(x, z);
      assert.ok(cell.depth >= 0 && Number.isFinite(cell.depth));
      assert.ok(cell.discharge.every(Number.isFinite));
    }
  }
});

test('EARTH-02 repeats native hashes and exact checkpoint restore in both memory variants', async () => {
  const options = {
    grid: grid(13, 4),
    bed: Array.from({ length: 52 }, (_, i) => -(i % 13) * 0.125),
    depth: Array.from({ length: 52 }, (_, i) => (i % 13 < 3 ? 0.8 : 0)),
    friction: 0.1,
  };
  const run = async (shared) => {
    const { flow, world } = await simulate(options, shared);
    world.advance(40);
    const snapshot = world.takeSnapshot();
    world.advance(80);
    const result = world.hash();
    const runout = flow.sample(5, 1);
    world.restoreSnapshot(snapshot.bytes);
    world.advance(80);
    assert.equal(world.hash(), result);
    assert.deepEqual(flow.sample(5, 1), runout);
    assert.ok(runout.depth > 0);
    return result;
  };
  assert.equal(await run(false), await run(false));
  assert.equal(await run(false), await run(true));
});

function plane(columns, rows, spacing, angle, direction) {
  const radians = (angle * Math.PI) / 180;
  const rise = Math.tan(radians);
  const bed = Float64Array.from({ length: columns * rows }, (_, i) => {
    const x = ((i % columns) - Math.floor(columns / 2)) * spacing;
    const z = (Math.floor(i / columns) - Math.floor(rows / 2)) * spacing;
    return -rise * (x * direction[0] + z * direction[1]);
  });
  return { bed, grid: grid(columns, rows, spacing), cos: Math.cos(radians), rise };
}

test('EARTH-02 Pouliquen–Forterre reproduces start-stop hysteresis at the same rough-plane depth', async () => {
  const { cos, rise, grid, bed } = plane(129, 3, 0.01, 23.3, [1, 0]);
  const normalDepth = 0.0035;
  const angleTan = (degrees) => Math.tan((degrees * Math.PI) / 180);
  const shape = (angleTan(30.7) - angleTan(21)) / (1 + normalDepth / 0.00065);
  const muStop = angleTan(21) + shape;
  const muStart = angleTan(22.2) + shape;
  assert.ok(muStop < rise && rise < muStart);
  const horizontalSpeed = 0.02 * cos;
  const common = { grid, bed, depth: normalDepth / cos, roughness: 'glass-beads' };
  const rest = await simulate(common);
  const moving = await simulate({ ...common, velocity: [horizontalSpeed, 0] });
  rest.world.advance(12);
  moving.world.advance(12);
  const stationary = rest.flow.sample(64, 1);
  assert.equal(stationary.depth, common.depth);
  assert.equal(stationary.discharge[0], 0);
  const ongoing = moving.flow.sample(64, 1);
  assert.ok(ongoing.discharge[0] / ongoing.depth > horizontalSpeed);
});

test('EARTH-02 rational roughness keeps the measured-flow-law equilibrium on rotated beds', async () => {
  for (const [angle, multiple, direction] of [
    [23, 2, [1, 0]],
    [25, 3, [0, 1]],
    [26, 4, [0.6, 0.8]],
  ]) {
    const { cos, rise, grid, bed } = plane(41, 41, 0.02, angle, direction);
    const angleTan = (degrees) => Math.tan((degrees * Math.PI) / 180);
    const low = angleTan(21);
    const high = angleTan(30.7);
    const stopDepth = 0.00065 * ((high - low) / (rise - low) - 1);
    const normalDepth = multiple * stopDepth;
    const speed = 0.136 * multiple * Math.sqrt(g * normalDepth) * cos;
    const velocity = [speed * direction[0], speed * direction[1]];
    const depth = normalDepth / cos;
    const { world, flow } = await simulate({ grid, bed, depth, velocity, roughness: 'glass-beads' });
    world.advance(4);
    const center = flow.sample(20, 20);
    // Heights and tangents are independently rounded and differ across faces. At most eight
    // surface differences contribute per step before the pressure and discharge projections.
    const bound = (8 * 4 * 64 * Number.EPSILON * grid.width * g * dt) / (grid.width / grid.columns);
    near(center.discharge[0] / center.depth, velocity[0], bound);
    near(center.discharge[1] / center.depth, velocity[1], bound);
    near(center.depth, depth, 4 * 64 * Number.EPSILON * depth);
  }
});

test('EARTH-02 exponential roughness predicts held-out front speed on two measured bead beds', async () => {
  // Pouliquen (1999), Table I sets the stopping curves. Section III.B reports the separate
  // 24 degree, h/d = 7 speed measurements, scaled by sqrt(g*d) for systems 1 and 3.
  for (const { diameter, low, high, length, measured } of [
    { diameter: 0.0005, low: 20.7, high: 32.8, length: 1.96, measured: 1 },
    { diameter: 0.00115, low: 22.9, high: 30.4, length: 1.5, measured: 0.9 },
  ]) {
    const { cos, rise, grid, bed } = plane(129, 3, 0.01, 24, [1, 0]);
    const angleTan = (degrees) => Math.tan((degrees * Math.PI) / 180);
    const threshold = (rise - angleTan(low)) / (angleTan(high) - angleTan(low));
    const stopDepth = -length * diameter * Math.log(threshold);
    const normalDepth = 7 * diameter;
    const speed = 0.136 * Math.sqrt(g * normalDepth) * (normalDepth / stopDepth);
    const { world: running, flow } = await simulate({
      grid,
      bed,
      depth: normalDepth / cos,
      velocity: [speed * cos, 0],
      roughness: {
        thickStopAngle: low,
        thinStopAngle: high,
        thickStartAngle: low,
        thickness: length * diameter,
        beta: 0.136,
        curve: 'exponential',
      },
    });
    running.advance(10);
    const center = flow.sample(64, 1);
    const result = center.discharge[0] / center.depth / (cos * Math.sqrt(g * diameter));
    // Article Section II estimates front-speed uncertainty at less than 10 percent.
    near(result, measured, 0.1 * measured);
    near(result, speed / Math.sqrt(g * diameter), 4096 * Number.EPSILON * result);
  }
});
