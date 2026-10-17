import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, loadGLTF, parseGLTF } from '../dist/index.js';
import { extendedMaterials } from '../dist/extended.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

const extension = 'KHR_materials_dispersion';
async function scene() {
  const gpu = mockGPU();
  return new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(64), {
    backend: 'webgpu',
    gpu: gpu.device,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
}
function fixture(payload) {
  const result = animatedTriangle();
  delete result.doc.skins;
  delete result.doc.animations;
  if (payload !== undefined) result.doc.materials[0].extensions = { [extension]: payload };
  return result;
}

test('dispersion defaults to zero and retains physical rendering through the materials decoder', async (t) => {
  const engine = await scene();
  t.after(() => engine.dispose());
  const plain = fixture(),
    plainMaterial = parseGLTF(engine, plain.doc, plain.buffers).primitives[0].material;
  assert.equal(plainMaterial.dispersion, 0);
  assert.equal(plainMaterial.physical, undefined);
  for (const payload of [{}, { dispersion: 0 }, { dispersion: 2.5 }]) {
    const input = fixture(payload),
      metadata = parseGLTF(engine, input.doc, input.buffers).primitives[0].material,
      material = parseGLTF(engine, input.doc, input.buffers, [], { materials: extendedMaterials }).primitives[0]
        .material;
    assert.equal(metadata.dispersion, payload.dispersion ?? 0);
    assert.equal(metadata.physical, undefined, 'native physical rendering needs the optional materials decoder');
    assert.equal(material.dispersion, payload.dispersion ?? 0);
    assert.ok(material.physical, 'declaring dispersion retains a physical frame even at zero');
    assert.equal(material.volume, undefined, 'dispersion alone does not reserve transmission');
  }
});

test('dispersion validates factors even when transmission is zero', async (t) => {
  const engine = await scene();
  t.after(() => engine.dispose());
  for (const value of [-0.01, NaN, Infinity, -Infinity, 1e300, '0.5', null]) {
    for (const hooks of [{}, { materials: extendedMaterials }]) {
      const input = fixture({ dispersion: value });
      input.doc.materials[0].extensions.KHR_materials_transmission = { transmissionFactor: 0 };
      assert.throws(() => parseGLTF(engine, input.doc, input.buffers, [], hooks), /dispersion/, String(value));
    }
  }
});

test('required dispersion loads without an extension hook and accepts factors above one', async (t) => {
  const engine = await scene();
  t.after(() => engine.dispose());
  const input = fixture({ dispersion: 2.5 });
  input.doc.extensionsUsed = [extension];
  input.doc.extensionsRequired = [extension];
  assert.doesNotThrow(() => new GLTFAsset(input.doc, input.buffers));
  input.doc.buffers.forEach((buffer, i) => {
    const data = input.buffers[i];
    buffer.uri = `data:application/octet-stream;base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')}`;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'model/gltf+json' });
    response.end(JSON.stringify(input.doc));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  );
  const model = await loadGLTF(engine, `http://127.0.0.1:${server.address().port}/model.gltf`);
  assert.equal(model.primitives[0].material.dispersion, 2.5);
  assert.equal(model.primitives[0].material.physical, undefined);
});

test('native PBR uploads live dispersion without overwriting the blue transmission tint', async (t) => {
  const gpu = mockGPU(),
    engine = new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(64), {
      backend: 'webgpu',
      gpu: gpu.device,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  t.after(() => engine.dispose());
  const input = fixture({ dispersion: 0 });
  input.doc.materials[0].extensions.KHR_materials_transmission = { transmissionFactor: 0.5 };
  const model = parseGLTF(engine, input.doc, input.buffers, [], { materials: extendedMaterials }),
    material = model.primitives[0].material,
    view = context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' });
  engine.camera.update(1, true);
  engine.store.tick(false);
  material.dispersion = 2.5;
  view.begin(0);
  model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  const values = model.resources[0].values;
  assert.equal(values[103], 2.5);
  assert.ok(Math.abs(values[102] - 0.05) < 1e-6, 'blue transmission tint remains in ext.z');
  material.dispersion = 0;
  view.begin(1);
  model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  assert.equal(values[103], 0);
});
