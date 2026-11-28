import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CelestialSolver,
  INSOLATION_FIELD,
  TIDAL_POTENTIAL_FIELD,
  insolationFromPort,
  tideFromPort,
} from '../../dist/celestial.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const site = { latitude: 0, longitude: 0 };
const coastalPoint = [6378137, 0, 0];

class SeaAndAtmosphere {
  describe() {
    return {
      id: 'radiation-and-tide-reader',
      fields: [
        { field: INSOLATION_FIELD, access: 'read' },
        { field: TIDAL_POTENTIAL_FIELD, access: 'read' },
      ],
      rate: 0,
      stableRate: () => 0,
      // It reads the sky at the sky's time, which runs 120 seconds a world second here.
      timeScale: () => 120,
    };
  }

  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('celestialResponse', 5 * 8, 'f64', 1);
  }

  step({ inputs }) {
    const light = inputs.get(INSOLATION_FIELD.name);
    const tides = inputs.get(TIDAL_POTENTIAL_FIELD.name);
    assert.ok(light && tides, 'a coupled step receives both celestial fields');
    const insolation = insolationFromPort(this.memory, light, site);
    const tide = tideFromPort(this.memory, tides, coastalPoint);
    regionWords(this.memory, this.region).set([insolation.horizontal, tide.potential, ...tide.acceleration]);
  }

  importPorts() {}
  exportPorts() {
    return [];
  }
  extraState() {
    return [];
  }
  stateRegions() {
    return [this.region];
  }

  words() {
    return Array.from(regionWords(this.memory, this.region));
  }
}

function make(rate = { num: 24, den: 1 }) {
  const celestial = new CelestialSolver();
  const reader = new SeaAndAtmosphere();
  const world = new PhysicsWorld({ rate }).add(reader, {}).add(celestial, { timeScale: 120 });
  world.celestial = celestial;
  world.reader = reader;
  return world;
}

test('CelestialSolver: the insolation and tides received through the registry reproduce the field samples', () => {
  const world = make({ num: 60, den: 1 });
  const { celestial, reader } = world;
  world.advance(1);
  const insolation = celestial.insolation(site);
  const tide = celestial.tide(coastalPoint);
  assert.ok(insolation.horizontal > 1200);
  assert.notEqual(tide.potential, 0);
  assert.deepEqual(reader.words(), [insolation.horizontal, tide.potential, ...tide.acceleration]);
  const first = world.hash();

  const repeated = make({ num: 60, den: 1 });
  repeated.advance(1);
  assert.equal(repeated.hash(), first);
  const snapshot = world.takeSnapshot();
  world.advance(90);
  const result = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  assert.equal(world.hash(), first);
  world.advance(90);
  assert.equal(world.hash(), result);
});

test('CelestialSolver: coupled state is independent of frame rate', () => frameRateIndependent(make));
test('CelestialSolver: coupled state after seeking equals a continuous run', () => seekEqualsContinuous(make));

test('CelestialSolver: signed cells label publications without translating Earth-fixed samples', () => {
  const celestial = new CelestialSolver();
  const world = new PhysicsWorld().add(celestial, {}, [-23, 12, -4]);
  const initial = celestial.exportPorts(-1);
  assert.deepEqual(
    initial.map((port) => port.cell),
    [
      [-23, 12, -4],
      [-23, 12, -4],
    ],
  );
  const light = celestial.insolation(site);
  const tide = celestial.tide(coastalPoint);
  const snapshot = world.takeSnapshot().bytes.slice();
  world.shiftOrigin([3, -9, 100]);
  assert.deepEqual(
    celestial.exportPorts(-1).map((port) => port.cell),
    [
      [-26, 21, -104],
      [-26, 21, -104],
    ],
  );
  assert.deepEqual(celestial.insolation(site), light);
  assert.deepEqual(celestial.tide(coastalPoint), tide);
  world.restoreSnapshot(snapshot);
  assert.deepEqual(celestial.exportPorts(-1), initial);
  assert.deepEqual(world.takeSnapshot().bytes, snapshot);
});

test('CelestialSolver: each reader uses the named memory, region layout and f64 offset', () => {
  const celestial = new CelestialSolver();
  const world = new PhysicsWorld().add(celestial, {});
  const otherMemory = new WebAssembly.Memory({ initial: 1 });
  const readers = [
    [insolationFromPort, site, celestial.insolation(site)],
    [tideFromPort, coastalPoint, celestial.tide(coastalPoint)],
  ];
  celestial.exportPorts(-1).forEach((port, i) => {
    const [read, location, expected] = readers[i];
    const byteOffset = 8 + i * 48;
    new Float64Array(otherMemory.buffer, byteOffset, 6).set(regionWords(world.memory, port.region));
    const foreign = { ...port, region: { ...port.region, byteOffset, memory: otherMemory } };
    assert.deepEqual(read(world.memory, foreign, location), expected);
    assert.throws(() => read(world.memory, { ...foreign, region: { ...foreign.region, layout: 2 } }, location), {
      code: 'version',
      message: /matching celestial field port.*#celestial/,
    });
    for (const bad of [byteOffset + 1, -8, otherMemory.buffer.byteLength - 40]) {
      assert.throws(
        () => read(world.memory, { ...foreign, region: { ...foreign.region, byteOffset: bad } }, location),
        {
          code: 'state',
          message: /aligned offset within the memory.*#celestial/,
        },
      );
    }
  });
});

test('CelestialSolver: rejected trial preserves the accepted snapshot and native receipt', async () => {
  const celestial = await CelestialSolver.load();
  try {
    const world = new PhysicsWorld().add(celestial, { timeScale: 60 * 86400 }, [9, -31, 4]);
    const snapshot = world.takeSnapshot().bytes.slice();
    const receipt = celestial.readNativeWork();
    assert.equal(receipt.planets, 8);
    assert.throws(
      () => celestial.step({ tick: 36525, level: 0, seed: 0, inputs: new Map(), cell: [9, -31, 4] }, 1 / 60),
      {
        code: 'state',
        message: /Use a JPL SPK file.*#celestial/,
      },
    );
    assert.deepEqual(world.takeSnapshot().bytes, snapshot);
    assert.deepEqual(celestial.readNativeWork(), receipt);
    world.advance(3);
    const advanced = world.takeSnapshot().bytes.slice();
    world.restoreSnapshot(snapshot);
    world.advance(3);
    assert.deepEqual(world.takeSnapshot().bytes, advanced);
  } finally {
    celestial[Symbol.dispose]();
  }
});

test('CelestialSolver: a nonfinite late ephemeris position never reaches either publication', () => {
  const celestial = new CelestialSolver();
  let rejectNeptune = false;
  const ephemeris = {
    state(target, observer, _tdb) {
      if (target === 399 && observer === 0) return { position: [0, 0, 0], velocity: [0, 0, 0] };
      const distance = target === 301 ? 384400000 : 149597870700 + target;
      return { position: [target === 8 && rejectNeptune ? Infinity : distance, target, 0], velocity: [0, 0, 0] };
    },
  };
  const world = new PhysicsWorld().add(celestial, { ephemeris });
  const saved = world.takeSnapshot().bytes.slice();
  rejectNeptune = true;
  assert.throws(() => celestial.step({ tick: 0, level: 0, seed: 0, inputs: new Map(), cell: [0, 0, 0] }, 1 / 60), {
    code: 'state',
    message: /produce finite positions and time.*#celestial/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, saved);
  rejectNeptune = false;
  world.advance(1);
  const advanced = world.takeSnapshot().bytes.slice();
  world.restoreSnapshot(saved);
  world.advance(1);
  assert.deepEqual(world.takeSnapshot().bytes, advanced);
});
