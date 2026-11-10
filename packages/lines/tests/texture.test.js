import test from 'node:test';
import assert from 'node:assert/strict';
import { LineTexture, TexturedLine, loadLineTexture } from '../dist/texture.js';
import { rig } from './gpu-rig.js';

const rgba = new Uint8Array([255, 0, 0, 255]);
test('texture owns its pixels and validates dimensions, repeat and alpha cutoff', () => {
  for (const [w, h, p] of [
    [0, 1, rgba],
    [1.5, 1, rgba],
    [1, 1, new Uint8Array(3)],
    [16385, 1, rgba],
  ])
    assert.throws(() => new LineTexture(w, h, p), RangeError);
  const texture = new LineTexture(1, 1, rgba);
  for (const options of [
    { repeat: NaN },
    { repeatAcross: Infinity },
    { offset: [1] },
    { alphaCutoff: -1 },
    { alphaCutoff: 2 },
  ])
    assert.throws(() => new TexturedLine({ texture, ...options }), RangeError);
  assert.throws(() => new TexturedLine({ texture: null }), TypeError);
});

test('texture resources compose with stroke, stay lazy, use unwrapped derivatives and release', () => {
  const { lines, frame, gpu } = rig();
  const pixels = rgba.slice(),
    texture = new LineTexture(1, 1, pixels);
  pixels.fill(0);
  const line = lines.add(
    new TexturedLine({ texture, positions: [0, 0, 0, 2, 0, 0], widths: [0.5, 2], progress: 0.5, repeat: 2 }),
  );
  const log = frame(),
    module = log.find((row) => row[0] === 'module')[2].code;
  assert.match(module, /textureSampleGrad/);
  assert.ok(module.indexOf('let texel=') < module.indexOf('if(stroke.params.x'));
  assert.match(module, /stroke.widths\[ia\]/);
  assert.ok(log.some((row) => row[0] === 'writeTexture' && JSON.stringify(row).includes('ff0000ff')));
  assert.equal(lines.stats.drawCalls, 1);
  line.repeat = -2;
  line.offset[0] = 0.25;
  frame();
  line.repeat = NaN;
  assert.throws(() => frame(), RangeError);
  line.repeat = 1;
  const released = gpu.record(() => lines.remove(line));
  assert.ok(released.filter((row) => row[0] === 'destroy').length >= 6);
});

test('aborted image loads preserve their exact reason before decoding or fetching', async () => {
  const controller = new AbortController(),
    reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(
    loadLineTexture('https://example.invalid/image.png', { signal: controller.signal }),
    (e) => e === reason,
  );
});
