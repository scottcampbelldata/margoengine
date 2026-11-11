import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '../dist/index.js';

// The cap is the most 24-byte vertices (position + normal) one buffer of WebGPU's default 256 MiB maxBufferSize holds.
// Before 2026-11-10 it was 1,000,000, so a 1,000,001-vertex scan or terrain was refused on every device.
const CAP = 11_184_810,
  DEFAULT_MAX_BUFFER = 2 ** 28;

test('Geometry takes up to 11,184,810 vertices, the most a default 256 MiB vertex buffer holds', () => {
  assert.ok(CAP * 24 <= DEFAULT_MAX_BUFFER && (CAP + 1) * 24 > DEFAULT_MAX_BUFFER);
  const triangle = [0, 1, 2];
  assert.equal(new Geometry(new Float32Array(1_000_001 * 3), new Float32Array(1_000_001 * 3), triangle).vertices.length, 6_000_006);
  const at = new Geometry(new Float32Array(CAP * 3), new Float32Array(CAP * 3), triangle);
  assert.equal(at.vertices.byteLength, CAP * 24);
  assert.ok(at.vertices.byteLength <= DEFAULT_MAX_BUFFER);
  assert.throws(() => new Geometry(new Float32Array((CAP + 1) * 3), new Float32Array((CAP + 1) * 3), triangle), {
    name: 'RangeError',
    message: 'Invalid geometry; see https://margoengine.com/errors#geometry',
  });
});
