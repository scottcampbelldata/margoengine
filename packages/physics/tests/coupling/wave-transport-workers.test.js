import assert from 'node:assert/strict';
import test from 'node:test';
import { WAVE_SPECTRUM_FIELD, WaveSolver } from '../../dist/waves.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { followWaveTransport, rebasedCell, transportOptions } from '../fixtures/wave-transport-workers.mjs';

const comparable = ({ accepted, values, sample, cell, fieldCell, time }) => ({
  accepted,
  values,
  sample,
  cell,
  fieldCell,
  time,
});

for (const variant of [0, 1, 2]) {
  test(`ordered native wave transport and signed replay match scalar for boundary case ${variant + 1}`, async () => {
    const scalar = await followWaveTransport(variant);
    assert.deepEqual(comparable(scalar), comparable(scalar.replay));
    assert.deepEqual(scalar.cell, rebasedCell);
    assert.deepEqual(scalar.fieldCell, rebasedCell);
    assert.equal(scalar.time, 24);
    assert.ok(scalar.values.some((value) => value > 0));
    let serial;
    for (const threads of variant === 2 ? [1, 4] : [1, 2, 4]) {
      const native = await followWaveTransport(variant, threads);
      assert.deepEqual(comparable(native), comparable(scalar));
      assert.deepEqual(comparable(native), comparable(native.replay));
      assert.deepEqual(native.work, native.replay.work);
      const counts = native.work.map(({ threads: participants, workers, ...counts }) => {
        assert.equal(participants, threads);
        const { axisSweeps } = counts;
        assert.ok(axisSweeps >= 2 && axisSweeps % 2 === 0);
        assert.equal(counts.updates, axisSweeps * native.wetCells * native.bins);
        assert.equal(counts.pairedUpdates, axisSweeps * native.wetCells * (native.bins - 1));
        assert.equal(counts.fluxes, (axisSweeps / 2) * native.wetFaces * native.bins);
        assert.equal(counts.pairedFluxes, (axisSweeps / 2) * native.wetFaces * (native.bins - 1));
        if (variant !== 2) assert.ok(counts.quickestFluxes > 0 && counts.quickestFluxes < counts.fluxes);
        for (const worker of workers) assert.ok(worker.pairedFluxes > 0 && worker.pairedUpdates > 0);
        return counts;
      });
      serial ??= counts;
      assert.deepEqual(counts, serial);
    }
  });
}

test('native wave transport rejects unsupported thread counts with an actionable error', async () => {
  await assert.rejects(WaveSolver.load('waves', { threads: 3 }), {
    name: 'MargoError',
    message: /Choose 1, 2 or 4 wave transport participants.*#wave-spectrum/,
  });
});

test('a nonfinite native flux leaves the accepted spectrum, clock and receipt intact and permits replay', async () => {
  using waves = await WaveSolver.load('waves', { threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(waves, transportOptions(0).options);
  world.advance(1);
  const accepted = world.takeSnapshot();
  const work = waves.readNativeWork();
  const [region] = waves.stateRegions();
  const published = world.fields.port(WAVE_SPECTRUM_FIELD.name).region;
  const beforePublication = regionWords(world.memory, published).slice();
  // A finite saved spectral bin whose positive advective speed makes its face flux unrepresentable.
  regionWords(world.memory, region)[0] = 1e308;
  const before = regionWords(world.memory, region).slice();
  assert.throws(() => world.advance(2), { name: 'MargoError', message: /flux or update exceeded.*#wave-spectrum/ });
  assert.deepEqual(regionWords(world.memory, region), before);
  assert.deepEqual(regionWords(world.memory, world.fields.port(WAVE_SPECTRUM_FIELD.name).region), beforePublication);
  assert.deepEqual(waves.readNativeWork(), work);
  assert.equal(waves.time, 6);
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  const recovered = world.takeSnapshot();
  world.restoreSnapshot(accepted.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot(), recovered);
});
