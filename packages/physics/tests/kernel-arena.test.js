// The rigid kernel lives in a region of a world memory (docs/physics-framework.md, section 3): its world's block, stack and
// query records are regions of an Arena, the block grows through the arena and moves when it cannot grow in place, and a
// world on a shared arena steps to the bits of one on its own.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { Arena, DYNAMIC_BASE, worldMemory } from '../dist/world.js';

await Physics.load();

/** A floor and a stack of `count` boxes on `arena` (none: an arena of its own). */
function stack(count, arena) {
  const physics = new Physics(null, arena ? { arena } : {});
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const boxes = [];
  for (let i = 0; i < count; i++)
    boxes.push(
      physics.addBody(null, {
        position: [0, 0.5 + i * 1.01, 0],
        colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
      }),
    );
  return { physics, boxes };
}

test("the kernel's world, stack and query records are regions of the arena, above the module windows", () => {
  const arena = new Arena(worldMemory(false)),
    { physics } = stack(3, arena),
    kernel = physics.kernel;
  assert.equal(kernel.memory, arena.memory);
  assert.equal(kernel.arena, arena);
  // 1 MiB of stack, 720 KiB of query records and the world's block: all in the arena.
  assert.ok(arena.used > (1 << 20) + 700_000, `${arena.used} bytes`);
  for (const range of kernel.stateRanges()) {
    assert.ok(range.byteOffset >= DYNAMIC_BASE && range.byteOffset + range.byteLength <= DYNAMIC_BASE + arena.used);
  }
  physics.dispose();
});

test('a second rigid kernel on one memory, or one on a shared memory, is refused before it writes, naming the fix', () => {
  const arena = new Arena(worldMemory(false)),
    { physics } = stack(1, arena),
    used = arena.used;
  assert.throws(
    () => new Physics(null, { arena }),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'state' &&
      /pass another Arena, one per KernelWorld/.test(error.message),
  );
  assert.equal(arena.used, used);
  // A shared memory needs the kernel's threaded build, which is not made yet.
  assert.throws(
    () => new Physics(null, { arena: new Arena(worldMemory(true)) }),
    (error) =>
      error.name === 'MargoError' && error.code === 'unsupported' && /worldMemory\(false\)/.test(error.message),
  );
  physics.dispose();
});

test('a world whose block cannot grow in place moves with its state, and steps on to the bits of one that grew in place', () => {
  const free = stack(4),
    arena = new Arena(worldMemory(false)),
    boxed = stack(4, arena);
  for (let i = 0; i < 30; i++) {
    free.physics.step();
    boxed.physics.step();
  }
  // A region right after the world's block: growing the world now takes a new place and one copy.
  const before = boxed.physics.kernel.stateRanges()[0].byteOffset;
  arena.allocate('neighbour', 64, 'u8', 1);
  for (const world of [free, boxed]) world.physics.kernel.reserve(8192, 8192);
  const after = boxed.physics.kernel.stateRanges()[0].byteOffset;
  assert.notEqual(after, before, 'the block moved');
  assert.equal(boxed.physics.kernel.hash, free.physics.kernel.hash);
  for (let i = 0; i < 60; i++) {
    free.physics.step();
    boxed.physics.step();
  }
  assert.equal(boxed.physics.kernel.hash, free.physics.kernel.hash);
  assert.deepEqual(boxed.boxes[3].position, free.boxes[3].position);
  free.physics.dispose();
  boxed.physics.dispose();
});

test("another region growing the memory between steps leaves the kernel's views reading the world", () => {
  const free = stack(2),
    arena = new Arena(worldMemory(false)),
    shared = stack(2, arena);
  for (let i = 0; i < 20; i++) {
    free.physics.step();
    shared.physics.step();
    // 4 MiB more each step: the memory grows, which detaches every view over it.
    arena.allocate(`grow${i}`, 4 << 20, 'u8', 1);
  }
  assert.equal(shared.physics.kernel.columns.positionY.length, free.physics.kernel.columns.positionY.length);
  assert.deepEqual(shared.boxes[1].position, free.boxes[1].position);
  assert.equal(shared.physics.kernel.hash, free.physics.kernel.hash);
  free.physics.dispose();
  shared.physics.dispose();
});

test("the kernel's slot is no module's, and its built statics lie inside that slot's window", async () => {
  const layout = await import('../../../scripts/physics-modules.mjs'),
    [rigid] = layout.KERNEL_SLOTS.filter((entry) => entry.name === 'rigid'),
    taken = layout.MODULES.map((entry) => entry.slot);
  assert.ok(!taken.includes(rigid.slot), `slot ${rigid.slot} is also a module's`);
  const { physics } = stack(1),
    exports = physics.kernel.api,
    base = layout.globalBase(rigid);
  assert.equal(exports.__global_base.value, base);
  assert.ok(exports.__data_end.value <= base + layout.MODULE_WINDOW, `statics end at ${exports.__data_end.value}`);
  physics.dispose();
});
