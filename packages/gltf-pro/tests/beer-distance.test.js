// White volume attenuation stays white when the exponent overflows to Infinity (JavaScript's 1 ** Infinity is NaN).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { extendedMaterials } from '../dist/extended.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

async function material(volume) {
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
      KHR_materials_transmission: { transmissionFactor: 0.5 },
      KHR_materials_volume: volume,
    };
    const { tint, volume: values } = parseGLTF(engine, fixture.doc, fixture.buffers, [], {
      materials: extendedMaterials,
    }).primitives[0].material;
    return { tint: [...tint], volume: [...values] };
  } finally {
    engine.dispose();
  }
}

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
