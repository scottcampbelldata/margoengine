import assert from 'node:assert/strict';
import test from 'node:test';
import { LavaSolver } from '../../dist/lava.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const gravity = [0, -9.80665, 0];
const rate = { num: 60, den: 1 };
const bounds = { cells: [2, 1], spacing: 1, bed: [0.1, 0], depth: 0.3 };
const density = 2500;
const near = (value, want, allowance) => assert.ok(Math.abs(value - want) <= allowance, `${value} vs ${want}`);

async function sheet(shared, options) {
  const solver = await LavaSolver.load();
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(shared) }).add(solver, {
    ...bounds,
    transport: 'terminal',
    density,
    emissivity: 0,
    convection: 0,
    conductivity: 0,
    yieldStrength: 0,
    ...options,
  });
  return { solver, world };
}

test('terminal sheet carries the exact Newtonian and yielded Bingham face discharge', async () => {
  const h = bounds.depth;
  const drive = -gravity[1] * 0.1;
  const dt = 1 / rate.num;
  for (const [yieldStrength, viscosity] of [
    [0, 70],
    [80, 320],
    [0, 20_000],
    [1000, 320],
  ]) {
    const { solver, world } = await sheet(false, { viscosity, yieldStrength });
    const plug = Math.min(1, yieldStrength / (density * h * drive));
    // Independently integrate the no-slip parabola below the yield depth and
    // the uniformly translating plug above it.
    const flowing = h * (1 - plug);
    const integrated = ((density * drive) / viscosity) * (flowing ** 3 / 3 + (plug * h * flowing ** 2) / 2);
    const moved = (integrated * dt) / bounds.spacing;
    world.advance(1);
    near(solver.sample(0, 0).depth, h - moved, 16 * Number.EPSILON);
    near(solver.sample(1, 0).depth, h + moved, 16 * Number.EPSILON);
    near(solver.sample(0, 0).discharge[0], 0.5 * integrated, 32 * Number.EPSILON);
    near(solver.sample(1, 0).discharge[0], 0.5 * integrated, 32 * Number.EPSILON);
    near(solver.budget.storedVolume, solver.budget.initialVolume, 16 * Number.EPSILON);
    near(
      solver.budget.storedEnthalpy,
      solver.budget.initialEnthalpy,
      16 * Number.EPSILON * solver.budget.initialEnthalpy,
    );
  }
});

test('terminal sheet drains a warm patch without negative columns, heat gain or a changed replay', async () => {
  const hashes = [];
  for (const shared of [false, true]) {
    const { solver, world } = await sheet(shared, {
      cells: [11, 3],
      spacing: 0.1,
      bed: new Float64Array(33).map((_, i) => -0.01 * (i % 11)),
      depth: new Float64Array(33).map((_, i) => (i === 12 ? 0.12 : 0)),
      viscosity: 80,
    });
    const before = world.takeSnapshot();
    world.advance(90);
    assert.ok(solver.sample(2, 1).depth > 0);
    for (let z = 0; z < 3; z++)
      for (let x = 0; x < 11; x++) {
        const cell = solver.sample(x, z);
        assert.ok(cell.depth >= 0 && cell.enthalpy >= 0 && Number.isFinite(cell.temperature));
      }
    near(solver.budget.storedVolume, solver.budget.initialVolume, 128 * Number.EPSILON * solver.budget.initialVolume);
    near(
      solver.budget.storedEnthalpy,
      solver.budget.initialEnthalpy,
      128 * Number.EPSILON * solver.budget.initialEnthalpy,
    );
    const after = world.hash();
    hashes.push(after);
    world.restoreSnapshot(before.bytes);
    world.advance(90);
    assert.equal(world.hash(), after);
  }
  assert.equal(hashes[0], hashes[1]);
});
