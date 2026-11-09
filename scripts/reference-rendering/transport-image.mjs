import assert from 'node:assert/strict';
import { pbrNeutral } from '../../packages/shared/display.js';
import { srgbByte } from '../../packages/oit/scripts/oit-scene.mjs';

/** Batch 168's raw, top-down scene-linear contract, with the declared neutral/sRGB display transform. */
export function displayImage(bytes, width, height) {
  assert.equal(bytes.length, width * height * 12);
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const linear = [0, 1, 2].map((c) => bytes.readFloatLE((p * 3 + c) * 4));
    assert.ok(linear.every(Number.isFinite), 'Non-finite path-traced radiance');
    const display = pbrNeutral(linear.map((x) => Math.max(0, x)));
    data.set([...display.map(srgbByte), 255], p * 4);
  }
  return { width, height, data };
}
