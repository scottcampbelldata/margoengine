import assert from 'node:assert/strict';
import test from 'node:test';
import { HeatConduction, Thermoelasticity } from '../../dist/thermal.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const referenceTemperature = 293;
const material = { youngModulus: 70e9, poissonRatio: 0.27, expansionCoefficient: 23e-6, referenceTemperature };

const close = (value, expected, bound) =>
  assert.ok(Math.abs(value - expected) <= bound, value + ' against ' + expected + ' within ' + bound);

async function loaded() {
  const heat = await HeatConduction.load();
  const solid = await Thermoelasticity.load({
    temperatureField: heat.temperatureField,
    liquidFractionField: heat.liquidFractionField,
  });
  return { heat, solid };
}

function coupled({ heat, solid }, options, initialTemperature, clock = rate, thermalOptions = {}) {
  const world = new PhysicsWorld({ rate: clock });
  world.add(heat, {
    dimensions: options.dimensions,
    cellSize: options.cellSize,
    materials: { conductivity: 0, heatCapacity: 2 },
    initialTemperature,
    ...thermalOptions,
  });
  return world.add(solid, options);
}

function ends(nx, ny, nz, far = 0) {
  const restraints = [];
  for (const x of [0, nx]) {
    for (let y = 0; y <= ny; y++)
      for (let z = 0; z <= nz; z++)
        restraints.push({ node: [x, y, z], displacement: [x === nx ? far : 0, null, null] });
  }
  return restraints;
}

function assertStress(solid, expected, tolerance) {
  const stresses = solid.readStress();
  for (let i = 0; i < stresses.length; i++) close(stresses[i], expected[i % 6], tolerance);
}

test('a traction-free solid expands affinely under uniform heating and its stress vanishes', async () => {
  const pair = await loaded();
  const dimensions = [2, 2, 1];
  const cellSize = [0.3, 0.5, 0.7];
  const delta = 40;
  const world = coupled(pair, { dimensions, cellSize, materials: material }, referenceTemperature + delta);
  world.advance(1);
  const u = pair.solid.readDisplacement();
  const expansion = material.expansionCoefficient * delta;
  // This affine patch has no tetrahedral interpolation error. Bound the
  // displacement and stress errors relative to the free-strain scales.
  const error = 1e-7 * expansion;
  let word = 0;
  for (let z = 0; z <= dimensions[2]; z++) {
    for (let y = 0; y <= dimensions[1]; y++) {
      for (let x = 0; x <= dimensions[0]; x++) {
        close(u[word++], x * cellSize[0] * expansion, error);
        close(u[word++], y * cellSize[1] * expansion, error);
        close(u[word++], z * cellSize[2] * expansion, error);
      }
    }
  }
  assertStress(pair.solid, [0, 0, 0, 0, 0, 0], material.youngModulus * error);
  assert.ok(pair.solid.readReaction().every((force) => force === 0));
  const published = world.fields.port(pair.solid.displacementField.name);
  assert.deepEqual(regionWords(world.memory, published.region), u);
});

test('an axially restrained hot bar compresses and expands freely on its transverse faces', async () => {
  const pair = await loaded();
  const dims = [3, 1, 1];
  const cellSize = [0.4, 0.2, 0.3];
  const delta = 60;
  const world = coupled(
    pair,
    { dimensions: dims, cellSize, materials: material, restraints: ends(...dims) },
    referenceTemperature + delta,
  );
  world.advance(1);
  const strain = material.expansionCoefficient * delta;
  // Zero axial strain and zero transverse stress give these values directly
  // from the isotropic compliance relation.
  const stress = -material.youngModulus * strain;
  const bound = Math.abs(stress) * 1e-7;
  assertStress(pair.solid, [stress, 0, 0, 0, 0, 0], bound);
  const lateral = strain * (1 + material.poissonRatio);
  const u = pair.solid.readDisplacement();
  const reaction = pair.solid.readReaction();
  let rmin = 0;
  let rmax = 0;
  let word = 0;
  for (let z = 0; z <= dims[2]; z++) {
    for (let y = 0; y <= dims[1]; y++) {
      for (let x = 0; x <= dims[0]; x++) {
        close(u[word], 0, strain * 1e-7);
        close(u[word + 1], y * cellSize[1] * lateral, strain * 1e-7);
        close(u[word + 2], z * cellSize[2] * lateral, strain * 1e-7);
        if (x === 0) rmin += reaction[word];
        else if (x === dims[0]) rmax += reaction[word];
        else assert.equal(reaction[word], 0);
        assert.equal(reaction[word + 1], 0);
        assert.equal(reaction[word + 2], 0);
        word += 3;
      }
    }
  }
  const area = cellSize[1] * cellSize[2];
  close(rmin, -stress * area, bound * area);
  close(rmax, stress * area, bound * area);
});

test('bonded materials carry one axial stress across a hot interface with a prescribed end displacement', async () => {
  const pair = await loaded();
  const dims = [2, 1, 1];
  const cellSize = [0.5, 0.25, 0.125];
  const end = 0.00025;
  const e0 = 0.00125;
  const e1 = 20e9;
  const e2 = 40e9;
  const materials = [
    { youngModulus: e1, poissonRatio: 0, expansionCoefficient: e0 / 40, referenceTemperature },
    { youngModulus: e2, poissonRatio: 0, expansionCoefficient: e0 / 80, referenceTemperature },
  ];
  const world = coupled(
    pair,
    { dimensions: dims, cellSize, materials, materialIndices: [0, 1], restraints: ends(...dims, end) },
    [referenceTemperature + 40, referenceTemperature + 80],
  );
  world.advance(1);
  // Series compliance, with the same free expansion on either side so that
  // transverse compatibility adds no stress. The imposed total stretch is end.
  const w = cellSize[0];
  const stress = (end - 2 * w * e0) / (w / e1 + w / e2);
  const uInterface = w * (e0 + stress / e1);
  assertStress(pair.solid, [stress, 0, 0, 0, 0, 0], Math.abs(stress) * 1e-7);
  const u = pair.solid.readDisplacement();
  for (let i = 0; i < 4; i++) close(u[(3 * i + 1) * 3], uInterface, e0 * 1e-7);
});

test('a fully fixed voxel develops the hydrostatic thermal stress of zero total strain', async () => {
  const pair = await loaded();
  const restraints = [];
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) restraints.push({ node: [x, y, z], displacement: [0, 0, 0] });
  const delta = 125;
  const world = coupled(pair, { dimensions: [1, 1, 1], materials: material, restraints }, referenceTemperature + delta);
  world.advance(1);
  const pressure = (-material.youngModulus * material.expansionCoefficient * delta) / (1 - 2 * material.poissonRatio);
  assertStress(pair.solid, [pressure, pressure, pressure, 0, 0, 0], 16 * Number.EPSILON * Math.abs(pressure));
  assert.ok(pair.solid.readDisplacement().every((u) => u === 0));
});

test('thermal stress follows the heat port at the same time across frame rates and after restore', async () => {
  const pairs = await Promise.all(Array.from({ length: 5 }, () => loaded()));
  const dims = [1, 1, 1];
  const options = { dimensions: dims, materials: material, restraints: ends(...dims) };
  const heating = { boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: 15 } } };
  const factory = (clock = { num: 24, den: 1 }) =>
    coupled(pairs.shift(), options, referenceTemperature, clock, heating);
  frameRateIndependent(factory);
  seekEqualsContinuous(factory);
});

test('missing or differently placed temperatures cannot produce misleading stress', async () => {
  const pair = await loaded();
  const options = { dimensions: [1, 1, 1], materials: material };
  const badWorld = new PhysicsWorld({ rate }).add(pair.solid, options);
  assert.throws(() => badWorld.advance(1), { code: 'state' });
  const world = new PhysicsWorld({ rate });
  const other = await loaded();
  world.add(
    other.heat,
    {
      dimensions: options.dimensions,
      materials: { conductivity: 0, heatCapacity: 2 },
    },
    [1, 0, 0],
  );
  world.add(other.solid, options);
  assert.throws(() => world.advance(1), /same origin/);
  const mismatched = await loaded();
  const wrongShape = coupled(mismatched, options, referenceTemperature, rate, { dimensions: [2, 1, 1] });
  assert.throws(() => wrongShape.advance(1), /does not match the solid grid/);
});

test('the solid solver retains its last equilibrium when the heat port shows melt', async () => {
  const pair = await loaded();
  const dimensions = [1, 1, 1];
  const world = coupled(pair, { dimensions, materials: material, restraints: ends(...dimensions) }, 299, rate, {
    materials: { conductivity: 0, heatCapacity: 2, phaseChange: { temperature: 300, latentHeat: 20 } },
    boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: 60 } },
  });
  world.advance(1);
  const previous = pair.solid.readStress();
  assert.ok(previous[0] < 0);
  world.advance(2);
  assert.equal(pair.heat.readLiquidFraction()[0], 0);
  const atSolidus = pair.solid.readStress();
  assert.throws(() => world.advance(3), { code: 'unsupported' });
  assert.ok(pair.heat.readLiquidFraction()[0] > 0);
  assert.deepEqual(pair.solid.readStress(), atSolidus);
});

test('the solid solver rejects an under-resolved solve without publishing partial results', async () => {
  const pair = await loaded();
  const options = { dimensions: [2, 1, 1], materials: material, maxIterations: 1 };
  const world = coupled(pair, options, referenceTemperature + 60);
  assert.throws(() => world.advance(1), { code: 'failed' });
  assert.ok(pair.solid.readStress().every((value) => value === 0));
  assert.ok(pair.solid.readDisplacement().every((value) => value === 0));
});
