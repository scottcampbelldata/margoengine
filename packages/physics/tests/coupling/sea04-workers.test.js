import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeSolver } from '../../dist/sea.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedWakeWork, followWake, wakeCases, wakeCell } from '../fixtures/sea04-workers.mjs';

for (const [kind, { cells }] of Object.entries(wakeCases)) {
  test(`SEA-04 ${kind} modal recurrence matches the scalar wake and signed replay at ${cells.join('×')}`, async () => {
    const scalar = await followWake(kind, 0);
    assert.deepEqual(scalar.replay, scalar.accepted);
    const reference = scalar.accepted;
    assert.deepEqual(reference.physical.cell, wakeCell);
    assert.notEqual(reference.physical.sample.height, 0);
    assert.ok(reference.physical.below.some((value) => value !== 0));
    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const native = await followWake(kind, threads, shared);
      assert.deepEqual(native.accepted.physical, reference.physical);
      assert.deepEqual(native.accepted.snapshot, reference.snapshot);
      assert.deepEqual(native.replay, native.accepted);
      assert.deepEqual(native.accepted.fft, {
        backend: 'wasm-simd',
        forward: reference.fft.forward,
        inverse: reference.fft.inverse,
        transferBytes: 8 * (2 * cells[0] + 2) * cells[1] * (reference.fft.forward + reference.fft.inverse),
      });
      for (const work of native.accepted.work) assert.deepEqual(work, expectedWakeWork(cells, threads));
    }
  });
}

test('SEA-04 native finite-depth capillary mode follows exact free decay and Doppler phase', async () => {
  using wake = await WakeSolver.load({ threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0], memory: worldMemory(true) });
  const cells = [12, 10];
  const cellSize = 0.125;
  const depth = 0.4;
  const density = 1025;
  const surfaceTension = 0.073;
  const kinematicViscosity = 0.000125;
  const current = [0.33, -0.11];
  const amplitude = 0.002;
  const length = cells[0] * cellSize;
  const k = (2 * Math.PI) / length;
  const vertical = k * Math.tanh(k * depth);
  const natural = Math.sqrt((9.81 + (surfaceTension / density) * k * k) * vertical);
  world.add(wake, {
    cells,
    cellSize,
    sponge: 0,
    depth,
    density,
    surfaceTension,
    kinematicViscosity,
    current,
    initial: (x) => [amplitude * Math.cos(k * x), (amplitude * natural * Math.sin(k * x)) / vertical],
  });
  const frames = 24;
  const time = frames / 60;
  world.advance(frames);
  const decay = Math.exp(-2 * kinematicViscosity * k * k * time);
  const roundoff = 128 * frames * Number.EPSILON * amplitude;
  for (let i = 0; i < cells[0]; i++) {
    const x = (i + 0.5) * cellSize - length / 2;
    const expected = amplitude * decay * Math.cos(k * x - (natural + current[0] * k) * time);
    assert.ok(Math.abs(wake.heights()[i] - expected) <= roundoff);
  }
  assert.deepEqual(wake.readNativeWork(), expectedWakeWork(cells, 4));
});
