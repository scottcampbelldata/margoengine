import assert from 'node:assert/strict';
import test from 'node:test';
import { box, PbrMaterial } from '@margoengine/core';
import { BoxCulledMeshes, BoxCulledModels, BoxDynamicInstances } from '../dist/bounds.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function harness() {
  const h = optionalGPU();
  h.context.shader = wgsl;
  h.context.descriptor = { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } };
  h.engine.canvas = { clientWidth: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = () => ({ instance: { size: 96 }, vertex: {}, index: {} });
  return h;
}
test('box mesh uniforms and shaders contain local center and half extents', () => {
  const h = harness(),
    g = box(0.1, 8, 0.2);
  h.context.batches = [{ geometry: g, instances: new Float32Array([...I, 1, 1, 1, 1, 0.5, 0, 1, 0]), count: 1 }];
  const p = BoxCulledMeshes.attach(h.engine, { occlusion: true });
  h.engine.frameGraph.execute(h.context);
  const shaders = h.pipelines.filter((p) => p.compute).map((p) => p.compute.module.code);
  assert.ok(shaders.some((s) => s.includes('boxKeep(records[i].m)')));
  assert.ok(shaders.some((s) => s.includes('boxDepth(records[i].m)')));
  const uniform = h.resources.find((r) => r.size === 64 && r.data);
  const f = new Float32Array(uniform.data);
  assert.deepEqual([...f.slice(8, 11)], [0, 0, 0]);
  assert.deepEqual([...f.slice(12, 15)], [Math.fround(0.05), 4, Math.fround(0.1)]);
  p.dispose();
});
test('plain and instanced model boxes occupy aligned records and include local padding', () => {
  const h = harness(),
    g = box(0.1, 8, 0.2),
    vertices = new Float32Array((g.vertices.length / 6) * 20);
  for (let i = 0; i < g.vertices.length / 6; i++) vertices.set(g.vertices.subarray(i * 6, i * 6 + 6), i * 20);
  const plain = { vertices, indices: g.indices, node: { matrix: I } },
    instanced = { ...plain, instances: { count: 1, capacity: 1, upload: () => ({ size: 96 }) } };
  const p = BoxCulledModels.attach(h.engine, [{ primitives: [plain, instanced] }]);
  p.add({ primitives: [plain, instanced] }, { padding: 0.25 });
  h.engine.frameGraph.execute(h.context);
  const shaders = h.pipelines.filter((p) => p.compute).map((p) => p.compute.module.code);
  assert.ok(shaders.some((s) => s.includes('boxKeep(items[i].node)')));
  assert.ok(shaders.some((s) => s.includes('boxKeep(b.node*records[i].m)')));
  const uniforms = h.resources.filter((r) => r.size === 128 && r.data);
  assert.ok(uniforms.some((r) => new Float32Array(r.data)[28] === Math.fround(0.3)));
  assert.ok(plain.culled);
  assert.ok(instanced.redirect);
  p.dispose();
  assert.equal(plain.culled, undefined);
  assert.equal(instanced.redirect, undefined);
});
test('dynamic box culling retains the world list and uses a distinct padded shape uniform', () => {
  const h = harness(),
    batches = [];
  h.context.batches = batches;
  h.engine.retain = (geometry) => batches.push({ geometry, count: 0, instances: new Float32Array(0) });
  h.engine.release = () => {};
  const p = BoxDynamicInstances.attach(h.engine, {
    geometry: box(0.1, 8, 0.2),
    material: new PbrMaterial(),
    capacity: 8,
  });
  p.addInstance(I);
  h.engine.frameGraph.execute(h.context);
  assert.ok(h.pipelines.some((p) => p.compute?.module.code.includes('r.ok&&keep(r.m)&&boxKeep(r.m)')));
  assert.ok(batches[0].redirect);
  p.dispose();
});
test('CPU box test agrees with all transformed corners under shear and reflection', () => {
  const p = new BoxCulledMeshes(),
    g = box(0.1, 8, 0.2),
    frame = new Float32Array(44);
  frame.set([1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1], 16);
  for (let i = 0; i < 100; i++) {
    const m = Float32Array.from(I);
    m[0] = i % 2 ? -1 : 1;
    m[4] = (i % 7) * 0.1;
    m[12] = i * 0.04;
    const actual = p.shape.cpu(m, 0, g.vertices, 6, 0, frame);
    let expected = true;
    for (let q = 16; q < 40; q += 4) {
      let max = -Infinity;
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? 0.05 : -0.05,
          y = c & 2 ? 4 : -4,
          z = c & 4 ? 0.1 : -0.1;
        const world = [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ];
        max = Math.max(max, frame[q] * world[0] + frame[q + 1] * world[1] + frame[q + 2] * world[2] + frame[q + 3]);
      }
      if (max < 0) expected = false;
    }
    assert.equal(actual, expected, `transform ${i}`);
  }
});
