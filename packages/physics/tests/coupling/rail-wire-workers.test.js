import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { expectedRailWireWork, railWireRun } from '../fixtures/rail-wire-workers.mjs';

test('native catenary waves follow the discrete pinned-end string eigenmode in both SIMD lanes', async () => {
  const wasm = await readFile(new URL('../../dist/rail-kernel.wasm', import.meta.url));
  const memory = new WebAssembly.Memory({ initial: 18, maximum: 65536 });
  const { instance } = await WebAssembly.instantiate(wasm, { env: { memory } });
  const { __stack_pointer: stack, rail_wire_apply: apply } = instance.exports;
  stack.value = 8192;
  const n = 19,
    intervals = n - 1,
    c2 = 175,
    dt = 1 / 240,
    ticks = 75,
    mode = 3;
  const position = 16384,
    velocity = 16704,
    force = 17024,
    receipt = 17408,
    job = 17432;
  const shape = (i) => (i === 0 || i === intervals ? 0 : Math.sin((Math.PI * mode * i) / intervals));
  const initial = Float64Array.from(
    { length: 2 * n },
    (_, i) => (i % 2 === 0 ? 0.3 : -0.65) * shape(Math.floor(i / 2)),
  );
  const displacement = new Float64Array(memory.buffer, position, initial.length);
  displacement.set(initial);
  new Uint32Array(memory.buffer, job, 6).set([position, velocity, force, receipt, n, intervals]);
  new Float64Array(memory.buffer, job + 24, 4).set([c2, 0.5, 0, dt]);
  for (let i = 0; i < ticks; i++) assert.equal(apply(job), 0);
  const lambda = 4 * c2 * Math.sin((Math.PI * mode) / (2 * intervals)) ** 2;
  const angle = 2 * Math.asin(0.5 * dt * Math.sqrt(lambda));
  // Position advances q(n+1)=(2-dt²λ)q(n)-q(n−1); zero initial kick velocity gives q(1)=(1-dt²λ)q(0).
  const amplitude = (n) => Math.cos(n * angle) - Math.tan(angle / 2) * Math.sin(n * angle);
  const bound = (256 * Number.EPSILON * ticks) / Math.sin(angle);
  const speeds = new Float64Array(memory.buffer, velocity, initial.length);
  for (let i = 0; i < initial.length; i++) {
    assert.ok(Math.abs(displacement[i] - initial[i] * amplitude(ticks)) <= bound);
    assert.ok(Math.abs(speeds[i] - (initial[i] * (amplitude(ticks) - amplitude(ticks - 1))) / dt) <= (2 * bound) / dt);
  }
  assert.deepEqual(Array.from(new Uint32Array(memory.buffer, receipt, 2)), [17, 17]);
  const before = displacement.slice();
  new Float64Array(memory.buffer, force, 2 * n)[2] = Number.MAX_VALUE;
  new Float64Array(memory.buffer, job + 24, 4).set([c2, 2, 0, dt]);
  assert.equal(apply(job), 1);
  assert.deepEqual(displacement, before, ' a failed velocity pass never runs the displacement pass');
});

test('running pantograph and rail wire preserve exact state and signed origins across 1/2/4 native participants', async () => {
  for (const nodes of [1027, 4099]) {
    const reference = await railWireRun(nodes, 1, false);
    assert.equal(reference.coldWork, undefined);
    assert.ok(reference.accepted.contact > 200);
    assert.ok(reference.accepted.position.distance > 42.5);
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const run = !shared ? reference : await railWireRun(nodes, threads, shared);
      assert.deepEqual(run.start.bytes, reference.start.bytes);
      assert.deepEqual(run.accepted.snapshot.bytes, reference.accepted.snapshot.bytes);
      assert.deepEqual(run.replay.snapshot.bytes, run.accepted.snapshot.bytes);
      assert.deepEqual(run.accepted.fields, reference.accepted.fields);
      assert.deepEqual(run.replay.fields, run.accepted.fields);
      assert.deepEqual(run.restoredCells, [run.cell, run.cell]);
      assert.deepEqual(
        run.accepted.fields.map(({ cell }) => cell),
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
      );
      assert.deepEqual(run.accepted.work, expectedRailWireWork(nodes, threads));
      assert.deepEqual(run.replay.work, run.accepted.work);
    }
    console.log('DYN-05 exact rail wire snapshot', nodes, reference.accepted.snapshot.hash, reference.accepted.contact);
  }
});
