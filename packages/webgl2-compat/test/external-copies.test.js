// The layer's copies of imported video frames follow WebGPU's external-texture lifetime (expired when the importing
// task ends) instead of living as long as their source object (the known bug "an imported external texture outlives
// the Video that imported it", found by check:owners).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalCopies, SPARE_EXTERNALS } from '../dist/device.js';

function copies() {
  const made = [], ends = [];
  const pool = new ExternalCopies((width, height) => {
    const copy = { width, height, destroyed: false, destroy() { this.destroyed = true; } };
    made.push(copy);
    return copy;
  }, (end) => ends.push(end));
  const endTask = () => ends.splice(0).forEach((end) => end());
  return { pool, made, endTask, live: () => made.filter((c) => !c.destroyed).length };
}

test('a copy serves its source for the task, and a steady video reuses it every frame', () => {
  const { pool, made, endTask } = copies(), video = {};
  const first = pool.take(video, 8, 4);
  assert.equal(pool.take(video, 8, 4), first, 'the same task imports the same copy again');
  for (let frame = 0; frame < 10; frame++) {
    endTask();
    assert.equal(pool.take(video, 8, 4), first, `frame ${frame} reuses the copy`);
  }
  assert.equal(made.length, 1, 'steady frames allocate nothing');
});

test('a copy does not outlive its importer while the source object stays alive', () => {
  const { pool, endTask, live } = copies(), kept = {};
  pool.take(kept, 8, 4);
  endTask();
  // Other videos of other sizes play on; the first source is still referenced by the caller but imported no more.
  for (let i = 0; i < 4; i++) {
    pool.take({}, 16 + i, 4);
    endTask();
  }
  assert.equal(live(), SPARE_EXTERNALS, 'only the spares stay');
  assert.equal(pool.size, SPARE_EXTERNALS);
});

test('a size change and device destruction release the old copies', () => {
  const { pool, made, endTask, live } = copies(), video = {};
  pool.take(video, 8, 4);
  pool.take(video, 16, 8);
  assert.equal(made.length, 2);
  endTask();
  assert.equal(live(), 2, 'both are spares now');
  pool.destroy();
  assert.equal(live(), 0);
  assert.equal(pool.size, 0);
});
