import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MeshPathTracer } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { triangleMeshes } from '../dist/mesh.js';
import { fakeEngine, simpleScene } from './support.js';

const geometry = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'mixed',
      material: 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 0, 1, 0, 1, 2, 1, 2, 2]),
    },
  ],
});

test('exactly degenerate triangles are counted without discarding the valid scene', async () => {
  for (const create of [
    (engine, scene) => MeshPathTracer.create(engine, { scene }),
    (engine, scene) => ComposedVoxelPathTracer.create(engine, { scene, features: [triangleMeshes()] }),
  ]) {
    const h = fakeEngine(),
      t = await create(h.engine, geometry());
    try {
      assert.equal(t.stats.meshTriangles, 1);
      assert.equal(t.stats.skippedDegenerateTriangles, 2);
      assert.equal(t.stats.meshBvhNodes, 1);
      const empty = geometry();
      empty.revision++;
      empty.meshes[0].indices = new Uint32Array([0, 0, 0]);
      await t.setScene(empty);
      assert.equal(t.stats.meshTriangles, 0);
      assert.equal(t.stats.skippedDegenerateTriangles, 1);
      assert.equal(t.stats.meshBvhNodes, 0);
      const bad = geometry();
      bad.revision += 2;
      bad.meshes[0].indices[0] = 100;
      await assert.rejects(t.setScene(bad), /index outside positions/);
      assert.equal(t.stats.skippedDegenerateTriangles, 1, 'failed updates preserve the committed counts');
    } finally {
      t.dispose();
    }
  }
});

test('thin nonzero Float32 geometry survives cancellation near large coordinates', async () => {
  const s = geometry();
  s.meshes[0].positions = new Float32Array([1e8, 1e8, 0, -1e8, -1e8, 0, 1e-40, 0, 0]);
  s.meshes[0].indices = new Uint32Array([0, 1, 2]);
  const t = await MeshPathTracer.create(fakeEngine().engine, { scene: s });
  try {
    assert.equal(t.stats.meshTriangles, 1);
    assert.equal(t.stats.skippedDegenerateTriangles, 0);
  } finally {
    t.dispose();
  }
});

test('Wasm zero-area decisions agree with an independent scaled-integer oracle', async () => {
  const {
    instance: { exports: k },
  } = await WebAssembly.instantiate(await readFile(new URL('../src/mesh.wasm', import.meta.url)));
  const packet = new Uint32Array(16),
    floats = new Float32Array(packet.buffer);
  packet.set([1, 3, 3, 1]);
  packet.set([0, 1, 2], 13);
  // Every finite Float32 is an integer multiple of 2^-149. BigInt arithmetic
  // supplies an independent exact area oracle over the whole accepted exponent range.
  const integer = (bits) => {
    const exponent = (bits >>> 23) & 255;
    const mantissa = BigInt((bits & 0x7fffff) | (exponent ? 0x800000 : 0));
    return (bits >>> 31 ? -mantissa : mantissa) << BigInt(Math.max(0, exponent - 1));
  };
  let random = 0x932bc;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const p = k.allocate(packet.length);
  try {
    let zeros = 0,
      nonzeros = 0;
    for (let row = 0; row < 512; row++) {
      if (row % 2 === 0) {
        const scale = 2 ** ((row % 160) - 140);
        floats.set([scale, 2 * scale, 4 * scale, 2 * scale, 4 * scale, 8 * scale, 3 * scale, 6 * scale, 12 * scale], 4);
      } else {
        for (let i = 4; i < 13; i++) {
          const bits = next();
          packet[i] = ((bits & 0x807fffff) | ((next() % 153) << 23)) >>> 0;
        }
      }
      const points = [0, 1, 2].map((v) => [0, 1, 2].map((a) => integer(packet[4 + v * 3 + a])));
      const a = points[1].map((v, i) => v - points[0][i]),
        b = points[2].map((v, i) => v - points[0][i]);
      const degenerate = a.every((_, i) => a[(i + 1) % 3] * b[(i + 2) % 3] - a[(i + 2) % 3] * b[(i + 1) % 3] === 0n);
      if (degenerate) zeros++;
      else nonzeros++;
      new Uint32Array(k.memory.buffer, p, packet.length).set(packet);
      assert.equal(k.build_mesh(p, packet.length), 0, `row ${row}`);
      const header = new Uint32Array(k.memory.buffer, k.output_ptr(), 4);
      assert.equal(header[2], degenerate ? 0 : 1, `retained row ${row}`);
      assert.equal(header[3], degenerate ? 1 : 0, `skipped row ${row}`);
    }
    assert.ok(zeros >= 200);
    assert.ok(nonzeros >= 200);
  } finally {
    k.release(p, packet.length);
  }
});
