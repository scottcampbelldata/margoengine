import assert from 'node:assert/strict';
import test from 'node:test';
import { acousticCell, expectedRoomWaveWork, roomWaveRun } from '../fixtures/room-wave-workers.mjs';

for (const dimensions of [
  [11, 9, 7],
  [25, 11, 17],
]) {
  test(`native room acoustics partitions ${dimensions.join('×')} exactly in plain, shared and isolated Node helpers`, async () => {
    const reference = await roomWaveRun(dimensions, 1, false);
    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = shared ? await roomWaveRun(dimensions, threads, true) : reference;
      const { accepted, replay } = run;
      assert.deepEqual(run.cold.bytes, reference.cold.bytes);
      assert.deepEqual(accepted.snapshot.bytes, reference.accepted.snapshot.bytes);
      assert.deepEqual(replay.snapshot.bytes, accepted.snapshot.bytes);
      assert.deepEqual(accepted.fields, reference.accepted.fields);
      assert.deepEqual(replay.fields, accepted.fields);
      assert.deepEqual(accepted.trace, reference.accepted.trace);
      assert.deepEqual(accepted.work, expectedRoomWaveWork(dimensions, threads));
      assert.deepEqual(replay.work, accepted.work);
      assert.deepEqual(run.restoredCells, [acousticCell, acousticCell]);
      assert.deepEqual(
        accepted.fields.map(({ cell }) => cell),
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
      );
      assert.equal(accepted.solid, 0);
      assert.ok(accepted.peak > 0);
      assert.equal(accepted.trace.sampleRate, 240);
    }
  });
}
