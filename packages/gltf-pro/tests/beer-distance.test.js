// White volume attenuation stays white when the exponent overflows to Infinity (JavaScript's 1 ** Infinity is NaN).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { extendedMaterials } from '../dist/extended.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

async function material(volume, transmissionFactor = 0.5) {
  const gpu = mockGPU(),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(64),
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  try {
    const fixture = animatedTriangle();
    fixture.doc.materials[0].pbrMetallicRoughness.baseColorFactor = [0.5, 0.75, 1, 1];
    fixture.doc.materials[0].extensions = {
      ...(transmissionFactor === null ? {} : {
        KHR_materials_transmission: transmissionFactor === 'default' ? {} : { transmissionFactor },
      }),
      KHR_materials_volume: volume,
    };
    const { tint, volume: values, opticalDepth } = parseGLTF(engine, fixture.doc, fixture.buffers, [], {
      materials: extendedMaterials,
    }).primitives[0].material;
    return { tint: tint?.slice(), volume: values?.slice(), opticalDepth };
  } finally {
    engine.dispose();
  }
}

test('zero and default transmission reserve the medium without a tint draw; no transmission reserves nothing', async () => {
  const volume = { thicknessFactor: 2, attenuationDistance: 2, attenuationColor: [0.25, 0.5, 1] };
  for (const factor of [0, 'default']) {
    const value = await material(volume, factor);
    assert.equal(value.tint, undefined);
    assert.deepEqual(value.volume, [2, 0.5, Math.sqrt(0.5), 1]);
    assert.deepEqual(value.opticalDepth, [Math.log(4), Math.log(2), 0]);
  }
  assert.deepEqual(await material(volume, null), { tint: undefined, volume: undefined, opticalDepth: undefined });
});

test('white attenuation survives an overflowing reciprocal distance', async () => {
  const { tint, volume } = await material({ thicknessFactor: 1, attenuationDistance: Number.MIN_VALUE });
  assert.deepEqual(tint, [0.25, 0.375, 0.5]);
  assert.deepEqual(volume, [1, 1, 1, 1]);
});

test('only white channels are exempt; other channels absorb fully', async () => {
  const { tint, volume } = await material({
    thicknessFactor: 1,
    attenuationColor: [0, 0.5, 1],
    attenuationDistance: Number.MIN_VALUE,
  });
  assert.deepEqual(tint, [0, 0, 0.5]);
  assert.deepEqual(volume, [1, 0, 0, 1]);
});

test('an overflowing thickness ratio keeps white tint white', async () => {
  const { tint } = await material({ thicknessFactor: 3e38, attenuationDistance: 2 ** -1023 });
  assert.deepEqual(tint, [0.25, 0.375, 0.5]);
});

test('native volume retains optical depth before binary32 or binary64 transmittance underflow', async () => {
  for (const thicknessFactor of [200, 1200]) {
    const value = await material({ thicknessFactor, attenuationColor: [0.25, 0.5, 1], attenuationDistance: 1 });
    assert.deepEqual(value.opticalDepth, [Math.log(4) * thicknessFactor, Math.log(2) * thicknessFactor, 0]);
  }
});

test('native optical depth preserves white, black, empty and unattenuated medium limits', async () => {
  assert.deepEqual((await material({ thicknessFactor: 1, attenuationColor: [0, 0.5, 1], attenuationDistance: 1 })).opticalDepth, [Infinity, Math.log(2), 0]);
  assert.deepEqual((await material({ thicknessFactor: 0, attenuationColor: [0, 0.5, 1], attenuationDistance: 1 })).opticalDepth, [0, 0, 0]);
  assert.deepEqual((await material({ thicknessFactor: 1, attenuationColor: [0, 0.5, 1] })).opticalDepth, [0, 0, 0]);
});
