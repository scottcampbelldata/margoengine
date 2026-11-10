import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry } from '../../core/dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { MSFTMaterialLOD } from '../dist/msft.js';
import { ClusterLOD } from '../dist/clusters.js';
import { LODSystem } from '../dist/index.js';
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

test('LODSystem disposal detaches it and its pass from its own scene, so it can attach again', async () => {
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
    const lods = new LODSystem();
    scene.use(lods);
    const anchor = scene.createMesh();
    lods.add(anchor, [{ object: geometry }, { object: null, distance: 10 }]);
    let decoys = 0;
    const decoy = { name: lods.name, setup() {}, dispose: () => decoys++ };
    engine.use(decoy);
    lods.dispose();
    assert.equal(engine.sceneOf(lods), undefined, 'a disposed LODSystem must leave its scene');
    assert.equal(scene.plugins.has(lods.name), false);
    // Its pass went with it: the name is free in the scene's frame graph.
    scene.frameGraph.add({ name: lods.name, order: 0, execute() {} })();
    assert.equal(engine.scene.plugins.get(lods.name), decoy);
    assert.equal(decoys, 0, 'the same name in the default scene stays attached');
    lods.dispose();
    scene.use(lods);
    assert.equal(engine.sceneOf(lods), scene, 'a disposed LODSystem attaches again');
  } finally {
    engine.dispose();
  }
});
