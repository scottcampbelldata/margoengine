import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface, TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { LandscapeEvolution } from '@margoengine/physics/landscape';
import { Snowpack } from '@margoengine/physics/snowpack';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from '../../../physics/tests/coupling/harness.js';
import { forestOrientation, ForestEcosystemSolver } from '../../dist/forest.js';

const rate = { num: 60, den: 1 };
const frame24 = { num: 24, den: 1 };
const bounds = [0, 0, 10, 10];
const fir = { id: 'fir', radius: 3, growth: 0.5, age: 2000, seeds: 0, rootCohesion: 1000, canopyFuel: 2 };
const plant = { species: 'fir', x: 2.5, z: 5, radius: 1.5 };
const grid = { columns: 1, rows: 1, width: 10, depth: 10, centre: [5, 5] };
const stand = { bounds, species: [fir], plants: [plant], limit: 64, ticksPerYear: 60 };

function array(world, field) {
  return Array.from(regionWords(world.memory, world.fields.port(field.name).region));
}
function close(got, want, bound = 48 * Number.EPSILON * Math.max(1, Math.abs(want))) {
  assert.ok(Math.abs(got - want) <= bound, `${got} versus ${want}, error bound ${bound}`);
}
function publisher(field, words, fill) {
  let host, region;
  return {
    describe: () => ({ id: field.name, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(h) {
      host = h;
      region = h.allocate('input', 8 * words, 'f64', 1);
    },
    step({ tick }) {
      fill(regionWords(host.memory, region), tick);
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('HYDRO-01 water resets flood-intolerant stands and root reinforcement after the specified immersion time', async () => {
  for (const depth of [0, 0.5]) {
    const forest = await ForestEcosystemSolver.load({ flooding: true });
    const water = new ShallowWaterSolver();
    const world = new PhysicsWorld({ rate })
      .add(water, { bed: bedSurface(grid, [0, 0, 0, 0]), depth })
      .add(forest, { ...stand, species: [{ ...fir, flooding: { depth: 0.25, fractionOfYear: 0.75 } }] });
    world.advance(59);
    assert.equal(forest.year.alive, 1);
    const snap = world.takeSnapshot();
    world.advance(60);
    assert.equal(forest.year.alive, depth ? 0 : 1);
    if (depth) {
      assert.equal(forest.trees()[0].died, 1);
      assert.equal(array(world, forest.rootCohesionField)[0], 0);
      assert.equal(array(world, forest.fuelField)[0], 0);
    }
    const hash = world.hash();
    world.restoreSnapshot(snap.bytes);
    world.advance(60);
    assert.equal(world.hash(), hash);
  }
});

test('real HYDRO-04 hillside incision reads forest roots and gross erosion kills the exposed stand', async () => {
  const shear = { name: 'heldShear', kind: 'uniformGrid', quantity: 'pressure', unit: 'Pa', centring: 'cell' };
  for (const rootCohesion of [0, 1000]) {
    let forest;
    let landscape;
    // In the erosion-to-forest proof the same landscape port is read; its name is the constructor's stable id prefix.
    const incision = {
      name: 'landscape:incision',
      kind: 'uniformGrid',
      quantity: 'incisionRate',
      unit: 'm/s',
      centring: 'vertex',
    };
    forest = await ForestEcosystemSolver.load(rootCohesion ? {} : { erosionField: incision });
    landscape = await LandscapeEvolution.load({ shearField: shear, rootCohesionField: forest.rootCohesionField });
    const world = new PhysicsWorld({ rate })
      .add(new TerrainBed(), { ...grid, elevations: [1, 0, 0, 0] })
      .add(forest, { ...stand, species: [{ ...fir, rootCohesion, erosionTolerance: 0.001 }] })
      .add(landscape, {
        grid,
        rainfall: 0.001,
        erodibility: 4,
        dischargeExponent: 0,
        alluvialDepth: 0,
        outlets: { maxX: true, maxZ: true },
      })
      .add(
        publisher(shear, 1, (out) => out.fill(10)),
        {},
      );
    world.advance(60);
    if (rootCohesion) {
      assert.equal(landscape.read(0, 0).incision, 0);
      assert.equal(forest.year.alive, 1);
    } else {
      assert.equal(forest.year.alive, 0, 'resolved gross erosion uproots the plant');
    }
  }
});

test('burn input resets live fuel and snags, preserving measured fuel moisture and sheltered cohorts', async () => {
  const forest = await ForestEcosystemSolver.load({ exposure: true });
  const world = new PhysicsWorld({ rate })
    .add(forest, {
      ...stand,
      cells: [2, 1],
      snags: 1,
      plants: [plant, { ...plant, x: 7.5 }],
    })
    .add(
      publisher(forest.exposureField, 4, (out, tick) => out.set([tick === 13 ? 1 : 0, 0.18, 0, 0.3])),
      {},
    );
  world.advance(60);
  assert.equal(forest.year.alive, 1);
  assert.equal(forest.year.died, 1);
  assert.equal(forest.trees().at(-1).died, 1);
  const [burned, sheltered] = array(world, forest.fuelField);
  assert.equal(burned, 0);
  assert.ok(sheltered > 0);
  assert.deepEqual(array(world, forest.moistureField), [0.18, 0.3]);
  world.advance(120);
  assert.equal(forest.trees().length, 1);
  assert.equal(forest.trees()[0].x, 7.5);
});

const localWind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(x, _y, _z, time, out) {
    out.velocity[0] = x < 5 && time < 1 ? 12 : 0;
    out.velocity[1] = 0;
    out.velocity[2] = 0;
    out.density = 1.225;
    out.temperature = 275;
    return out;
  },
};

test('TREE-3: the windward tree grows a permanent leeward axis and the sheltered tree stays upright', async () => {
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate }).add(forest, {
    ...stand,
    wind: localWind,
    cells: [2, 1],
    plants: [plant, { ...plant, x: 7.5 }],
  });
  world.advance(60);
  const [windward, sheltered] = forest.trees();
  const projection = (plant.radius / windward.radius) ** 2;
  close(windward.lean[0], (1 - projection) * 0.25);
  assert.deepEqual(sheltered.lean, [0, 0]);
  world.advance(120);
  const [after] = forest.trees();
  close(after.lean[0], windward.lean[0] * (windward.radius / after.radius) ** 2);
  assert.ok(after.lean[0] > 0, 'leeward growth remains when there is no gust');
  const [qx, qy, qz, qw] = forestOrientation(after);
  const topX = 2 * (qx * qy - qz * qw);
  const topY = 1 - 2 * (qx * qx + qz * qz);
  close(topX, after.lean[0] * topY);
  assert.ok(topX > 0, 'the rendered +Y crown axis leans downwind');
});

test('borrowed exposure and a late invalid patch preserve forest history and replay in the signed cell', async () => {
  const cell = [-12, 5, 3];
  const forest = await ForestEcosystemSolver.load({ exposure: true });
  const world = new PhysicsWorld({ rate }).add(
    forest,
    {
      ...stand,
      cells: [2, 1],
      plants: [plant, { ...plant, x: 7.5 }],
      ticksPerYear: 2,
    },
    cell,
  );
  const memory = new WebAssembly.Memory({ initial: 1 });
  const depth = new Float64Array(memory.buffer, 32, 4);
  depth.set([0.25, 0.2, 0.5, 0.4]);
  const field = forest.exposureField.name;
  const port = {
    field,
    tick: 0,
    cell,
    region: { name: 'borrowed-exposure', layout: 1, type: 'f64', byteOffset: 32, byteLength: 32, memory },
  };
  const sample = (tick, origin, input) =>
    forest.step({ tick, level: 0, seed: 17, cell: origin, inputs: new Map([[field, input]]) }, 1 / 60);
  const humidity = () => {
    const { region } = forest.exportPorts(0).find((p) => p.field === forest.moistureField.name);
    return [...regionWords(world.memory, region)];
  };
  sample(0, cell, port);
  assert.deepEqual(humidity(), [0.2, 0.4]);
  const before = world.takeSnapshot();
  assert.equal(forest.readNativeWork(), undefined);
  depth.set([0.6, 0.7, 0.8, Number.NaN]);
  assert.throws(() => sample(1, cell, port), {
    code: 'state',
    message: /fuel moisture.*errors#forest/,
  });
  assert.throws(() => sample(1, cell, { ...port, region: { ...port.region, byteOffset: 33 } }), {
    code: 'state',
    message: /owning memory.*errors#forest/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, before.bytes);
  assert.deepEqual(humidity(), [0.2, 0.4]);
  assert.equal(forest.readNativeWork(), undefined);
  depth[3] = 0.8;
  const delta = [2, -3, 1];
  const shifted = [-14, 8, 2];
  world.shiftOrigin(delta);
  sample(1, shifted, { ...port, tick: 1, cell: shifted });
  assert.deepEqual(humidity(), [0.7, 0.8]);
  assert.deepEqual(
    forest.exportPorts(1).map((p) => p.cell),
    Array(4).fill(shifted),
  );
  assert.equal(forest.year.year, 1);
  const accepted = world.takeSnapshot();
  world.restoreSnapshot(before.bytes);
  world.shiftOrigin(delta);
  sample(1, shifted, { ...port, tick: 1, cell: shifted });
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('a rejected recruitment callback retains accepted trees and receipts after native shade work', async () => {
  let samples = 0;
  let reject = true;
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate, seed: 8 }).add(forest, {
    ...stand,
    ticksPerYear: 1,
    species: [{ ...fir, seeds: 64, maturity: 0, dispersal: 0.5 }],
    plants: [{ ...plant, x: 5, radius: 2.5 }],
    where() {
      if (++samples === 2 && reject) throw new Error('invalid site sampling');
      return 1;
    },
  });
  const before = world.takeSnapshot();
  const step = () => forest.step({ tick: 0, level: 0, seed: 8, cell: [0, 0, 0], inputs: new Map() }, 1 / 60);
  assert.throws(step, { code: 'failed', message: /site suitability.*errors#forest/ });
  assert.equal(samples, 2);
  assert.equal(forest.trees().length, 1);
  assert.equal(forest.trees()[0].radius, 2.5);
  assert.equal(forest.readNativeWork(), undefined);
  assert.deepEqual(world.takeSnapshot().bytes, before.bytes);
  reject = false;
  step();
  assert.ok(forest.trees().length > 2);
  assert.equal(forest.year.year, 1);
  assert.equal(forest.readNativeWork().trees, 1);
});

test('annual exposure and birth identities replay from a partial year at different frame rates', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => ForestEcosystemSolver.load()));
  const make = (frameRate = frame24) =>
    new PhysicsWorld({ rate: frameRate, seed: 42 }).add(solvers.pop(), {
      ...stand,
      wind: localWind,
      species: [{ ...fir, seeds: 9, maturity: 0, dispersal: 2 }],
    });
  frameRateIndependent(make, { seconds: 2 });
  seekEqualsContinuous(make, { frames: 48, at: 11 });
});

test('ICE-01 directly reads patch root cohesion and loses snow support after a burn', async () => {
  const forest = await ForestEcosystemSolver.load({ exposure: true });
  const snow = await Snowpack.load({ followTerrain: true, inputs: { support: { field: forest.rootCohesionField } } });
  const ground = new TerrainBed();
  const world = new PhysicsWorld({ rate })
    .add(ground, { columns: 2, rows: 1, width: 2, depth: 1, centre: [1, 0.5], elevations: (x) => 2 - x })
    .add(forest, {
      ...stand,
      bounds: [0, 0, 2, 1],
      cells: [2, 1],
      plants: [{ ...plant, x: 1.5, z: 0.5, radius: 0.4 }],
    })
    .add(snow, {
      width: 2,
      depth: 1,
      origin: [0.5, 0.5],
      layers: [{ mass: 100, density: 300, cohesion: 10 }],
    })
    .add(
      publisher(forest.exposureField, 4, (out, tick) => out.set([0, 0, tick === 13 ? 1 : 0, 0])),
      {},
    );
  world.advance(1);
  assert.ok(snow.read(0, 0).stability < 1, 'bare patch is unstable');
  assert.ok(snow.read(1, 0).stability > 1, 'rooted patch is stable');
  world.advance(61);
  assert.equal(forest.year.alive, 0);
  close(snow.read(1, 0).stability, snow.read(0, 0).stability);
  assert.ok(snow.read(1, 0).stability < 1, 'fire removes the root support term');
});
