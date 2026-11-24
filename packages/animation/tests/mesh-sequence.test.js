// FG-11: a mesh sequence (one whole mesh a frame, as a meshed fluid bake writes it) becomes a geometry cache:
// consecutive frames of one topology share a chunk, a topology change starts a new one, repeated triangles and UVs are
// left out for the reader to repeat, and the streamed and whole-file forms read back frame for frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMeshSequence, readGeometryCache, streamMeshSequence } from '../dist/geometry-cache.js';

/** A fan of `sides` triangles at height z: a mesh whose vertex count follows `sides`, as a fluid surface's does. */
function fan(sides, z, withUVs = false) {
  const positions = new Float32Array((sides + 1) * 3),
    indices = [];
  positions.set([0, 0, z]);
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    positions.set([Math.cos(a), Math.sin(a), z], (1 + s) * 3);
    indices.push(0, 1 + s, 1 + ((s + 1) % sides));
  }
  const frame = { positions, indices: new Uint32Array(indices) };
  if (withUVs) frame.uvs = Float32Array.from({ length: (sides + 1) * 2 }, (_, i) => i / 100);
  return frame;
}
const collect = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

test('frames group by topology into chunks; a change of vertex count starts a new chunk', async () => {
  // 3 frames of 6 sides, 2 of 9, 1 of 6 again: three chunks.
  const frames = [fan(6, 0), fan(6, 0.1), fan(6, 0.2), fan(9, 0.3), fan(9, 0.4), fan(6, 0.5)];
  const bytes = await encodeMeshSequence(24, frames),
    view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(12, true), 6, 'total frames filled in');
  const chunks = await collect(readGeometryCache(bytes));
  assert.deepEqual(
    chunks.map((c) => [c.firstFrame, c.frameCount, c.vertexCount]),
    [
      [0, 3, 7],
      [3, 2, 10],
      [5, 1, 7],
    ],
  );
  for (const c of chunks) assert.equal(c.totalFrames, 6);
  // Every frame's positions come back exactly.
  let f = 0;
  for (const c of chunks)
    for (let k = 0; k < c.frameCount; k++, f++) {
      const n = c.vertexCount * 3;
      assert.deepEqual(c.positions.subarray(k * n, (k + 1) * n), frames[f].positions, `frame ${f}`);
      assert.deepEqual(c.indices, frames[f].indices);
    }
});

test('chunks stop at maxChunkFrames; repeated triangles and UVs are left out and read back', async () => {
  const frames = Array.from({ length: 5 }, (_, i) => fan(8, i / 10, true));
  const parts = await collect(streamMeshSequence(30, frames, { maxChunkFrames: 2 }));
  assert.equal(parts.length, 1 + 3, 'header then chunks of 2, 2 and 1 frames');
  assert.equal(new DataView(parts[0].buffer, parts[0].byteOffset).getUint32(12, true), 0, 'streamed: total not known');
  const index = (p) => new DataView(p.buffer, p.byteOffset).getUint32(20, true),
    flags = (p) => new DataView(p.buffer, p.byteOffset).getUint32(24, true);
  assert.deepEqual(parts.slice(1).map(index), [8 * 3, 0, 0], 'only the first chunk stores the triangles');
  assert.deepEqual(parts.slice(1).map(flags), [2, 0, 0], 'only the first chunk stores the UVs');
  const chunks = await collect(readGeometryCache(join(parts)));
  assert.deepEqual(
    chunks.map((c) => c.firstFrame),
    [0, 2, 4],
  );
  for (const c of chunks) {
    assert.deepEqual(c.uvs, frames[0].uvs);
    assert.deepEqual(c.indices, frames[0].indices);
  }
  // The default chunk length is about a second of frames.
  const long = await collect(
    streamMeshSequence(
      4,
      Array.from({ length: 9 }, (_, i) => fan(5, i)),
    ),
  );
  assert.equal(long.length, 1 + 3);
});

test('normals ride along; frames arrive from an async iterable', async () => {
  async function* bake() {
    for (let i = 0; i < 3; i++) {
      const f = fan(4, i);
      f.normals = new Float32Array(f.positions.length).map((_, k) => (k % 3 === 2 ? 1 : 0));
      yield f;
    }
  }
  const chunks = await collect(readGeometryCache(await encodeMeshSequence(10, bake())));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].frameCount, 3);
  assert.equal(chunks[0].normals[2], 1);
  // A frame with normals after frames without starts a new chunk.
  const mixed = [fan(4, 0), { ...fan(4, 1), normals: new Float32Array(15) }];
  assert.equal((await collect(readGeometryCache(await encodeMeshSequence(10, mixed)))).length, 2);
});

test('validation names the bad frame', async () => {
  await assert.rejects(encodeMeshSequence(0, [fan(4, 0)]), RangeError);
  await assert.rejects(encodeMeshSequence(24, []), /Empty mesh sequence/);
  await assert.rejects(encodeMeshSequence(24, [fan(4, 0)], { maxChunkFrames: 0 }), /maxChunkFrames/);
  const broken = fan(4, 0);
  broken.indices[0] = 99;
  await assert.rejects(encodeMeshSequence(24, [fan(4, 0), broken]), /frame 1/);
  await assert.rejects(encodeMeshSequence(24, [{ ...fan(4, 0), uvs: new Float32Array(3) }]), /frame 0/);
  const nan = fan(4, 0);
  nan.positions[4] = Number.NaN;
  await assert.rejects(encodeMeshSequence(24, [nan]), /frame 0/);
});
