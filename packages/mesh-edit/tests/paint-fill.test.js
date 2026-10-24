import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../dist/index.js';
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function scene() {
  const mesh = engine.createPrimitiveMesh('plane', 'wide');
  mesh.faces[0].uv = [
    [1 / 256, 1 / 16],
    [255 / 256, 1 / 16],
    [255 / 256, 15 / 16],
    [1 / 256, 15 / 16],
  ];
  return {
    objects: [{ ...mesh, id: 'wide', worldMatrix: matrix, canPaint: true, canProject: true, canMirror: false }],
    texture: { width: 256, height: 16, pixels: Array(256 * 16 * 4).fill(0) },
  };
}
const rgba = (atlas, x, y) => atlas.pixels.slice((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4);
test('whole-face fill reaches both ends of an island wider than the dab limit and dilates its edge', () => {
  const input = scene(),
    before = structuredClone(input),
    target = { objectId: 'wide', faceId: input.objects[0].faces[0].id };
  const out = engine.fillMeshPaintFaces(input, [target, target], '#e89054');
  assert.deepEqual(rgba(out, 10, 8), [232, 144, 84, 255]);
  assert.deepEqual(rgba(out, 240, 8), [232, 144, 84, 255]);
  assert.deepEqual(rgba(out, 0, 8), [232, 144, 84, 255]);
  assert.deepEqual(input, before);
});
test('whole-face fill retains locked shared owners and supports exact dither/transparent RGB', () => {
  const input = scene(),
    peer = structuredClone(input.objects[0]);
  peer.id = 'locked';
  peer.canPaint = false;
  peer.faces[0].id = 'locked-face';
  peer.faces[0].uv = [
    [220 / 256, 4 / 16],
    [240 / 256, 4 / 16],
    [240 / 256, 12 / 16],
    [220 / 256, 12 / 16],
  ];
  input.objects.push(peer);
  const target = { objectId: 'wide', faceId: input.objects[0].faces[0].id },
    out = engine.fillMeshPaintFaces(input, [target], '#123456', { mode: 'dither', secondaryColor: '#abcdef' });
  assert.deepEqual(rgba(out, 230, 8), [0, 0, 0, 0]);
  assert.deepEqual(rgba(out, 10, 8), [18, 52, 86, 255]);
  assert.deepEqual(rgba(out, 11, 8), [171, 205, 239, 255]);
  const transparent = engine.fillMeshPaintFaces(input, [target], '#12345600', {
    mode: 'dither',
    secondaryColor: '#abcdef',
  });
  assert.deepEqual(rgba(transparent, 11, 8), [18, 52, 86, 0]);
});
test('fill rejects stale targets and malformed commands atomically; empty and ineligible fills are no-ops', () => {
  const input = scene(),
    before = structuredClone(input),
    target = { objectId: 'wide', faceId: input.objects[0].faces[0].id };
  for (const targets of [
    null,
    [target, { objectId: 'wide', faceId: 'missing' }],
    [{ objectId: 'missing', faceId: 'missing' }],
  ]) {
    assert.throws(() => engine.fillMeshPaintFaces(input, targets, '#fff'));
    assert.deepEqual(input, before);
  }
  assert.throws(() => engine.fillMeshPaintFaces(input, [target], 'invalid'));
  assert.throws(() => engine.fillMeshPaintFaces(input, [target], '#fff', { mode: 'bad' }));
  assert.equal(engine.fillMeshPaintFaces(input, [], '#fff'), null);
  input.objects[0].canPaint = false;
  assert.equal(engine.fillMeshPaintFaces(input, [target], '#fff'), null);
});
