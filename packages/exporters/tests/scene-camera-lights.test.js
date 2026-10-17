// Camera/light round trips use checked-in glTF assets and the public loader. Only browser image decoding and GPU
// operations are supplied by Node shims; PBRModel construction, setup, transforms and export all run unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGLTF } from '@margoengine/gltf-pro';
import { instancing, PBRInstances } from '@margoengine/gltf-pro/instancing';
import { exportModel } from '../dist/model.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';
import { readGLB, validate, validator } from './helpers.js';

const project = new URL('../../../', import.meta.url);
const directional = 'examples/assets/khronos/DirectionalLight/DirectionalLight.glb';
const cameras = 'examples/assets/khronos/Cameras/Cameras.gltf';
const points = 'examples/assets/khronos/PointLightIntensityTest/PointLightIntensityTest.glb';
const box = 'packages/exporters/tests/fixtures/Box.glb';
const diskFetch = async (url) => new Response(await readFile(new URL(new URL(url).pathname.slice(1), project)));

async function engine(t) {
  const instance = await loadedPBREngine();
  // Textured fixtures still execute real PBRModel texture setup. Device-side copies and mip draws need no GPU.
  instance.gpu.queue.copyExternalImageToTexture = () => {};
  instance.gpu.queue.submit = () => {};
  instance.gpu.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  t.after(() => instance.dispose());
  return instance;
}

async function load(t, file) {
  if (file === points) {
    const bitmap = globalThis.createImageBitmap;
    // This fixture's PNG is reused byte-for-byte by exportModel. Keep its real dimensions for texture setup.
    globalThis.createImageBitmap = async (source) => {
      const data = new DataView(await source.arrayBuffer());
      assert.equal(data.getUint32(0), 0x89504e47, 'fixture image is PNG');
      return { width: data.getUint32(16), height: data.getUint32(20), close() {} };
    };
    t.after(() => {
      if (bitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = bitmap;
    });
  }
  return loadGLTF(await engine(t), `https://fixtures.test/${file}`, { fetch: diskFetch });
}

async function output(t, model, binary) {
  const result = await exportModel(model, binary ? { binary: true } : { embed: false, binUri: 'metadata.bin' });
  const json = binary ? readGLB(result).json : result.json;
  return {
    json,
    async roundTrip(decoders = {}) {
      if (validator) {
        const report = binary ? await validate(result) : await validate(result.text, { 'metadata.bin': result.bin });
        assert.equal(report.errors, 0, JSON.stringify(report.messages));
      }
      const fetch = async (url) => {
        if (new URL(url).pathname === '/metadata.bin') return new Response(result.bin);
        return new Response(binary ? result : result.text);
      };
      return loadGLTF(await engine(t), `https://roundtrip.test/scene.${binary ? 'glb' : 'gltf'}`, { fetch, decoders });
    },
  };
}

function close(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < actual.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < 2e-6, `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
}

function sameNodeTree(source, json, copy) {
  const doc = source.asset.doc;
  for (let i = 0; i < doc.nodes.length; i++) {
    assert.equal(json.nodes[i].name, source.nodes[i].name || undefined, `node ${i} name`);
    assert.deepEqual(json.nodes[i].children ?? [], doc.nodes[i].children ?? [], `node ${i} children`);
  }
  source.root.engine.store.tick(false);
  copy.root.engine.store.tick(false);
  for (let i = 0; i < doc.nodes.length; i++) close(copy.nodes[i].matrix, source.nodes[i].matrix, `node ${i} matrix`);
}

for (const binary of [true, false]) {
  const format = binary ? 'GLB' : 'JSON';

  test(`exportModel ${format}: loaded scene camera and directional light retain definitions and node references`, async (t) => {
    const model = await load(t, directional);
    assert.equal(model.cameras.length, 1, 'real fixture contains one camera');
    assert.equal(model.lights.length, 1, 'real fixture contains one light');
    assert.ok(model.primitives.length > 0, 'real fixture contains mesh geometry');
    const result = await output(t, model, binary),
      { json } = result;
    assert.deepEqual(json.cameras, [
      {
        name: 'Generated Camera',
        type: 'perspective',
        perspective: { aspectRatio: 1.777, yfov: 0.65, zfar: 5, znear: 0.3 },
      },
    ]);
    assert.deepEqual(json.extensions.KHR_lights_punctual.lights, [
      { name: 'Sun', type: 'directional', color: [0.9, 0.8, 0.1], intensity: 1 },
    ]);
    assert.equal(json.nodes[4].camera, 0);
    assert.deepEqual(json.nodes[3].extensions.KHR_lights_punctual, { light: 0 });
    assert.deepEqual(json.scenes[json.scene].nodes, [0, 1, 2, 3, 4]);
    assert.equal(json.extensionsUsed.filter((name) => name === 'KHR_lights_punctual').length, 1);
    assert.ok(json.extensionsRequired.includes('KHR_lights_punctual'), 'required source extension stays required');
    assert.equal(Object.hasOwn(json.nodes[0], 'camera'), false, 'mesh node has no camera field');
    assert.equal(Object.hasOwn(json.nodes[4], 'extensions'), false, 'camera node has no light extension');
    const copy = await result.roundTrip();
    assert.equal(copy.cameras[0].node, copy.nodes[4]);
    assert.equal(copy.lights[0].node, copy.nodes[3]);
    assert.deepEqual(copy.cameras[0].perspective, model.cameras[0].perspective);
    assert.deepEqual(copy.lights[0].color, [0.9, 0.8, 0.1]);
    assert.equal(copy.lights[0].type, 'directional');
    sameNodeTree(model, json, copy);
  });

  test(`exportModel ${format}: loaded perspective and orthographic cameras use live projections and transforms`, async (t) => {
    const model = await load(t, cameras),
      [perspective, orthographic] = model.cameras;
    assert.equal(model.cameras.length, 2, 'real fixture contains both projection types');
    perspective.name = 'Edited perspective';
    perspective.perspective = { yfov: 0.9, znear: 0.125 };
    orthographic.name = 'Edited orthographic';
    orthographic.orthographic = { xmag: 2, ymag: 3, znear: 0.25, zfar: 80 };
    perspective.node.setPosition([1, 2, 7]);
    orthographic.node.setPosition([-1, 0.5, 9]);
    model.root.setPosition([4, 5, 6]);
    const result = await output(t, model, binary),
      { json } = result;
    assert.deepEqual(json.cameras, [
      { name: 'Edited perspective', type: 'perspective', perspective: { yfov: 0.9, znear: 0.125 } },
      { name: 'Edited orthographic', type: 'orthographic', orthographic: { xmag: 2, ymag: 3, znear: 0.25, zfar: 80 } },
    ]);
    assert.deepEqual(
      json.nodes.slice(1, 3).map((node) => node.camera),
      [0, 1],
    );
    assert.deepEqual(json.nodes[1].translation, [1, 2, 7]);
    assert.deepEqual(json.nodes[2].translation, [-1, 0.5, 9]);
    assert.deepEqual(json.nodes[3], { translation: [4, 5, 6], children: [0, 1, 2] });
    assert.deepEqual(json.scenes[json.scene].nodes, [3]);
    assert.equal(json.extensions?.KHR_lights_punctual, undefined);
    const copy = await result.roundTrip();
    assert.equal(copy.cameras.length, 2);
    assert.deepEqual(
      copy.cameras.map((camera) => camera.type),
      ['perspective', 'orthographic'],
    );
    assert.deepEqual(copy.cameras[0].perspective, { yfov: 0.9, znear: 0.125 });
    assert.deepEqual(copy.cameras[1].orthographic, { xmag: 2, ymag: 3, znear: 0.25, zfar: 80 });
    sameNodeTree(model, json, copy);
  });

  test(`exportModel ${format}: existing point lights retain live properties, nested nodes and ranges`, async (t) => {
    const model = await load(t, points),
      light = model.lights[0];
    assert.equal(model.lights.length, 8, 'real fixture contains eight point lights');
    assert.equal(model.asset.doc.extensionsRequired?.includes('KHR_lights_punctual') ?? false, false);
    light.name = 'Edited white light';
    light.color = [0.25, 0.5, 0.75];
    light.intensity = 12;
    light.range = 6;
    light.node.setPosition([0.25, 0.5, 2]);
    model.nodes[1].setPosition([3, -4, 1]);
    const result = await output(t, model, binary),
      { json } = result,
      lights = json.extensions?.KHR_lights_punctual?.lights;
    assert.equal(lights?.length, 8, 'all existing point lights are exported');
    assert.ok(json.extensionsUsed.includes('KHR_lights_punctual'));
    assert.equal(
      json.extensionsRequired?.includes('KHR_lights_punctual') ?? false,
      false,
      'used-only lights stay optional',
    );
    assert.deepEqual(lights[0], {
      name: 'Edited white light',
      type: 'point',
      color: [0.25, 0.5, 0.75],
      intensity: 12,
      range: 6,
    });
    assert.deepEqual(
      lights.slice(1).map(({ type, intensity, range }) => [type, intensity, range]),
      [
        ['point', 1, 1.125],
        ['point', 1, 1.125],
        ['point', 1, 1.125],
        ['point', 1, 1.125],
        ['point', 1, 1.125],
        ['point', 1, 1.125],
        ['point', 1, 1.125],
      ],
    );
    for (const [index, node] of [0, 3, 5, 7, 9, 11, 12, 13].entries())
      assert.deepEqual(json.nodes[node].extensions.KHR_lights_punctual, { light: index });
    assert.deepEqual(json.nodes[1].children, [0]);
    assert.deepEqual(json.nodes[14].children, [11, 12, 13]);
    assert.deepEqual(json.nodes[0].translation, [0.25, 0.5, 2]);
    assert.deepEqual(json.nodes[1].translation, [3, -4, 1]);
    const copy = await result.roundTrip();
    assert.equal(copy.lights.length, 8);
    assert.deepEqual(copy.lights[0].color, [0.25, 0.5, 0.75]);
    assert.equal(copy.lights[0].intensity, 12);
    assert.equal(copy.lights[0].range, 6);
    assert.deepEqual(
      copy.lights.map((item) => item.nodeIndex),
      [0, 3, 5, 7, 9, 11, 12, 13],
    );
    sameNodeTree(model, json, copy);
  });

  test(`exportModel ${format}: a loaded light edited to the existing spot type writes its cone properties`, async (t) => {
    const model = await load(t, directional),
      light = model.lights[0];
    // Edit the existing public light record; geometry and scene nodes still come from the real loaded asset.
    Object.assign(light, {
      type: 'spot',
      name: 'Edited spotlight',
      color: [0.5, 0.75, 1],
      intensity: 20,
      range: 7.5,
      innerConeAngle: 0.2,
      outerConeAngle: 0.6,
    });
    const result = await output(t, model, binary),
      { json } = result;
    assert.deepEqual(json.extensions?.KHR_lights_punctual?.lights, [
      {
        type: 'spot',
        name: 'Edited spotlight',
        color: [0.5, 0.75, 1],
        intensity: 20,
        range: 7.5,
        spot: { innerConeAngle: 0.2, outerConeAngle: 0.6 },
      },
    ]);
    assert.deepEqual(json.nodes[3].extensions.KHR_lights_punctual, { light: 0 });
    const copy = await result.roundTrip();
    assert.equal(copy.lights[0].type, 'spot');
    assert.equal(copy.lights[0].innerConeAngle, 0.2);
    assert.equal(copy.lights[0].outerConeAngle, 0.6);
    assert.equal(copy.lights[0].range, 7.5);
    sameNodeTree(model, json, copy);
  });

  test(`exportModel ${format}: loaded Box without camera or light still exports clean node records`, async (t) => {
    const model = await load(t, box);
    assert.equal(model.cameras.length, 0);
    assert.equal(model.lights.length, 0);
    const result = await output(t, model, binary),
      { json } = result;
    assert.equal(Object.hasOwn(json, 'cameras'), false);
    assert.equal(json.extensions?.KHR_lights_punctual, undefined);
    assert.equal(json.extensionsUsed?.includes('KHR_lights_punctual') ?? false, false);
    for (const node of json.nodes) {
      assert.equal(Object.hasOwn(node, 'camera'), false);
      assert.equal(Object.hasOwn(node, 'extensions'), false);
      for (const [key, value] of Object.entries(node)) assert.notEqual(value, undefined, `node.${key} is omitted`);
    }
    const copy = await result.roundTrip();
    assert.equal(copy.primitives.length, model.primitives.length);
    assert.equal(copy.cameras.length, 0);
    assert.equal(copy.lights.length, 0);
    sameNodeTree(model, json, copy);
  });

  test(`exportModel ${format}: a loaded mesh node keeps instancing, camera and punctual light attachments together`, async (t) => {
    const model = await load(t, directional),
      primitive = model.primitives[0];
    assert.equal(primitive.nodeIndex, 0, 'fixture mesh is node zero');
    primitive.instances = new PBRInstances(2);
    for (const record of [model.cameras[0], model.lights[0]]) {
      record.node = primitive.node;
      record.nodeIndex = primitive.nodeIndex;
    }
    const result = await output(t, model, binary),
      { json } = result,
      node = json.nodes[0];
    assert.equal(node.camera, 0);
    assert.ok(node.extensions.EXT_mesh_gpu_instancing);
    assert.deepEqual(node.extensions.KHR_lights_punctual, { light: 0 });
    assert.ok(json.extensionsUsed.includes('EXT_mesh_gpu_instancing'));
    assert.ok(json.extensionsUsed.includes('KHR_lights_punctual'));
    const copy = await result.roundTrip({ instancing });
    assert.equal(copy.primitives[0].instances.count, 2);
    assert.equal(copy.cameras[0].node, copy.nodes[0]);
    assert.equal(copy.lights[0].node, copy.nodes[0]);
    sameNodeTree(model, json, copy);
  });
}

test('exportModel JSON: camera and light references remap across loaded models and hidden metadata is omitted', async (t) => {
  const a = await load(t, directional),
    b = await load(t, cameras),
    result = await output(t, [b, a], false),
    { json } = result;
  assert.equal(json.cameras?.length, 3);
  assert.deepEqual([json.nodes[1].camera, json.nodes[2].camera, json.nodes[7].camera], [0, 1, 2]);
  assert.deepEqual(json.nodes[6].extensions.KHR_lights_punctual, { light: 0 });
  assert.deepEqual(json.scenes[json.scene].nodes, [0, 1, 2, 3, 4, 5, 6, 7]);
  const copy = await result.roundTrip();
  assert.deepEqual(
    copy.cameras.map((camera) => camera.nodeIndex),
    [1, 2, 7],
  );
  assert.equal(copy.lights[0].nodeIndex, 6);
  a.cameras[0].node.visible = false;
  a.lights[0].node.visible = false;
  const hidden = await output(t, a, false);
  assert.equal(Object.hasOwn(hidden.json, 'cameras'), false);
  assert.equal(hidden.json.extensions?.KHR_lights_punctual, undefined);
  assert.equal(hidden.json.extensionsUsed?.includes('KHR_lights_punctual') ?? false, false);
  assert.equal(hidden.json.extensionsRequired?.includes('KHR_lights_punctual') ?? false, false);
  assert.ok(hidden.json.nodes.every((node) => !Object.hasOwn(node, 'camera') && !Object.hasOwn(node, 'extensions')));
  const hiddenCopy = await hidden.roundTrip();
  assert.equal(hiddenCopy.cameras.length, 0);
  assert.equal(hiddenCopy.lights.length, 0);
  const inclusive = await exportModel(a, { onlyVisible: false });
  assert.equal(inclusive.json.cameras.length, 1);
  assert.equal(inclusive.json.extensions.KHR_lights_punctual.lights.length, 1);
});
