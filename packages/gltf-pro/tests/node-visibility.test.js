import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF, parseGLTFAsync, applyGLTFLights, viewGLTFCamera } from '../dist/index.js';
import { getSceneBounds } from '../dist/scene.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

function fixture() {
  const data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.meshes[0].weights;
  delete data.doc.meshes[0].primitives[0].targets;
  delete data.doc.meshes[0].primitives[0].attributes.JOINTS_0;
  delete data.doc.meshes[0].primitives[0].attributes.WEIGHTS_0;
  data.doc.nodes = [
    {
      name: 'Helper-colonly',
      mesh: 0,
      translation: [-3, 0, 0],
      children: [1, 2],
      extensions: { KHR_node_visibility: { visible: false } },
    },
    {
      name: 'ExplicitlyVisibleChild',
      mesh: 0,
      translation: [1, 0, 0],
      extensions: { KHR_node_visibility: { visible: true } },
    },
    { name: 'Socket', translation: [0, 2, 0], extras: { id: 'socket' } },
    { name: 'Independent', mesh: 0, translation: [5, 0, 0], extensions: { KHR_node_visibility: {} } },
  ];
  data.doc.scenes = [{ nodes: [0, 3] }];
  data.doc.scene = 0;
  data.doc.extensionsUsed = ['KHR_node_visibility'];
  return data;
}

test('node visibility loads as local public flags and retains hidden geometry, descendants and socket transforms', () =>
  headlessModels(async () => {
    const engine = await headless(),
      { doc, buffers } = fixture();
    const model = parseGLTF(engine, doc, buffers);
    try {
      assert.deepEqual(
        model.nodes.map((node) => node.visible),
        [false, true, true, true],
      );
      assert.equal(model.nodes.length, 4);
      assert.equal(model.primitives.length, 3);
      const all = getSceneBounds(engine, [model.root], { visibleOnly: false });
      const shown = getSceneBounds(engine, [model.root]);
      assert.ok(shown[0] > 4, 'the explicitly visible child stays hidden under its hidden parent');
      assert.ok(all[0] < -3, 'collision query can still include retained hidden triangles');
      assert.deepEqual([...model.extras()[0].matrix.subarray(12, 15)], [-3, 2, 0]);
      model.nodes[0].setPosition([-3, 1, 0]);
      assert.deepEqual([...model.extras()[0].matrix.subarray(12, 15)], [-3, 3, 0]);
      model.nodes[0].visible = true;
      assert.ok(getSceneBounds(engine, [model.root])[0] < -3);
      model.nodes[1].visible = false;
      assert.equal(model.nodes[0].visible, true, 'child flags stay independent');
    } finally {
      model.dispose();
      engine.dispose();
    }
  }));

test('async options parsing supports required KHR_node_visibility without a plugin', () =>
  headlessModels(async () => {
    const engine = await headless(),
      { doc, buffers } = fixture();
    doc.extensionsRequired = ['KHR_node_visibility'];
    let model;
    try {
      model = await parseGLTFAsync(engine, doc, { buffers });
      assert.equal(model.nodes[0].visible, false);
      assert.equal(model.nodes[3].visible, true);
    } finally {
      model?.dispose();
      engine.dispose();
    }
  }));

test('malformed node visibility throws TypeError before allocating scene nodes', () =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      const before = engine.meshes.size;
      for (const value of [null, false, 1, 'hidden', [], { visible: null }, { visible: 0 }, { visible: 'false' }]) {
        const { doc, buffers } = fixture();
        doc.nodes[0].extensions.KHR_node_visibility = value;
        assert.throws(() => parseGLTF(engine, doc, buffers), { name: 'TypeError', message: /KHR_node_visibility/ });
        assert.equal(engine.meshes.size, before);
      }
    } finally {
      engine.dispose();
    }
  }));

test('hidden light hierarchies do not contribute imported lights; hidden cameras remain usable', () =>
  headlessModels(async () => {
    const engine = await headless(),
      { doc, buffers } = fixture();
    doc.extensions = {
      KHR_lights_punctual: {
        lights: [
          { type: 'directional', intensity: 9 },
          { type: 'point', intensity: 4 },
          { type: 'directional', intensity: 5 },
          { type: 'point', intensity: 6 },
        ],
      },
    };
    doc.nodes.push(
      { extensions: { KHR_lights_punctual: { light: 0 } } },
      { extensions: { KHR_lights_punctual: { light: 1 } } },
      { extensions: { KHR_lights_punctual: { light: 2 } } },
      { extensions: { KHR_lights_punctual: { light: 3 } } },
      { camera: 0, translation: [0, 0, 7] },
    );
    doc.nodes[0].children.push(4, 5, 8);
    doc.scenes[0].nodes.push(6, 7);
    doc.cameras = [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }];
    const model = parseGLTF(engine, doc, buffers);
    try {
      assert.equal(model.lights.length, 4, 'hidden source lights are retained');
      assert.deepEqual(
        model.clusteredLights().map((light) => light.intensity),
        [6],
      );
      applyGLTFLights(model);
      assert.equal(engine.lighting.direction[3], 5);
      viewGLTFCamera(model);
      assert.deepEqual(engine.camera.position, [-3, 0, 7]);
      model.nodes[0].visible = true;
      assert.deepEqual(
        model.clusteredLights().map((light) => light.intensity),
        [4, 6],
      );
      applyGLTFLights(model);
      assert.equal(engine.lighting.direction[3], 9);
    } finally {
      model.dispose();
      engine.dispose();
    }
  }));

test('reapplying hidden imported sun restores caller lighting and respects later caller edits', () =>
  headlessModels(async () => {
    const engine = await headless(),
      { doc, buffers } = fixture();
    doc.extensions = { KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 7 }] } };
    doc.nodes.push({ extensions: { KHR_lights_punctual: { light: 0 } } });
    doc.nodes[0].children.push(4);
    const model = parseGLTF(engine, doc, buffers);
    const plain = fixture(),
      noLights = parseGLTF(engine, plain.doc, plain.buffers);
    try {
      engine.lighting.direction.set([0.2, 0.4, 0.6, 2]);
      engine.lighting.radiance.set([0.3, 0.5, 0.7]);
      const baseline = { direction: [...engine.lighting.direction], radiance: [...engine.lighting.radiance] };
      applyGLTFLights(noLights);
      assert.deepEqual([...engine.lighting.direction], baseline.direction);
      model.nodes[0].visible = true;
      applyGLTFLights(model);
      assert.equal(engine.lighting.direction[3], 7);
      engine.lighting.radiance[3] = 0.25;
      model.nodes[0].visible = false;
      applyGLTFLights(model);
      assert.deepEqual([...engine.lighting.direction], baseline.direction);
      assert.deepEqual(
        [...engine.lighting.radiance],
        [...baseline.radiance.slice(0, 3), 0.25],
        'restoring imported sun RGB leaves the unrelated ambient strength unchanged',
      );
      model.nodes[0].visible = true;
      applyGLTFLights(model);
      assert.equal(engine.lighting.direction[3], 7, 'show and reapply restores the imported sun');
      engine.lighting.direction.set([1, 0, 0, 12]);
      engine.lighting.radiance.set([0.2, 0.8, 0.4]);
      const caller = { direction: [...engine.lighting.direction], radiance: [...engine.lighting.radiance] };
      model.nodes[0].visible = false;
      applyGLTFLights(model);
      assert.deepEqual([...engine.lighting.direction], caller.direction);
      assert.deepEqual([...engine.lighting.radiance], caller.radiance);
    } finally {
      model.dispose();
      noLights.dispose();
      engine.dispose();
    }
  }));

test('only the most recently applied model can restore the caller lighting baseline', () =>
  headlessModels(async () => {
    const engine = await headless();
    const make = (intensity) => {
      const { doc, buffers } = fixture();
      doc.extensions = { KHR_lights_punctual: { lights: [{ type: 'directional', intensity }] } };
      doc.nodes.push({ extensions: { KHR_lights_punctual: { light: 0 } } });
      doc.nodes[0].children.push(4);
      const model = parseGLTF(engine, doc, buffers);
      model.nodes[0].visible = true;
      return model;
    };
    const first = make(7),
      second = make(11),
      baseline = [...engine.lighting.direction];
    try {
      applyGLTFLights(first);
      applyGLTFLights(second);
      assert.equal(engine.lighting.direction[3], 11);
      first.nodes[0].visible = false;
      applyGLTFLights(first);
      assert.equal(engine.lighting.direction[3], 11, 'hiding another model cannot remove the active imported sun');
      second.nodes[0].visible = false;
      applyGLTFLights(second);
      assert.deepEqual([...engine.lighting.direction], baseline);
    } finally {
      first.dispose();
      second.dispose();
      engine.dispose();
    }
  }));
