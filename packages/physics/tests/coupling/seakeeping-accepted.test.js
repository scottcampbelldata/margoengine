import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { bakeHullSlamming, HullSolver, slamStations } from '../../dist/seakeeping.js';
import {
  BODIES_FIELD,
  DECK_INFLOW_FIELD,
  DECK_INFLOW_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
} from '../../dist/world.js';

await Physics.load();

const mesh = {
  vertices: Float64Array.of(
    -1,
    -0.5,
    -0.5,
    1,
    -0.5,
    -0.5,
    1,
    0.5,
    -0.5,
    -1,
    0.5,
    -0.5,
    -1,
    -0.5,
    0.5,
    1,
    -0.5,
    0.5,
    1,
    0.5,
    0.5,
    -1,
    0.5,
    0.5,
  ),
  indices: Uint32Array.of(
    0,
    2,
    1,
    0,
    3,
    2,
    4,
    5,
    6,
    4,
    6,
    7,
    0,
    1,
    5,
    0,
    5,
    4,
    3,
    7,
    6,
    3,
    6,
    2,
    0,
    4,
    7,
    0,
    7,
    3,
    1,
    2,
    6,
    1,
    6,
    5,
  ),
};

function hullFixture(physics, positions, sea, options = {}, hullMesh = mesh) {
  const rigid = new RigidSolver();
  const hull = new HullSolver('hull', { minimumRadius: 0.25 });
  const hulls = positions.map((position) => {
    const body = physics.addBody(null, {
      position,
      linearVelocity: [0, -0.125, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1000 },
    });
    return { row: body.row, mesh: hullMesh };
  });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 1, gravity: [0, -9.81, 0] })
    .add(rigid, { physics })
    .add(hull, { hulls, sea, originCellSize: 1, stations: 8, memory: 0.5, ...options })
    .couple(['hull', 'rigid'], 'staggered');
  const step = (tick) => {
    const port = { ...rigid.exportPorts(tick)[0], cell: world.cellOf('rigid') };
    hull.step(
      { tick, level: 0, seed: 1, inputs: new Map([[BODIES_FIELD.name, port]]), cell: world.cellOf('hull') },
      1 / 60,
    );
  };
  const accepted = () =>
    [...hull.stateRegions(), ...hull.exportPorts(0).map(({ region }) => region)].map((region) =>
      regionWords(world.arena.memory, region).slice(),
    );
  return { world, hull, step, accepted, row: hulls[0].row };
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
    const { world, step, accepted } = hullFixture(
      physics,
      [
        [-2, -0.125, 0],
        [2, -0.125, 0],
      ],
      sea,
    );
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
      get cell() {
        return seaCell;
      },
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
    assert.throws(() => world.add(new HullSolver(), { sea, hulls, ...bad }), {
      code: 'unsupported',
      message: explanation,
    });
  }
});

test('green-water inflow on a rasterized tapered deck uses the receiving wet cell height', () => {
  using physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] });
  const tapered = { ...mesh, vertices: mesh.vertices.slice() };
  for (let i = 0; i < tapered.vertices.length; i += 3) if (tapered.vertices[i] > 0) tapered.vertices[i + 2] *= 0.375;
  const { world, hull, row, step } = hullFixture(
    physics,
    [[0, -0.25, 0]],
    {
      elevation: () => 0.5,
      density: 1000,
    },
    { addedMass: false, slamming: false, radiation: false, rollDamping: false, deckCells: [12, 12] },
    tapered,
  );
  assert.equal(hull.deckSurface(row), undefined);
  const start = world.takeSnapshot();
  step(0);
  const accepted = hull.deckSurface(row);
  assert.ok(accepted);
  assert.ok(accepted.depth.some((value) => value > 0));
  const { region } = hull.exportPorts(0).find((port) => port.field === DECK_INFLOW_FIELD.name);
  const records = regionWords(world.arena.memory, region);
  assert.ok(records[0] > 0);
  let interiorEdges = 0;
  for (let n = 0; n < records[0]; n++) {
    const o = 1 + n * DECK_INFLOW_WORDS;
    const [, ax, ay, az, bx, by, bz, nX, , nZ, depth, , , , flux] = records.subarray(o, o + DECK_INFLOW_WORDS);
    assert.ok(depth > 0 && flux > 0);
    const ux = ((ax + bx) / 2 - accepted.x0) / accepted.dx;
    const uz = ((az + bz) / 2 - accepted.z0) / accepted.dz;
    const i = Math.floor(ux + nX / 2);
    const j = Math.floor(uz + nZ / 2);
    assert.equal(ay, 0.5);
    assert.equal(by, accepted.height[j * accepted.nx + i]);
    const outsideI = Math.floor(ux - nX / 2);
    const outsideJ = Math.floor(uz - nZ / 2);
    if (
      outsideI >= 0 &&
      outsideI < accepted.nx &&
      outsideJ >= 0 &&
      outsideJ < accepted.nz &&
      Number.isNaN(accepted.height[outsideJ * accepted.nx + outsideI])
    )
      interiorEdges++;
  }
  assert.ok(interiorEdges > 0, 'some edges border a dry hole within the raster, away from the outer bounds');
  const expected = hull.deckSurface(row);
  accepted.depth.fill(0);
  accepted.height.fill(-100);
  assert.deepEqual(hull.deckSurface(row), expected);
  world.restoreSnapshot(start.bytes);
  assert.equal(hull.deckSurface(row), undefined);
  step(0);
  assert.deepEqual(hull.deckSurface(row), expected);
});

test('slamming rejects open hulls, invalid density and unsupported table dimensions with coded fixes', () => {
  const open = { ...mesh, indices: mesh.indices.slice(0, -3) };
  assert.throws(() => slamStations(open, 1025), { code: 'unsupported', message: /Close every edge.+#ship-seakeeping/ });
  assert.throws(() => slamStations(mesh, Infinity), {
    code: 'unsupported',
    message: /finite positive kilograms.+#ship-seakeeping/,
  });
  assert.throws(() => slamStations(mesh, 1025, Number.MAX_SAFE_INTEGER), {
    code: 'unsupported',
    message: /within Wasm memory.+#ship-seakeeping/,
  });
  assert.ok(slamStations(mesh, 1025).length > 0);
});

test('a native slam table is admitted only for the matching hull and is copied into the live solver', async () => {
  const table = await bakeHullSlamming(mesh, { density: 1000, stations: 8, threads: 1 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, bodyRows: 1 });
  const sea = { elevation: () => 0, density: 1000 };
  const hulls = [{ row: 0, mesh, slammingTable: table }];
  for (const options of [{ sea: { ...sea, density: 1025 } }, { stations: 7 }]) {
    assert.throws(() => world.add(new HullSolver(), { hulls, sea, stations: 8, ...options }), {
      code: 'unsupported',
      message: /same body-local mesh, sea density and station count.+#ship-seakeeping/,
    });
  }
  const offset = mesh.vertices.map((coordinate, i) => (i % 3 === 0 ? coordinate + 1 : coordinate));
  assert.throws(
    () =>
      world.add(new HullSolver(), {
        sea,
        stations: 8,
        hulls: [{ ...hulls[0], mesh: { ...mesh, vertices: offset } }],
      }),
    { code: 'unsupported', message: /same body-local mesh.+#ship-seakeeping/ },
  );
  const invalid = {
    ...table,
    profiles: table.profiles.map((profile) => ({ ...profile, slope: profile.slope.slice() })),
  };
  invalid.profiles[0].slope[0] = NaN;
  assert.throws(
    () =>
      world.add(new HullSolver(), {
        sea,
        stations: 8,
        hulls: [{ ...hulls[0], slammingTable: invalid }],
      }),
    { code: 'unsupported', message: /ordered finite profiles.+#ship-seakeeping/ },
  );

  function run(scalar) {
    using physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] });
    const input = scalar ? { row: 0, mesh } : hulls[0];
    const { world: fixture, accepted, step } = hullFixture(physics, [[0, 0.25, 0]], sea, { hulls: [input] });
    step(0);
    if (!scalar) table.profiles[0].slope.fill(NaN);
    fixture.advance(4);
    return accepted();
  }
  assert.deepEqual(run(false), run(true));
});
