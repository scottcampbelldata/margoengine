// A glTF that uses a physical material extension (clearcoat, sheen, transmission...) gets gltf-pro's physical shader
// without the caller passing `decoders.materials`: loadGLTF and parseGLTFAsync import @margoengine/gltf-pro/extended
// on first need. A default ToyCar load used to drop its cloth sheen, paint clearcoat and glass. `materials: false`
// keeps the base shader; a file without such extensions never imports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTFAsync } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { mockGPU } from '../examples/package-benchmarks/proofs/gpu-recorder.js';

// PBRModel needs a WebGPU device: a recording mock (no drawing happens here).
async function headless() {
  return new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, await TransformStore.create(16), {
    backend: 'webgpu',
    gpu: mockGPU().device,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
}
function coated() {
  const fixture = animatedTriangle();
  fixture.doc.extensionsUsed = [...(fixture.doc.extensionsUsed ?? []), 'KHR_materials_clearcoat'];
  fixture.doc.materials[0].extensions = {
    KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.2 },
  };
  return fixture;
}

test('a clearcoat material loads with the physical shader by default', async () => {
  const engine = await headless(),
    { doc, buffers } = coated(),
    model = await parseGLTFAsync(engine, doc, buffers);
  try {
    const material = model.primitives[0].material;
    assert.ok(material.physical, 'physical frame reserved');
    assert.equal(material.physical[0], 1, 'clearcoat factor read');
    assert.equal(Math.fround(material.physical[1]), Math.fround(0.2), 'clearcoat roughness read');
  } finally {
    model.dispose();
    engine.dispose();
  }
});

test('materials: false keeps the base shader; a plain material never gets the physical frame', async () => {
  const engine = await headless(),
    { doc, buffers } = coated(),
    off = await parseGLTFAsync(engine, doc, buffers, [], { decoders: { materials: false } }),
    plain = animatedTriangle(),
    base = await parseGLTFAsync(engine, plain.doc, plain.buffers);
  try {
    assert.equal(off.primitives[0].material.physical, undefined, 'opted out');
    assert.equal(base.primitives[0].material.physical, undefined, 'no physical extension in the file');
  } finally {
    off.dispose();
    base.dispose();
    engine.dispose();
  }
});
