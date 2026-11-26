import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspectModule } from '../../../scripts/physics-modules.mjs';
import { GroundwaterSolver } from '../dist/groundwater.js';
import { DYNAMIC_BASE, PhysicsWorld, worldMemory } from '../dist/world.js';

test('groundwater leaves both the rigid slot and every other arena byte untouched on load', async () => {
  for (const shared of [false, true]) {
    const url = new URL(`../dist/groundwater-kernel${shared ? '-shared' : ''}.wasm`, import.meta.url);
    const bytes = await readFile(url);
    const meta = inspectModule(bytes);
    assert.deepEqual(meta.active, []);
    assert.equal(meta.exports.__data_end.value, 0);
    assert.equal(meta.exports.__global_base.value, 0);
    const memory = worldMemory(shared);
    const contents = new Uint8Array(memory.buffer);
    assert.ok(contents.length >= DYNAMIC_BASE);
    contents.fill(0xe6);
    await WebAssembly.instantiate(bytes, { env: { memory } });
    assert.ok(contents.every((word) => word === 0xe6));
  }
});

test('a host without the shared-buffer constructor gets the plain-memory repair', async () => {
  const memory = worldMemory(true);
  const constructor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
  assert.ok(constructor);
  Object.defineProperty(globalThis, 'SharedArrayBuffer', { ...constructor, value: undefined });
  try {
    const solver = await GroundwaterSolver.load();
    const world = new PhysicsWorld({ memory, rate: { num: 60, den: 1 } });
    const grid = { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] };
    assert.throws(() => world.add(solver, { grid }), /choose plain world memory/);
  } finally {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', constructor);
  }
});
