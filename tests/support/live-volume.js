import { Engine, TransformStore } from '../../packages/core/dist/extension.js';
import { parseGLTF } from '../../packages/gltf-pro/dist/index.js';
import { extendedMaterials } from '../../packages/gltf-pro/dist/extended.js';
import { mockGPU, context } from '../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { animatedTriangle } from './gltf-pro-fixture.js';

export async function liveVolume(t, volume = {}, channel) {
  const gpu = mockGPU(),
    engine = new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(64), {
        backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {},
      });
  t.after(() => engine.dispose());
  const input = animatedTriangle();
  input.doc.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  input.doc.materials[0].extensions = {
    KHR_materials_transmission: { transmissionFactor: 1 },
    KHR_materials_volume: { thicknessFactor: 2, attenuationColor: [0.25, 0.5, 1], attenuationDistance: 2, ...volume },
  };
  if (channel) {
    const data = Float32Array.from(channel.values), index = input.buffers.length;
    input.buffers.push(data);
    input.doc.buffers.push({ byteLength: data.byteLength });
    input.doc.bufferViews.push({ buffer: index, byteLength: data.byteLength });
    input.doc.accessors.push({ bufferView: index, componentType: 5126, count: 2, type: channel.type });
    input.doc.animations = [{
      samplers: [{ input: 5, output: index }],
      channels: [{ sampler: 0, target: { path: 'pointer', extensions: {
        KHR_animation_pointer: { pointer: `/materials/0/extensions/KHR_materials_volume/${channel.property}` },
      } } }],
    }];
  }
  const model = parseGLTF(engine, input.doc, input.buffers, [], { materials: extendedMaterials }),
    material = model.primitives[0].material,
    view = context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' });
  let frame = 0;
  const draw = () => {
    engine.camera.update(1, true);
    engine.store.tick(false);
    view.begin(frame++);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    return [98, 99, 102].map((i) => model.resources[0].values[i]);
  };
  return { model, material, draw };
}
