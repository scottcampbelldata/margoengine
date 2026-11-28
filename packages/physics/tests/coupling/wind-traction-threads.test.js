import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { tractionWorld } from '../fixtures/wind-traction-world.mjs';

const bytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

test('paired native wind traction matches an analytic pressure/friction/COM wrench and rejects overflow', async () => {
  const file = new URL('../../dist/wind-traction-kernel.wasm', import.meta.url);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536 });
  const { instance } = await WebAssembly.instantiate(await readFile(file), { env: { memory } });
  instance.exports.__stack_pointer.value = 4096;
  const phase = instance.exports.wind_traction_thread_phase;
  const job = 8192;
  const panels = 9000;
  const motion = 9344;
  const output = 9408;
  const receipts = 9480;
  new Uint32Array(memory.buffer, job, 6).set([panels, motion, output, receipts, 3, 1]);
  new Float64Array(memory.buffer, job + 24, 2).set([1.25, 0.0625]);
  const panelData = new Float64Array(memory.buffer, panels, 33);
  panelData.set([
    // Face-on: 1/2 ρA C_N |u|² = 18.75 N x, at positive y => -37.5 N m z.
    0, 2, 0, -1, 0, 0, 5, 0, 0, 1.2, 1,
    // Tangential: 1/2 ρA C_f |u|² = 0.5 N x, at positive z => +1.5 N m y.
    0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 1,
    // Below the calm cutoff; the large area must contribute exactly zero.
    1, 1, 1, -1, 0, 0, 1e-12, 0, 0, 1, 1e11,
  ]);
  assert.equal(phase(job, 0, 0, 1), 0);
  assert.deepEqual(Array.from(new Float64Array(memory.buffer, output, 6)), [19.25, 0, 0, 0, 1.5, -37.5]);
  assert.deepEqual(Array.from(new Uint32Array(memory.buffer, receipts, 3)), [1, 3, 1]);
  panelData[6] = 1e200;
  assert.equal(phase(job, 0, 0, 1), 1);
  assert.deepEqual(Array.from(new Float64Array(memory.buffer, output, 6)), [19.25, 0, 0, 0, 1.5, -37.5]);
});

test('real wind probes preserve the accepted force, torque and rigid replay across one, two and four threads', async () => {
  for (const faces of [1027, 4099]) {
    // The open indexed surface shares a body with a massive 4×4×2 triangle-per-side support collider.
    const panels = faces + 192;
    const expected = await tractionWorld(faces);
    assert.deepEqual(expected.firstSample, [8.25, -8.5, 9.25]);
    assert.ok(expected.first[0] > 0 && expected.first[5] < 0);
    assert.notDeepEqual(bytes(expected.first), bytes(expected.held));
    for (const threads of [1, 2, 4]) {
      const actual = await tractionWorld(faces, threads);
      assert.deepEqual(actual.firstSample, expected.firstSample);
      for (const field of ['first', 'held', 'replayHeld'])
        assert.deepEqual(bytes(actual[field]), bytes(expected[field]), field);
      assert.deepEqual(actual.accepted.bytes, expected.accepted.bytes);
      assert.deepEqual(actual.replay.bytes, actual.accepted.bytes);
      assert.equal(actual.replay.hash, actual.accepted.hash);
      const work = actual.counts;
      assert.equal(work.threads, threads);
      assert.equal(work.probes, 5 * 13);
      assert.equal(work.panels, work.probes * panels);
      assert.equal(work.simdPanelPairs, work.probes * Math.floor(panels / 2));
      assert.deepEqual(
        work.workers.map(({ probes }) => probes),
        Array.from(
          { length: threads },
          (_, id) => 5 * (Math.floor(((id + 1) * 13) / threads) - Math.floor((id * 13) / threads)),
        ),
      );
    }
  }
});
