import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry } from '../../core/dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { MSFTMaterialLOD } from '../dist/msft.js';
import { ClusterLOD } from '../dist/clusters.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const geometry = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
const node = { id: 0, children: [], meshlets: [geometry], bounds: [0.5, 0.5, 0, 1], error: 0 };
for (const [label, make] of [
  ['material LOD', (model) => new MSFTMaterialLOD(model)],
  ['cluster LOD', (model) => new ClusterLOD({ root: node, nodes: [node], triangles: 1 }, model.root)],
]) {
  test(`${label} disposal removes only its own scene registration and passes`, async () => {
    const engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(64), {
      backend: 'webgpu',
      gpu: mockGPU().device,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
    try {
      const scene = engine.createScene('lod');
      let model;
      scene.use({
        name: 'model-setup',
        setup() {
          model = new PBRModel(
            engine,
            new GLTFAsset(
              {
                asset: { version: '2.0' },
                buffers: [{ byteLength: 36 }],
                bufferViews: [{ buffer: 0, byteLength: 36 }],
                accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }],
                materials: [{ extensions: { MSFT_lod: { ids: [1] } } }, {}],
                meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
                nodes: [{ mesh: 0 }],
                scenes: [{ nodes: [0] }],
                scene: 0,
              },
              [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])],
            ),
          );
        },
      });
      const controller = make(model);
      scene.use(controller);
      let disposed = 0;
      const decoy = {
        name: controller.name,
        setup() {},
        dispose() {
          disposed++;
        },
      };
      engine.use(decoy);
      assert.equal(engine.sceneOf(controller) === scene, true);
      controller.dispose();
      assert.equal(engine.sceneOf(controller) === undefined, true, 'disposed controller must leave its scene');
      assert.equal(scene.plugins.has(controller.name), false);
      const remove = scene.frameGraph.add({ name: controller.name, order: 0, execute() {} });
      remove();
      controller.dispose();
      assert.equal(disposed, 0);
      assert.equal(engine.scene.plugins.get(decoy.name), decoy);
      assert.equal(model.disposed, false, 'the model remains caller-owned');
      const other = make(model);
      scene.use(other);
      scene.removePlugin(other.name);
      assert.equal(engine.sceneOf(other), undefined);
    } finally {
      engine.dispose();
    }
  });
}
