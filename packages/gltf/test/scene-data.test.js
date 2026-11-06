import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF } from '../dist/index.js';
import { instancing } from '../dist/instancing.js';
import { sceneData, sceneExtras } from '../dist/scene-data.js';
import { documentOf, headlessEngine } from './helpers.js';

const LIGHTS = 'KHR_lights_punctual',
  half = Math.SQRT1_2;
const close = (actual, expected) =>
  [...actual].forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${i}: ${value} vs ${expected[i]}`));
function file(rest = {}) {
  return documentOf([new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    cameras: [
      { type: 'perspective', perspective: { yfov: 0.7, znear: 0.1, zfar: 50, aspectRatio: 1.5 } },
      { type: 'orthographic', orthographic: { xmag: 2, ymag: 3, znear: 0, zfar: 9 } },
      { type: 'perspective', perspective: { yfov: 1, znear: 0.5 } },
    ],
    extensions: {
      [LIGHTS]: {
        lights: [
          { type: 'directional', color: [1, 0.5, 0.25], intensity: 3, range: 4 },
          { type: 'point', range: 12 },
          { type: 'spot', spot: { innerConeAngle: 0.1, outerConeAngle: 0.4 } },
          { type: 'spot' },
        ],
      },
    },
    extensionsUsed: [LIGHTS],
    nodes: [{ mesh: 0 }],
    ...rest,
  });
}
const load = (engine, { doc, bytes }, extensions = [sceneExtras]) => parseGLTF(engine, doc, [bytes], { extensions });
const withNodes = (...extra) => {
  const input = file();
  input.doc.nodes.push(...extra);
  return input;
};
const light = (id) => ({ extensions: { [LIGHTS]: { light: id } } });

test('cameras come back as plain data, with their projection and place', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = withNodes(
        { camera: 0, name: 'main', translation: [1, 2, 3] },
        { camera: 1, rotation: [0, half, 0, half] },
        { camera: 2 },
      ),
      before = JSON.stringify(input.doc),
      model = load(engine, input),
      { cameras, lights } = sceneData(model);
    assert.equal(lights.length, 0);
    assert.equal(cameras.length, 3);
    const byType = cameras.find((c) => c.name === 'main');
    assert.equal(byType.type, 'perspective');
    assert.equal(byType.yfov, 0.7);
    assert.equal(byType.znear, 0.1);
    assert.equal(byType.zfar, 50);
    assert.equal(byType.aspectRatio, 1.5);
    assert.deepEqual(byType.position, [1, 2, 3]);
    assert.deepEqual(byType.direction.map((v) => v + 0), [0, 0, -1]);
    assert.equal(byType.node, model.nodes.find((node) => node.name === 'main'));
    const orthographic = cameras.find((c) => c.type === 'orthographic');
    assert.deepEqual([orthographic.xmag, orthographic.ymag, orthographic.znear, orthographic.zfar], [2, 3, 0, 9]);
    // Turned 90 degrees about y, -z points along -x.
    close(orthographic.direction, [-1, 0, 0]);
    const infinite = cameras.find((c) => c.yfov === 1);
    assert.equal('zfar' in infinite, false);
    assert.equal('aspectRatio' in infinite, false);
    assert.equal(infinite.name, '');
    assert.equal(JSON.stringify(input.doc), before);
    model.dispose();
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('lights come back with the extension defaults filled in', async () => {
  const { engine } = await headlessEngine();
  try {
    const model = load(engine, withNodes(light(0), light(1), light(2), { name: 'wide', ...light(3) })),
      { cameras, lights } = sceneData(model);
    assert.equal(cameras.length, 0);
    const of = (type) => lights.filter((l) => l.type === type),
      [sun] = of('directional'),
      [bulb] = of('point');
    assert.deepEqual(sun.color, [1, 0.5, 0.25]);
    assert.equal(sun.intensity, 3);
    assert.equal('range' in sun, false);
    assert.deepEqual(bulb.color, [1, 1, 1]);
    assert.equal(bulb.intensity, 1);
    assert.equal(bulb.range, 12);
    assert.equal('innerConeAngle' in bulb, false);
    const spot = of('spot').find((l) => l.name === ''),
      wide = of('spot').find((l) => l.name === 'wide');
    assert.deepEqual([spot.innerConeAngle, spot.outerConeAngle], [0.1, 0.4]);
    assert.deepEqual([wide.innerConeAngle, wide.outerConeAngle], [0, Math.PI / 4]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('placement follows the node tree, a matrix, and a scale that must not reach the direction', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = withNodes(
      { translation: [10, 0, 0], rotation: [0, half, 0, half], scale: [2, 2, 2], children: [2] },
      { translation: [0, 0, 1], camera: 0, name: 'child' },
      { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1], ...light(1) },
    );
    const model = load(engine, input),
      { cameras, lights } = sceneData(model);
    // Local +z of 1, scaled by 2 and turned to +x, from x = 10.
    close(cameras[0].position, [12, 0, 0]);
    close(cameras[0].direction, [-1, 0, 0]);
    close([Math.hypot(...cameras[0].direction)], [1]);
    assert.equal(cameras[0].matrix.length, 16);
    assert.deepEqual(lights[0].position, [4, 5, 6]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('a node with a mesh keeps it, and only nodes of the loaded scene count', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = withNodes({ mesh: 0, camera: 0, name: 'both' }, { camera: 1, name: 'elsewhere' });
    input.doc.scenes = [{ nodes: [0, 1] }, { nodes: [2] }];
    const model = load(engine, input),
      { cameras } = sceneData(model);
    assert.equal(model.meshes.length, 2);
    assert.deepEqual(
      cameras.map((c) => c.name),
      ['both'],
    );
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('other extensions on a node stay for the loader, and instancing combines in either order', async () => {
  const { engine } = await headlessEngine();
  try {
    const vendor = withNodes({ extensions: { [LIGHTS]: { light: 0 }, VENDOR_thing: {} } });
    assert.throws(() => load(engine, vendor), /gltf-pro/);
    const NAME = 'EXT_mesh_gpu_instancing';
    for (const order of [
      [sceneExtras, instancing],
      [instancing, sceneExtras],
    ]) {
      const input = withNodes({
        mesh: 0,
        camera: 0,
        translation: [0, 3, 0],
        extensions: { [NAME]: { attributes: { TRANSLATION: 0 } } },
      });
      const model = load(engine, input, order),
        { cameras } = sceneData(model);
      assert.equal(model.meshes.length, 4);
      assert.equal(cameras.length, 1);
      assert.deepEqual(cameras[0].position, [0, 3, 0]);
      model.dispose();
    }
  } finally {
    engine.dispose();
  }
});

test('without the entry nodes stay refused, and a model without it holds no data', async () => {
  const { engine } = await headlessEngine();
  try {
    const camera = withNodes({ camera: 0 });
    assert.throws(() => parseGLTF(engine, camera.doc, [camera.bytes]), /gltf-pro/);
    const required = withNodes(light(0));
    required.doc.extensionsRequired = [LIGHTS];
    assert.throws(() => parseGLTF(engine, required.doc, [required.bytes]), /gltf-pro/);
    const plain = file();
    const model = parseGLTF(engine, plain.doc, [plain.bytes]);
    assert.deepEqual(sceneData(model), { cameras: [], lights: [] });
    model.dispose();
    const loaded = load(engine, required);
    assert.equal(sceneData(loaded).lights.length, 1);
    loaded.dispose();
  } finally {
    engine.dispose();
  }
});

test('malformed cameras and lights are named errors and leave nothing behind', async () => {
  const { engine } = await headlessEngine();
  try {
    const camera = (definition) => {
      const input = withNodes({ camera: 0 });
      input.doc.cameras[0] = definition;
      return input;
    };
    const lit = (definition) => {
      const input = withNodes(light(0));
      input.doc.extensions[LIGHTS].lights[0] = definition;
      return input;
    };
    const cases = [
      [withNodes({ camera: 9 }), /Missing glTF camera/],
      [camera({ type: 'fisheye' }), /Invalid glTF camera/],
      [camera({ type: 'perspective' }), /Invalid glTF camera/],
      [camera({ type: 'perspective', perspective: { yfov: 0, znear: 1 } }), /camera yfov/],
      [camera({ type: 'perspective', perspective: { yfov: 1, znear: 0 } }), /camera znear/],
      [camera({ type: 'perspective', perspective: { yfov: 1, znear: 1, zfar: 1 } }), /camera zfar/],
      [camera({ type: 'orthographic', orthographic: { xmag: 0, ymag: 1, znear: 0, zfar: 1 } }), /camera xmag/],
      [camera({ type: 'orthographic', orthographic: { xmag: 1, ymag: 1, znear: 2, zfar: 1 } }), /camera zfar/],
      [withNodes(light(9)), /Missing glTF light/],
      [withNodes({ extensions: { [LIGHTS]: {} } }), /Invalid glTF light/],
      [lit({ type: 'neon' }), /light type/],
      [lit({ type: 'point', color: [1, 1] }), /light color/],
      [lit({ type: 'point', color: [1, 1, -1] }), /light color/],
      [lit({ type: 'point', intensity: -1 }), /light intensity/],
      [lit({ type: 'point', range: 0 }), /light range/],
      [lit({ type: 'spot', spot: { innerConeAngle: 0.5, outerConeAngle: 0.5 } }), /spot angle/],
      [lit({ type: 'spot', spot: { outerConeAngle: 2 } }), /spot angle/],
    ];
    for (const [input, message] of cases) assert.throws(() => load(engine, input), message);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});
