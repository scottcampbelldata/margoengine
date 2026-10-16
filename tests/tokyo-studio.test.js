import test from 'node:test';
import assert from 'node:assert/strict';
import { studioCube } from '../examples/tokyo-studio.js';

const mean = (face) => {
  let sum = 0;
  for (let i = 0; i < face.length; i += 4) sum += face[i];
  return sum / (face.length / 4);
};

test('six finite RGBA faces in CubeFaces layout', () => {
  const cube = studioCube();
  assert.equal(cube.size, 64);
  assert.equal(cube.faces.length, 6);
  for (const face of cube.faces) {
    assert.equal(face.length, 64 * 64 * 4);
    for (let i = 0; i < face.length; i++) assert.ok(Number.isFinite(face[i]) && face[i] >= 0);
    for (let i = 3; i < face.length; i += 4) assert.equal(face[i], 1);
  }
});

test('lit like a studio: bright ceiling softbox, darker floor', () => {
  const [, , ceiling, floor] = studioCube(32).faces;
  assert.ok(mean(ceiling) > mean(floor) * 3);
  assert.ok(Math.max(...ceiling) >= 5, 'ceiling softbox missing');
});

test('rejects sizes that are not a power of two', () => {
  assert.throws(() => studioCube(48), RangeError);
  assert.throws(() => studioCube(4), RangeError);
});
