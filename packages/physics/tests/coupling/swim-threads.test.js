import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { SWIM_PASSIVE_REACTION_FIELD, SwimSolver } from '../../dist/life.js';
import { SwimDragToWater } from '../../dist/loads.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { expectedSwimWork, far, makeSwimmers, runSwimmers, swimmerPorts } from '../fixtures/swim-threads-worker.mjs';

test('ordinary and passive swimmer workers replay the same pulses and signed origin through accepted snapshots', async () => {
  for (const passive of [false, true]) {
    const serial = await runSwimmers(false, 1, passive);
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const current = shared ? await runSwimmers(shared, threads, passive) : serial;
      const report = current.report;
      assert.deepEqual(current.start, serial.start);
      assert.deepEqual(current.checkpoint, serial.checkpoint);
      assert.deepEqual(current.final, serial.final);
      assert.equal(report.hash, serial.report.hash);
      assert.ok(report.originShiftExact && report.hashedReplay && report.acceptedCellAgrees);
      assert.ok(report.tailAndFin && report.drag);
      assert.deepEqual(report.reading, serial.report.reading);
      assert.deepEqual(report.initialCells, Array(passive ? 3 : 2).fill(far));
      assert.deepEqual(report.shiftedCells, Array(passive ? 3 : 2).fill([0, 0, 0]));
      assert.deepEqual(report.restoredCells, report.initialCells);
      assert.deepEqual(report.coldWork, expectedSwimWork(0, threads, passive));
      assert.deepEqual(report.work, expectedSwimWork(report.bodies, threads, passive));
      assert.deepEqual(report.replayWork, report.work);
    }
  }
});

test('two odd swimmer groups execute counted SIMD linear and angular responses in four partitions', async () => {
  for (const [count, passive] of [[1027, false], [4099, true]]) {
    using serial = await SwimSolver.load({ passiveReaction: passive });
    using parallel = await SwimSolver.load({ passiveReaction: passive, threads: 4 });
    const { world: plain } = makeSwimmers(serial, false, count);
    const { world: shared } = makeSwimmers(parallel, true, count);
    try {
      plain.advance(1);
      shared.advance(1);
      const work = parallel.workCounts();
      assert.deepEqual(work, expectedSwimWork(count, 4, passive));
      assert.deepEqual(serial.workCounts(), expectedSwimWork(count, 1, passive));
      assert.ok(work.workers.every(({ simdAxisPairs }) => simdAxisPairs > 0));
      assert.deepEqual(swimmerPorts(shared, passive, count), swimmerPorts(plain, passive, count));
      assert.deepEqual(shared.takeSnapshot().bytes, plain.takeSnapshot().bytes);
      console.log('LIFE-03 swimmer work', count, work);
    } finally {
      plain.remove(serial.describe().id);
      shared.remove(parallel.describe().id);
    }
  }
});

test('four-way passive swimmer drag delivers the same horizontal impulse to live SEA-12 and shallow water', async () => {
  const count = 7;
  const rho = 1000;
  const depth = 0.5;
  const width = 2;
  const mass = 8;
  const beds = () =>
    bedSurface({ columns: 1, rows: 1, width, depth: width, centre: [0, 0] }, new Float64Array(4).fill(-depth));
  const speeds = Array.from({ length: count }, (_, i) => 0.43 + 0.024 * i);
  const initial = mass * speeds.reduce((sum, speed) => sum + speed, 0);
  async function coupled(threads, shared) {
    using swim = await SwimSolver.load({ passiveReaction: true, threads });
    const water = new ShallowWaterSolver();
    const receiver = new SwimDragToWater();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
    const bed = beds();
    world.add(water, {
      bed,
      depth,
      density: rho,
      roughness: 0,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    });
    world.add(swim, {
      flow: water.flow,
      bodies: speeds.map((speed, row) => ({
        position: [-0.36 + 0.12 * row, -0.25, -0.35 + 0.04 * row],
        velocity: [0, 0, speed],
        mass,
        volume: mass / rho,
        length: 0.5,
        width: 0.12,
        height: 0.12,
        tail: { amplitude: 0, span: 0.22, wavelength: 0.75 },
        wettedArea: 0,
        formDragArea: 0.045,
        crossflowDrag: [0, 0],
        axialAddedMassRatio: 0,
      })),
    });
    world.add(receiver, { bed, density: rho });
    world.couple([swim.describe().id, receiver.id, water.id], 'staggered');
    let maxResidual = 0;
    let receiptSum = 0;
    let priorWater = 0;
    try {
      for (let frame = 1; frame <= 10; frame++) {
        world.advance(frame);
        const packet = world.fields.port(SWIM_PASSIVE_REACTION_FIELD.name);
        const reaction = regionWords(world.memory, packet.region);
        let returned = 0;
        let fish = 0;
        for (let i = 0; i < count; i++) {
          assert.equal(reaction[8 * i + 7], 1);
          assert.ok(reaction[8 * i + 5] > 0);
          returned += reaction[8 * i + 5];
          fish += mass * swim.read(i).velocity[2];
        }
        const waterNow = water.sample(0, 0).velocity[1] * (rho * depth * width * width);
        maxResidual = Math.max(maxResidual, Math.abs(waterNow - priorWater - returned), Math.abs(fish + waterNow - initial));
        priorWater = waterNow;
        receiptSum += returned;
      }
      const checkpoint = world.takeSnapshot();
      world.advance(13);
      const final = world.takeSnapshot();
      assert.deepEqual(swim.workCounts(), expectedSwimWork(count, threads, true));
      world.restoreSnapshot(checkpoint.bytes);
      world.advance(13);
      assert.deepEqual(world.takeSnapshot().bytes, final.bytes);
      return { state: final.bytes, maxResidual, receiptSum };
    } finally {
      world.remove(swim.describe().id);
    }
  }
  const serial = await coupled(1, false);
  const parallel = await coupled(4, true);
  assert.deepEqual(parallel, serial);
  assert.ok(parallel.receiptSum > 0);
  assert.ok(parallel.maxResidual <= 128 * Number.EPSILON * initial);
  console.log('LIFE-03 reciprocal water impulse', parallel.receiptSum, 'N s, max residual', parallel.maxResidual, 'N s');
});

test('swimmer workers refuse a plain world with a coded workaround', async () => {
  using swimmer = await SwimSolver.load({ threads: 2 });
  assert.throws(() => makeSwimmers(swimmer, false, 1), {
    name: 'MargoError',
    code: 'unsupported',
    message: /worldMemory\(true\)|shared.*threads: 1/i,
  });
});

test('overflowing native fin authority rejects the candidate with prior fields and work intact', async () => {
  for (const [threads, shared] of [[1, false], [4, true]]) {
    using swim = await SwimSolver.load({ threads, passiveReaction: true });
    let excessive = false;
    const water = {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out) {
        out.velocity[0] = excessive ? Number.MAX_VALUE : 0;
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        out.density = 1000;
        out.temperature = 289.15;
        return out;
      },
    };
    const bodies = Array.from({ length: 3 }, (_, row) => ({
      position: [row / 8, -2, 0],
      velocity: [0, 0, 0.25],
      mass: 4,
      length: 0.5,
      width: 0.12,
      height: 0.12,
      volume: 0.004,
      wettedArea: 0,
      tail: { amplitude: 0, span: 0.1, wavelength: 0.5 },
      target: { velocity: [0, 0, 0.1], relativeToWater: true },
    }));
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) }).add(swim, {
      bodies,
      flow: water,
    });
    try {
      world.advance(1);
      const accepted = swimmerPorts(world, true, bodies.length);
      const work = swim.workCounts();
      const readings = bodies.map((_, i) => swim.read(i));
      excessive = true;
      assert.throws(() => world.advance(2), {
        name: 'MargoError',
        code: 'state',
        message: /Swimming integration exceeded its numeric range.*Use smaller loads/,
      });
      assert.deepEqual(swimmerPorts(world, true, bodies.length), accepted);
      assert.deepEqual(swim.workCounts(), work);
      assert.deepEqual(bodies.map((_, i) => swim.read(i)), readings);
    } finally {
      world.remove(swim.describe().id);
    }
  }
});
