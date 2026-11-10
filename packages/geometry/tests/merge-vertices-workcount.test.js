import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { geometryData, mergeVertices } from '../dist/index.js';

// Parent byte digests, captured before the hash factors were reused: tolerance 0, attributes, tangents, groups,
// degenerate removal, cell boundaries and a 32-bit hash collision.
const cases = JSON.parse(readFileSync(new URL('./fixtures/merge-vertices-workcount.json', import.meta.url), 'utf8'));
const run = (c) => {
  const g = geometryData(c.positions, c.normals, c.uvs, c.indices, c.groups);
  if (c.tangents) g.tangents = Float32Array.from(c.tangents);
  return mergeVertices(g, c.options);
};
for (const c of cases)
  test(`mergeVertices parent bytes: ${c.name}`, () => {
    const out = run(c), hash = createHash('sha256');
    for (const k of ['positions', 'normals', 'uvs', 'indices', 'tangents'])
      if (out[k]) hash.update(new Uint8Array(out[k].buffer, out[k].byteOffset, out[k].byteLength));
    hash.update(JSON.stringify(out.groups ?? []));
    assert.equal(hash.digest('hex'), c.sha256);
  });

const countImul = (fn) => {
  const imul = Math.imul;
  let calls = 0;
  Math.imul = (a, b) => { calls++; return imul(a, b); };
  try { fn(); } finally { Math.imul = imul; }
  return calls;
};

test('mergeVertices computes each hash factor once per vertex', () => {
  // 64 vertices in separate cells: the parent made 48 Math.imul calls each (3072), now 9 each.
  assert.equal(countImul(() => run(cases.find((c) => c.name === 'sparse64'))), 64 * 9);
});

test('mergeVertices never makes more hash calls than the parent on an early match', () => {
  // The second vertex matches in the first neighbor cell scanned; the parent needed 3 calls there, as does the new
  // code. The first vertex is unmatched: 48 before, 9 now.
  const p = [0.199, 0.199, 0.199, 0.201, 0.201, 0.201, 5, 5, 5];
  const g = geometryData(p, Array(9).fill(0), Array(6).fill(0), [0, 1, 2]);
  let out;
  assert.equal(countImul(() => { out = mergeVertices(g, { tolerance: 0.1, positionOnly: true }); }), 9 + 3 + 9);
  assert.deepEqual([...out.indices], [0, 0, 1]);
});
