import assert from 'node:assert/strict';
import test from 'node:test';
import { AeolianTransport } from '../../dist/aeolian.js';
import { TerrainBed } from '../../dist/earth.js';
import { isShared, PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const grid = { columns: 8, rows: 4, width: 8, depth: 4, centre: [0, 0] };
const rate = { num: 60, den: 1 };
const gravity = 9.81;
const density = 1.225;
const dt = 1 / 60;
const bedShape = { grid, hillStrength: 0, dustEfficiency: 0 };

function create(transport, params = {}, elevations = () => 0, options = {}) {
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0], ...options });
  const bed = new TerrainBed();
  const shape = params.grid ?? grid;
  world.add(bed, { ...shape, elevations });
  world.add(transport, { ...bedShape, ...params });
  return { world, bed };
}

function near(actual, expected, bound = 128 * Number.EPSILON * Math.max(Math.abs(expected), 1)) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} differs from ${expected} by more than ${bound}`);
}

function mass(transport) {
  const { mobileBed, moving, outflow, dust } = transport.budget;
  return mobileBed + moving + outflow + dust;
}

test('calm settles an existing saltation column and increases the real TerrainBed volume', async () => {
  const transport = await AeolianTransport.load();
  const { world, bed } = create(transport, { initialSaltation: 0.03, settlingTime: 0.1 });
  const initial = mass(transport);
  world.advance(1);
  const settled = (0.03 * 0.1) / (0.1 + dt);
  near(transport.read(4, 2).mass, settled);
  assert.deepEqual(transport.read(4, 2).velocity, [0, 0]);
  assert.equal(transport.read(4, 2).dust, 0);
  world.advance(2);
  const next = (settled * 0.1) / (0.1 + dt);
  const deposited = ((0.03 - next) * grid.width * grid.depth) / 1590;
  // In explicit scheduling the latest accumulated bed change is in flight for at most one step.
  const pending = ((settled - next) * grid.width * grid.depth) / 1590;
  assert.ok(bed.volume() >= deposited - pending - 1e-14 && bed.volume() <= deposited + 1e-14);
  near(mass(transport), initial);
});

test('a uniform interior patch follows the saltation quadratic, stress balance, and dust law', async () => {
  const transport = await AeolianTransport.load();
  const wind = 0.4,
    critical = 0.24,
    initial = 0.01,
    grainSpeed = 1.5;
  const { world } = create(transport, {
    frictionVelocity: [wind, 0],
    impactThreshold: critical,
    initiationRatio: 2,
    grainSpeed,
    initialSaltation: initial,
    dustEfficiency: 0.001,
  });
  const start = mass(transport);
  world.advance(1);
  const delta = density * (wind * wind - critical * critical);
  const stressPerMass = gravity / (2 * 0.35);
  const saturation = delta / stressPerMass;
  const growth = (0.2 * stressPerMass * delta) / (grainSpeed * density * critical * critical);
  const sample = transport.read(4, 2);
  near(sample.mass - dt * growth * sample.mass * (1 - sample.mass / saturation), initial);
  near(sample.dust, 0.001 * sample.mass * grainSpeed);
  near(sample.drag[0], -stressPerMass * sample.mass);
  assert.deepEqual(sample.velocity, [grainSpeed, 0]);
  near(mass(transport), start);
});

test('snow at its modeled equilibrium flux follows Pomeroy and Gray, equation 11', async () => {
  const wind = 0.36,
    critical = 0.2,
    speed = 2.8 * critical;
  for (const exposed of [1, 0.55]) {
    const transport = await AeolianTransport.load();
    const flux = (0.68 * critical * density * (exposed * wind * wind - critical * critical)) / (gravity * wind);
    const { world } = create(transport, {
      material: 'snow',
      frictionVelocity: [wind, 0],
      impactThreshold: critical,
      initialSaltation: flux / speed,
      erodibility: exposed,
      initiationRatio: 2,
    });
    world.advance(1);
    const sample = transport.read(4, 2);
    near(sample.mass * sample.velocity[0], flux);
    assert.equal(sample.dust, 0);
  }
});

test('closed domains conserve moving plus bed mass; an open edge tracks the export', async () => {
  for (const open of [false, true]) {
    const transport = await AeolianTransport.load();
    const { world } = create(transport, {
      initialSaltation: 0.05,
      frictionVelocity: [0.45, 0.12],
      open: { maxX: open },
    });
    const start = mass(transport);
    world.advance(180);
    near(mass(transport), start, 512 * Number.EPSILON * start);
    assert.equal(transport.budget.outflow > 0, open);
    assert.ok(transport.budget.mobileBed >= 0);
  }
});

test('the sand impact threshold sustains existing grains below the fluid initiation threshold', async () => {
  const fluid = 0.1 * Math.sqrt(((2650 - density) * gravity * 0.00025) / density);
  const forced = async (friction, initialSaltation) => {
    const transport = await AeolianTransport.load();
    const { world } = create(transport, { frictionVelocity: [friction * fluid, 0], initialSaltation });
    world.advance(1);
    return transport.read(4, 2).mass;
  };
  assert.equal(await forced(0.9, 0), 0);
  assert.ok((await forced(1.1, 0)) > 0);
  assert.ok((await forced(0.9, 0.0001)) > 0.0001);
  assert.ok((await forced(0.7, 0.0001)) < 0.0001);
});

test('a seeded dune relaxes toward repose by paired downslope motion', async () => {
  const transport = await AeolianTransport.load();
  const { world, bed } = create(
    transport,
    {
      grid: { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] },
      mobileDepth: 3,
      repose: 0.5,
      avalancheTime: 0.1,
    },
    (x) => (x < 0 ? 2 : 0),
  );
  const initial = bed.volume();
  const budget = mass(transport);
  world.advance(180);
  const heights = bed.elevations();
  near(bed.volume(), initial, 512 * Number.EPSILON * initial);
  near(mass(transport), budget, 512 * Number.EPSILON * budget);
  assert.ok(heights[0] < 2 && heights[2] > 0);
  // Each X-face's implicit slope residual is reduced by at least the diagonal factor per step.
  const bound = 1.5 * (0.1 / (0.1 + dt)) ** 179 + 8 * 2 ** -23;
  assert.ok(Math.abs(heights[0] - heights[2] - 0.5) < bound, String(heights));
});

test('Anderson short hops grow a seeded impact ripple without creating bed mass', async () => {
  const shape = { columns: 128, rows: 2, width: 3.2, depth: 0.1, centre: [0, 0] };
  const wavenumber = (2 * Math.PI) / 0.4,
    amplitude = 0.001;
  const seed = (x) => amplitude * Math.cos(wavenumber * x);
  const transport = await AeolianTransport.load();
  const initialSaltation = (2 * 0.35 * density * (0.4 * 0.4 - 0.24 * 0.24)) / gravity;
  const params = {
    grid: shape,
    initialSaltation,
    frictionVelocity: [0.4, 0],
    impactThreshold: 0.24,
    initiationRatio: 2,
    grainSpeed: 0.1,
    avalancheTime: 0,
  };
  const { world, bed } = create(transport, { ...params, ripples: { meanHop: 0.065, ejectionsPerSecond: 8 } }, seed);
  const control = create(await AeolianTransport.load(), params, seed);
  const initial = mass(transport);
  world.advance(12);
  control.world.advance(12);
  const heights = bed.elevations();
  assert.ok(heights[64 * 3 + 1] > amplitude, 'near the crest lee-side arrivals exceed local ejection');
  near(bed.volume(), control.bed.volume());
  near(mass(transport), initial, 512 * Number.EPSILON * initial);
});

test('a wind provider moves a ridge downwind while sheltered/resolved still snow stays on the ground', async () => {
  const forSpeed = async (speed, erodibility) => {
    const transport = await AeolianTransport.load();
    const observed = new Set();
    const wind = {
      cell: [0, 0, 0],
      sample(_x, y, _z, time, out) {
        observed.add(time);
        if (time === 0) near(y, 10 + Math.fround(ridge(_x)));
        out.velocity = [speed, 0, 0];
        out.density = density;
        return out;
      },
    };
    const ridge = (x) => Math.max(0, 0.12 * (3 - Math.abs(x)));
    const { world, bed } = create(
      transport,
      {
        material: 'snow',
        wind,
        erodibility,
        hillStrength: 3.2,
        open: { maxX: true },
      },
      ridge,
    );
    world.advance(120);
    assert.ok(observed.has(1));
    return { transport, bed, ridge };
  };
  const calm = await forSpeed(0, 1);
  const covered = await forSpeed(15, 0);
  const blowing = await forSpeed(15, 1);
  assert.deepEqual(calm.bed.elevations(), covered.bed.elevations());
  assert.ok(blowing.transport.read(4, 2).drag[0] < 0);
  assert.ok(blowing.transport.read(4, 2).mass > 0);
  assert.ok(blowing.bed.bed.sample(0, 0).elevation < calm.bed.bed.sample(0, 0).elevation);
  assert.ok(blowing.transport.budget.outflow > 0);
});

test('a wind/friction writer and dust/drag reader couple through held world ports', async () => {
  const friction = { name: 'groundAir', kind: 'heightfield', centring: 'vertex', quantity: 'velocity', unit: 'm/s' };
  const transport = await AeolianTransport.load({ frictionField: friction });
  const { world } = create(transport, { initialSaltation: 0.01, dustEfficiency: 0.001 });
  const n = (grid.columns + 1) * (grid.rows + 1);
  const seen = [];
  let host, region;
  world.add(
    {
      describe: () => ({
        id: 'surface-air',
        fields: [{ field: friction, access: 'write' }],
        rate: 0,
        stableRate: () => 0,
      }),
      init(value) {
        host = value;
        region = host.allocate('air', n * 3 * 8, 'f64', 1);
        const words = regionWords(host.memory, region);
        for (let i = 0; i < n; i++) words.set([0.45, 0, density], 3 * i);
      },
      step() {},
      importPorts() {},
      extraState: () => [],
      stateRegions: () => [region],
      exportPorts: (tick) => [{ field: friction.name, region, tick, cell: [0, 0, 0] }],
    },
    {},
  );
  let readerHost;
  world.add(
    {
      describe: () => ({
        id: 'air-dust',
        fields: [transport.windDragField, transport.dustField].map((field) => ({ field, access: 'read' })),
        rate: 0,
        stableRate: () => 0,
      }),
      init(host) {
        readerHost = host;
      },
      step({ inputs }) {
        const drag = inputs.get(transport.windDragField.name);
        const dust = inputs.get(transport.dustField.name);
        if (drag && dust)
          seen.push([regionWords(readerHost.memory, drag.region)[0], regionWords(readerHost.memory, dust.region)[0]]);
      },
      importPorts() {},
      exportPorts: () => [],
      stateRegions: () => [],
      extraState: () => [],
    },
    {},
  );
  world.advance(10);
  assert.ok(seen.some(([drag, dust]) => drag < 0 && dust > 0));
});

test('60 Hz dynamics are independent of the frame clock and replay exactly across both memory modes', async () => {
  const a = await AeolianTransport.load(),
    b = await AeolianTransport.load();
  const build = (rate, memory, transport = a) =>
    create(
      transport,
      {
        initialSaltation: 0.005,
        frictionVelocity: [0.45, 0.12],
        hillStrength: 3.2,
        dustEfficiency: 0.001,
      },
      (x, z) => 0.03 * (x * x + z * z),
      { rate, memory },
    ).world;
  frameRateIndependent(build);
  seekEqualsContinuous(() => build({ num: 24, den: 1 }));
  const plain = worldMemory(false),
    shared = worldMemory(true);
  assert.equal(isShared(plain), false);
  assert.equal(isShared(shared), true);
  const first = build(rate, plain),
    second = build(rate, shared, b);
  first.advance(60);
  second.advance(60);
  assert.equal(first.hash(), second.hash());
});

test('native Wasm loads without touching any byte in either populated memory variant', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const shared of [false, true]) {
    const memory = worldMemory(shared);
    const bytes = new Uint8Array(memory.buffer);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 19) % 251;
    const original = bytes.slice();
    const words = await readFile(new URL(`../../dist/aeolian-kernel${shared ? '-shared' : ''}.wasm`, import.meta.url));
    const { instance } = await WebAssembly.instantiate(words, { env: { memory } });
    assert.equal(instance.exports.__data_end.value, 0);
    assert.deepEqual(bytes, original);
  }
});

test('signed cell offsets put wind samples at the same positions before and after a saved seek', async () => {
  const transport = await AeolianTransport.load();
  const cellSize = 128;
  const points = [];
  const wind = {
    cell: [-3, 4, 2],
    sample(x, y, z, time, out) {
      points.push([x, y, z, time]);
      out.velocity = [12 + x / 4096, 0, -3 + z / 4096];
      out.density = density;
      return out;
    },
  };
  const { world } = create(transport, { wind, cellSize }, () => 2, { cellSize });
  const cell = [-4, 5, -2];
  world.shiftOrigin([4, -5, 2]);
  const initial = world.takeSnapshot();
  world.advance(1);
  const hash = world.hash();
  assert.deepEqual(points[0], [-132, 140, -514, 0]);
  assert.deepEqual(points.at(-1), [-124, 140, -510, 0]);
  assert.deepEqual(
    transport.exportPorts(1).map(({ cell }) => cell),
    Array(4).fill(cell),
  );
  const first = points.splice(0);
  world.restoreSnapshot(initial.bytes);
  world.advance(1);
  assert.deepEqual(points, first);
  assert.equal(world.hash(), hash);
});

test('invalid late wind, unrepresentable shear and CFL counts leave all accepted regions and diagnostics intact', async () => {
  for (const threads of [1, 4]) {
    using transport = await AeolianTransport.load({ threads });
    let speed = 14;
    let corrupt = false;
    const wind = {
      cell: [0, 0, 0],
      sample(x, _y, z, _time, out) {
        out.velocity = [corrupt && x === 4 && z === 2 ? NaN : speed, 0, 2];
        out.density = density;
        return out;
      },
    };
    const { world, bed } = create(transport, { wind, initialSaltation: 0.03 }, () => 0, {
      memory: worldMemory(threads > 1),
    });
    world.advance(4);
    const context = {
      tick: 4,
      level: 0,
      seed: 0,
      cell: [0, 0, 0],
      inputs: new Map(bed.exportPorts(4).map((port) => [port.field, port])),
    };
    const snapshot = () =>
      transport.stateRegions().map((r) => new Uint8Array(world.memory.buffer, r.byteOffset, r.byteLength).slice());
    const accepted = snapshot();
    const work = transport.workCounts();
    assert.ok(work);
    const rejection = (step, description) => {
      assert.throws(step, { name: 'MargoError', code: 'state', message: description });
      assert.deepEqual(snapshot(), accepted);
      assert.deepEqual(transport.workCounts(), work);
      assert.equal(transport.revision, 4);
    };
    corrupt = true;
    rejection(() => transport.step(context, dt), /friction X; pass a finite value/);
    corrupt = false;
    speed = 1e200;
    rejection(() => transport.step(context, dt), /numeric range; reduce forcing/);
    speed = 14;
    rejection(() => transport.step(context, 1e20), /reduce the step or use coarser bed cells/);
    transport.step(context, dt);
    assert.equal(transport.revision, 5);
    assert.notDeepEqual(snapshot(), accepted);
  }
});
