import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { BODIES_FIELD, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';

await Physics.load();

const mesh = {
  vertices: Float64Array.of(-1, -0.5, -0.5, 1, -0.5, -0.5, 1, 0.5, -0.5, -1, 0.5, -0.5,
    -1, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5, 0.5, -1, 0.5, 0.5),
  indices: Uint32Array.of(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5),
};

function hullFixture(physics, positions, sea, options = {}) {
  const rigid = new RigidSolver();
  const hull = new HullSolver('hull', { minimumRadius: 0.25 });
  const hulls = positions.map((position) => {
    const body = physics.addBody(null, {
      position,
      linearVelocity: [0, -0.125, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1000 },
    });
    return { row: body.row, mesh };
  });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 1, gravity: [0, -9.81, 0] })
    .add(rigid, { physics })
    .add(hull, { hulls, sea, originCellSize: 1, stations: 8, memory: 0.5, ...options })
    .couple(['hull', 'rigid'], 'staggered');
  const step = (tick) => {
    const port = { ...rigid.exportPorts(tick)[0], cell: world.cellOf('rigid') };
    hull.step({ tick, level: 0, seed: 1, inputs: new Map([[BODIES_FIELD.name, port]]), cell: world.cellOf('hull') }, 1 / 60);
  };
  const accepted = () => [...hull.stateRegions(), ...hull.exportPorts(0).map(({ region }) => region)].map((region) =>
    regionWords(world.arena.memory, region).slice());
  return { world, step, accepted };
}

test('a late failed hull query preserves earlier hull histories and every published field', () => {
  const pressure = (y) => Math.max(0, -9810 * y);
  const run = (failure) => {
    using physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] });
    let mode = 'valid';
    let firstSamples = 0;
    const sea = {
      density: 1000,
      elevation: () => 0,
      pressure(x, y) {
        if (x < 0) firstSamples++;
        if (x > 0 && mode === 'non-finite') return NaN;
        if (x > 0 && mode === 'overflow') return 1e50;
        return pressure(y);
      },
      water: {
        sample(_x, _y, _z, t, out) {
          out.velocity[1] = t / 8;
          out.velocity[2] = t / 32;
          return out;
        },
      },
    };
    const { world, step, accepted } = hullFixture(physics, [[-2, -0.125, 0], [2, -0.125, 0]], sea);
    step(0);
    const before = accepted();
    assert.ok(before.some((region) => region.some((value) => value !== 0)));
    if (failure) {
      const snapshot = world.takeSnapshot();
      const sampled = firstSamples;
      mode = 'non-finite';
      assert.throws(() => step(1), { code: 'failed', message: /Return finite gauge pascals.+#ship-seakeeping/ });
      assert.ok(firstSamples > sampled);
      assert.deepEqual(accepted(), before);
      assert.deepEqual(world.takeSnapshot().bytes, snapshot.bytes);
      mode = 'overflow';
      assert.throws(() => step(1), { code: 'failed', message: /Reduce hull scale.+#ship-seakeeping/ });
      assert.deepEqual(accepted(), before);
      assert.deepEqual(world.takeSnapshot().bytes, snapshot.bytes);
    }
    mode = 'valid';
    step(1);
    return accepted();
  };
  assert.deepEqual(run(true), run(false));
});

test('a rigid hull in a nearby signed cell uses the same pressure and wake as a local hull', () => {
  const signed = [1170000000, -1070000000, 2000000000];
  const run = (separate) => {
    using physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] });
    let seaCell = signed;
    const sea = {
      get cell() { return seaCell; },
      elevation: (x) => x / 32,
      density: 1000,
    };
    const { world, accepted, step } = hullFixture(physics, [[separate ? -1 : 0, -0.125, 0]], sea);
    world.setCell('hull', signed).setCell('rigid', separate ? [signed[0] + 1, signed[1], signed[2]] : signed);
    step(0);
    const snapshot = world.takeSnapshot();
    step(1);
    const next = accepted();
    world.restoreSnapshot(snapshot.bytes);
    const delta = [4100000, -21500000, 17300000];
    world.shiftOrigin(delta);
    seaCell = signed.map((cell, axis) => cell - delta[axis]);
    step(1);
    assert.deepEqual(accepted(), next);
    return next;
  };
  assert.deepEqual(run(true), run(false));
});

test('invalid hull inputs use coded errors before force allocation', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, bodyRows: 2 });
  const hulls = [{ row: 0, mesh }];
  const sea = { elevation: () => 0 };
  for (const [bad, explanation] of [
    [{ hulls: [hulls[0], hulls[0]] }, /Supply one hull per rigid row.+#ship-seakeeping/],
    [{ capacity: 3 }, /Omit capacity.+#ship-seakeeping/],
    [{ originCellSize: Infinity }, /positive cellSize.+#ship-seakeeping/],
    [{ sea: { ...sea, density: 0 } }, /positive finite density.+#ship-seakeeping/],
  ]) {
    assert.throws(
      () => world.add(new HullSolver(), { sea, hulls, ...bad }),
      { code: 'unsupported', message: explanation },
    );
  }
});
