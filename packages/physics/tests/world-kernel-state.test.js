// The rigid kernel's state as framework regions: the ranges the kernel names are exactly the words its own hash covers, so the
// framework's state hash over them and the kernel's hash move together on every state word and on nothing else.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { stateHash } from '../dist/world.js';

await Physics.load();

function world() {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  for (let i = 0; i < 6; i++)
    physics.addBody(null, {
      position: [i * 0.3, 1 + i, 0],
      colliders: { shape: i % 2 ? 'sphere' : 'box', radius: 0.3, halfExtents: [0.3, 0.3, 0.3] },
    });
  for (let i = 0; i < 30; i++) physics.step();
  const kernel = physics.kernel;
  const regions = kernel
    .stateRanges()
    .map((range, i) => ({ name: `range${i}`, ...range, type: 'u32', layout: 1, memory: kernel.memory }));
  const solver = { describe: () => ({ id: 'rigid' }), stateRegions: () => regions, extraState: () => [] };
  const scratchMemory = new WebAssembly.Memory({ initial: 1 });
  return { physics, kernel, regions, frameworkHash: () => stateHash(scratchMemory, [solver]) };
}

test('the state ranges lie in the arena, in order, without overlap, and cover what the kernel hash covers', () => {
  const { physics, kernel, regions } = world();
  const base = kernel.stateRanges()[0].byteOffset;
  let end = 0;
  for (const region of regions) {
    assert.ok(region.byteOffset % 4 === 0 && region.byteLength % 4 === 0, 'whole words');
    assert.ok(region.byteOffset >= end, 'in order, no overlap');
    end = region.byteOffset + region.byteLength;
  }
  assert.ok(end <= base + kernel.bytes, 'inside the arena');
  physics.dispose();
});

/**
 * Every word between the first state range and the end of the last that no range covers: the header's padding, the walk stamp
 * and the scratch columns between state columns. The layout words before the first range are left alone (flipping them moves
 * the columns themselves).
 */
function nonState(kernel) {
  const ranges = kernel.stateRanges(),
    covered = new Set();
  for (const { byteOffset, byteLength } of ranges)
    for (let at = byteOffset; at < byteOffset + byteLength; at += 4) covered.add(at);
  const first = ranges[0].byteOffset,
    last = Math.max(...ranges.map(({ byteOffset, byteLength }) => byteOffset + byteLength)),
    words = [];
  for (let at = first; at < last; at += 4) if (!covered.has(at)) words.push(at);
  return words;
}

test('flipping a scratch, padding or stamp word changes neither hash; flipping any state word changes both', () => {
  const { physics, kernel, regions, frameworkHash } = world();
  const words = new Uint32Array(kernel.memory.buffer);
  const kernelBefore = kernel.hash,
    frameworkBefore = frameworkHash();
  const outside = nonState(kernel);
  assert.ok(outside.length > 100, `the arena has words outside its state (${outside.length})`);
  for (let i = 0; i < outside.length; i += Math.max(1, Math.floor(outside.length / 400))) {
    const at = outside[i] / 4;
    words[at] ^= 0x5a5a5a5a;
    assert.equal(kernel.hash, kernelBefore, `the kernel hash moved on non-state byte ${outside[i]}`);
    assert.equal(frameworkHash(), frameworkBefore, `the framework hash moved on non-state byte ${outside[i]}`);
    words[at] ^= 0x5a5a5a5a;
  }
  let flipped = 0;
  for (const region of regions)
    for (
      let at = region.byteOffset;
      at < region.byteOffset + region.byteLength;
      at += 4 * Math.max(1, Math.floor(region.byteLength / 16))
    ) {
      words[at / 4] ^= 1;
      assert.notEqual(kernel.hash, kernelBefore, `the kernel hash missed state byte ${at}`);
      assert.notEqual(frameworkHash(), frameworkBefore, `the framework hash missed state byte ${at}`);
      words[at / 4] ^= 1;
      flipped++;
    }
  assert.ok(flipped > 200, `${flipped} state words tried`);
  assert.equal(kernel.hash, kernelBefore);
  assert.equal(frameworkHash(), frameworkBefore);
  physics.dispose();
});
