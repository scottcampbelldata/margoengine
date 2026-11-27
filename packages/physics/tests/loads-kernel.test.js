import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const STRIDE = 32;
const COUPLED = STRIDE + 9;
const WRENCH = 6;
const PAGE = 65536;
const START = 18 * PAGE;

async function instance(shared) {
  const suffix = shared ? '-shared' : '';
  const bytes = await readFile(new URL(`../src/loads/loads-kernel${suffix}.wasm`, import.meta.url));
  // f64x2.mul is prefixed opcode 0xfd followed by unsigned LEB128 0xf2, according to Wasm's vector instruction table.
  assert.ok(bytes.includes(Buffer.from([0xfd, 0xf2, 0x01])), 'the emitted kernel uses f64x2 multiplication');
  const memory = new WebAssembly.Memory({ initial: 22, maximum: 65536, shared });
  const mark = new Uint8Array(memory.buffer).fill(0x63);
  const { instance: wasm } = await WebAssembly.instantiate(bytes, { env: { memory } });
  assert.equal(wasm.exports.__global_base.value, 0);
  assert.equal(wasm.exports.__data_end.value, 0);
  assert.ok(mark.every((word) => word === 0x63));
  wasm.exports.__stack_pointer.value = START;
  return {
    memory,
    hold: wasm.exports.loads_hold,
    holdCoupled: wasm.exports.loads_hold_coupled,
    holdCoupledMobility: wasm.exports.loads_hold_coupled_mobility,
  };
}

// The scalar Loads algorithm before batching, retaining the original parenthesization and rounded stores.
function inverse([a, b, c, d, e, f, g, h, i]) {
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

function multiply(matrix, vector, r) {
  return matrix[3 * r] * vector[0] + matrix[3 * r + 1] * vector[1] + matrix[3 * r + 2] * vector[2];
}

function scalar(input, out, gravity) {
  const [row, mass, fx, fy, fz, tx, ty, tz] = input;
  const weight = [0, -mass * gravity, 0];
  const force = [fx + weight[0], fy + weight[1], fz + weight[2]];
  const translational = Array.from(input.slice(8, 17));
  for (let i = 0; i < 3; i++) translational[4 * i] = mass + translational[4 * i];
  const invTranslation = inverse(translational);
  const added = input.slice(17, 26);
  const torque = [tx, ty, tz];
  let heldTorque = torque;
  if (added.some((word) => word !== 0)) {
    const [xx, xy, xz, yy, yz, zz] = input.slice(26, 32);
    const mobility = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
    const system = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        for (let k = 0; k < 3; k++) system[3 * r + c] += added[3 * r + k] * mobility[3 * k + c];
    const invRotation = inverse(system);
    heldTorque = [0, 1, 2].map((r) => multiply(invRotation, torque, r));
  }
  for (let r = 0; r < 3; r++) {
    out[row * WRENCH + r] += mass * multiply(invTranslation, force, r) - weight[r];
    out[row * WRENCH + r + 3] += heldTorque[r];
  }
}

function mix(state) {
  return (Math.imul(1664525, state) + 1013904223) >>> 0;
}

function fixture(count, gravity) {
  const input = new Float64Array(count * STRIDE);
  const initial = new Float64Array(512 * WRENCH).map((_, i) => (i % 17 === 0 ? -0 : (i % 37) / 31));
  const expected = initial.slice();
  let state = 19206011;
  const next = () => {
    state = mix(state);
    return state / 2147483648 - 1;
  };
  for (let i = 0; i < count; i++) {
    const row = (73 * i + 101) % 512;
    const mass = 10 ** ((i % 14) - 5);
    const at = i * STRIDE;
    const candidate = input.subarray(at, at + STRIDE);
    candidate.set([row, mass, 1e4 * next(), i % 13 === 0 ? -0 : 1e4 * next(), 1e4 * next()]);
    candidate.set([1e3 * next(), 1e3 * next(), 1e3 * next()], 5);
    const p = [next(), next(), next()];
    const q = [next(), next(), next()];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        // Rank-one anisotropy added to a diagonal. Every seventh row has no carried water.
        candidate[8 + r * 3 + c] = i % 7 === 0 ? 0 : mass * (p[r] * p[c] + (r === c ? r / 3 : 0));
        candidate[17 + r * 3 + c] = i % 4 === 0 ? 0 : mass * (q[r] * q[c] + (r === c ? c / 2 : 0));
      }
    }
    const dry = [next(), next(), i % 3 === 0 ? 0 : next()];
    for (const [k, r, c] of [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 1, 1],
      [4, 1, 2],
      [5, 2, 2],
    ]) {
      // Match the actual f32 port, including fully and partly axis-locked rows.
      candidate[26 + k] = i % 11 === 0 ? 0 : Math.fround((dry[r] * dry[c]) / mass);
    }
    scalar(candidate, expected, gravity);
  }
  return { expected, initial, input };
}

for (const shared of [false, true]) {
  test(`the ${shared ? 'shared' : 'plain'} SIMD batch is bitwise scalar-equivalent and leaves inactive rows alone`, async () => {
    const { memory, hold } = await instance(shared);
    const count = 321;
    const forceRegion = START + count * STRIDE * 8 + 32;
    for (const gravity of [9.81, 0]) {
      const { input, initial, expected } = fixture(count, gravity);
      const output = new Float64Array(memory.buffer, forceRegion, expected.length);
      new Float64Array(memory.buffer, START, input.length).set(input);
      output.set(initial);
      assert.equal(hold(START, count, forceRegion, 512, gravity), 0, 'one native call computes all 321 active rows');
      assert.deepEqual(
        new BigUint64Array(memory.buffer, forceRegion, expected.length),
        new BigUint64Array(expected.buffer),
      );
      assert.deepEqual(new Float64Array(memory.buffer, START, input.length), input, 'input remains reusable');
      assert.ok(new Uint8Array(memory.buffer, forceRegion - 32, 32).every((word) => word === 0x63));
      // The next step makes fresh views after the host grows or restores the arena.
      memory.grow(1);
      new Float64Array(memory.buffer, forceRegion, initial.length).set(initial);
      assert.equal(hold(START, count, forceRegion, 512, gravity), 0);
      assert.deepEqual(
        new BigUint64Array(memory.buffer, forceRegion, expected.length),
        new BigUint64Array(expected.buffer),
      );
    }
  });
}

test('the native ABI refuses invalid regions and reports the bad input row without writing that row', async () => {
  const { hold, memory } = await instance(false);
  const forces = START + 2 * STRIDE * 8;
  const inWords = new Float64Array(memory.buffer, START, 2 * STRIDE).fill(0);
  const outWords = new Float64Array(memory.buffer, forces, 2 * WRENCH).fill(0);
  inWords.set([0, 8, 14, 20, 0, 2], 0);
  inWords.set([1, 0], STRIDE);
  assert.equal(hold(START + 4, 2, forces, 2, 0), -1, 'input is unaligned');
  assert.equal(hold(START, 2, START + 16, 2, 0), -1, 'regions overlap');
  assert.equal(hold(START, 2, memory.buffer.byteLength - 8, 2, 0), -1, 'output is out of bounds');
  assert.equal(hold(START, 2, forces, 2, -1), -1, 'gravity must be a finite magnitude');
  assert.equal(hold(START, 2, forces, 1, 0), -1, 'the count exceeds the output capacity');
  assert.equal(hold(START, 2, forces, 2, 0), 2, 'the second input has a zero mass');
  assert.deepEqual(Array.from(outWords), [14, 20, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  inWords[STRIDE + 1] = 10;
  inWords[STRIDE + 3] = NaN;
  assert.equal(hold(START, 2, forces, 2, 0), 2, 'the second input is nonfinite');
  assert.deepEqual(Array.from(outWords.slice(WRENCH)), [0, 0, 0, 0, 0, 0]);
});

for (const shared of [false, true]) {
  test(`the ${shared ? 'shared' : 'plain'} SIMD batch holds six coupled motions against a known applied wrench`, async () => {
    const { memory, holdCoupled } = await instance(shared);
    const count = 65;
    const outputRows = 128;
    const forces = START + count * COUPLED * 8 + 64;
    const packed = new Float64Array(memory.buffer, START, count * COUPLED).fill(0);
    const output = new Float64Array(memory.buffer, forces, outputRows * WRENCH).fill(-17);
    const expected = output.slice();
    const relative = 192 * Number.EPSILON;
    const gravity = 9.81;
    for (let i = 0; i < count; i++) {
      const mass = 10 ** ((i % 11) - 4);
      const row = (17 * i + 31) % outputRows;
      const held = [0.5, 1.5 + (i % 9), -2.5, 3.5, -4.5, 5.5].map((value) => value * mass);
      const weight = -mass * gravity;
      const twist = [0.48, -0.52, 0.46, 0.51, 0.54, -0.63];
      const inRotation = i % 5 === 0 ? [0, 0, 0] : [0.21 / mass, 0, 0.7 / mass].map(Math.fround);
      const acceleration = held.map((value, axis) => (axis < 3 ? value / mass : value * inRotation[axis - 3]));
      const added = (r, c) => mass * (twist[r] * twist[c] + (r === c ? (r + 1) * 0.2 : 0));
      const applied = held.map(
        (value, axis) => value + acceleration.reduce((torque, a, c) => torque + a * added(axis, c), 0),
      );
      applied[1] -= weight;
      const input = packed.subarray(i * COUPLED, (i + 1) * COUPLED);
      input.set([row, mass, ...applied]);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          input[8 + 3 * r + c] = added(r, c);
          input[17 + 3 * r + c] = added(r + 3, c + 3);
          input[STRIDE + 3 * r + c] = added(r, c + 3);
        }
      }
      input.set([inRotation[0], 0, 0, inRotation[1], 0, inRotation[2]], 26);
      for (let axis = 0; axis < WRENCH; axis++) expected[row * WRENCH + axis] += held[axis] - (axis === 1 ? weight : 0);
    }

    const initial = packed.slice();
    assert.equal(holdCoupled(START, count, forces, outputRows, gravity), 0, 'one call for every coupled row');
    assert.deepEqual(packed, initial, 'the next step can repack the same region');
    for (const [i, value] of output.entries()) {
      // Three-product mobility and six-equation elimination on well-conditioned manufactured systems.
      const bound = relative * Math.max(1, Math.abs(expected[i] + 17));
      assert.ok(Math.abs(value - expected[i]) <= bound, `word ${i}: ${value} vs ${expected[i]} ± ${bound}`);
    }
    assert.ok(new Uint8Array(memory.buffer, forces - 64, 64).every((word) => word === 0x63));
  });
}

test('a singular six-axis system reports the row without publishing a partial wrench', async () => {
  const { memory, holdCoupled } = await instance(false);
  const forces = START + COUPLED * 8;
  const input = new Float64Array(memory.buffer, START, COUPLED).fill(0);
  const output = new Float64Array(memory.buffer, forces, WRENCH).fill(12);
  input.set([0, 8, 2, 4, 6, 8, 10, 12]);
  input[8] = -8;
  assert.equal(holdCoupled(START, 1, forces, 1, 0), 1);
  assert.deepEqual(output, new Float64Array(WRENCH).fill(12));
  assert.equal(holdCoupled(START, 1, START + 32 * 8, 1, 0), -1, 'the cross block must not overlap the output');
});

test('the coupled kernel uses the selected rigid row and checks the mobility region before writing', async () => {
  const { memory, holdCoupledMobility } = await instance(false);
  const forces = START + COUPLED * 8;
  const mobility = forces + 2 * WRENCH * 8;
  const input = new Float64Array(memory.buffer, START, COUPLED).fill(0);
  const output = new Float64Array(memory.buffer, forces, 2 * WRENCH).fill(0);
  const response = new Float32Array(memory.buffer, mobility, 18).fill(0);
  const block = [2, 2, 0, 2, 2, 0, 0, 0, 0];
  input.set([1, 8, 12, 7, 0, 6, 9, 0]);
  for (const at of [8, 17, 32]) input.set(block, at);
  input[26] = 0.5;
  response.set([0, 0.125, 0.125], 0);
  response.set([0.125, 0, 0.125], 9);
  for (const bad of [mobility + 2, forces, memory.buffer.byteLength - 36]) {
    assert.equal(holdCoupledMobility(START, 1, forces, 2, 0, bad), -1);
    assert.ok(output.every((word) => word === 0));
  }
  response[9] = NaN;
  assert.equal(holdCoupledMobility(START, 1, forces, 2, 0, mobility), 1, 'an invalid selected row is refused');
  assert.ok(output.every((word) => word === 0));
  response[9] = 0.125;
  assert.equal(holdCoupledMobility(START, 1, forces, 2, 0, mobility), 0);
  // (I + 2 u uᵀ D) [8,3,0,2,5,0] = [12,7,0,6,9,0].
  const expected = [0, 0, 0, 0, 0, 0, 8, 3, 0, 2, 5, 0];
  for (const [i, word] of output.entries()) assert.ok(Math.abs(word - expected[i]) < 1e-14);
});
