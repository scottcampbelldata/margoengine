// Raycaster layer, filter and visibility rules for glTF Pro model nodes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
const { parseGLTFAsync } = await import(
  process.env.MARGO_SOURCE_TEST ? '../../gltf-pro/src/model.ts' : '../../gltf-pro/dist/index.js'
);
import { exportGLB } from '../../exporters/dist/index.js';
const { Raycaster } = await import(process.env.MARGO_SOURCE_TEST ? '../src/index.ts' : '../dist/index.js');
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';
const ix = { helper: 1 };
const scene = () => ({
  nodes: [
    {
      name: 'Parent',
      children: [
        {
          name: 'Helper',
          geometry: {
            positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2],
          },
        },
      ],
    },
  ],
});
async function fixture(run) {
  const gpu = mockGPU(),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(128),
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    models = [];
  const add = async () => {
    const model = await parseGLTFAsync(engine, exportGLB(scene()));
    models.push(model);
    return model;
  };
  try {
    await run({ engine, add });
  } finally {
    for (const m of models.reverse()) m.dispose();
    engine.dispose();
  }
}
const ray = () => {
  const r = new Raycaster([0, 0, 2], [0, 0, -1]);
  r.side = 'double';
  return r;
};

test('direct PBR node queries keep their own default layer independently of the model root', () =>
  fixture(async ({ engine, add }) => {
    const model = await add(),
      node = model.nodes[ix.helper],
      r = ray();
    r.layers = 1;
    setRenderLayers(model.root, 2);
    const hits = r.intersectObjects(engine, [node]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].mesh, node);
    assert.deepEqual(r.intersectObjects(engine, [model]), [], 'whole-model queries inherit the root layer');
  }));
test('direct PBR node candidates recheck their live own layer after the filter', () =>
  fixture(async ({ engine, add }) => {
    const model = await add(),
      node = model.nodes[ix.helper],
      r = ray();
    r.layers = 1;
    r.filter = () => {
      setRenderLayers(node, 2);
      return true;
    };
    assert.deepEqual(r.intersectObjects(engine, [node]), []);
  }));
test('a direct PBR node filter changing the root layer does not change its layer policy', () =>
  fixture(async ({ engine, add }) => {
    const model = await add(),
      node = model.nodes[ix.helper],
      r = ray();
    r.layers = 1;
    r.filter = () => {
      setRenderLayers(model.root, 2);
      return true;
    };
    const hits = r.intersectObjects(engine, [node]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].mesh, node);
  }));

test('picking skips hidden nodes and their descendants', () =>
  fixture(async ({ engine, add }) => {
    const model = await add(),
      node = model.nodes[ix.helper];
    assert.equal(ray().intersectObjects(engine, [node]).length, 1);
    model.root.visible = false;
    assert.deepEqual(ray().intersectObjects(engine, [node]), []);
    assert.deepEqual(ray().intersectObjects(engine, [model]), []);
  }));
