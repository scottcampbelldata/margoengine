import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { HeatConduction } from '../../dist/thermal.js';
import { PhysicsWorld, rateOf, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const oneSecond = { num: 24, den: 1 };
const material = { conductivity: 0.5, heatCapacity: 5 };
const make = (thermal, options, rate = oneSecond) => new PhysicsWorld({ rate }).add(thermal, options);

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, [actual, expected, bound].join(' against '));
}

function totalEnergy(world, thermal) {
  const port = world.fields.port(thermal.enthalpyField.name);
  return regionWords(world.memory, port.region).reduce((sum, value) => sum + value, 0);
}

test('insulated slab follows the Fourier cosine mode within its space and time truncation bound', async () => {
  const thermal = await HeatConduction.load();
  const nx = 24;
  const amplitude = 12;
  const ambient = 300;
  const initialTemperature = Array.from(
    { length: nx },
    (_, i) => ambient + amplitude * Math.cos((Math.PI * (i + 0.5)) / nx),
  );
  const world = make(thermal, {
    dimensions: [nx, 1, 1],
    cellSize: [1 / nx, 1, 1],
    materials: material,
    initialTemperature,
  });
  const dt = 1 / rateOf(thermal.describe().stableRate());
  assert.ok(thermal.describe().stableRate() > 0, 'stiffness selects a finer world rate');
  const t = 0.5;
  const lambda = (material.conductivity / material.heatCapacity) * Math.PI * Math.PI;
  world.advance(12);
  const temperatures = thermal.readTemperature();
  // Sine expansion gives the eigenvalue error. The time term bounds the remainder
  // of log(1 - lambda * dt). Both exponentials are 1-Lipschitz for negative arguments.
  const spaceError = (lambda * Math.PI * Math.PI) / (12 * nx * nx);
  const timeError = (lambda * lambda * dt) / (2 * (1 - lambda * dt));
  const bound = amplitude * t * (spaceError + timeError);
  for (let i = 0; i < nx; i++) {
    const exact = ambient + (initialTemperature[i] - ambient) * Math.exp(-lambda * t);
    near(temperatures[i], exact, bound);
  }
});

test('a layered wall at its series-resistance steady state stays steady', async () => {
  const thermal = await HeatConduction.load();
  const width = 0.8;
  const conductivity = [4, 1, 2];
  const totalResistance = conductivity.reduce((sum, k) => sum + width / k, 0);
  const q = (500 - 300) / totalResistance;
  let previous = 0;
  const exact = conductivity.map((k) => {
    const resistance = width / k;
    const atCentre = 500 - q * (previous + resistance / 2);
    previous += resistance;
    return atCentre;
  });
  const world = make(thermal, {
    dimensions: [3, 1, 1],
    cellSize: [width, 2, 3],
    materials: conductivity.map((k) => ({ conductivity: k, heatCapacity: 20 })),
    materialIndices: [0, 1, 2],
    initialTemperature: exact,
    boundaries: { xMin: { kind: 'temperature', kelvin: 500 }, xMax: { kind: 'temperature', kelvin: 300 } },
  });
  world.advance(48);
  const actual = thermal.readTemperature();
  for (let i = 0; i < exact.length; i++) near(actual[i], exact[i], 48 * 60 * Number.EPSILON * 500);
});

test('latent heat pins the melting temperature and liquid capacity controls later heating', async () => {
  const thermal = await HeatConduction.load();
  const world = make(thermal, {
    dimensions: [1, 1, 1],
    materials: {
      conductivity: 0,
      heatCapacity: 2,
      phaseChange: { temperature: 273, latentHeat: 40, liquidHeatCapacity: 4 },
    },
    initialTemperature: 270,
    boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: 30 } },
  });
  world.advance(24);
  assert.equal(thermal.readTemperature()[0], 273);
  near(thermal.readLiquidFraction()[0], 0.6, 2 * Number.EPSILON);
  assert.equal(totalEnergy(world, thermal), 570);
  world.advance(48);
  assert.equal(thermal.readTemperature()[0], 276.5);
  assert.equal(thermal.readLiquidFraction()[0], 1);
});

test('the melt and freeze fronts follow the one-phase Stefan solution', async () => {
  const nx = 96;
  const diffusivity = 0.01;
  const meltTemperature = 273;
  const offset = 20;
  const lambda = 0.5;
  const erfHalf = 0.5204998778130465;
  const stefan = Math.sqrt(Math.PI) * lambda * Math.exp(lambda * lambda) * erfHalf;
  const t = 3;
  const expectedFront = 2 * lambda * Math.sqrt(diffusivity * t);

  for (const heating of [true, false]) {
    const thermal = await HeatConduction.load();
    const world = make(thermal, {
      dimensions: [nx, 1, 1],
      cellSize: [1 / nx, 1, 1],
      materials: {
        conductivity: diffusivity,
        heatCapacity: 1,
        phaseChange: { temperature: meltTemperature, latentHeat: offset / stefan },
      },
      initialTemperature: meltTemperature,
      initialLiquidFraction: heating ? 0 : 1,
      boundaries: { xMin: { kind: 'temperature', kelvin: meltTemperature + (heating ? offset : -offset) } },
    });
    world.advance(t * oneSecond.num);
    const front = thermal.readLiquidFraction().reduce((sum, f) => sum + (heating ? f : 1 - f), 0) / nx;
    // The integral of the phase fraction measures the converted thickness.
    // Compare at the spatial resolution of the cell-centred grid.
    near(front, expectedFront, 1 / nx);
  }
});

test('backward Euler follows the two-cell diffusion eigenmode at a stiff world tick', async () => {
  const thermal = await HeatConduction.load();
  const conductivity = 90;
  const heatCapacity = 1;
  const dt = 1 / 60;
  const mean = 330;
  const offset = 30;
  const world = make(
    thermal,
    {
      integration: 'implicit',
      dimensions: [2, 1, 1],
      materials: { conductivity, heatCapacity },
      initialTemperature: [mean - offset, mean + offset],
    },
    { num: 60, den: 1 },
  );
  assert.equal(thermal.describe().stableRate(), 0);
  world.advance(1);
  // The antisymmetric mode has diffusion eigenvalue -2*k/C for unit cells.
  const implicitOffset = offset / (1 + (2 * dt * conductivity) / heatCapacity);
  const actual = thermal.readTemperature();
  const bound = 512 * Number.EPSILON * mean;
  near(actual[0], mean - implicitOffset, bound);
  near(actual[1], mean + implicitOffset, bound);
  near(totalEnergy(world, thermal), 2 * mean * heatCapacity, 8 * Number.EPSILON * mean);
});

test('the implicit heat flux melts and freezes a cell on the latent interval', async () => {
  const melting = 273;
  const latentHeat = 100;
  const capacity = 2;
  const conductivity = 60;
  const gain = conductivity / (60 * capacity);
  for (const sign of [-1, 1]) {
    const thermal = await HeatConduction.load();
    const initial = melting + sign * 30;
    const world = make(
      thermal,
      {
        integration: 'implicit',
        dimensions: [2, 1, 1],
        materials: [
          { conductivity, heatCapacity: capacity, phaseChange: { temperature: melting, latentHeat } },
          { conductivity, heatCapacity: capacity },
        ],
        materialIndices: [0, 1],
        initialTemperature: [melting, initial],
        initialLiquidFraction: [0.5, 0],
      },
      { num: 60, den: 1 },
    );
    world.advance(1);
    const expected = melting + (initial - melting) / (1 + gain);
    const bound = 512 * Number.EPSILON * melting;
    near(thermal.readTemperature()[0], melting, Number.EPSILON * melting);
    near(thermal.readTemperature()[1], expected, bound);
    near(
      thermal.readLiquidFraction()[0],
      0.5 + (capacity * (initial - expected)) / latentHeat,
      (bound * capacity) / latentHeat,
    );
  }
});

test('implicit heat with radiation is frame-rate independent and resumes bit for bit', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => HeatConduction.load()));
  let next = 0;
  const factory = (rate = oneSecond) =>
    make(
      solvers[next++],
      {
        integration: 'implicit',
        dimensions: [3, 2, 1],
        materials: { conductivity: 2, heatCapacity: 30 },
        initialTemperature: [500, 450, 380, 600, 700, 480],
        boundaries: { xMin: { kind: 'radiation', kelvin: 360, emissivity: 0.75, coefficient: 2 } },
      },
      rate,
    );
  frameRateIndependent(factory);
  seekEqualsContinuous(factory);
});

test('the kiln wall develops a cooler exposed face and loses energy after cooling begins (THE-KILN-SHIFT-5)', async () => {
  const thermal = await HeatConduction.load();
  const world = make(thermal, {
    dimensions: [5, 1, 1],
    cellSize: [0.1, 1, 1],
    initialTemperature: 1150,
    materials: { conductivity: 2, heatCapacity: 2000 },
    boundaries: { xMin: { kind: 'convection', kelvin: 300, coefficient: 40 } },
  });
  const initial = totalEnergy(world, thermal);
  world.advance(48);
  const temperatures = thermal.readTemperature();
  assert.ok(temperatures[0] > 300);
  assert.ok(temperatures[0] < temperatures[1]);
  assert.ok(temperatures[1] < temperatures[2]);
  assert.ok(temperatures[4] <= 1150);
  assert.ok(totalEnergy(world, thermal) < initial);
});

test('insulated conduction redistributes energy without changing the total across all three axes', async () => {
  const thermal = await HeatConduction.load();
  const dimensions = [3, 4, 5];
  const initialTemperature = Array.from({ length: 60 }, (_, i) => (i === 0 ? 600 : 300));
  const world = make(thermal, { dimensions, materials: material, initialTemperature });
  const initial = totalEnergy(world, thermal);
  world.advance(24);
  const temperatures = thermal.readTemperature();
  for (const i of [1, 3, 12]) assert.ok(temperatures[i] > initialTemperature[i]);
  assert.ok(temperatures[0] < initialTemperature[0]);
  // About twenty rounded operations per cell and 60 ticks, plus the field reduction.
  near(totalEnergy(world, thermal), initial, 21 * 60 * Number.EPSILON * initial);
});

function heater(field) {
  let memory;
  let energy;
  return {
    describe: () => ({
      id: 'heater',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field, access: 'accumulate' }],
    }),
    init(host) {
      memory = host.memory;
      energy = host.allocate('delivered', 8, 'f64', 1);
    },
    importPorts() {},
    step(_context, dt) {
      regionWords(memory, energy)[0] = 60 * dt;
    },
    exportPorts: (tick) => [{ field: field.name, region: energy, cell: [0, 0, 0], tick }],
    stateRegions: () => [energy],
    extraState: () => [],
  };
}

function coupled(thermal, rate = oneSecond) {
  const world = new PhysicsWorld({ rate });
  world.add(heater(thermal.enthalpyField), {});
  world.add(thermal, {
    dimensions: [1, 1, 1],
    materials: { conductivity: 0, heatCapacity: 2 },
    initialTemperature: 300,
  });
  return world;
}

test('a coupled heat input accumulates once per tick and survives memory growth', async () => {
  const thermal = await HeatConduction.load();
  const world = coupled(thermal);
  world.arena.allocate('another solver grew the memory', 256 * 1024, 'u8', 1);
  world.advance(24);
  assert.equal(totalEnergy(world, thermal), 660);
  assert.equal(thermal.readTemperature()[0], 330);
});

test('coupled conduction is frame-rate independent and resumes bit for bit', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => HeatConduction.load()));
  let next = 0;
  frameRateIndependent((rate) => coupled(solvers[next++], rate));
  seekEqualsContinuous(() => coupled(solvers[next++]));
});

test('the temperature port drives the stress of a restrained bar in a mechanical stand-in', async () => {
  const heat = await HeatConduction.load();
  const stressFreeTemperature = 293;
  const heatCapacity = 10;
  const power = 600;
  const youngModulus = 70e9;
  const expansion = 23e-6;
  let host;
  let stress;
  const bar = {
    describe: () => ({
      id: 'restrained-bar',
      fields: [{ field: heat.temperatureField, access: 'read' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(value) {
      host = value;
      stress = host.allocate('axial-stress-Pa', 8, 'f64', 1);
    },
    importPorts() {},
    step({ inputs }) {
      const port = inputs.get(heat.temperatureField.name);
      assert.ok(port, 'the bar receives the current temperature through the world');
      assert.equal(port.region.type, 'f64');
      const temperature = regionWords(host.memory, port.region)[0];
      // Small strain with free sides and fixed ends, so axial strain is zero.
      regionWords(host.memory, stress)[0] = -youngModulus * expansion * (temperature - stressFreeTemperature);
    },
    exportPorts: () => [],
    stateRegions: () => [stress],
    extraState: () => [],
  };
  const world = make(
    heat,
    {
      dimensions: [1, 1, 1],
      materials: { conductivity: 0, heatCapacity },
      initialTemperature: stressFreeTemperature,
      boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: power } },
    },
    { num: 60, den: 1 },
  );
  world.add(bar, {});
  world.advance(1);
  const temperatureRise = power / (heatCapacity * 60);
  const expectedStress = -youngModulus * expansion * temperatureRise;
  near(regionWords(world.memory, stress)[0], expectedStress, 16 * Number.EPSILON * Math.abs(expectedStress));
});

test('both builds import only world memory and leave an already-live arena intact', async () => {
  for (const shared of [false, true]) {
    const filename = shared ? 'thermal-kernel-shared.wasm' : 'thermal-kernel.wasm';
    const bytes = await readFile(new URL('../../dist/' + filename, import.meta.url));
    const module = await WebAssembly.compile(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'env', name: 'memory', kind: 'memory' }]);
    const memory = worldMemory(shared);
    const data = new Uint8Array(memory.buffer).fill(0xa7);
    const { exports } = new WebAssembly.Instance(module, { env: { memory } });
    assert.ok(exports.__stack_pointer instanceof WebAssembly.Global);
    assert.ok(
      data.every((value) => value === 0xa7),
      filename + ' preserves the arena',
    );
  }
});

test('plain and shared worlds produce identical conduction results', async () => {
  const results = [];
  for (const shared of [false, true]) {
    const thermal = await HeatConduction.load();
    const world = new PhysicsWorld({ rate: oneSecond, memory: worldMemory(shared) }).add(thermal, {
      dimensions: [2, 1, 1],
      materials: material,
      initialTemperature: [300, 330],
      integration: 'implicit',
    });
    world.advance(24);
    results.push(thermal.readTemperature());
  }
  assert.deepEqual(results[0], results[1]);
});

test('invalid options and an aborted kernel load fail before running a solve', async () => {
  const reason = new Error('thermal load cancelled');
  await assert.rejects(HeatConduction.load({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
  const thermal = await HeatConduction.load();
  const world = new PhysicsWorld();
  assert.throws(() => world.add(thermal, { dimensions: [1, 1, 1] }), {
    code: 'state',
    message: /Supply conductivity.*errors#thermal/,
  });
  assert.throws(
    () => world.add(thermal, { dimensions: [1, 1, 1], materials: { conductivity: -1, heatCapacity: 2 } }),
    /conductivity/,
  );
  world.add(thermal, { dimensions: [1, 1, 1], materials: material });
  assert.throws(() => new PhysicsWorld().add(thermal, { dimensions: [1, 1, 1], materials: material }), {
    code: 'attached',
  });
});

test('an unphysical heat extraction leaves the last published state intact', async () => {
  const thermal = await HeatConduction.load();
  const world = make(thermal, {
    dimensions: [1, 1, 1],
    materials: { conductivity: 0, heatCapacity: 1 },
    initialTemperature: 1,
    boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: -120 } },
  });
  assert.throws(() => world.advance(1), /invalid energy/);
  assert.equal(thermal.readTemperature()[0], 1);
  assert.equal(totalEnergy(world, thermal), 1);
});

test('a grey exterior face balances conduction, thermal radiation and convection', async () => {
  const thermal = await HeatConduction.load();
  const conductivity = 10;
  const capacity = 1000;
  const surface = 500;
  const ambient = 300;
  const emissivity = 0.8;
  const coefficient = 3;
  const sigma = 5.6703744191844314e-8;
  const power = emissivity * sigma * (surface ** 4 - ambient ** 4) + coefficient * (surface - ambient);
  const cell = surface + power / (2 * conductivity);
  const world = make(
    thermal,
    {
      dimensions: [1, 1, 1],
      initialTemperature: cell,
      materials: { conductivity, heatCapacity: capacity },
      boundaries: { xMin: { kind: 'radiation', kelvin: ambient, emissivity, coefficient } },
    },
    { num: 60, den: 1 },
  );
  assert.equal(thermal.describe().stableRate(), 0);
  world.advance(1);
  // The chosen surface temperature exactly balances the two published laws.
  // Allow rounding in the arithmetic, one world step, and the f64 root solve.
  near(thermal.readTemperature()[0], cell - power / (60 * capacity), 16 * Number.EPSILON * cell);
});

test('implicit radiation uses the surface balance at the new temperature', async () => {
  const thermal = await HeatConduction.load();
  const conductivity = 10;
  const capacity = 1000;
  const surface = 500;
  const ambient = 300;
  const emissivity = 0.8;
  const coefficient = 3;
  const sigma = 5.6703744191844314e-8;
  const power = emissivity * sigma * (surface ** 4 - ambient ** 4) + coefficient * (surface - ambient);
  const cell = surface + power / (2 * conductivity);
  const initial = cell + power / (60 * capacity);
  const world = make(
    thermal,
    {
      dimensions: [1, 1, 1],
      initialTemperature: initial,
      integration: 'implicit',
      materials: { conductivity, heatCapacity: capacity },
      boundaries: { xMin: { kind: 'radiation', kelvin: ambient, emissivity, coefficient } },
    },
    { num: 60, den: 1 },
  );
  assert.equal(thermal.describe().stableRate(), 0);
  world.advance(1);
  // The chosen surface temperature exactly balances the two published laws.
  // Allow rounding in the arithmetic, one world step, and the f64 root solve.
  near(thermal.readTemperature()[0], cell, 512 * Number.EPSILON * cell);
});
