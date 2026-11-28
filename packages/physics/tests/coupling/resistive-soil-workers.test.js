import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { BED_FIELD, TerrainBed } from '../../dist/earth.js';
import { ResistiveSoil } from '../../dist/terramechanics.js';
import { BODIES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { expectedCell, followResistiveSoil, sampleBatches } from '../fixtures/resistive-soil-workers.mjs';

function checkWork(work, plan, threads) {
  const counts = plan.map((strokes) => strokes.reduce((sum, count) => sum + count, 0));
  const samples = counts.reduce((sum, count) => sum + count, 0);
  const odd = counts.filter((count) => count % 2 !== 0).length;
  assert.equal(work.threads, threads);
  assert.equal(work.workers.length, threads);
  assert.equal(work.samples, samples);
  assert.equal(work.pairedSamples, samples - odd);
  assert.equal(work.simdPairs, (samples + odd) / 2);
  for (const [part, worker] of work.workers.entries()) {
    const first = Math.floor((part * work.simdPairs) / threads);
    const end = Math.floor(((part + 1) * work.simdPairs) / threads);
    assert.equal(worker.simdPairs, end - first);
    assert.ok(worker.pairedSamples > 0);
    assert.equal(worker.pairedSamples % 2, 0);
    assert.ok(worker.samples >= worker.pairedSamples);
  }
}

for (const [batch, plan] of sampleBatches.entries()) {
  test(
    'EARTH-05 distributes buried strip samples and preserves ordered rigid wrenches for ' + plan.length + ' bodies',
    async () => {
      const baseline = await followResistiveSoil(batch, 1);
      const { state, work } = baseline.accepted;
      assert.equal(state.snapshot.hash, baseline.replay.state.snapshot.hash);
      assert.deepEqual(baseline.replay, baseline.accepted);
      assert.deepEqual(state.forceCell, expectedCell);
      assert.deepEqual(state.rigidCell, expectedCell);
      assert.ok(state.bodies.every(({ force, torque }) => force[1] > 0 && torque.some((value) => value !== 0)));
      assert.ok(state.bodies[0].velocity[1] > -0.41);
      for (const [threads, shared] of [
        [1, true],
        [2, true],
        [4, true],
      ]) {
        const actual = await followResistiveSoil(batch, threads, shared);
        assert.equal(actual.accepted.state.snapshot.hash, state.snapshot.hash);
        assert.deepEqual(actual.accepted.state, state);
        assert.deepEqual(actual.replay, actual.accepted);
        for (const [frame, receipt] of actual.accepted.work.entries()) {
          checkWork(receipt, plan, threads);
          assert.equal(receipt.samples, work[frame].samples);
        }
      }
    },
  );
}

test('EARTH-05 rejects unsupported native participants and returns the original abort reason', async () => {
  await assert.rejects(ResistiveSoil.load({ threads: 3 }), /Choose 1, 2 or 4.*#soil/);
  const reason = new Error('cancel soil loading');
  await assert.rejects(
    ResistiveSoil.load({ signal: AbortSignal.abort(reason), threads: 4 }),
    (cause) => cause === reason,
  );
});

test('EARTH-05 reads foreign soil and rigid banks and rejects bad alignment before changing accepted work', async () => {
  await Physics.load({ threads: true });
  using soil = await ResistiveSoil.load({ threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true), gravity: [0, 0, 0] });
  using physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const body = physics.addBody(null, {
    colliders: { shape: 'sphere', radius: 0.05, mass: 2 },
    linearVelocity: [0, -0.1, 0],
  });
  const terrain = { columns: 2, rows: 2, width: 1, depth: 1, centre: [0, 0] };
  world
    .add(new TerrainBed(), { ...terrain, elevations: () => 0.08 })
    .add(new RigidSolver(), { physics })
    .add(soil, {
      terrain,
      coefficients: [1000, 0, 0, 0, 0, 0, 0, 0, 0],
      bodies: [{ row: body.row, strips: [{ start: [0.01, -0.1, 0], end: [0.11, -0.1, 0], width: 0.1, samples: 7 }] }],
    })
    .couple(['bed', 'rigid', soil.id], 'staggered');
  world.advance(1);
  const bed = world.fields.port(BED_FIELD.name);
  const rigid = world.fields.port(BODIES_FIELD.name);
  const step = (p, q) =>
    soil.step({
      tick: 1,
      level: 0,
      seed: 0,
      cell: [0, 0, 0],
      inputs: new Map([
        [p.field, p],
        [q.field, q],
      ]),
    });
  function foreign(port) {
    const byteOffset = 64;
    const memory = new WebAssembly.Memory({ initial: Math.ceil((byteOffset + port.region.byteLength) / 65536) });
    const region = { ...port.region, memory, byteOffset };
    regionWords(memory, region).set(regionWords(port.region.memory ?? world.memory, port.region));
    return { ...port, region };
  }
  step(bed, rigid);
  const accepted = world.takeSnapshot();
  const force = soil.read(body.row);
  const work = soil.readNativeWork();
  assert.ok(force.force[1] > 0);
  const foreignBed = foreign(bed);
  const foreignRigid = foreign(rigid);
  step(foreignBed, foreignRigid);
  assert.deepEqual(soil.read(body.row), force);
  assert.deepEqual(soil.readNativeWork(), work);
  assert.deepEqual(world.takeSnapshot(), accepted);
  for (const p of [foreignBed, foreignRigid]) {
    const bad = { ...p, region: { ...p.region, byteOffset: 65 } };
    assert.throws(
      () => step(p === foreignBed ? bad : foreignBed, p === foreignRigid ? bad : foreignRigid),
      /four-byte-aligned.*owning WebAssembly memory.*#soil/,
    );
    assert.deepEqual(world.takeSnapshot(), accepted);
    assert.deepEqual(soil.readNativeWork(), work);
  }
});
