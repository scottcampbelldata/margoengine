import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseCube } from '../dist/index.js';

test('Cube parsing validates samples once and allocates only the row token arrays', () => {
  for (const size of [2, 17, 33, 65]) {
    const samples = size ** 3;
    const text = `LUT_3D_SIZE ${size}\n${'-0 .125 1e-3 # sample\r\n'.repeat(samples)}`;
    const split = String.prototype.split;
    const finite = Number.isFinite;
    let arrays = 0;
    let checks = 0;
    let parsed;
    String.prototype.split = function (...args) {
      arrays++;
      return split.apply(this, args);
    };
    Number.isFinite = (value) => {
      checks++;
      return finite(value);
    };
    try {
      parsed = parseCube(text);
    } finally {
      String.prototype.split = split;
      Number.isFinite = finite;
    }
    assert.equal(checks, samples * 3 + 9, 'RGB checked during conversion plus three domain checks per channel');
    assert.equal(arrays, samples + 1, 'one token array per sample and size header; no file or comment arrays');
    const expected = new Float32Array(samples * 4);
    for (let i = 0; i < samples; i++) expected.set([-0, 0.125, 0.001, 1], i * 4);
    assert.deepEqual(Buffer.from(parsed.data.buffer), Buffer.from(expected.buffer));
    assert.deepEqual(parsed.domainMin, new Float32Array(3));
    assert.deepEqual(parsed.domainMax, new Float32Array([1, 1, 1]));
  }
});

test('Cube output retains the pre-change bytes for signed zero, subnormals, exponents and large values', () => {
  // SHA-256 of the RGBA bytes from the parser before batch 165 job 1.
  const hashes = new Map([
    [2, '759c69a9959bbe7ba7cc2751c40b8c725eb0147efd94b402260468b8c759088c'],
    [17, '10b2f98c694557ec5ef5b9ad789709e9d7f100542bf2827ae8f26751d56dd245'],
    [33, 'b92b0d4c7a453df022eae5a4634c72b563e231f81a61d428a3495676b2dd37e2'],
    [65, '33f083aa5e6a3a2157b6ce5787ada8a1a0c55d08da6f68905d8d712d7f497156'],
  ]);
  const values = ['-0', '+.125', '1e-45', '-2.5E+2', '3.4028234e38', '-1e-50', '0.1234567890123456789'];
  for (const [size, hash] of hashes) {
    const rows = Array.from(
      { length: size ** 3 },
      (_, i) => [0, 1, 2].map((j) => values[(i * 3 + j) % values.length]).join('\t') + (i % 2 ? ' # row' : ''),
    );
    const text =
      '\uFEFFTITLE "Numbers # test" # title\r\nDOMAIN_MAX 2 3 4\r\nDOMAIN_MIN -1 -2 -3\r\n' +
      `LUT_3D_SIZE ${size}\r\n` +
      rows.join('\r\n');
    const parsed = parseCube(text);
    assert.equal(createHash('sha256').update(Buffer.from(parsed.data.buffer)).digest('hex'), hash);
    assert.deepEqual(parsed.domainMin, new Float32Array([-1, -2, -3]));
    assert.deepEqual(parsed.domainMax, new Float32Array([2, 3, 4]));
  }
});
