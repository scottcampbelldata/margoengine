// Virtual shadow map bookkeeping (src/pages.ts), stage 1 of row 21.6: addresses, table slots, the allocator, LRU eviction
// and the invalidation rules, plus VirtualShadows.attach validating options and allocating the pool and table.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PagePool,
  PAGES_PER_SIDE,
  PAGE_INTERIOR,
  ENTRY_VALID,
  basePageSize,
  inWindow,
  pageIndex,
  pageMatrix,
  pageSize,
  tableSlot,
} from '../src/pages.ts';
import { VirtualShadows } from '../dist/virtual.js';
import { Shadows } from '../dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const pool = (options = {}) => new PagePool({ levels: 4, base: 1, poolPages: 2, ...options });

test('page addresses: each level doubles the page, and a camera position names one absolute page', () => {
  const base = basePageSize(500, 8);
  assert.equal(base, 500 / 7 / 128);
  assert.equal(pageSize(base, 7), 500 / 7);
  // Light-space x = 10.3, y = -4.2 with pages of 0.5, 1 and 2.
  assert.deepEqual([pageIndex(10.3, 0.5), pageIndex(-4.2, 0.5)], [20, -9]);
  assert.deepEqual([pageIndex(10.3, 1), pageIndex(-4.2, 1)], [10, -5]);
  assert.deepEqual([pageIndex(10.3, 2), pageIndex(-4.2, 2)], [5, -3]);
});
test('the coarsest window reaches `distance` from the camera wherever it sits in its centre page', () => {
  const distance = 500,
    levels = 8,
    size = pageSize(basePageSize(distance, levels), levels - 1);
  for (const camera of [0, 1, 34.9, 35.8, 71.4, -0.1, -70, 12345.6]) {
    const center = pageIndex(camera, size);
    assert.ok(inWindow(pageIndex(camera + distance * 0.999, size), center), `+ from ${camera}`);
    assert.ok(inWindow(pageIndex(camera - distance * 0.999, size), center), `- from ${camera}`);
  }
});
test('a table slot wraps with the window: pages one window apart share it, pages in one window never do', () => {
  assert.equal(tableSlot(0, 0, 0), 0);
  assert.equal(tableSlot(1, 0, 0), PAGES_PER_SIDE * PAGES_PER_SIDE);
  assert.equal(tableSlot(0, 3, 2), 2 * PAGES_PER_SIDE + 3);
  assert.equal(tableSlot(2, -1, -1), tableSlot(2, PAGES_PER_SIDE - 1, PAGES_PER_SIDE - 1));
  assert.equal(tableSlot(0, 5 + PAGES_PER_SIDE, 7), tableSlot(0, 5, 7));
  const seen = new Set();
  for (let iy = -9; iy < PAGES_PER_SIDE - 9; iy++)
    for (let ix = 40; ix < 40 + PAGES_PER_SIDE; ix++) seen.add(tableSlot(1, ix, iy));
  assert.equal(seen.size, PAGES_PER_SIDE * PAGES_PER_SIDE);
});
test('resident pages never pass the budget, and a budget smaller than the pool leaves its slots unused', () => {
  const p = pool({ poolPages: 4, budgetPages: 5 });
  for (let frame = 0; frame < 20; frame++) {
    p.beginFrame();
    for (let i = 0; i < 3; i++) {
      const slot = p.request(0, frame * 3 + i, 0);
      assert.ok(slot >= 0 && slot < 5);
      assert.ok(p.resident <= 5);
    }
  }
  assert.equal(p.resident, 5);
});
test('eviction takes the least recently requested page, the finer level on a tie, and only when full', () => {
  const p = pool();
  p.beginFrame();
  const a = p.request(0, 0, 0);
  p.beginFrame();
  const b = p.request(1, 0, 0),
    c = p.request(0, 1, 0);
  p.beginFrame();
  const d = p.request(2, 0, 0);
  assert.equal(p.resident, 4);
  p.beginFrame();
  p.request(0, 0, 0); // a is recent again
  p.request(2, 0, 0);
  // Full: of b (level 1) and c (level 0), requested on the same frame, the finer goes first.
  p.request(3, 0, 0);
  assert.equal(p.find(0, 1, 0), -1);
  assert.equal(p.find(1, 0, 0), b);
  assert.equal(p.find(0, 0, 0), a);
  assert.equal(p.find(2, 0, 0), d);
  assert.equal(p.find(3, 0, 0), c, 'the new page took the evicted slot');
});
test('a page requested this frame is never evicted: the extra request reports -1 and counts as overflow', () => {
  const p = pool({ poolPages: 1 });
  p.beginFrame();
  const a = p.request(0, 0, 0);
  assert.equal(p.request(0, 1, 0), -1);
  assert.equal(p.overflow, 1);
  assert.equal(p.find(0, 0, 0), a);
  p.beginFrame();
  assert.equal(p.overflow, 0);
  assert.equal(p.request(0, 1, 0), a, 'next frame the older page can go');
  assert.equal(p.find(0, 0, 0), -1);
});
test('static pages survive an unrelated request: a resident page stays, still cached, when others come', () => {
  const p = pool({ poolPages: 4 });
  p.beginFrame();
  const kept = p.request(2, 3, 4);
  assert.equal(p.stale[kept], 1, 'new pages draw');
  p.stale[kept] = 0;
  for (let frame = 0; frame < 5; frame++) {
    p.beginFrame();
    p.request(0, frame, 0);
    assert.equal(p.find(2, 3, 4), kept);
    assert.equal(p.stale[kept], 0, 'unrelated requests leave it cached');
  }
  p.beginFrame();
  assert.equal(p.request(2, 3, 4), kept, 'requested again: same slot, no redraw');
  assert.equal(p.stale[kept], 0);
});
test('a moved caster marks exactly its pages, guard texels included', () => {
  const p = pool({ poolPages: 4 });
  p.beginFrame();
  const slots = [];
  for (let iy = 0; iy < 3; iy++) for (let ix = 0; ix < 3; ix++) slots.push(p.request(0, ix, iy));
  const far = p.request(1, 100, 100);
  p.stale.fill(0);
  // Pages are 1 x 1. A radius 0.2 circle at (1.5, 1.5) reaches only the centre page (1,1).
  assert.equal(p.invalidateCircle(1.5, 1.5, 0.2), 1);
  assert.equal(p.stale[slots[4]], 1);
  assert.equal(p.stale[far], 0);
  p.stale.fill(0);
  // Across the corner of four pages.
  assert.equal(p.invalidateCircle(1, 1, 0.1), 4);
  for (const i of [0, 1, 3, 4]) assert.equal(p.stale[slots[i]], 1);
  p.stale.fill(0);
  // Outside page (1,1) by less than one guard texel: its guard band holds this caster, so it redraws too.
  const guard = 1 / PAGE_INTERIOR;
  assert.equal(p.invalidateCircle(2 + guard / 4, 1.5, 0), 2);
  assert.equal(p.stale[slots[4]], 1);
  assert.equal(p.stale[slots[5]], 1);
  p.stale.fill(0);
  assert.equal(p.touchCircle(1.5, 1.5, 0.2), 1);
  assert.equal(p.touched[slots[4]], 1);
  p.beginFrame();
  assert.equal(p.touched[slots[4]], 0);
  assert.equal(p.touchedBefore[slots[4]], 1, 'last frame stays known, so its old depth gets cleaned');
});
test('invalidateAll marks every resident page and no empty slot', () => {
  const p = pool({ poolPages: 4 });
  p.beginFrame();
  const a = p.request(0, 0, 0),
    b = p.request(1, 0, 0);
  p.stale.fill(0);
  p.invalidateAll();
  assert.equal(p.stale[a] + p.stale[b], 2);
  assert.equal(
    p.stale.reduce((sum, v) => sum + v),
    2,
  );
});
test('the table lists resident pages inside their window; a page outside it stays resident but unmapped', () => {
  const p = pool({ poolPages: 4 }),
    table = new Uint32Array(4 * PAGES_PER_SIDE * PAGES_PER_SIDE);
  p.beginFrame();
  const inside = p.request(1, 3, -2),
    outside = p.request(1, 3 + PAGES_PER_SIDE, -2);
  const centers = new Int32Array(8);
  p.writeTable(table, centers);
  assert.equal(table[tableSlot(1, 3, -2)] & 0xffff, (inside % 4) | (Math.floor(inside / 4) << 8));
  assert.ok(table[tableSlot(1, 3, -2)] & ENTRY_VALID);
  assert.equal(table.filter(Boolean).length, 1);
  centers[2] = PAGES_PER_SIDE + 3;
  p.writeTable(table, centers);
  assert.equal(table[tableSlot(1, 3, -2)] & 0xffff, (outside % 4) | (Math.floor(outside / 4) << 8));
  assert.equal(p.find(1, 3, -2), inside, 'still resident: coming back needs no redraw');
});
test('a page matrix maps the page square, guard included, onto clip space', () => {
  const m = pageMatrix(new Float32Array(16), [1, 0, 0], [0, 1, 0], [0, 0, 1], -10, 40, 2, 3, -1);
  const clip = (x, y, z) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
  const guard = 2 / PAGE_INTERIOR;
  const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${a} vs ${b}`));
  // Page (3,-1) of size 2 spans x 6..8, y -2..0. Row 0 of the page is the smallest y, at clip y +1.
  close(clip(6 - guard, -2 - guard, -10), [-1, 1, 0]);
  close(clip(8 + guard, 0 + guard, 30), [1, -1, 1]);
  close(clip(7, -1, 10), [0, 0, 0.5]);
});
test('VirtualShadows validates its options with the fix in the message', () => {
  for (const options of [
    { distance: 0 },
    { levels: 0 },
    { levels: 17 },
    { levels: 1.5 },
    { poolSize: 100 },
    { poolSize: 128 * 3 },
    { budgetPages: 0 },
    { poolSize: 256, budgetPages: 5 },
    { lightSize: -1 },
    { bias: Number.NaN },
    { normalBias: -1 },
    { casterMargin: Infinity },
  ])
    assert.throws(() => new VirtualShadows(options), RangeError, JSON.stringify(options));
  assert.throws(() => new VirtualShadows({ filter: 'fuzzy' }), RangeError);
});
test('attach allocates the pool and one table layer per level; dispose destroys them', () => {
  const { device } = mockGPU(),
    textures = [],
    createTexture = device.createTexture.bind(device);
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    textures.push({ descriptor, texture });
    return texture;
  };
  const shadows = new VirtualShadows({ levels: 6, poolSize: 2048 });
  shadows.setup({ gpu: device, lighting: { direction: [0, 1, 0] }, removePlugin() {}, sceneOf() {} });
  const pools = textures.filter((t) => t.descriptor.format === 'depth32float'),
    table = textures.find((t) => t.descriptor.format === 'r32uint');
  assert.deepEqual(pools[0].descriptor.size, [2048, 2048]);
  assert.deepEqual(table.descriptor.size, [PAGES_PER_SIDE, PAGES_PER_SIDE, 6]);
  assert.equal(shadows.stats.residentPages, 0);
  assert.equal(shadows.memoryBytes, 2 * 2048 * 2048 * 4 + PAGES_PER_SIDE * PAGES_PER_SIDE * 6 * 4);
  shadows.dispose();
  assert.throws(() => shadows.bindings(), /not attached/);
});
test('importing the virtual entry leaves the root entry whole: both load side by side', () => {
  assert.equal(typeof Shadows, 'function');
  assert.equal(typeof VirtualShadows, 'function');
  assert.notEqual(new VirtualShadows().name, new Shadows().name);
});
test('feedback bits decode through the window they were marked in, with dilation and the coarsest ancestor first', () => {
  const p = new PagePool({ levels: 3, base: 1, poolPages: 16 }),
    bits = new Uint32Array((3 * PAGES_PER_SIDE * PAGES_PER_SIDE) / 32),
    seen = new Int32Array([20, -3, 0, 0, 0, 0]),
    mark = (level, ix, iy) => {
      const slot = tableSlot(level, ix, iy);
      bits[slot >>> 5] |= 1 << (slot & 31);
    };
  mark(0, 25, -9);
  p.beginFrame();
  p.requestFeedback(bits, seen, seen);
  // Nine pages around (25, -9) on level 0, one ancestor (25 >> 2, -9 >> 2) on level 2.
  assert.deepEqual(Array.from(p.requested), [9, 0, 1]);
  assert.ok(p.find(0, 25, -9) >= 0 && p.find(0, 24, -10) >= 0 && p.find(0, 26, -8) >= 0);
  assert.ok(p.find(2, 6, -3) >= 0);
  // The window moved on: a page outside the current window is not asked for.
  const moved = new Int32Array([20 + PAGES_PER_SIDE, -3, 0, 0, 0, 0]);
  p.beginFrame();
  p.requestFeedback(bits, seen, moved);
  assert.deepEqual(Array.from(p.requested), [0, 0, 1]);
});
test('a full budget keeps the coarser requests: fine pages overflow first', () => {
  const p = new PagePool({ levels: 3, base: 1, poolPages: 2 }),
    bits = new Uint32Array((3 * PAGES_PER_SIDE * PAGES_PER_SIDE) / 32),
    seen = new Int32Array(6);
  for (const [level, ix, iy] of [
    [0, 0, 0],
    [1, 4, 4],
  ]) {
    const slot = tableSlot(level, ix, iy);
    bits[slot >>> 5] |= 1 << (slot & 31);
  }
  p.beginFrame();
  p.requestFeedback(bits, seen, seen);
  assert.equal(p.resident, 4);
  assert.ok(p.overflow > 0);
  assert.ok(p.find(2, 0, 0) >= 0 && p.find(2, 2, 2) >= 0, 'both ancestors');
  assert.equal(p.find(0, 0, 0), -1);
});
test('requestCircle takes the pages a caster reaches, clipped to the window', () => {
  const p = pool({ poolPages: 16, levels: 1 }),
    centers = [0, 0];
  p.beginFrame();
  p.requestCircle(0, 0.5, 0.5, 0.1, centers);
  assert.equal(p.requested[0], 1);
  p.beginFrame();
  p.requestCircle(0, 0, 0, 0.1, centers);
  assert.equal(p.requested[0], 4);
  p.beginFrame();
  p.requestCircle(0, 7.5, 0.5, 3, centers);
  assert.ok(p.find(0, 8, 0) === -1, 'the window ends at page 7');
});
