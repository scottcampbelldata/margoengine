import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { worldMemory } from '../../dist/world.js';

for (const shared of [false, true]) {
  test(`the ${shared ? 'shared' : 'plain'} acoustic SIMD stencil keeps finite extreme pressure and rejects a true overflow`, async () => {
    const variant = shared ? '-shared' : '';
    const bytes = await readFile(new URL(`../../dist/room-sound-kernel${variant}.wasm`, import.meta.url));
    const module = await WebAssembly.compile(bytes);
    const memory = worldMemory(shared);
    const { exports } = new WebAssembly.Instance(module, { env: { memory } });
    const { acoustic_wave: wave, __stack_pointer: stack } = exports;
    stack.value = memory.buffer.byteLength;

    const row = 6;
    const plane = 24;
    const count = 120;
    const addresses = [0, count, count * 2, count * 5, count * 5 + 1].map((words) => 8 * words);
    const current = new Float64Array(memory.buffer, addresses[0], count);
    const previous = new Float64Array(memory.buffer, addresses[1], count);
    const coefficients = new Float64Array(memory.buffer, addresses[2], count * 3);
    const trace = new Float64Array(memory.buffer, addresses[4], 1);
    const active = new Uint8Array(count);
    const solid = 58;
    const tap = 57;
    const p = 2 ** 1023;
    for (let z = 1; z <= 3; z++) {
      for (let y = 1; y <= 2; y++) {
        for (let x = 1; x <= 4; x++) {
          const i = z * plane + y * row + x;
          if (i !== solid) active[i] = 1;
        }
      }
    }
    for (let i = 0; i < count; i++) {
      if (!active[i]) continue;
      const open =
        active[i - 1] + active[i + 1] + active[i - row] + active[i + row] + active[i - plane] + active[i + plane];
      current[i] = p;
      previous[i] = p;
      coefficients[i] = 2 - 0.25 * open;
      coefficients[count + i] = -1;
      coefficients[2 * count + i] = 1;
    }
    // A very strong passive damper has a bounded (D-1)/(1+D) despite overflowing
    // the unscaled coefficient times the old pressure.
    coefficients[count + tap] = 2 ** 512;
    coefficients[2 * count + tap] = 2 ** -512;
    const step = () => wave(...addresses, count, row, plane, tap, tap, 1, 0.25);
    assert.equal(step(), 0);
    assert.equal(trace[0], p);
    assert.equal(previous[solid], 0);
    assert.equal(previous[56], p);

    // The same closed room, with an opposite old pressure, has a true 3p endpoint.
    coefficients[count + tap] = -1;
    coefficients[2 * count + tap] = 1;
    previous[tap] = -p;
    trace[0] = 0;
    assert.equal(step(), 1);
    assert.equal(trace[0], 0);
  });
}
