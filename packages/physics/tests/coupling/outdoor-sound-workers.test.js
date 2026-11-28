import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OUTDOOR_SOUND_BANDS, outdoorAirAbsorption } from '../../dist/outdoor-sound.js';
import { worldMemory } from '../../dist/world.js';
import { outdoorSoundRun, outdoorWorkerWorld } from '../fixtures/outdoor-sound-workers.mjs';

for (const links of [35, 63]) {
  test(`native outdoor sound integrates ${links} mixed paths exactly in 1, 2 and 4 participants, including replay`, async () => {
    const scalar = await outdoorSoundRun(links, 0);
    const blocked = scalar.accepted.countBlocked;
    assert.ok(blocked > 0 && blocked < links - 1, 'cover blocked paths with two legs and clear paths');
    assert.equal(scalar.accepted.zeroLength, 0, 'coincident endpoints consume no quadrature samples');
    const samples = (links - 1 + blocked) * 17;
    let coefficientSets;
    for (const threads of [1, 2, 4]) {
      const { start, accepted, replay, restored, initial } = await outdoorSoundRun(links, threads);
      assert.deepEqual(start.bytes, scalar.start.bytes);
      assert.deepEqual(accepted.snapshot.bytes, scalar.accepted.snapshot.bytes);
      assert.deepEqual(accepted.field, scalar.accepted.field);
      assert.deepEqual(replay, accepted);
      assert.deepEqual(restored, initial);
      assert.equal(accepted.field.cell[1], initial[1] - 1);
      const work = accepted.work;
      assert.equal(work.threads, threads);
      assert.equal(work.links, links);
      assert.equal(work.samples, samples);
      assert.equal(work.bandPairs, 4 * samples);
      assert.equal(work.workers.length, threads);
      for (const [part, worker] of work.workers.entries()) {
        const from = Math.floor((part * links) / threads);
        const to = Math.floor(((part + 1) * links) / threads);
        assert.equal(worker.links, to - from);
        assert.ok(worker.samples > 0 && worker.coefficientSets > 0);
        assert.equal(worker.bandPairs, 4 * worker.samples);
      }
      assert.ok(work.coefficientSets < samples, 'a homogeneous stretch reuses its eight coefficients');
      assert.equal(
        work.coefficientSets,
        work.workers.reduce((sum, work) => sum + work.coefficientSets, 0),
      );
      coefficientSets ??= work.coefficientSets;
      assert.equal(work.coefficientSets, coefficientSets);
    }
  });
}

test('late invalid weather preserves threaded outdoor sound measurements and the accepted receipt', async () => {
  const { world, sound, fail, recover } = await outdoorWorkerWorld(63, 4);
  try {
    world.advance(1);
    const checkpoint = world.takeSnapshot();
    const before = sound.read(62);
    const work = sound.workCounts();
    fail();
    assert.throws(() => world.advance(2), /density/i);
    assert.deepEqual(sound.read(62), before);
    assert.deepEqual(sound.workCounts(), work);
    recover();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(2);
    assert.notDeepEqual(sound.read(62), before);
  } finally {
    sound.dispose();
  }
});

test('native outdoor acoustic legs preserve distance and delay grouping and one ordered octave sum', async () => {
  const binary = await readFile(new URL('../../dist/outdoor-sound-kernel.wasm', import.meta.url));
  const memory = worldMemory(false);
  const { exports } = await WebAssembly.instantiate(binary, { env: { memory } }).then(({ instance }) => instance);
  exports.__stack_pointer.value = memory.buffer.byteLength;
  const humidity = 0.5;
  const temperature = 273.15;
  const pressure = 101325;
  const distance = 2 ** 53;
  const sampleAddress = 64;
  const firstAddress = 192;
  const totalAddress = 196;
  const outputAddress = 200;
  const workAddress = 280;
  new Uint32Array(memory.buffer, 0, 8).set([
    sampleAddress,
    firstAddress,
    totalAddress,
    outputAddress,
    workAddress,
    1,
    4,
    0,
  ]);
  new Float64Array(memory.buffer, 32, 1)[0] = humidity;
  new Float64Array(memory.buffer, sampleAddress, 16).set([
    distance,
    1,
    temperature,
    pressure,
    1,
    1,
    temperature,
    pressure,
    1,
    1,
    temperature,
    pressure,
  ]);
  new Uint32Array(memory.buffer, firstAddress, 2).set([1, 3]);
  const output = new Float64Array(memory.buffer, outputAddress, 10);
  const receipt = new Float64Array(memory.buffer, workAddress, 4);
  assert.equal(exports.outdoor_sound_thread_phase(0, 0, 0, 1), 0);
  assert.equal(distance + 1 + 1, distance, 'the ungrouped loop would lose both short distances');
  assert.equal(output[0], distance + 2);
  assert.equal(output[1], distance + 2);
  assert.deepEqual(
    [...output.slice(2)],
    OUTDOOR_SOUND_BANDS.map((f) => {
      const alpha = outdoorAirAbsorption(f, temperature, humidity, pressure);
      return distance * alpha + alpha + alpha;
    }),
  );
  assert.deepEqual([...receipt], [1, 3, 12, 1]);
  // ISO 9613-1 Table 1(e), 50% RH at 0 °C and 1 kHz, published to 0.01 dB/km.
  assert.ok(Math.abs((output[6] * 1000) / output[0] - 6.83) < 0.005);
});
