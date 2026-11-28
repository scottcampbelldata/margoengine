import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dimension = 3;
const pitch = dimension + 2;
const slab = pitch * pitch;
const length = slab * pitch;
const bytes = length * Float64Array.BYTES_PER_ELEMENT;

function cell(x, y, z) {
  return z * slab + y * pitch + x;
}

test('lightning Wasm surfaces an invalid free-node correction in either SIMD lane', async () => {
  for (const shared of [false, true]) {
    const suffix = shared ? '-shared' : '';
    const asset = new URL(`../../dist/lightning-kernel${suffix}.wasm`, import.meta.url);
    const module = await WebAssembly.compile(await readFile(asset));
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared });
    const { relax_potential, __stack_pointer: stack } = new WebAssembly.Instance(module, {
      env: { memory },
    }).exports;
    stack.value = 2 * 65536;

    const offset = 65536;
    const scratch = offset + bytes;
    const forcing = scratch + bytes;
    const maskOffset = forcing + bytes;
    const potential = new Float64Array(memory.buffer, offset, length);
    const mask = new Uint8Array(memory.buffer, maskOffset, length);
    for (const x of [1, 2]) {
      potential.fill(0);
      mask.fill(1);
      mask[cell(x, 2, 2)] = 0;
      // The finite Y and Z neighbours separately overflow their sums with
      // opposite signs. The resulting NaN used to look like zero correction.
      potential[cell(x, 1, 2)] = 1e308;
      potential[cell(x, 3, 2)] = 1e308;
      potential[cell(x, 2, 1)] = -1e308;
      potential[cell(x, 2, 3)] = -1e308;
      assert.equal(relax_potential(offset, scratch, forcing, maskOffset, 3, 3, 3, 1e-6, 1), Infinity);
    }
  }
});
