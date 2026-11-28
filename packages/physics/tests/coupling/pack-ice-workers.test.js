import assert from 'node:assert/strict';
import test from 'node:test';
import { PackIceSolver } from '../../dist/pack-ice.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { followPackIce, packIceCell } from '../fixtures/pack-ice-workers.mjs';

const state = ({ snapshot, floes, bodies, impulses, cell, rigidCell }) => ({
  snapshot,
  floes,
  bodies,
  impulses,
  cell,
  rigidCell,
});

for (const count of [289, 391]) {
  test(`pack-ice native worker drift leaves canonical contacts and signed vessel replay exact for ${count} floes`, async () => {
    const plain = await followPackIce(count, 1);
    assert.deepEqual(state(plain.accepted), state(plain.replay));
    assert.deepEqual(plain.accepted.cell, packIceCell);
    assert.deepEqual(plain.accepted.rigidCell, packIceCell);
    assert.ok(plain.accepted.impulses.some(({ linear }) => linear[1] < 0));
    assert.ok(plain.accepted.work.some(({ contacts }) => contacts.pairs > 0 && contacts.substeps > 1));
    for (const [threads, shared] of [
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const native = await followPackIce(count, threads, shared);
      assert.deepEqual(state(native.accepted), state(plain.accepted));
      assert.deepEqual(state(native.accepted), state(native.replay));
      assert.deepEqual(native.accepted.work, native.replay.work);
      for (const [i, { native: work, contacts }] of native.accepted.work.entries()) {
        assert.equal(work.threads, threads);
        assert.equal(work.substeps, contacts.substeps);
        assert.equal(work.cflProbes, count);
        assert.equal(work.dragRows, work.substeps * count);
        assert.equal(work.pairedRows, work.dragRows);
        assert.deepEqual(contacts, plain.accepted.work[i].contacts);
        for (const [part, worker] of work.workers.entries()) {
          const rows = Math.floor((count * (part + 1)) / threads) - Math.floor((count * part) / threads);
          assert.deepEqual(worker, { dragRows: rows * work.substeps, pairedRows: rows * work.substeps });
        }
      }
    }
  });
}

test('pack-ice helpers refuse unsupported participant counts with a coded correction', async () => {
  await assert.rejects(PackIceSolver.load({ threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 pack-ice native participants.*#pack-ice/,
  });
});

test('a nonfinite result in the last native drift range cannot publish other floes or receipts', async () => {
  using pack = await PackIceSolver.load({ threads: 4 });
  const floes = Array.from({ length: 9 }, (_, i) => ({
    position: [4 * i, 0],
    radius: 0.6,
    thickness: 0.2,
    heading: i === 8 ? 0.99 * Number.MAX_VALUE : 0,
    spin: i === 8 ? 0.4 * Number.MAX_VALUE : 0,
  }));
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) }).add(pack, { floes });
  world.advance(1);
  const accepted = world.takeSnapshot();
  const port = () => regionWords(world.memory, world.fields.port(pack.floeField.name).region).slice();
  const before = port();
  const sample = pack.sample(8);
  const work = pack.readNativeWork();
  const contacts = pack.work;
  assert.equal(work.workers.length, 4);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => world.advance(2), {
      name: 'MargoError',
      message: /Pack-ice step exceeds numeric range.*#pack-ice/,
    });
    assert.deepEqual(port(), before);
    assert.deepEqual(pack.sample(8), sample);
    assert.deepEqual(pack.readNativeWork(), work);
    assert.deepEqual(pack.work, contacts);
    world.restoreSnapshot(accepted.bytes);
  }
});
