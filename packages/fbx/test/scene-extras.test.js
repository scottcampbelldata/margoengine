// Cameras and lights: real Blender exports checked against the numbers Blender itself reports, then the FBX SDK's other
// camera modes on hand-written files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import validator from 'gltf-validator';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { headlessEngine } from '../../exporters/tests/helpers.js';
import { convertFBX, parseFBX } from '../dist/index.js';
import { sceneExtras } from '../dist/scene-extras.js';
import { modelFromPrepared } from '../../gltf-pro/dist/worker.js';
import { readGLB } from './native-scene-helper.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const file = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  truth = JSON.parse(file('blender-shot.json')),
  extensions = [sceneExtras];

/** Blender's Z-up axes in glTF's Y-up ones. */
const glTFAxes = ([x, y, z]) => [x, z, -y];

function near(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${label}: ${actual} vs ${expected}`));
}

async function shot(name) {
  const buffer = await convertFBX(file(name), { extensions }),
    { doc, bin } = readGLB(buffer),
    engine = await headlessEngine(),
    model = new PBRModel(engine, new GLTFAsset(doc, [bin]));
  engine.store.tick(false);
  return { buffer, doc, model };
}

// Rotation and position of a light or camera node, from the world matrix the engine computed.
function pose(model, node) {
  const m = model.nodes[node].worldMatrix ?? model.nodes[node].matrix;
  return { position: [m[12], m[13], m[14]], forward: [-m[8], -m[9], -m[10]], up: [m[4], m[5], m[6]] };
}

for (const name of ['blender-shot.fbx', 'blender-shot-zup.fbx'])
  test(`${name}: the file's cameras and lights land where Blender has them`, async () => {
    const { buffer, doc, model } = await shot(name);
    const report = await validator.validateBytes(new Uint8Array(buffer));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
    assert.deepEqual(model.cameras.map((c) => c.name).sort(), ['Hero', 'Top']);
    assert.deepEqual(model.lights.map((l) => l.name).sort(), ['Beam', 'Bulb', 'Panel', 'Sky']);
    // Float32 keys and matrices across two rigid transforms: a few ulps of values near 10, so 1e-5 is far from either side.
    const check = (entry, label) => {
      const seen = pose(model, entry.nodeIndex),
        want = truth[label];
      near(seen.position, glTFAxes(want.position), 1e-5, `${label} position`);
      near(seen.forward, glTFAxes(want.forward), 1e-5, `${label} forward`);
      // A light has no up; a camera does.
      if (entry.perspective || entry.orthographic) near(seen.up, glTFAxes(want.up), 1e-5, `${label} up`);
    };
    const hero = model.cameras.find((c) => c.name === 'Hero'),
      top = model.cameras.find((c) => c.name === 'Top');
    check(hero, 'Hero');
    check(top, 'Top');
    check(model.lights.find((l) => l.name === 'Beam'), 'Beam');
    check(model.lights.find((l) => l.name === 'Sky'), 'Sky');
    // The file holds degrees and inches as doubles from Float32 values: 1e-6 of a radian covers the rounding.
    assert.ok(Math.abs(hero.perspective.yfov - truth.Hero.yfov) < 1e-6);
    assert.ok(Math.abs(hero.perspective.znear - 0.25) < 1e-6);
    assert.ok(Math.abs(hero.perspective.zfar - 250) < 1e-4);
    assert.equal(hero.perspective.aspectRatio, 1920 / 1080);
    assert.equal(top.type, 'orthographic');
    assert.ok(Math.abs(top.orthographic.xmag - truth.Top.xmag) < 1e-6);
    assert.ok(Math.abs(top.orthographic.ymag - (truth.Top.xmag * 1080) / 1920) < 1e-6);
    const lights = Object.fromEntries(model.lights.map((l) => [l.name, l]));
    assert.equal(lights.Bulb.type, 'point');
    assert.equal(lights.Sky.type, 'directional');
    assert.equal(lights.Beam.type, 'spot');
    assert.equal(lights.Panel.type, 'point');
    assert.equal(lights.Panel.extras.fbxLightType, 3);
    near(lights.Bulb.color, truth.BulbData.color, 1e-6, 'Bulb colour');
    near(lights.Sky.color, truth.SunData.color, 1e-6, 'Sky colour');
    // Blender leaves a white light's colour out, and the file's template holds another class's grey.
    near(lights.Beam.color, truth.SpotData.color, 0, 'Beam colour');
    assert.equal(lights.Bulb.intensity, truth.BulbData.energy);
    assert.equal(lights.Sky.intensity, truth.SunData.energy);
    near([lights.Beam.spot.outerConeAngle], [truth.SpotData.outer], 1e-6, 'outer cone');
    near([lights.Beam.spot.innerConeAngle], [truth.SpotData.inner], 1e-6, 'inner cone');
    // The dolly's keys sit on the camera's own node, above the helper that turns it to glTF's -Z.
    const clip = doc.animations[0],
      moved = clip.channels.filter((c) => doc.nodes[c.target.node].name === 'Hero');
    assert.ok(moved.some((c) => c.target.path === 'translation'));
  });

test('without the extension a file keeps its old result: no cameras, no lights', async () => {
  const { doc } = readGLB(await convertFBX(file('blender-shot.fbx')));
  assert.equal(doc.cameras, undefined);
  assert.equal(doc.extensions?.KHR_lights_punctual, undefined);
  assert.ok(!doc.nodes.some((node) => node.name === 'Hero camera'));
});

test('curves on a lens or a light are left out, not refused', async () => {
  const curves = `
 AnimationStack: 50, "AnimStack::Take", "" {
 }
 AnimationLayer: 51, "AnimLayer::Base", "" {
 }
 AnimationCurveNode: 52, "AnimCurveNode::Lens", "" {
 }
 AnimationCurve: 53, "AnimCurve::", "" {
  KeyTime: *2 {
   a: 0,46186158000
  }
  KeyValueFloat: *2 {
   a: 35,50
  }
 }`;
  const links = `
 C: "OO",51,50
 C: "OO",52,51
 C: "OP",52,10,"FocalLength"
 C: "OP",53,52,"d|FocalLength"`;
  const glb = await convertFBX(fbx([cameraAttribute(number('FieldOfView', 40)), curves], links), {
    extensions,
  });
  assert.equal(json(glb).cameras.length, 1);
  assert.equal(json(glb).animations, undefined);
});

// A camera on a model, in ASCII, with the given settings.
function fbx(objects, links = '', settings = '') {
  return new TextEncoder().encode(`; FBX 7.4.0 project file
FBXHeaderExtension:  {
 FBXVersion: 7400
}
GlobalSettings:  {
 Properties70:  {
  P: "UnitScaleFactor", "double", "Number", "", 1
  ${settings}
 }
}
Objects:  {
 Model: 1, "Model::Shot", "Camera" {
 }
 ${objects.join('\n')}
}
Connections:  {
 C: "OO",1,0
 C: "OO",10,1
 ${links}
}
`);
}
const cameraAttribute = (...lines) => `NodeAttribute: 10, "NodeAttribute::Shot", "Camera" {
  Properties70:  {
   ${lines.join('\n   ')}
  }
 }`;
const lightAttribute = (...lines) => `NodeAttribute: 10, "NodeAttribute::Lamp", "Light" {
  Properties70:  {
   ${lines.join('\n   ')}
  }
 }`;
const number = (name, value) => `P: "${name}", "double", "Number", "", ${value}`;
// A file of cameras and lights has no binary chunk, which readGLB expects.
const json = (glb) => JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))));
const read = async (bytes) => json(await convertFBX(bytes, { extensions }));

test('a file with only a camera converts with the extension and still reports no mesh without it', async () => {
  const bytes = fbx([cameraAttribute(number('FieldOfView', 40))]);
  await assert.rejects(convertFBX(bytes), /no mesh geometry/);
  assert.equal((await read(bytes)).cameras.length, 1);
  // gltf-pro's model needs a mesh to draw, so such a file stops at the GLB, with its error.
  await assert.rejects(parseFBX(await headlessEngine(), bytes, { extensions }), /no renderable meshes/);
});

test('aperture modes: vertical, horizontal, both and focal length give the same view', async () => {
  // 40 degrees tall at 16:9 is tan(20) * 16 / 9 wide, and 24 mm of film under a lens of 12 / tan(20) mm.
  const tangent = Math.tan((20 * Math.PI) / 180),
    aspect = [number('AspectWidth', 16), number('AspectHeight', 9)],
    wide = (2 * Math.atan((tangent * 16) / 9) * 180) / Math.PI,
    mode = (value) => `P: "ApertureMode", "enum", "", "", ${value}`,
    cases = [
      [mode(2), number('FieldOfView', 40)],
      [mode(1), number('FieldOfView', wide)],
      [mode(0), number('FieldOfViewX', wide), number('FieldOfViewY', 40)],
      [mode(3), number('FocalLength', 12 / tangent), number('FilmHeight', 24 / 25.4)],
    ];
  for (const lines of cases) {
    const doc = await read(fbx([cameraAttribute(...lines, ...aspect)]));
    assert.ok(Math.abs(doc.cameras[0].perspective.yfov - (40 * Math.PI) / 180) < 1e-12, lines[0]);
  }
});

test('near and far convert with the file unit, and a far plane nearer than the near plane means no far plane', async () => {
  const lines = [number('FieldOfView', 40), number('NearPlane', 10), number('FarPlane', 5)],
    doc = await read(fbx([cameraAttribute(...lines)]));
  assert.ok(Math.abs(doc.cameras[0].perspective.znear - 0.1) < 1e-12);
  assert.equal(doc.cameras[0].perspective.zfar, undefined);
});

test('the camera GlobalSettings names is marked, so an app can open on it', async () => {
  const doc = await read(
    fbx([cameraAttribute(number('FieldOfView', 40))], '', 'P: "DefaultCamera", "KString", "", "", "Shot"'),
  );
  assert.deepEqual(doc.cameras[0].extras, { defaultCamera: true });
});

test('a camera whose view cannot be worked out is an error, with the fix', async () => {
  await assert.rejects(read(fbx([cameraAttribute(number('FieldOfView', 0))])), /camera field of view/);
  const orthographic = ['P: "CameraProjectionType", "enum", "", "", 1', number('OrthoZoom', 0)];
  await assert.rejects(read(fbx([cameraAttribute(...orthographic)])), /camera zoom/);
});

test('the orthographic zoom is metres at any file unit, across the wider side of the view', async () => {
  const orthographic = (...more) => cameraAttribute('P: "CameraProjectionType", "enum", "", "", 1', number('OrthoZoom', 8), ...more),
    of = async (text) => (await read(text)).cameras[0].orthographic;
  // Blender's default export is a centimetre file, and it still writes an 8 metre view as 8.
  const wide = await of(fbx([orthographic(number('AspectWidth', 2), number('AspectHeight', 1))]));
  assert.equal(wide.xmag, 4);
  assert.equal(wide.ymag, 2);
  const tall = await of(fbx([orthographic(number('AspectWidth', 1), number('AspectHeight', 2))]));
  assert.equal(tall.xmag, 2);
  assert.equal(tall.ymag, 4);
});

test('light defaults, attenuation range and a cone wider than glTF allows', async () => {
  const unset = await read(fbx([lightAttribute()]));
  assert.deepEqual(unset.extensions.KHR_lights_punctual.lights[0], {
    type: 'point',
    color: [1, 1, 1],
    intensity: 1,
    name: 'Shot',
    extras: { fbxLightType: 0, fbxDecayType: 0 },
  });
  const spot = await read(
    fbx([
      lightAttribute(
        'P: "LightType", "enum", "", "", 2',
        number('OuterAngle', 400),
        number('InnerAngle', 400),
        'P: "EnableFarAttenuation", "bool", "", "", 1',
        number('FarAttenuationEnd', 250),
      ),
    ]),
  );
  const light = spot.extensions.KHR_lights_punctual.lights[0];
  assert.equal(light.range, 2.5);
  assert.ok(Math.abs(light.spot.outerConeAngle - Math.PI / 2) < 1e-6);
  assert.ok(light.spot.innerConeAngle < light.spot.outerConeAngle);
  await assert.rejects(
    read(fbx([lightAttribute('P: "Color", "Color", "", "A", -1, 0, 0')])),
    /Invalid FBX light color/,
  );
});

test('the worker runs the extension when the page names it', () =>
  headlessModels(async () => {
    const worker = new URL('../dist/workers/fbx.js', import.meta.url),
      input = new Uint8Array(file('blender-shot.fbx')).buffer,
      prepared = await runParseWorker(worker, { input, resourcePath: 'https://example.test/', extensions: ['scene-extras'] }),
      model = modelFromPrepared(await headless(), prepared);
    assert.equal(model.cameras.length, 2);
    assert.equal(model.lights.length, 4);
  }));
