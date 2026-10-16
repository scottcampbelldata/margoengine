import test from 'node:test';
import assert from 'node:assert/strict';
import { head } from '../packages/sky/src/atmosphere.ts';
import { createSkyProbeFrame } from './support/nature-uniforms.js';

test('nature cloud probes bind the complete current Sky frame, including disabled night fields', () => {
  const frame = createSkyProbeFrame();
  const fields = /struct Frame\s*\{([^}]+)\}/.exec(head)[1].split(',');
  const offsets = new Map();
  let floats = 0;
  for (const field of fields) {
    const [name, type] = field.trim().split(':');
    assert.ok(type === 'mat4x4f' || type === 'vec4f', `Update probe ABI check for ${type}`);
    offsets.set(name, floats);
    floats += type === 'mat4x4f' ? 16 : 4;
  }
  assert.equal(frame.byteLength, floats * Float32Array.BYTES_PER_ELEMENT, 'Probe binding must cover the WGSL Frame');
  assert.ok(frame.every(Number.isFinite));
  assert.deepEqual(Array.from(frame.slice(offsets.get('sun'), offsets.get('sun') + 4)), [0, 1, 0, 0]);
  assert.deepEqual(Array.from(frame.slice(offsets.get('clouds'), offsets.get('clouds') + 4)), [
    Math.fround(0.45),
    0,
    1500,
    0,
  ]);
  assert.deepEqual(Array.from(frame.slice(offsets.get('nightZenith'))), new Array(24).fill(0));
});
