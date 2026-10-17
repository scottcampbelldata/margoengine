// Caller and installed transmission share the dispersion factor without growing the extension uniform layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { install, transmission } from '../dist/index.js';
import { transmissionQuads } from '../../../tests/support/transmission-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function loaded(extensions) {
  const harness = optionalGPU(),
    store = await TransformStore.create(32),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 3], target: [0, 0, 0] },
    null,
  );
  const fixture = transmissionQuads(extensions),
    model = parseGLTF(engine, fixture.doc, fixture.buffers);
  return { ...harness, engine, model, material: model.primitives[1].material };
}

test('caller transmission stores values above one in its reserved dispersion factor', () => {
  const options = { factor: 1, opaqueColor: {}, volume: { thicknessFactor: 0.5 } },
    zero = transmission(options),
    positive = transmission({ ...options, dispersion: 2.5 });
  assert.deepEqual([...zero.factors], [1, 1.5, 0.5, 0, 1, 1, 1, 0]);
  assert.deepEqual([...positive.factors], [1, 1.5, 0.5, 0, 1, 1, 1, 2.5]);
  assert.equal(positive.textures.length, 1);
});

test('caller transmission rejects invalid dispersion before its zero-factor early return', () => {
  for (const dispersion of [-1, NaN, Infinity, -Infinity, '1', null, 1e100])
    for (const factor of [0, 1])
      assert.throws(() => transmission({ factor, dispersion, opaqueColor: {} }), /dispersion/, String(dispersion));
});

test('materials.install reads dispersion metadata and appends it after existing lobe factors', async () => {
  const s = await loaded({
    KHR_materials_transmission: { transmissionFactor: 1 },
    KHR_materials_volume: { thicknessFactor: 0.5, attenuationDistance: 2, attenuationColor: [0.25, 0.5, 0.75] },
    KHR_materials_dispersion: { dispersion: 2.75 },
    KHR_materials_clearcoat: { clearcoatFactor: 0.4 },
  });
  try {
    const installation = install(s.model),
      extension = s.material.extension;
    assert.deepEqual([...extension.factors].slice(-8), [1, 1.5, 0.5, 0.5, 0.25, 0.5, 0.75, 2.75]);
    assert.equal(extension.factors.length, 12, 'clearcoat and transmission keep their existing factor layout');
    assert.equal(s.material.settings[0], 2);
    installation.dispose();
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('materials.install validates dormant dispersion metadata before creating resources', async () => {
  for (const dispersion of [-0.5, NaN, Infinity, '1', null]) {
    const s = await loaded({});
    try {
      // Mutating retained metadata exercises installation validation independently of parser validation.
      s.material.extensions.KHR_materials_dispersion = { dispersion };
      const textures = s.counts.textures;
      assert.throws(() => install(s.model), /dispersion/, String(dispersion));
      assert.equal(s.material.extension, undefined);
      assert.equal(s.counts.textures, textures);
    } finally {
      s.engine.dispose();
    }
  }
});

test('dispersion metadata without transmission keeps the installed opaque path and allocates no capture', async () => {
  const s = await loaded({ KHR_materials_dispersion: { dispersion: 2 } });
  try {
    const textures = s.counts.textures,
      installation = install(s.model);
    assert.equal(s.material.extension, undefined);
    assert.equal(s.counts.textures, textures);
    installation.dispose();
  } finally {
    s.engine.dispose();
  }
});
