// Lights and cameras: a real Blender 5.2.3 export (tests/fixtures/scene.margo, made by
// tools/blender-addon/tests/blender_scene.py) carries each light and camera as a tagged node, and the components entry
// turns them into KHR_lights_punctual lights and glTF cameras that point and project as Blender's own numbers say
// (tests/fixtures/scene-truth.json: directions from Blender's world matrices, projections from calc_matrix_camera).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargo } from '../dist/index.js';
import { margoComponents } from '../dist/components.js';

const asset = decodeMargo(await readFile(new URL('./fixtures/scene.margo', import.meta.url)));
const truth = JSON.parse(await readFile(new URL('./fixtures/scene-truth.json', import.meta.url), 'utf8'));
const { document, camera, hasLights } = margoComponents(asset);
const node = (name) => document.nodes.find((n) => n.name === name);
/** The quaternion [x, y, z, w] applied to v. */
function rotate([x, y, z, w], v) {
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
const close = (actual, expected, tolerance, what) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tolerance, `${what}: ${actual} against Blender's ${expected}`));

test('each Blender light is a punctual light at its place, pointing where Blender points it', () => {
  assert.ok(hasLights);
  const lights = document.extensions.KHR_lights_punctual.lights;
  for (const [name, { direction, position }] of Object.entries(truth.lights)) {
    const n = node(name);
    close(rotate(n.rotation, [0, 0, -1]), direction, 1e-6, `${name} direction`);
    close(n.translation, position, 1e-5, `${name} position`);
  }
  const sun = lights[node('Sun').extensions.KHR_lights_punctual.light],
    spot = lights[node('Spot').extensions.KHR_lights_punctual.light],
    bulb = lights[node('Bulb').extensions.KHR_lights_punctual.light];
  // 683 lm/W: sun strength (W/m2) to lux, power over the sphere (W) to candela.
  assert.equal(sun.type, 'directional');
  assert.ok(Math.abs(sun.intensity - 3 * 683) < 1e-3);
  assert.ok(Math.abs(spot.intensity - (500 * 683) / (4 * Math.PI)) < 1e-2);
  assert.ok(Math.abs(bulb.intensity - (100 * 683) / (4 * Math.PI)) < 1e-2);
  close(spot.color, [0.2, 0.4, 1], 1e-6, 'spot colour');
  assert.ok(Math.abs(spot.spot.outerConeAngle - (25 * Math.PI) / 180) < 1e-6, 'outer cone is half the spot size');
  assert.ok(Math.abs(spot.spot.innerConeAngle - spot.spot.outerConeAngle * 0.7) < 1e-6, 'inner cone follows the blend');
  assert.equal(bulb.range, 8);
  assert.equal(sun.range, undefined);
});

test('each camera projects as Blender projects it, and the scene camera is the one the scene opens with', () => {
  assert.equal(document.nodes[camera].name, 'View', "the scene's active camera");
  for (const [name, { position, forward, up, projection }] of Object.entries(truth.cameras)) {
    const n = node(name),
      def = document.cameras[n.camera];
    close(n.translation, position, 1e-5, `${name} position`);
    close(rotate(n.rotation, [0, 0, -1]), forward, 1e-6, `${name} forward`);
    close(rotate(n.rotation, [0, 1, 0]), up, 1e-6, `${name} up`);
    // Blender's projection rows: [0][0] and [1][1] are the x and y scales.
    if (def.type === 'perspective') {
      assert.ok(Math.abs(def.perspective.yfov - 2 * Math.atan(1 / projection[1][1])) < 1e-6, `${name} yfov`);
      assert.ok(Math.abs(def.perspective.aspectRatio - projection[1][1] / projection[0][0]) < 1e-6, `${name} aspect`);
      assert.deepEqual([def.perspective.znear, def.perspective.zfar].map((v) => +v.toFixed(5)), [0.05, 60]);
    } else {
      assert.ok(Math.abs(def.orthographic.ymag - 1 / projection[1][1]) < 1e-6, `${name} ymag`);
      assert.ok(Math.abs(def.orthographic.xmag - 1 / projection[0][0]) < 1e-6, `${name} xmag`);
    }
  }
});

test('camera tags it cannot read fail by object name', () => {
  const tagged = (properties) => {
    const doc = structuredClone(asset.document);
    doc.nodes.find((n) => n.name === 'View').extras.margo.properties = properties;
    return { ...asset, document: doc };
  };
  const rejects = (properties, message) =>
    assert.throws(() => margoComponents(tagged(properties)), (e) => e.name === 'TypeError' && e.message.includes("Object 'View'") && e.message.includes(message));
  rejects({ 'margo:camera': 'fisheye' }, 'one of perspective, orthographic');
  rejects({ 'margo:camera': 'perspective', 'margo:yfov': 4 }, 'below pi');
  rejects({ 'margo:camera': 'perspective', 'margo:znear': 2, 'margo:zfar': 1 }, 'above margo:znear');
  rejects({ 'margo:camera': 'orthographic', 'margo:ymag': 2 }, "'margo:zfar' must be set");
  rejects({ 'margo:yfov': 1 }, 'on an object with margo:camera');
  rejects({ 'margo:camera': 'perspective', 'margo:active': 'yes' }, 'true or false');
  rejects({ 'margo:camra': 'perspective' }, "did you mean 'margo:camera'");
  rejects({ 'margo:camera': 'perspective', 'margo:light': 'point' }, 'without margo:light');
});

test('a scene without cameras names none', () => {
  const doc = structuredClone(asset.document);
  for (const n of doc.nodes) if (n.extras.margo.properties['margo:camera']) n.extras.margo.properties = {};
  assert.equal(margoComponents({ ...asset, document: doc }).camera, undefined);
});
