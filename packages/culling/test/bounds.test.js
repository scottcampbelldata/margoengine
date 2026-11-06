import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CulledInstances } from '../dist/index.js';
import { CulledParts } from '../dist/parts.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const batch = (geometry = box(2, 4, 6)) => ({
  geometry,
  material: new PbrMaterial(),
  transforms: new Float32Array(identity),
});
function harness() {
  const h = optionalGPU();
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 1 },
    depthStencil: { format: 'depth32float' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  return { ...h, run: () => h.engine.frameGraph.execute(h.context) };
}
const code = (h) => h.pipelines.find((p) => p.compute).compute.module.code;

test("bounds: 'box' compiles the box tests after the sphere's, and uploads each batch's sphere and box", () => {
  const h = harness(),
    g = box(2, 4, 6),
    parts = new CulledInstances([batch(g)], { culling: 'occlusion', bounds: 'box' });
  h.engine.use(parts);
  h.run();
  assert.match(code(h), /inside\(s\)&&\(u\.mode\.x==0u\|\|boxInside\(i\)\)&&\(u\.mode\.x<2u\|\|boxUnoccluded\(i\)\)/);
  const data = new Float32Array(parts.buffers.bounds.data);
  assert.deepEqual([...data.subarray(0, 4)], [...g.bounds], 'the sphere first');
  assert.deepEqual([...data.subarray(4, 7)], [0, 0, 0], 'the box centre');
  assert.deepEqual([...data.subarray(8, 11)], [1, 2, 3], 'the box half size');
});

test('an off-centre geometry keeps its box centre', () => {
  const g = box(2, 2, 2),
    h = harness();
  for (let i = 0; i < g.vertices.length; i += 6) g.vertices[i] += 5;
  const parts = new CulledInstances([{ ...batch(), geometry: g }], { bounds: 'box' });
  h.engine.use(parts);
  h.run();
  const data = new Float32Array(parts.buffers.bounds.data);
  assert.deepEqual([...data.subarray(4, 7)], [5, 0, 0]);
  assert.deepEqual([...data.subarray(8, 11)], [1, 1, 1]);
});

test('spheres stay the default: no box code, the same frame', () => {
  const h = harness();
  h.engine.use(new CulledInstances([batch()], { culling: 'occlusion' }));
  h.run();
  assert.doesNotMatch(code(h), /boxInside/);
  assert.match(code(h), /inside\(s\)&&\(u\.mode\.x<2u\|\|unoccluded\(s\)\)/);
});

test('CulledParts takes the option; anything else is refused', () => {
  const h = harness();
  h.engine.use(new CulledParts([batch()], { bounds: 'box' }));
  h.run();
  assert.match(code(h), /boxInside/);
  assert.throws(() => new CulledInstances([batch()], { bounds: 'capsule' }), /"sphere" or "box"/);
});
