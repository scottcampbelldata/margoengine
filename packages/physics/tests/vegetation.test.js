import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PlantSway } from '../dist/vegetation.js';
import { moduleBase, worldMemory } from '../dist/world.js';

test('PlantSway is cancellable and the Wasm instance leaves caller memory intact', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled plant setup');
  controller.abort(reason);
  await assert.rejects(PlantSway.load({ signal: controller.signal }), (error) => error === reason);

  for (const shared of [false, true]) {
    const filename = shared ? 'vegetation-kernel-shared.wasm' : 'vegetation-kernel.wasm';
    const module = await WebAssembly.compile(await readFile(new URL('../dist/' + filename, import.meta.url)));
    assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'env', name: 'memory', kind: 'memory' }]);
    const memory = worldMemory(shared);
    const arena = new Uint8Array(memory.buffer).fill(0x6b);
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    assert.equal(instance.exports.__global_base.value, moduleBase(3));
    assert.ok(instance.exports.__stack_pointer instanceof WebAssembly.Global);
    assert.ok(arena.every((value) => value === 0x6b));
  }
});
