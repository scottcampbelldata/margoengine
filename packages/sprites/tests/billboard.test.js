// Node checks of the CPU side of @margoengine/sprites/billboard: the buffer layout, change ranges, sorting and errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Billboard, BillboardLayer, BILLBOARD_FLOATS, packBillboards, sortBillboards } from '../dist/billboard.js';

const atlas = { width: 16, height: 16, data: new Uint8Array(1024) };
const pack = (boards, data = new Float32Array(boards.length * BILLBOARD_FLOATS)) => ({
  data,
  ...packBillboards(boards, data, 16, 16),
});

test('the buffer layout: 16 floats of position, turn, size, pivot, signed rectangle and tint bytes', () => {
  assert.equal(BILLBOARD_FLOATS, 16);
  const { data, count } = pack([
    new Billboard({ x: 1, y: 2, z: 3, rotation: 0.5, width: 4, height: 2, pivotY: 1, rect: [4, 8, 2, 3], tint: 0x102030, alpha: 1 }),
  ]);
  assert.equal(count, 1);
  assert.deepEqual([...data.subarray(0, 12)], [1, 2, 3, 0.5, 4, 2, 0.5, 1, 4, 8, 2, 3]);
  assert.deepEqual([...new Uint8Array(data.buffer, 48, 4)], [0x10, 0x20, 0x30, 0xff], 'red is the low byte');
});

test('defaults: unit size, centred pivot, the whole atlas; a flip moves the origin and negates the size', () => {
  const { data } = pack([new Billboard(), new Billboard({ rect: [1, 2, 3, 4], flipX: true, flipY: true })]);
  assert.deepEqual([...data.subarray(4, 12)], [1, 1, 0.5, 0.5, 0, 0, 16, 16]);
  assert.deepEqual([...data.subarray(24, 28)], [4, 6, -3, -4]);
});

test('hidden billboards are skipped and only changed floats are reported', () => {
  const a = new Billboard({ x: 1 }),
    b = new Billboard({ x: 2, visible: false }),
    c = new Billboard({ x: 3 });
  const first = pack([a, b, c]);
  assert.equal(first.count, 2);
  assert.equal(first.data[BILLBOARD_FLOATS], 3, 'c follows a directly');
  const again = packBillboards([a, b, c], first.data, 16, 16);
  assert.equal(again.start, again.end, 'nothing changed');
  c.y = 5;
  const moved = packBillboards([a, b, c], first.data, 16, 16);
  assert.deepEqual([moved.start, moved.end], [BILLBOARD_FLOATS + 1, BILLBOARD_FLOATS + 2]);
});

test('invalid billboards throw RangeError naming the field group', () => {
  for (const bad of [{ x: NaN }, { width: 0 }, { height: -1 }, { alpha: 2 }, { rotation: Infinity }])
    assert.throws(() => pack([new Billboard(bad)]), { name: 'RangeError', message: /Invalid billboard/ });
  for (const rect of [[0, 0, 17, 1], [0.5, 0, 1, 1], [0, 0, 0, 1], [-1, 0, 1, 1]])
    assert.throws(() => pack([new Billboard({ rect })]), { message: /Invalid billboard rect/ });
  assert.throws(() => new Billboard({ tint: '#12' }), TypeError);
});

test('sortBillboards puts the farthest first and keeps add order for equal distances', () => {
  const layer = new BillboardLayer({ atlas, transparent: true });
  const near = layer.add({ z: 4 }),
    far = layer.add({ z: -4 }),
    tieA = layer.add({ x: 1 }),
    tieB = layer.add({ x: -1 });
  const list = [near, tieB, far, tieA];
  sortBillboards(list, [0, 0, 5]);
  assert.deepEqual(list, [far, tieA, tieB, near]);
});

test('the layer: options, add and remove, a billboard in one layer only, dispose', () => {
  assert.throws(() => new BillboardLayer({}), TypeError);
  assert.throws(() => new BillboardLayer({ atlas, capacity: 0 }), RangeError);
  assert.throws(() => new BillboardLayer({ atlas, alphaTest: 1.5 }), RangeError);
  assert.throws(() => new BillboardLayer({ atlas, order: NaN }), RangeError);
  const layer = new BillboardLayer({ atlas });
  assert.equal(layer.sizeAttenuation, true);
  assert.equal(layer.lockY, false);
  assert.equal(layer.transparent, false);
  assert.equal(layer.alphaTest, 0.5);
  assert.match(layer.name, /^billboards-\d+$/);
  const b = layer.add({ x: 1 });
  assert.ok(b instanceof Billboard);
  assert.throws(() => new BillboardLayer({ atlas }).add(b), { code: 'attached' });
  assert.equal(layer.remove(b), true);
  assert.equal(layer.remove(b), false);
  layer.add(b);
  layer.clearBillboards();
  assert.equal(layer.billboards.length, 0);
  layer.dispose();
  assert.throws(() => layer.add(), { code: 'disposed' });
  assert.throws(() => layer.setup({ backend: 'webgpu' }), { code: 'disposed' });
  assert.throws(() => new BillboardLayer({ atlas }).setup({ backend: 'webgl2' }), { code: 'unsupported' });
});
