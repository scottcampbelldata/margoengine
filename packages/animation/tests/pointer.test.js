import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { GLTFAsset, parseGLTFAsync, viewGLTFCamera } from '@margoengine/gltf-pro';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';
import { atlas } from '../../exporters/tests/material-animation-fixture.js';

const near = (actual, expected, epsilon = 1e-6) => {
  assert.equal(actual.length, expected.length, `${[...actual]} vs ${expected}`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `[${i}] ${actual[i]} != ${expected[i]}`);
};

/** A hand-built GLB: one textured triangle, a spot light, a perspective and an orthographic camera, pointer clips. */
function scene() {
  const chunks = [],
    accessors = [],
    bufferViews = [];
  let length = 0;
  const view = (bytes) => {
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength });
    chunks.push(padded);
    length += padded.byteLength;
    return bufferViews.length - 1;
  };
  const add = (values, type, componentType = 5126, extra = {}) => {
    const array = componentType === 5121 ? new Uint8Array(values) : new Float32Array(values),
      width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    accessors.push({ bufferView: view(array), componentType, count: values.length / width, type, ...extra });
    return accessors.length - 1;
  };
  const position = add([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 5126, { min: [0, 0, 0], max: [1, 1, 0] }),
    uv = add([0, 0, 1, 0, 0, 1], 'VEC2'),
    image = view(atlas.image),
    times = add([0, 1], 'SCALAR');
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: [
      'KHR_animation_pointer',
      'KHR_lights_punctual',
      'KHR_texture_transform',
      'KHR_materials_emissive_strength',
      'KHR_node_visibility',
    ],
    extensionsRequired: ['KHR_animation_pointer'],
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3] }],
    nodes: [
      { name: 'Tri', mesh: 0, extensions: { KHR_node_visibility: { visible: true } } },
      { name: 'Spot', translation: [0, 2, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: 'Eye', camera: 0, translation: [0, 0, 5] },
      { name: 'Top', camera: 1, translation: [0, 5, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: position, TEXCOORD_0: uv }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          roughnessFactor: 1,
          metallicFactor: 0,
          baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0, 0], scale: [1, 1] } } },
        },
        emissiveFactor: [0, 0, 0],
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 } },
      },
    ],
    textures: [{ source: 0 }],
    images: [{ bufferView: image, mimeType: 'image/png' }],
    cameras: [
      { type: 'perspective', perspective: { yfov: 1, znear: 0.1 } },
      { type: 'orthographic', orthographic: { xmag: 1, ymag: 1, znear: 0.1, zfar: 10 } },
    ],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          {
            type: 'spot',
            color: [1, 1, 1],
            intensity: 1,
            spot: { innerConeAngle: 0.1, outerConeAngle: 0.5 },
          },
        ],
      },
    },
    animations: [],
  };
  const samplers = [],
    channels = [];
  const channel = (pointer, values, type, interpolation = 'LINEAR', componentType = 5126) => {
    samplers.push({ input: times, output: add(values, type, componentType), interpolation });
    channels.push({
      sampler: samplers.length - 1,
      target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer } } },
    });
  };
  const m = '/materials/0';
  channel(`${m}/pbrMetallicRoughness/baseColorFactor`, [1, 1, 1, 1, 0, 0.5, 1, 1], 'VEC4');
  channel(`${m}/pbrMetallicRoughness/roughnessFactor`, [1, 0.25], 'SCALAR', 'STEP');
  // CUBICSPLINE: per key in tangent, value, out tangent.
  channel(`${m}/emissiveFactor`, [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0], 'VEC3', 'CUBICSPLINE');
  channel(`${m}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/rotation`, [0, 1], 'SCALAR');
  const light = '/extensions/KHR_lights_punctual/lights/0';
  channel(`${light}/color`, [1, 1, 1, 1, 0, 0], 'VEC3');
  channel(`${light}/intensity`, [1, 5], 'SCALAR');
  channel(`${light}/spot/outerConeAngle`, [0.5, 0.7], 'SCALAR');
  channel('/cameras/0/perspective/yfov', [1, 0.5], 'SCALAR');
  channel('/cameras/1/orthographic/ymag', [1, 3], 'SCALAR', 'STEP');
  channel('/nodes/0/translation', [0, 0, 0, 2, 0, 0], 'VEC3');
  channel('/nodes/0/extensions/KHR_node_visibility/visible', [1, 0], 'SCALAR', 'STEP', 5121);
  // Valid pointers this player does not drive: reported and skipped.
  channel(`${m}/extensions/KHR_materials_iridescence/iridescenceFactor`, [0, 1], 'SCALAR');
  channel('/cameras/0/perspective/zfar', [10, 20], 'SCALAR');
  doc.animations.push({ name: 'Show', samplers, channels });
  const json = new TextEncoder().encode(
    JSON.stringify({ ...doc, accessors, bufferViews, buffers: [{ byteLength: length }] }),
  );
  const jsonLength = Math.ceil(json.byteLength / 4) * 4,
    total = 12 + 8 + jsonLength + 8 + length,
    glb = new Uint8Array(total),
    data = new DataView(glb.buffer);
  data.setUint32(0, 0x46546c67, true);
  data.setUint32(4, 2, true);
  data.setUint32(8, total, true);
  data.setUint32(12, jsonLength, true);
  data.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(json, 20);
  data.setUint32(20 + jsonLength, length, true);
  data.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const chunk of chunks) {
    glb.set(chunk, at);
    at += chunk.byteLength;
  }
  return { glb, doc: { ...doc, accessors, bufferViews, buffers: [{ byteLength: length }] } };
}

async function load(t, glb) {
  const engine = await loadedPBREngine();
  engine.gpu.queue.copyExternalImageToTexture = () => {};
  engine.gpu.queue.submit = () => {};
  engine.gpu.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (source) => {
    const view = new DataView(await source.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  };
  t.after(() => {
    engine.dispose();
    if (bitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = bitmap;
  });
  return { engine, model: await parseGLTFAsync(engine, glb, {}) };
}

test('a file requiring KHR_animation_pointer loads', () => {
  const { doc, glb } = scene();
  assert.doesNotThrow(() => new GLTFAsset(doc, [glb.subarray(glb.length - doc.buffers[0].byteLength)]));
});

test('pointer channels drive live material factors, texture transforms, lights, cameras, nodes and visibility', async (t) => {
  const { glb } = scene(),
    { engine, model } = await load(t, glb),
    before = structuredClone(model.asset.doc),
    animation = new Animation(model, { loop: false, pointers: pointerChannels });
  assert.equal(animation.clips[0].duration, 1);
  assert.equal(animation.warnings.length, 2);
  assert.match(
    animation.warnings[0],
    /channel 11: pointer \/materials\/0\/extensions\/KHR_materials_iridescence\/iridescenceFactor .*skipped/,
  );
  assert.match(animation.warnings[1], /perspective\/zfar targets zfar, which the camera does not define; skipped/);
  const material = model.primitives[0].material,
    [light] = model.lights,
    [eye, top] = model.cameras;

  animation.seek(0.5);
  near(material.base, [0.5, 0.75, 1, 1]);
  assert.equal(material.factors[0], 1, 'STEP roughness holds the first key');
  // Hermite at u = 0.5: 0.5 * p0 + 0.125 * m0 + 0.5 * p1 - 0.125 * m1, then emissive strength 2.
  near(material.emission, [2 * (0.125 + 0.5), 1, 1]);
  const r = 0.5;
  assert.equal(material.maps[0].extensions.KHR_texture_transform.rotation, r);
  near(material.uvt.slice(0, 8), [Math.cos(r), Math.sin(r), 0, 0, -Math.sin(r), Math.cos(r), 0, 0]);
  near(light.color, [1, 0.5, 0.5]);
  assert.equal(light.intensity, 3);
  near([light.outerConeAngle], [0.6]);
  const [clustered] = model.clusteredLights();
  near([clustered.outerAngle, clustered.intensity], [0.6, 3]);
  near(clustered.color, [1, 0.5, 0.5]);
  near([eye.perspective.yfov], [0.75]);
  assert.equal(top.orthographic.ymag, 1);
  viewGLTFCamera(model, 0);
  near([engine.camera.fov], [(0.75 * 180) / Math.PI], 1e-4);
  assert.equal(model.nodes[0].position.x, 1);
  assert.equal(model.nodes[0].visible, true);
  assert.deepEqual(model.asset.doc, before, 'live values are owned copies; the asset document is unchanged');

  animation.seek(1);
  near(material.base, [0, 0.5, 1, 1]);
  assert.equal(material.factors[0], 0.25);
  near(material.emission, [2, 2, 2]);
  assert.equal(top.orthographic.ymag, 3);
  assert.equal(light.intensity, 5);
  assert.equal(model.nodes[0].position.x, 2);
  assert.equal(model.nodes[0].visible, false);
  animation.dispose();
});

test('invalid pointers and samplers throw; ordinary and pointer channels may not share a node property', async (t) => {
  const cases = [
    [
      (d) => (d.channels[1].target.extensions.KHR_animation_pointer.pointer = '/materials/0/name'),
      TypeError,
      /not an animatable glTF property/,
    ],
    [
      (d) => (d.channels[1].target.extensions.KHR_animation_pointer.pointer = '/materials/01/alphaCutoff'),
      TypeError,
      /names no material 01/,
    ],
    [
      (d) => (d.channels[1].target.extensions.KHR_animation_pointer.pointer = '/materials/7/alphaCutoff'),
      TypeError,
      /names no material 7/,
    ],
    [
      (d) => (d.channels[1].target.extensions.KHR_animation_pointer.pointer = 'materials/0/alphaCutoff'),
      TypeError,
      /JSON pointer/,
    ],
    [
      (d) =>
        (d.channels[1].target.extensions.KHR_animation_pointer.pointer =
          d.channels[0].target.extensions.KHR_animation_pointer.pointer),
      TypeError,
      /repeats pointer/,
    ],
    [(d) => (d.channels[1].target.node = 0), TypeError, /no target node/],
    [(d) => (d.samplers[2].interpolation = 'LINEAR'), RangeError, /output values for 2 keys/],
    [(d) => (d.samplers[10].interpolation = 'LINEAR'), TypeError, /boolean; use STEP/],
    [
      (d) => d.channels.push({ sampler: 9, target: { node: 0, path: 'translation' } }),
      Error,
      /Duplicate animation target/,
    ],
  ];
  const { glb } = scene(),
    { model } = await load(t, glb),
    original = structuredClone(model.asset.doc.animations[0]);
  for (const [change, type, pattern] of cases) {
    const clip = structuredClone(original);
    change(clip);
    model.asset.doc.animations[0] = clip;
    assert.throws(
      () => new Animation(model, { pointers: pointerChannels }),
      (error) => error instanceof type && pattern.test(error.message),
    );
  }
});

test('without the pointer entry, pointer channels are skipped with the fix named and nothing is written', async (t) => {
  const { glb } = scene(),
    { model } = await load(t, glb),
    material = model.primitives[0].material,
    base = material.base.slice(),
    animation = new Animation(model, { loop: false });
  assert.equal(animation.clips[0].duration, 1, 'skipped channels still count in the duration');
  assert.equal(animation.warnings.length, 13);
  for (const warning of animation.warnings)
    assert.match(warning, /pointer \/.* is not played; pass pointers from @margoengine\/animation\/pointer/);
  animation.seek(1);
  assert.deepEqual(material.base, base);
  assert.equal(model.nodes[0].position.x, 0);
  assert.equal(model.lights[0].intensity, 1);
  // Only the pointer entry checks pointers.
  model.asset.doc.animations[0].channels[1].target.extensions.KHR_animation_pointer.pointer = '/materials/0/name';
  assert.doesNotThrow(() => new Animation(model));
  assert.throws(() => new Animation(model, { pointers: {} }), { name: 'TypeError', message: /pointerChannels/ });
});
