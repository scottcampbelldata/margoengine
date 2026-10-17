// Invalid live camera/light edits must reject before JSON can replace non-finite values with null. These tests load
// the real five-node DirectionalLight fixture; the existing device shim keeps PBRModel setup on the CPU in Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGLTF } from '@margoengine/gltf-pro';
import { exportModel } from '../dist/model.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

async function loadedScene(t) {
  const engine = await loadedPBREngine();
  t.after(() => engine.dispose());
  const bytes = await readFile(
    new URL('../../../examples/assets/khronos/DirectionalLight/DirectionalLight.glb', import.meta.url),
  );
  const model = await loadGLTF(engine, 'https://fixtures.test/DirectionalLight.glb', {
    fetch: async () => new Response(bytes),
  });
  assert.equal(model.cameras.length, 1);
  assert.equal(model.lights.length, 1);
  assert.ok(model.primitives.length > 0, 'the loaded fixture retains its real geometry');
  return model;
}

async function invalidEdits(model, record, cases) {
  const original = { ...record };
  for (const [label, edit] of cases) {
    try {
      edit(record);
      await assert.rejects(
        exportModel(model),
        (error) => error instanceof TypeError || error instanceof RangeError,
        label,
      );
    } finally {
      for (const key of Object.keys(record)) delete record[key];
      Object.assign(record, original);
    }
  }
}

test('exportModel rejects unknown camera types and missing or mismatched projection objects', async (t) => {
  const model = await loadedScene(t);
  await invalidEdits(model, model.cameras[0], [
    [
      'unknown camera type',
      (camera) => {
        camera.type = 'panorama';
      },
    ],
    [
      'null perspective',
      (camera) => {
        camera.perspective = null;
      },
    ],
    [
      'missing perspective',
      (camera) => {
        delete camera.perspective;
      },
    ],
    [
      'orthographic type with only perspective data',
      (camera) => {
        camera.type = 'orthographic';
      },
    ],
  ]);
});

test('exportModel rejects non-finite camera values and invalid required projection domains', async (t) => {
  const model = await loadedScene(t);
  await invalidEdits(model, model.cameras[0], [
    [
      'non-finite field of view',
      (camera) => {
        camera.perspective = { yfov: NaN, znear: 0.3 };
      },
    ],
    [
      'zero perspective near plane',
      (camera) => {
        camera.perspective = { yfov: 0.65, znear: 0 };
      },
    ],
    [
      'reversed perspective depth',
      (camera) => {
        camera.perspective = { yfov: 0.65, znear: 2, zfar: 1 };
      },
    ],
    [
      'non-finite aspect ratio',
      (camera) => {
        camera.perspective = { yfov: 0.65, znear: 0.3, aspectRatio: Infinity };
      },
    ],
    [
      'zero orthographic magnification',
      (camera) => {
        camera.type = 'orthographic';
        delete camera.perspective;
        camera.orthographic = { xmag: 0, ymag: 1, znear: 0, zfar: 5 };
      },
    ],
    [
      'non-finite orthographic magnification',
      (camera) => {
        camera.type = 'orthographic';
        delete camera.perspective;
        camera.orthographic = { xmag: 1, ymag: Infinity, znear: 0, zfar: 5 };
      },
    ],
    [
      'reversed orthographic depth',
      (camera) => {
        camera.type = 'orthographic';
        delete camera.perspective;
        camera.orthographic = { xmag: 1, ymag: 1, znear: 2, zfar: 1 };
      },
    ],
  ]);
});

test('exportModel rejects unsupported light types, non-finite light data and invalid spot cones', async (t) => {
  const model = await loadedScene(t);
  await invalidEdits(model, model.lights[0], [
    [
      'unknown light type',
      (light) => {
        light.type = 'area';
      },
    ],
    [
      'non-finite color',
      (light) => {
        light.color = [0.9, NaN, 0.1];
      },
    ],
    [
      'incomplete color',
      (light) => {
        light.color = [0.9, 0.8];
      },
    ],
    [
      'sparse color',
      (light) => {
        light.color = new Array(3);
      },
    ],
    [
      'non-finite intensity',
      (light) => {
        light.intensity = Infinity;
      },
    ],
    [
      'negative intensity',
      (light) => {
        light.intensity = -1;
      },
    ],
    [
      'non-finite range',
      (light) => {
        light.type = 'point';
        light.range = Infinity;
      },
    ],
    [
      'zero range',
      (light) => {
        light.type = 'point';
        light.range = 0;
      },
    ],
    [
      'reversed spot cones',
      (light) => {
        light.type = 'spot';
        light.innerConeAngle = 0.75;
        light.outerConeAngle = 0.5;
      },
    ],
    [
      'non-finite spot cone',
      (light) => {
        light.type = 'spot';
        light.innerConeAngle = 0;
        light.outerConeAngle = Infinity;
      },
    ],
  ]);
});

test('exportModel rejects camera and light records pointing outside their loaded model nodes', async (t) => {
  const model = await loadedScene(t),
    foreign = await loadedScene(t);
  await invalidEdits(model, model.cameras[0], [
    [
      'negative camera index',
      (camera) => {
        camera.nodeIndex = -1;
      },
    ],
    [
      'out-of-range camera index',
      (camera) => {
        camera.nodeIndex = model.nodes.length;
      },
    ],
    [
      'mismatched camera node',
      (camera) => {
        camera.node = model.nodes[0];
      },
    ],
  ]);
  await invalidEdits(model, model.lights[0], [
    [
      'noninteger light index',
      (light) => {
        light.nodeIndex = 0.5;
      },
    ],
    [
      'foreign light node',
      (light) => {
        light.node = foreign.lights[0].node;
      },
    ],
  ]);
});

test('exportModel returns detached projection and light-color snapshots without changing input definitions', async (t) => {
  const model = await loadedScene(t),
    camera = model.cameras[0],
    light = model.lights[0],
    { json } = await exportModel(model);
  assert.deepEqual(camera.perspective, { aspectRatio: 1.777, yfov: 0.65, zfar: 5, znear: 0.3 });
  assert.deepEqual(light.color, [0.9, 0.8, 0.1]);
  assert.ok(json.cameras?.[0]?.perspective, 'the exported snapshot contains the loaded camera projection');
  assert.ok(
    json.extensions?.KHR_lights_punctual?.lights?.[0]?.color,
    'the exported snapshot contains the loaded light color',
  );
  const projection = json.cameras[0].perspective,
    color = json.extensions.KHR_lights_punctual.lights[0].color;
  projection.yfov = 1;
  color[0] = 0.25;
  assert.equal(camera.perspective.yfov, 0.65, 'editing output projection does not edit the model');
  assert.equal(model.asset.doc.cameras[0].perspective.yfov, 0.65, 'source camera definition remains intact');
  assert.equal(light.color[0], 0.9, 'editing output color does not edit the model');
  assert.equal(model.asset.doc.extensions.KHR_lights_punctual.lights[0].color[0], 0.9);
  camera.perspective.znear = 0.5;
  light.color[1] = 0.3;
  assert.equal(projection.znear, 0.3, 'later model edits do not change an exported projection');
  assert.equal(color[1], 0.8, 'later model edits do not change an exported color');
});

test('exportModel omits hidden invalid camera and light metadata without validating or declaring it', async (t) => {
  const model = await loadedScene(t);
  model.cameras[0].node.visible = false;
  model.lights[0].node.visible = false;
  model.cameras[0].perspective = { yfov: NaN, znear: 0 };
  model.lights[0].intensity = Infinity;
  const { json } = await exportModel(model);
  assert.equal(Object.hasOwn(json, 'cameras'), false);
  assert.equal(json.extensions?.KHR_lights_punctual, undefined);
  assert.equal(json.extensionsUsed?.includes('KHR_lights_punctual') ?? false, false);
  assert.equal(json.extensionsRequired?.includes('KHR_lights_punctual') ?? false, false);
  assert.ok(json.nodes.every((node) => !Object.hasOwn(node, 'camera') && !node.extensions?.KHR_lights_punctual));
  await assert.rejects(
    exportModel(model, { onlyVisible: false }),
    (error) => error instanceof TypeError || error instanceof RangeError,
  );
});

test('exportModel accepts negative nonzero orthographic magnification and positive wide perspective fields of view', async (t) => {
  const model = await loadedScene(t),
    camera = model.cameras[0];
  camera.type = 'orthographic';
  delete camera.perspective;
  camera.orthographic = { xmag: -2, ymag: -3, znear: 0, zfar: 5 };
  const orthographic = await exportModel(model);
  assert.deepEqual(orthographic.json.cameras?.[0]?.orthographic, { xmag: -2, ymag: -3, znear: 0, zfar: 5 });
  camera.type = 'perspective';
  delete camera.orthographic;
  camera.perspective = { yfov: 4, znear: 0.3 };
  const perspective = await exportModel(model);
  assert.deepEqual(perspective.json.cameras?.[0]?.perspective, { yfov: 4, znear: 0.3 });
});
