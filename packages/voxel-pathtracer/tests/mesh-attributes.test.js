import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshPathTracer } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { triangleMeshes } from '../dist/mesh.js';
import { fakeEngine, simpleScene } from './support.js';
const scene = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'smooth',
      material: 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array([0, 0, 2, 0, 2, 2, 2, 0, 2]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    },
  ],
});
test('mesh attributes survive the async snapshot and are packed per retained vertex', async () => {
  for (const create of [
    (engine, scene) => MeshPathTracer.create(engine, { scene }),
    (engine, scene) => ComposedVoxelPathTracer.create(engine, { scene, features: [triangleMeshes()] }),
  ]) {
    const h = fakeEngine(),
      s = scene(),
      pending = create(h.engine, s);
    s.meshes[0].normals.fill(NaN);
    s.meshes[0].uvs.fill(NaN);
    const t = await pending;
    try {
      await t.ready;
      h.frame();
      const words = h.device.buffers
        .map((b) => new Uint32Array(b.data))
        .find((w) => w[2] > 0 && w[w[2]] === 1 && w[w[2] + 2] === 1);
      assert.ok(words, 'geometry upload exists');
      const head = words[2],
        tri = head + words[head + 1],
        attrs = words[tri + 7];
      assert.ok(attrs > 0, 'triangle points to its attribute record');
      const f = new Float32Array(words.buffer);
      assert.equal(f[head + attrs + 2], 1);
      assert.equal(f[head + attrs + 3], 0);
      assert.equal(f[head + attrs + 11], 1);
      assert.equal(words[head + attrs + 15], 3, 'normal and UV flags');
    } finally {
      t.dispose();
    }
  }
});
test('malformed normals, UVs and textured meshes without UVs fail before GPU allocation', async () => {
  for (const change of [
    (s) => (s.meshes[0].normals = new Float32Array(3)),
    (s) => s.meshes[0].normals.fill(0),
    (s) => s.meshes[0].normals.fill(NaN),
    (s) => (s.meshes[0].uvs = new Float32Array(2)),
    (s) => (s.meshes[0].uvs[0] = Infinity),
    (s) => {
      delete s.meshes[0].uvs;
      s.materials[0].texture = 0;
      s.textures = [{ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }];
    },
  ]) {
    const h = fakeEngine(),
      s = scene();
    change(s);
    await assert.rejects(MeshPathTracer.create(h.engine, { scene: s }));
    assert.equal(h.device.buffers.length, 0);
  }
});
