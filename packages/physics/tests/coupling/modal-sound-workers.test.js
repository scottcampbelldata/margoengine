import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DYNAMIC_BASE, PAGE } from '../../../../scripts/physics-modules.mjs';
import { ModalSoundSolver } from '../../dist/modal-sound.js';
import { worldMemory } from '../../dist/world.js';
import { expectedModalWork, followModalSound, modalCell } from '../fixtures/modal-sound-workers.mjs';

for (const count of [7, 11]) {
  test(
    'SOUND-04 independently rendered tracks retain exact audio and signed-world replay for ' + count + ' tracks',
    async () => {
      const baseline = await followModalSound(count, 1);
      const { state } = baseline.accepted;
      assert.deepEqual(baseline.replay, baseline.accepted);
      assert.equal(Object.keys(state.ports).length, 2);
      for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, modalCell);
      for (const [i, block] of state.blocks.entries()) {
        assert.equal(block.sampleRate, 44100);
        assert.ok(block.samples.some((sample) => Number.isFinite(sample) && sample !== 0));
        const history = state.history[i];
        assert.equal(history.samples.length, 1000);
        assert.equal(history.firstSample + 1000, block.firstSample + block.samples.length);
        assert.deepEqual(history.samples.slice(-block.samples.length), block.samples);
      }
      assert.notDeepEqual(state.blocks[0].samples, state.blocks.at(-1).samples);
      assert.deepEqual(new Set(baseline.accepted.work.map((item) => item.blockSamples)), new Set([367, 368]));

      for (const [threads, shared] of [
        [1, false],
        [1, true],
        [2, true],
        [4, true],
      ]) {
        const actual = shared ? await followModalSound(count, threads, shared) : baseline;
        assert.deepEqual(actual.accepted.state, state);
        assert.deepEqual(actual.replay, actual.accepted);
        for (const { blockSamples, receipt } of actual.accepted.work)
          assert.deepEqual(receipt, expectedModalWork(count, blockSamples, threads));
      }
    },
  );
}

test('SOUND-04 validates worker options and processes one whole track without splitting its modes', async () => {
  await assert.rejects(ModalSoundSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#modal-sound/);
  const stop = new Error('Cancel audio synthesis before loading.');
  await assert.rejects(
    ModalSoundSolver.load({ threads: 4, signal: AbortSignal.abort(stop) }),
    (cause) => cause === stop,
  );

  const one = await followModalSound(1, 1);
  const four = await followModalSound(1, 4);
  assert.deepEqual(four.accepted.state, one.accepted.state);
  assert.deepEqual(four.replay, four.accepted);
  const { blockSamples, receipt } = four.accepted.work.at(-1);
  assert.deepEqual(receipt, expectedModalWork(1, blockSamples, 4));
  assert.deepEqual(
    receipt.workers.map((worker) => worker.tracks),
    [0, 0, 0, 1],
  );
});

test('SOUND-04 native track validation rejects PCM, oscillator and roughness nonfinite results', async () => {
  const memory = worldMemory(false);
  memory.grow(2);
  const asset = await readFile(new URL('../../dist/modal-sound-kernel.wasm', import.meta.url));
  const module = await WebAssembly.compile(asset);
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = DYNAMIC_BASE + 2 * PAGE;
  const base = DYNAMIC_BASE;
  const job = base + 64;
  const work = base + 128;
  const models = base + 192;
  const oscillator = base + 256;
  const surface = base + 320;
  const drive = base + 512;
  const pcm = base + 768;
  const view = (at, length) => new Float64Array(memory.buffer, at, length);
  const phases = view(surface + 16, 16);
  view(models, 1)[0] = 1;
  for (let band = 0; band < 8; band++) {
    phases[band * 2] = 1;
    view(drive + 8 * (5 + band * 3), 1)[0] = 1;
  }
  new Uint32Array(memory.buffer, base, 4).set([job, 1, 1, work]);
  new Uint32Array(memory.buffer, job, 6).set([models, oscillator, 1, surface, drive, pcm]);
  const run = () => exports.modal_sound_thread_phase(base, 0, 0, 1);
  view(oscillator, 2).set([0.5, -0.25]);
  assert.equal(run(), 0);
  const previous = view(work, 4).slice();
  assert.deepEqual(Array.from(previous), [1, 1, 1, 8]);

  view(oscillator, 2).set([1e39, 0]);
  assert.equal(run(), 1);
  assert.equal(new Float32Array(memory.buffer, pcm, 1)[0], Infinity);
  assert.deepEqual(view(work, 4), previous);

  view(models, 1)[0] = 2;
  view(oscillator, 2).set([0, 1.7e308]);
  assert.equal(run(), 1);
  assert.equal(new Float32Array(memory.buffer, pcm, 1)[0], 0);
  assert.equal(view(oscillator, 2)[1], Infinity);
  assert.deepEqual(view(work, 4), previous);

  view(models, 1)[0] = 1;
  phases[0] = 0;
  view(oscillator, 2).fill(0);
  assert.equal(run(), 1);
  assert.ok(Number.isNaN(phases[0]));
  assert.deepEqual(view(work, 4), previous);
});
