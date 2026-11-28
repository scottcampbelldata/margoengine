import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { SailForce, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';

await Physics.load();

const grid = [3, 5];
const dt = 1 / 60;

async function setup(t, options, native = false) {
  const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
  t.after(() => physics.dispose());
  const soft = await SoftBodies.attach(physics);
  const cloth = soft.create(SoftBodyDesc.cloth([0, 3, 0], [0.6, -0.125, 0], [0, 0, 1], ...grid));
  const settings = { grid, density: 1.2, ...options };
  const sail = native
    ? await SailForce.attachNative(physics, cloth, settings)
    : new SailForce(physics, cloth, settings);
  return { physics, soft, cloth, sail };
}

function sailInput(fix) {
  return (error) => {
    assert.equal(error.name, 'MargoError');
    assert.equal(error.code, 'state');
    assert.match(error.message, fix);
    assert.match(error.message, /errors#physics-sail/);
    return true;
  };
}

test('signed sail fields sample corresponding air and preserve exact cloth velocities', async (t) => {
  const queries = [[], []];
  const field = (i) => ({
    medium: 'air',
    cell: i === 0 ? [0, 0, 0] : [-6, 3, 5],
    sample(x, y, z, time, out) {
      const p = i === 0 ? [x, y, z] : [x - 8, y + 16, z - 24];
      queries[i].push([...p, time]);
      out.velocity[0] = 8;
      out.velocity[1] = 0.5 * p[2];
      out.velocity[2] = 0.25 * p[0];
      out.density = 1 + 0.01 * p[1];
      return out;
    },
  });
  const a = await setup(t, { wind: field(0), density: undefined });
  const b = await setup(t, { wind: field(1), density: undefined, frame: { cell: [-5, 1, 8], cellSize: 8 } });
  // Collocation x involves f32 cloth coordinates and offset cancellation can change its last few f64 bits.
  // Compare coordinates using roundoff of adding and subtracting the signed shift.
  a.sail.beforeStep(dt);
  b.sail.beforeStep(dt);
  assert.equal(queries[0].length, 8);
  assert.equal(queries[1].length, 8);
  for (let row = 0; row < queries[0].length; row++)
    for (let axis = 0; axis < 4; axis++)
      assert.ok(Math.abs(queries[0][row][axis] - queries[1][row][axis]) <= 32 * Number.EPSILON);
  assert.deepEqual(a.cloth.particleVelocities(), b.cloth.particleVelocities());
  for (let i = 0; i < a.sail.circulation.length; i++)
    assert.ok(Math.abs(a.sail.circulation[i] - b.sail.circulation[i]) <= 32 * Number.EPSILON);
  assert.ok(b.sail.force[1] > 0);

  const malformedCell = { ...field(1), cell: { length: 3, 0: -6, 1: 3, 2: Number.NaN } };
  const valid = { grid, wind: field(1) };
  assert.throws(() => new SailForce(a.physics, a.cloth, valid), sailInput(/Pass a signed cloth frame/));
  assert.throws(
    () => new SailForce(a.physics, a.cloth, { ...valid, wind: malformedCell }),
    sailInput(/Pass three signed/),
  );
  assert.throws(() => new SailForce(a.physics, a.cloth, { ...valid, grid: [2, 6] }), sailInput(/Pass the cloth/));
  assert.throws(
    () => new SailForce(a.physics, a.cloth, { ...valid, wind: { ...field(0), medium: 'water' } }),
    sailInput(/Pass an air flow field/),
  );
});

test('rejected late sail samples and unrepresentable cloth kicks leave every accepted output and velocity intact', async (t) => {
  let mode = 'valid';
  let samples = 0;
  const options = {
    wind: {
      medium: 'air',
      cell: [-3, 5, 4],
      sample(_x, _y, z, _time, out) {
        samples++;
        const isEnd = z >= 3;
        out.velocity[0] = 8;
        out.velocity[1] = mode === 'overflow' && isEnd ? 3e41 : 0;
        out.velocity[2] = 0;
        out.density = mode === 'density' && isEnd ? 0 : 1.19;
        return out;
      },
    },
    density: undefined,
    frame: { cell: [-3, 5, 4], cellSize: 16 },
  };
  const { cloth, sail } = await setup(t, options, true);
  sail.beforeStep(dt);
  const state = sail.takeState();
  const accepted = sail.readNativeWork();
  const positions = cloth.particlePositions();
  const velocities = cloth.particleVelocities();
  assert.equal(accepted.solves, 1);
  assert.ok(accepted.matrixPairs > 0);
  assert.ok(velocities.some((value) => value !== 0));
  for (const [bad, fix] of [
    ['density', /finite positive air density/],
    ['overflow', /sail impulse fits the cloth velocity/],
  ]) {
    mode = bad;
    samples = 0;
    assert.throws(() => sail.beforeStep(dt), sailInput(fix));
    assert.ok(samples >= 7);
    assert.deepEqual(cloth.particlePositions(), positions);
    assert.deepEqual(cloth.particleVelocities(), velocities);
    assert.deepEqual(sail.takeState(), state);
    assert.deepEqual(sail.readNativeWork(), accepted);
  }
  const invalid = state.slice();
  invalid[invalid.length - 1] = -1;
  assert.throws(() => sail.restoreState(invalid), sailInput(/Restore the original nonnegative/));
  assert.deepEqual(sail.takeState(), state);
  mode = 'valid';
  sail.beforeStep(dt);
  assert.notDeepEqual(cloth.particleVelocities(), velocities);
});

test('the rigid world retains fixed-size sail load words through accepted advance and replay', async (t) => {
  const { physics, soft, sail } = await setup(t, { wind: (_point, time) => [8, 0.3 + time, 0] }, true);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
  const initial = sail.takeState();
  const snapshot = world.takeSnapshot();
  world.advance(8);
  const accepted = sail.takeState();
  const bytes = world.takeSnapshot().bytes;
  assert.equal(accepted.length, initial.length);
  assert.equal(sail.readNativeWork().solves, 1);
  world.restoreSnapshot(snapshot.bytes);
  assert.deepEqual(world.takeSnapshot().bytes, snapshot.bytes);
  world.advance(8);
  assert.deepEqual(sail.takeState(), accepted);
  assert.deepEqual(world.takeSnapshot().bytes, bytes);
});
