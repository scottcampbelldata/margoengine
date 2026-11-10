import test from 'node:test';
import assert from 'node:assert/strict';
import { setLineCameraTile } from '@margoengine/lines/tiles';
import { Line } from '@margoengine/lines';
import { rig } from './gpu-rig.js';
const frameUniform = (log) => {
  const written = log.find((e) => e[0] === 'writeBuffer' && e[3].length === 224);
  return new Float32Array(Uint8Array.from(Buffer.from(written[3], 'hex')).buffer);
};

test('capture frame uses the uncropped projection and full pixel density, with an isolated removable tile transform', () => {
  const { camera, lines, frame } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0] }));
  const original = camera.matrix.slice(),
    before = frameUniform(frame());
  const options = { matrix: original, fullWidth: 256, fullHeight: 128, x: 64, y: 0, width: 64, height: 64 };
  const remove = setLineCameraTile(camera, options);
  original.fill(0);
  camera.matrix[0] = 100;
  const captured = frameUniform(frame());
  assert.deepEqual([...captured.subarray(0, 16)], [...before.subarray(0, 16)]);
  assert.deepEqual([...captured.subarray(16, 19)], [256, 128, 4]);
  assert.equal(captured[21], 1);
  assert.deepEqual([...captured.subarray(24)], [4, 2, 1, -1]);
  remove();
  remove();
  const after = frameUniform(frame());
  assert.equal(after[0], 100);
  assert.equal(after[21], 0);
  assert.deepEqual([...after.subarray(24)], [1, 1, 0, 0]);
  lines.dispose();
});

test('invalid tile state rejects before publication, and an older remover cannot erase its replacement', () => {
  const { camera, lines, frame } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0] }));
  const tile = { matrix: camera.matrix, fullWidth: 256, fullHeight: 128, x: 64, y: 0, width: 64, height: 64 };
  for (const change of [{ width: 0 }, { x: -1 }, { x: 240 }, { matrix: [] }, { fullHeight: Infinity }])
    assert.throws(() => setLineCameraTile(camera, { ...tile, ...change }), RangeError);
  const old = setLineCameraTile(camera, tile),
    current = setLineCameraTile(camera, { ...tile, x: 0 });
  old();
  assert.equal(frameUniform(frame())[26], 3);
  current();
  assert.equal(frameUniform(frame())[21], 0);
  lines.dispose();
});
