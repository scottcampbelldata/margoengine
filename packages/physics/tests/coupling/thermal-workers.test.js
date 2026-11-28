import assert from 'node:assert/strict';
import test from 'node:test';
import { HeatConduction } from '../../dist/thermal.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import {
  attachThermal,
  expectedThermalWork,
  followThermal,
  readThermal,
  thermalCell,
} from '../fixtures/thermal-workers.mjs';

for (const dimensions of [
  [19, 7, 5],
  [23, 9, 5],
]) {
  test('FIRE-06 phased explicit heat and signed-world replay match on ' + dimensions.join('×'), async () => {
    const baseline = await followThermal(dimensions, 1);
    const { state } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    const temperature = state.ports['heat-conduction/temperature'].words;
    const initialTemperature = state.first['heat-conduction/temperature'].words;
    const liquid = state.ports['heat-conduction/liquid-fraction'].words;
    const initialLiquid = state.first['heat-conduction/liquid-fraction'].words;
    assert.ok(temperature.some((value, i) => value !== initialTemperature[i]));
    assert.ok(liquid.some((fraction, i) => fraction > 0 && fraction < 1 && fraction !== initialLiquid[i]));
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, thermalCell);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const actual = shared ? await followThermal(dimensions, threads, shared) : baseline;
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const receipt of actual.accepted.work)
        assert.deepEqual(receipt, expectedThermalWork(dimensions, 1, threads));
    }
  });
}

test('FIRE-06 four participants retain accepted banks and work when a remote range rejects forcing', async () => {
  using heat = await HeatConduction.load({ threads: 4 });
  const dimensions = [19, 7, 5];
  const { world, input } = attachThermal(heat, dimensions, true);
  world.advance(1);
  const checkpoint = world.takeSnapshot();
  const before = readThermal(heat, world, 1);
  const work = heat.readNativeWork();
  input.reject = true;
  assert.throws(() => world.advance(2), /invalid energy or temperature.*#thermal/);
  assert.deepEqual(readThermal(heat, world, 1), before);
  assert.deepEqual(heat.readNativeWork(), work);

  input.reject = false;
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(2);
  using controlHeat = await HeatConduction.load();
  const control = attachThermal(controlHeat, dimensions, false).world;
  control.advance(2);
  assert.deepEqual(readThermal(heat, world, 2), readThermal(controlHeat, control, 2));
});

test('FIRE-06 subdivision work remains exact, and worker configuration errors offer remedies', async () => {
  await assert.rejects(HeatConduction.load({ threads: 3 }), /Choose 1, 2 or 4.*#thermal/);
  const aborted = new Error('Cancel thermal playback before loading.');
  await assert.rejects(
    HeatConduction.load({ threads: 4, signal: AbortSignal.abort(aborted) }),
    (cause) => cause === aborted,
  );

  const dimensions = [5, 2, 1];
  const options = {
    dimensions,
    materials: { conductivity: 1500, heatCapacity: 1 },
    initialTemperature: [273, 278, 300, 355, 320, 315, 333, 356, 291, 301],
  };
  using implicit = await HeatConduction.load({ threads: 4 });
  const shared = { rate: { num: 60, den: 1 }, memory: worldMemory(true) };
  assert.throws(
    () => new PhysicsWorld(shared).add(implicit, { ...options, integration: 'implicit' }),
    /Choose explicit conduction.*#thermal/,
  );
  using one = await HeatConduction.load();
  using four = await HeatConduction.load({ threads: 4 });
  const a = new PhysicsWorld({ rate: shared.rate, memory: worldMemory(false) }).add(one, options);
  const b = new PhysicsWorld({ rate: shared.rate, memory: worldMemory(true) }).add(four, options);
  a.advance(1);
  b.advance(1);
  assert.deepEqual(readThermal(four, b, 1), readThermal(one, a, 1));
  assert.deepEqual(b.takeSnapshot(), a.takeSnapshot());
  assert.deepEqual(four.readNativeWork(), expectedThermalWork(dimensions, 2, 4));
});
