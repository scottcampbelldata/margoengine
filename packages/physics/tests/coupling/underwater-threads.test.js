import assert from 'node:assert/strict';
import test from 'node:test';
import { ACOUSTIC_FIELD_LAYOUT, UnderwaterAcousticsSolver } from '../../dist/underwater.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const id = 'underwater-test';
const rate = { num: 60, den: 1 };
const far = [690_000, -320_000, 900_000];
const near = [-3, 1, -2];
const originShift = far.map((coordinate, axis) => coordinate - near[axis]);
const mixed = {
  profile: [
    { depth: 0, speed: 1496 },
    { depth: 3, speed: 1496 },
    { depth: 14, speed: 1480 },
    { depth: 26, speed: 1500 },
    { depth: 35, speed: 1492 },
  ],
  rays: [
    { depth: 1, declination: 0, frequency: 1000 },
    { depth: 7, declination: 0.05, frequency: 1199, waist: 3.5 },
    { depth: 13, declination: 0.02, frequency: 810 },
    { depth: 25, declination: 0.65, pressure: -0.7 },
    { depth: 17, declination: -0.54, frequency: 1920, waist: 2.1 },
    { depth: 35, declination: -Math.PI / 2, frequency: 700 },
    { depth: 29, declination: Math.PI / 2, frequency: 4000 },
    { depth: 0, declination: 0.55, pressure: 0.45 },
    { depth: 8, declination: -0.18, waist: 1.9 },
  ],
  surfaceReflection: -0.98,
  bottomReflection: 0.72,
  absorption: 4,
};

async function make(t, { threads, shared = false, reference = false, params = mixed } = {}) {
  const acoustics = reference
    ? new UnderwaterAcousticsSolver({ id })
    : await UnderwaterAcousticsSolver.load(threads === undefined ? { id } : { id, threads });
  const world = new PhysicsWorld({ rate, cellSize: 4096, memory: worldMemory(shared) });
  t.after(() => {
    world.remove(id);
    if (!reference) acoustics[Symbol.dispose]();
  });
  world.add(acoustics, params, far);
  return { world, acoustics, threads: threads ?? 1, count: params.rays.length };
}

function retainedPorts({ world, acoustics, count }) {
  return [
    [acoustics.pathField, 4],
    [acoustics.signalField, 2],
    [acoustics.delayField, 1],
  ].map(([field, width]) => {
    const record = world.fields.field(field.name);
    assert.ok(record?.current);
    const read = ({ port }) => {
      const { region, tick, cell } = port;
      assert.equal(region.type, 'f64');
      assert.equal(region.layout, ACOUSTIC_FIELD_LAYOUT);
      const words = regionWords(world.memory, region);
      assert.equal(words.length, count * width);
      return { tick, cell, words: words.slice() };
    };
    return { current: read(record.current), previous: record.previous ? read(record.previous) : undefined };
  });
}

function accepted(lane) {
  return {
    snapshot: lane.world.takeSnapshot(),
    ports: retainedPorts(lane),
    rays: Array.from({ length: lane.count }, (_, i) => lane.acoustics.sample(i)),
  };
}

function partition(count, part, threads) {
  return [Math.floor((count * part) / threads), Math.floor((count * (part + 1)) / threads)];
}

function checkWork({ acoustics, threads, count }) {
  const work = acoustics.workCounts();
  assert.equal(work.threads, threads);
  assert.equal(work.rays, count);
  assert.equal(work.workers.length, threads);
  for (const [part, worker] of work.workers.entries()) {
    const [from, to] = partition(count, part, threads);
    assert.equal(worker.rays, to - from);
    assert.ok(worker.driftIntegrals >= worker.rays);
    for (const key of ['rays', 'driftIntegrals', 'boundaryCrossings'])
      assert.ok(Number.isSafeInteger(worker[key]) && worker[key] >= 0);
  }
  for (const key of ['rays', 'driftIntegrals', 'boundaryCrossings'])
    assert.equal(
      work[key],
      work.workers.reduce((sum, part) => sum + part[key], 0),
    );
  return work;
}

test('native underwater rays exactly match the TypeScript reference, far-cell fields and shifted replay', async (t) => {
  const reference = await make(t, { reference: true });
  const native = [
    await make(t),
    await make(t, { shared: true, threads: 1 }),
    await make(t, { shared: true, threads: 2 }),
    await make(t, { shared: true, threads: 4 }),
  ];
  const lanes = [reference, ...native];
  for (const lane of native) assert.deepEqual(accepted(lane), accepted(reference));
  for (const lane of lanes) lane.world.advance(3);
  for (const lane of native) assert.deepEqual(accepted(lane), accepted(reference));
  const checkpoints = lanes.map(accepted);
  for (const lane of native) {
    const work = checkWork(lane);
    assert.ok(work.driftIntegrals > mixed.rays.length, 'This step must traverse more than one segment.');
    assert.ok(work.boundaryCrossings > 0, 'This step must encounter a boundary.');
  }
  assert.ok(checkpoints[0].rays.some(({ reflections }) => reflections > 0));

  function finish(lane, checkpoint) {
    lane.world.shiftOrigin(originShift);
    assert.deepEqual(lane.world.cellOf(id), near);
    const shifted = retainedPorts(lane);
    for (const [i, result] of shifted.entries()) {
      for (const key of ['current', 'previous']) {
        assert.deepEqual(checkpoint.ports[i][key].cell, far);
        assert.deepEqual(result[key], { ...checkpoint.ports[i][key], cell: near });
      }
    }
    lane.world.advance(15);
    const result = accepted(lane);
    for (const port of result.ports) {
      assert.equal(port.current.tick, 14);
      assert.equal(port.previous.tick, 13);
      assert.deepEqual(port.current.cell, near);
      assert.deepEqual(port.previous.cell, near);
    }
    return result;
  }

  const expected = finish(reference, checkpoints[0]);
  for (const [i, lane] of lanes.entries()) {
    if (lane !== reference) assert.deepEqual(finish(lane, checkpoints[i]), expected);
    lane.world.restoreSnapshot(checkpoints[i].snapshot.bytes);
    assert.deepEqual(accepted(lane), checkpoints[i]);
    assert.deepEqual(finish(lane, checkpoints[i]), expected);
  }
});

test('each underwater worker reports the exact work of its odd-sized ray partition', async (t) => {
  const parallel = await make(t, { shared: true, threads: 4 });
  const serial = [];
  for (let part = 0; part < parallel.threads; part++) {
    const [from, to] = partition(mixed.rays.length, part, parallel.threads);
    serial.push(await make(t, { params: { ...mixed, rays: mixed.rays.slice(from, to) } }));
  }
  const receipts = [];
  for (let frame = 1; frame <= 3; frame++) {
    parallel.world.advance(frame);
    for (const lane of serial) lane.world.advance(frame);
    const work = checkWork(parallel);
    assert.deepEqual(
      work.workers,
      serial.map((lane) => checkWork(lane).workers[0]),
    );
    receipts.push(work.workers.map(({ driftIntegrals, boundaryCrossings }) => [driftIntegrals, boundaryCrossings]));
  }
  assert.ok(receipts.some((parts) => new Set(parts.map((part) => part.join('/'))).size > 1));
});

test('native underwater folding resolves every reflection with one drift per ray', async (t) => {
  const depth = 2 ** -20;
  const horizontal = { depth: depth / 2, declination: 0 };
  const params = {
    profile: [
      { depth: 0, speed: 1920 },
      { depth, speed: 1920 },
    ],
    rays: [horizontal, horizontal, horizontal, horizontal, { ...horizontal, declination: Math.PI / 2 }],
    surfaceReflection: -1,
    bottomReflection: 1,
  };
  const reference = await make(t, { reference: true, params });
  const serial = await make(t, { params });
  const parallel = await make(t, { shared: true, threads: 4, params });
  for (const lane of [reference, serial, parallel]) lane.world.advance(1);
  assert.deepEqual(accepted(serial), accepted(reference));
  assert.deepEqual(accepted(parallel), accepted(reference));
  const expected = 1920 / rate.num / depth;
  assert.equal(parallel.acoustics.sample(4).depth, depth / 2);
  assert.equal(parallel.acoustics.sample(4).reflections, expected);
  assert.equal(checkWork(serial).boundaryCrossings, expected);
  const work = checkWork(parallel);
  assert.equal(work.driftIntegrals, 5);
  assert.deepEqual(
    work.workers.map(({ boundaryCrossings }) => boundaryCrossings),
    [0, 0, 0, expected],
  );
});

function checkRefusal(lane, message) {
  const { world, acoustics } = lane;
  const initial = accepted(lane);
  const initialWork = acoustics.workCounts();
  const assertRefused = (advance) => {
    assert.throws(advance, {
      name: 'MargoError',
      code: 'state',
      message,
    });
    assert.equal(world.tick, 0);
    assert.deepEqual(retainedPorts(lane), initial.ports);
    assert.deepEqual(
      Array.from({ length: lane.count }, (_, i) => acoustics.sample(i)),
      initial.rays,
    );
    assert.deepEqual(acoustics.workCounts(), initialWork);
  };
  assertRefused(() => world.advance(1));
  // The clock records its requested frame even when the solver refuses a step.
  const pending = world.takeSnapshot();
  assertRefused(() => world.settle());
  assert.deepEqual(world.takeSnapshot(), pending);
  world.restoreSnapshot(initial.snapshot.bytes);
  assert.deepEqual(accepted(lane), initial);
}

test('native underwater workers reject an unrepresentable count without accepting any ray, field or work', async (t) => {
  const depth = 2 ** -52;
  const params = {
    profile: [
      { depth: 0, speed: 1920 },
      { depth, speed: 1920 },
    ],
    rays: [
      { depth: depth / 2, declination: 0 },
      { depth: depth / 2, declination: Math.PI / 2 },
    ],
  };
  const lane = await make(t, { shared: true, threads: 2, params });
  checkRefusal(lane, /reflection count.*increase the water depth or shorten the run/i);
});

test('individually exact acoustic crossings cannot overflow the accepted aggregate work', async (t) => {
  const depth = 2 ** -47;
  const ray = { depth: depth / 2, declination: Math.PI / 2 };
  const profile = [
    { depth: 0, speed: 1920 },
    { depth, speed: 1920 },
  ];
  const single = await make(t, { params: { profile, rays: [ray] } });
  single.world.advance(1);
  const count = 1920 / rate.num / depth;
  assert.equal(single.acoustics.sample(0).reflections, count);
  assert.equal(checkWork(single).boundaryCrossings, count);
  const double = await make(t, { shared: true, threads: 2, params: { profile, rays: [ray, ray] } });
  checkRefusal(double, /trace work exceeds exact numeric range.*use fewer rays or deeper layers/i);
});

test('threaded underwater mode requires shared memory and closes when disposed', async () => {
  for (const threads of [0, 1.5, 65, Infinity]) {
    await assert.rejects(UnderwaterAcousticsSolver.load({ id, threads }), {
      name: 'MargoError',
      code: 'state',
      message: /threads/i,
    });
  }
  const acoustics = await UnderwaterAcousticsSolver.load({ id, threads: 2 });
  const plain = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const shared = new PhysicsWorld({ rate, memory: worldMemory(true) });
  try {
    assert.throws(() => plain.add(acoustics, mixed, far), {
      name: 'MargoError',
      code: 'unsupported',
      message: /worldMemory\(true\).*threads: 1/i,
    });
    assert.equal(plain.fields.port(acoustics.pathField.name), undefined);
    shared.add(acoustics, mixed, far).advance(1);
    assert.equal(shared.remove(id), true);
    acoustics[Symbol.dispose]();
    acoustics[Symbol.dispose]();
    const disposed = { name: 'MargoError', code: 'disposed', message: /disposed/i };
    assert.throws(() => acoustics.sample(0), disposed);
    assert.throws(() => shared.add(acoustics, mixed, far), disposed);
    assert.equal(shared.fields.port(acoustics.pathField.name), undefined);
  } finally {
    shared.remove(id);
    acoustics[Symbol.dispose]();
  }
});
