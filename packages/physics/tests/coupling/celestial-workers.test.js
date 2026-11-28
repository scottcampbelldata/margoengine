import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cos, sin } from '@margoengine/math/pinned';
import { DYNAMIC_BASE, PAGE } from '../../../../scripts/physics-modules.mjs';
import { STANDISH_ORBITS } from '../../../shared/standish-orbits.js';
import { CelestialSolver } from '../../dist/celestial.js';
import { worldMemory } from '../../dist/world.js';
import { celestialCell, expectedCelestialWork, followCelestial } from '../fixtures/celestial-workers.mjs';

for (const [t, timeScale] of [
  [-1.098, 86400 * 300],
  [0.493, -86400 * 420],
]) {
  test('SPACE-02 analytic planets and Earth-fixed ports replay with native workers at T=' + t, async () => {
    const scalar = await followCelestial(t, timeScale, 0);
    const { state } = scalar.accepted;
    assert.deepEqual(scalar.replay, scalar.accepted);
    assert.ok(scalar.accepted.work.every((receipt) => receipt === undefined));
    assert.equal(Math.sign(state.epoch.tdbSeconds - state.before.tdbSeconds), Math.sign(timeScale));
    assert.notDeepEqual(state.positions[2], state.prior);
    assert.equal(Object.keys(state.ports).length, 2);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, celestialCell);
    assert.ok(state.positions.flat().every(Number.isFinite));
    assert.ok(state.tide.acceleration.some((acceleration) => acceleration !== 0));

    const unshifted = await followCelestial(t, timeScale, 0, false, false);
    assert.deepEqual(unshifted.accepted.state.positions, state.positions);
    assert.deepEqual(unshifted.accepted.state.light, state.light);
    assert.deepEqual(unshifted.accepted.state.tide, state.tide);
    const bytes = (state) => Object.values(state.ports).map(({ words }) => words);
    assert.deepEqual(bytes(unshifted.accepted.state), bytes(state));

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const native = await followCelestial(t, timeScale, threads, shared);
      assert.deepEqual(native.accepted.state, state);
      assert.deepEqual(native.replay, native.accepted);
      for (const receipt of native.accepted.work) assert.deepEqual(receipt, expectedCelestialWork(threads));
    }
  });
}

test('SPACE-02 raw native coordinates match the ordered Standish Table 1 formula across the full interval', async () => {
  const memory = worldMemory(false);
  memory.grow(1);
  const wasm = await readFile(new URL('../../dist/celestial-kernel.wasm', import.meta.url));
  const module = await WebAssembly.compile(wasm);
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  exports.__stack_pointer.value = DYNAMIC_BASE + PAGE;
  const job = DYNAMIC_BASE;
  const work = job + 64;
  const table = job + 256;
  const output = job + 2048;
  const families = Object.values(STANDISH_ORBITS);
  const weights = new Float64Array(memory.buffer, table, 8 * 12);
  families.forEach(({ at, rate }, i) => {
    weights.set(at, i * 12);
    weights.set(rate, i * 12 + 6);
  });
  new Uint32Array(memory.buffer, job, 4).set([table, output, work, 0]);
  const duration = new Float64Array(memory.buffer, job + 16, 1);
  const actual = new Float64Array(memory.buffer, output, 24);
  const epochs = Array.from({ length: 97 }, (_, i) => -2 + (i * 2.5) / 96);
  epochs.push(-Number.EPSILON, 0, Number.EPSILON);

  for (const t of epochs) {
    duration[0] = t;
    const expected = Float64Array.from(families.flatMap(({ at, rate }) => standish(at, rate, t)));
    for (const threads of [1, 2, 4]) {
      for (let part = threads - 1; part >= 0; part--)
        assert.equal(exports.celestial_thread_phase(job, 0, part, threads), 0);
      assert.deepEqual(actual, expected);
      for (const [i, worker] of expectedCelestialWork(threads).workers.entries())
        assert.deepEqual(Array.from(new Float64Array(memory.buffer, work + 24 * i, 3)), Object.values(worker));
    }
  }

  const accepted = actual.slice();
  const receipt = new Float64Array(memory.buffer, work, 3).slice();
  for (const impossible of [Infinity, Number.NaN, -2.5, 0.5001]) {
    duration[0] = impossible;
    assert.equal(exports.celestial_thread_phase(job, 0, 0, 1), 1);
    assert.deepEqual(actual, accepted);
    assert.deepEqual(new Float64Array(memory.buffer, work, 3), receipt);
  }
});

// Standish Table 1 using the archived scalar dynamics and original f64 operation grouping.
function standish(start, rates, t) {
  const rad = Math.PI / 180;
  const [au, eccentricity, i, longitude, perihelion, ascending] = start.map((value, k) => value + rates[k] * t);
  const axis = 149597870700 * au;
  const inclination = rad * i;
  const node = rad * ascending;
  const mean = rad * (longitude - perihelion);
  const circle = 2 * Math.PI;
  const wrapped = ((((mean + Math.PI) % circle) + circle) % circle) - Math.PI;
  let anomaly = wrapped + eccentricity * sin(wrapped);
  for (let step = 0; step < 6; step++)
    anomaly -= (anomaly - eccentricity * sin(anomaly) - wrapped) / (1 - eccentricity * cos(anomaly));
  const xp = axis * (cos(anomaly) - eccentricity);
  const yp = axis * Math.sqrt(1 - eccentricity * eccentricity) * sin(anomaly);
  const peri = rad * perihelion - node;
  const x = cos(peri) * xp - sin(peri) * yp;
  const y = sin(peri) * xp + cos(peri) * yp;
  return [
    cos(node) * x - sin(node) * cos(inclination) * y,
    sin(node) * x + cos(node) * cos(inclination) * y,
    sin(inclination) * y,
  ];
}

test('SPACE-02 native worker options reject unsupported counts and preserve cancellation', async () => {
  await assert.rejects(CelestialSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#celestial/);
  const aborted = new Error('Cancel celestial playback before loading.');
  await assert.rejects(
    CelestialSolver.load({ threads: 4, signal: AbortSignal.abort(aborted) }),
    (cause) => cause === aborted,
  );
});
