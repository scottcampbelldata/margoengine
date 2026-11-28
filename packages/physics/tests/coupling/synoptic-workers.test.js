import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SynopticWeather } from '../../dist/synoptic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { expectedSynopticWork, followSynoptic, synopticCases, synopticCell } from '../fixtures/synoptic-workers.mjs';

for (const [tier, [nx, nz]] of Object.entries(synopticCases)) {
  test(`ATMO-10 ${tier} diagnostics and shallow-water forcing replay on a signed ${nx}×${nz} grid`, async () => {
    const serial = await followSynoptic(tier);
    const { state } = serial.accepted;
    assert.equal(Object.keys(state.ports).length, 2);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, synopticCell);
    assert.ok(state.sample.vapour > 0 && state.sample.cloud > 0 && state.sample.hydrometeors > 0);
    assert.ok(state.sample.precipitation > 0 && state.budget.evaporation > 0);
    assert.ok(state.water.velocity[0] > 0 && state.water.velocity[1] < 0);
    const forcing = state.ports.surfaceWaterForcing.words;
    for (let row = 0; row < forcing.length; row += 5) assert.ok(forcing[row] > 0 && forcing[row + 1] < 0);
    if (tier === 'layers') {
      assert.notEqual(state.layers.upperWind[0], state.layers.lowerWind[0]);
      assert.notEqual(state.layers.temperatureAnomaly, 0);
    } else {
      assert.equal(state.layers, undefined);
    }
    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = shared ? await followSynoptic(tier, threads, shared) : serial;
      assert.deepEqual(run.accepted.state, state);
      assert.deepEqual(run.replay, run.accepted);
      for (const work of run.accepted.work)
        assert.deepEqual(work, expectedSynopticWork(nx * nz, tier === 'layers', threads));
    }
  });
}

test('ATMO-10 uniform column publication agrees with analytic constant wind and fallout', async () => {
  using weather = await SynopticWeather.load({ threads: 4 });
  const duration = 20;
  const falloutTime = 100;
  const vapour = 7.25;
  const hydrometeors = 0.625;
  const seaTemperature = 291;
  const wind = [8, -4];
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  world.add(weather, {
    cells: [16, 8],
    timeScale: duration * 60,
    coriolis: 0,
    beta: 0,
    streamfunction: 0,
    meanWind: wind,
    temperature: seaTemperature,
    vapour,
    cloud: 0,
    hydrometeors,
    falloutTime,
  });
  world.advance(1);
  const [port] = weather.exportPorts(1);
  const rows = regionWords(world.memory, port.region);
  const expectedWater = hydrometeors * Math.exp(-duration / falloutTime);
  const expectedRain = (-hydrometeors * Math.expm1(-duration / falloutTime)) / duration;
  for (let i = 0; i < rows.length; i += 12) {
    assert.deepEqual(Array.from(rows.subarray(i, i + 8)), [
      101325,
      ...wind,
      0,
      seaTemperature,
      seaTemperature,
      vapour,
      0,
    ]);
    assert.ok(Math.abs(rows[i + 8] - expectedWater) <= 16 * Number.EPSILON * hydrometeors);
    assert.ok(Math.abs(rows[i + 9] - expectedRain) <= (16 * Number.EPSILON * hydrometeors) / duration);
    assert.deepEqual(Array.from(rows.subarray(i + 10, i + 12)), [vapour * wind[0], vapour * wind[1]]);
  }
});

test('ATMO-10 native SIMD and odd tail preserve signed zero and reject overflowed IVT', async () => {
  const count = 5;
  const [job, data, diagnostic, output, layer, work] = [1024, 2048, 3072, 4096, 5120, 6144];
  const module = await WebAssembly.compile(await readFile(new URL('../../dist/synoptic-kernel.wasm', import.meta.url)));
  const memory = worldMemory(false);
  const { __stack_pointer, synoptic_publish_phase } = new WebAssembly.Instance(module, { env: { memory } }).exports;
  __stack_pointer.value = 131072;
  new Uint32Array(memory.buffer, job, 6).set([count, data, diagnostic, output, layer, work]);
  const q = new Float64Array(memory.buffer, data, 5 * count);
  const d = new Float64Array(memory.buffer, diagnostic, 8 * count + 3);
  const anomaly = new Float64Array(memory.buffer, layer + 4 * count * 8, count);
  for (let row = 0; row < count; row++) {
    q[count + row] = 5 + row;
    q[2 * count + row] = row / 8;
    q[3 * count + row] = row / 4;
    d[count + row] = 2 + row;
    d[2 * count + row] = -0;
    d[3 * count + row] = 101000 + row;
    d[4 * count + row] = 0.125;
    d[5 * count + row] = 0.001;
    d[6 * count + row] = 286 - row;
    d[7 * count + row] = 278 - row;
    anomaly[row] = 0.25 * row;
  }
  for (let part = 0; part < 4; part++) assert.equal(synoptic_publish_phase(job, 0, part, 4), 0);
  const result = new Float64Array(memory.buffer, output, count * 12);
  for (let row = 0; row < count; row++) {
    assert.deepEqual(Array.from(result.subarray(12 * row, 12 * (row + 1))), [
      101000 + row,
      2 + row,
      -0,
      0.125,
      286 - row + anomaly[row],
      278 - row + anomaly[row],
      5 + row,
      row / 8,
      row / 4,
      0.001,
      (5 + row) * (2 + row),
      -0,
    ]);
  }
  const receipt = new Uint32Array(memory.buffer, work, 12);
  assert.deepEqual(Array.from(receipt), [0, 0, 0, 2, 2, 2, 0, 0, 0, 3, 2, 3]);
  const lastRow = result.slice(4 * 12);
  q[count + 4] = Number.MAX_VALUE;
  assert.equal(synoptic_publish_phase(job, 0, 3, 4), 2);
  assert.deepEqual(result.slice(4 * 12), lastRow);
});
