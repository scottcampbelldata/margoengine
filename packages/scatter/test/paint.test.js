import test from 'node:test';
import assert from 'node:assert/strict';
import { DensityBrush } from '../dist/paint.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
const bounds = [-10, -10, 10, 10];
const gpu = () => {
  const writes = [];
  return {
    writes,
    createTexture: (d) => ({
      ...d,
      destroyed: 0,
      destroy() {
        this.destroyed++;
      },
    }),
    queue: { writeTexture: (target, data, layout, size) => writes.push({ target, data, layout, size }) },
  };
};
test('a stroke raises the centre, fades to the edge, clamps, and erases with a negative strength', () => {
  const brush = new DensityBrush({ bounds, resolution: 20 });
  brush.paint(0, 0, { radius: 5, strength: 0.5, hardness: 0 });
  assert.ok(brush.at(0, 0) > 0.4);
  assert.ok(brush.at(3, 0) < brush.at(1, 0));
  assert.equal(brush.at(6, 0), 0);
  assert.equal(brush.at(99, 0), 0);
  for (let i = 0; i < 5; i++) brush.paint(0, 0, { radius: 5, hardness: 1 });
  assert.equal(brush.at(0, 0), 1, 'no wrap past 255');
  for (let i = 0; i < 3; i++) brush.paint(0, 0, { radius: 5, strength: -1, hardness: 1 });
  assert.equal(brush.at(0, 0), 0, 'no wrap below 0');
});
test('row 0 is minZ, and a stroke off the map changes nothing', () => {
  const brush = new DensityBrush({ bounds, resolution: [20, 10] });
  brush.paint(-9.5, -9, { radius: 0.9, hardness: 1 });
  assert.equal(brush.data[0], 255);
  const before = brush.data.slice();
  brush.paint(100, 100, { radius: 1 });
  assert.deepEqual(brush.data, before);
});
test('only the changed rectangle uploads, merged between reads, and nothing when nothing changed', () => {
  const brush = new DensityBrush({ bounds, resolution: 20 }),
    device = gpu();
  const texture = brush.texture(device);
  assert.equal(texture.format, 'r8unorm');
  assert.deepEqual(device.writes.at(-1).size, [20, 20], 'the first read uploads everything');
  assert.equal(brush.texture(device), texture);
  assert.equal(device.writes.length, 1);
  brush.paint(0, 0, { radius: 1 });
  brush.paint(2, 0, { radius: 1 });
  brush.texture(device);
  const { size, target, layout } = device.writes.at(-1);
  assert.deepEqual(target.origin, [9, 9]);
  assert.deepEqual(size, [4, 2]);
  assert.equal(layout.bytesPerRow, 20);
  assert.equal(layout.offset, 9 * 20 + 9);
  brush.dispose();
  assert.equal(texture.destroyed, 1);
});
test('a splat channel becomes the density, sampled to the brush size', () => {
  const brush = new DensityBrush({ bounds, resolution: 2 });
  brush.fromSplat([0, 200, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 255, 255, 0], 2, 2, [0, 1, 0.5, 0]);
  assert.deepEqual([...brush.data], [200, 0, 100, 255]);
  assert.throws(() => brush.fromSplat([1], 2, 2, [1, 0, 0, 0]), /splat/);
});
test('bad options throw RangeErrors that name the fix', () => {
  for (const options of [
    { bounds: [0, 0, 0, 1] },
    { bounds, resolution: 0 },
    { bounds, resolution: 9000 },
    { bounds, fill: 2 },
  ])
    assert.throws(() => new DensityBrush(options), /Invalid DensityBrush/);
  const brush = new DensityBrush({ bounds });
  for (const stroke of [{ radius: 0 }, { radius: 1, strength: 2 }, { radius: 1, hardness: 2 }])
    assert.throws(() => brush.paint(0, 0, stroke), /density stroke/);
});
