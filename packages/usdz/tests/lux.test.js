// UsdLux lights and UsdGeom cameras. fixtures/lux/openusd.json holds what OpenUSD's public API says of cases.usda, a stand-in
// written here: world matrices, and each camera's field of view through Gf.Camera. Light strength has no outside tool, so
// those numbers are worked by hand from the LightAPI page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseUSDFiles } from '../dist/compose.js';
import { blackbody, domeLight, lights } from '../dist/lux.js';

const folder = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lux'),
  truth = JSON.parse(readFileSync(join(folder, 'openusd.json'), 'utf8'));
const stage = (body, head = 'metersPerUnit = 1\n    upAxis = "Y"', extensions = [lights()]) =>
  parseUSDFiles('root.usda', () => new TextEncoder().encode(`#usda 1.0\n(\n    ${head}\n)\n${body}`), { extensions });
const TRIANGLE = `def Mesh "M"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}
`;
const lightOf = (asset, path) => {
  const { lights: list } = asset.document.extensions.KHR_lights_punctual;
  return list.find((l) => l.name === path);
};
const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b)), `${message ?? ''} ${a} is not ${b}`);
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const worlds = (asset) => {
  const { nodes } = asset.document,
    out = new Map(),
    walk = (id, parent) => {
      const world = mul(parent, nodes[id].matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      out.set(id, world);
      for (const child of nodes[id].children ?? []) walk(child, world);
    };
  walk(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
};

test('lights and cameras stand where OpenUSD puts them, and cameras see what it says', async () => {
  const asset = await parseUSDFiles('cases.usda', (id) => new Uint8Array(readFileSync(join(folder, id))), { extensions: [lights()] }),
    { nodes, cameras, extensions } = asset.document,
    world = worlds(asset),
    root = nodes[0].matrix,
    defs = extensions.KHR_lights_punctual.lights,
    nodeOf = new Map();
  nodes.forEach((node, id) => {
    const light = node.extensions?.KHR_lights_punctual?.light;
    if (light !== undefined) nodeOf.set(defs[light].name, id);
    if (node.camera !== undefined) nodeOf.set(cameras[node.camera].name, id);
  });
  const unit = Math.hypot(root[0], root[1], root[2]);
  for (const [path, want] of Object.entries(truth)) {
    const id = nodeOf.get(path);
    assert.notEqual(id, undefined, path);
    const expected = mul(root, want.world);
    for (let i = 0; i < 16; i++) close(world.get(id)[i], expected[i], `${path} matrix ${i}`);
    if (want.vfov === undefined) continue;
    const { perspective } = cameras[nodes[id].camera];
    close((perspective.yfov * 180) / Math.PI, want.vfov, `${path} field of view`);
    close(perspective.aspectRatio, want.aspect, `${path} aspect`);
    close(perspective.znear / unit, want.near, `${path} near`);
    close(perspective.zfar / unit, want.far, `${path} far`);
  }
});

test('a sphere shows its disc: luminance times pi r^2, in candela', async () => {
  const asset = await stage(`${TRIANGLE}def SphereLight "L"\n{\n    float inputs:intensity = 3\n    float inputs:exposure = 2\n    float inputs:radius = 2\n    color3f inputs:color = (1, 0.5, 0.25)\n}`),
    light = lightOf(asset, '/L');
  assert.equal(light.type, 'point');
  close(light.intensity, 3 * 4 * Math.PI * 4);
  assert.deepEqual(light.color, [1, 0.5, 0.25]);
});

test('normalize divides by the whole surface, the transform stack included', async () => {
  const asset = await stage(`${TRIANGLE}def Xform "X"\n{\n    double3 xformOp:scale = (2, 2, 2)\n    uniform token[] xformOpOrder = ["xformOp:scale"]\n    def SphereLight "L"\n    {\n        float inputs:intensity = 8\n        bool inputs:normalize = 1\n        float inputs:radius = 1\n    }\n    def RectLight "R"\n    {\n        float inputs:width = 3\n        float inputs:height = 2\n    }\n}`);
  // A sphere shows a quarter of its surface, at any size.
  close(lightOf(asset, '/X/L').intensity, 8 / 4);
  // 3 by 2 at twice the size.
  close(lightOf(asset, '/X/R').intensity, 6 * 2 * 2);
});

test('a distant light gives lux, from the disc it fills, and normalize leaves its luminance', async () => {
  const asset = await stage(`${TRIANGLE}def DistantLight "D"\n{\n}\ndef DistantLight "N"\n{\n    float inputs:intensity = 2\n    bool inputs:normalize = 1\n}\ndef DistantLight "W"\n{\n    float inputs:angle = 240\n    float inputs:intensity = 1\n}`),
    half = (0.53 * Math.PI) / 360;
  assert.equal(lightOf(asset, '/D').type, 'directional');
  close(lightOf(asset, '/D').intensity, 50000 * Math.sin(half) ** 2 * Math.PI);
  close(lightOf(asset, '/N').intensity, 2);
  // Past a half sphere the page's second form holds: (2 - sin^2) pi at 120 degrees.
  close(lightOf(asset, '/W').intensity, (2 - Math.sin((120 * Math.PI) / 180) ** 2) * Math.PI);
});

test('a cone under 90 degrees makes a spot, its softness the inner angle', async () => {
  const asset = await stage(`${TRIANGLE}def DiskLight "S" (\n    prepend apiSchemas = ["ShapingAPI"]\n)\n{\n    float inputs:shaping:cone:angle = 30\n    float inputs:shaping:cone:softness = 0.5\n}`),
    light = lightOf(asset, '/S');
  assert.equal(light.type, 'spot');
  close(light.spot.outerConeAngle, Math.PI / 6);
  close(light.spot.innerConeAngle, Math.PI / 12);
});

test('colour temperature follows OpenUSD within 0.3 percent from 2000 to 10000 kelvin', () => {
  for (const [kelvin, want] of Object.entries(JSON.parse(readFileSync(join(folder, 'blackbody.json'), 'utf8')))) {
    if (+kelvin < 2000) continue;
    blackbody(+kelvin).forEach((c, i) => {
      // Krystek's fit is good to about this, and the blue of warm light is near zero, so small values get an absolute bound.
      assert.ok(Math.abs(c - want[i]) <= Math.max(0.003 * want[i], 0.0025), `${kelvin} K channel ${i}: ${c} is not ${want[i]}`);
    });
  }
  assert.deepEqual(blackbody(20000), blackbody(10000));
});

test('colour temperature tints the light, and a colour past 1 moves into its strength', async () => {
  const asset = await stage(`${TRIANGLE}def SphereLight "L"\n{\n    bool inputs:enableColorTemperature = 1\n    float inputs:colorTemperature = 3000\n}`),
    light = lightOf(asset, '/L'),
    tint = blackbody(3000);
  close(Math.max(...light.color), 1);
  close(light.intensity, Math.PI * 0.25 * tint[0]);
  close(light.color[2], tint[2] / tint[0]);
});

test('a stage of a camera alone opens; a stage of nothing still fails', async () => {
  const asset = await stage('def Camera "C"\n{\n}');
  assert.equal(asset.document.cameras.length, 1);
  await assert.rejects(stage('def Xform "X"\n{\n}'), /no renderable meshes/);
});

test('without the entry nothing of it is in the document', async () => {
  const asset = await stage(`${TRIANGLE}def SphereLight "L"\n{\n}\ndef Camera "C"\n{\n}`, undefined, []);
  assert.equal(asset.document.cameras, undefined);
  assert.equal(asset.document.extensions?.KHR_lights_punctual, undefined);
});

test('an orthographic camera takes its size in tenths of a unit', async () => {
  const asset = await stage(`${TRIANGLE}def Camera "C"\n{\n    token projection = "orthographic"\n    float horizontalAperture = 40\n    float verticalAperture = 20\n}`),
    { orthographic } = asset.document.cameras[0];
  assert.equal(asset.document.cameras[0].type, 'orthographic');
  close(orthographic.xmag, 2);
  close(orthographic.ymag, 1);
});

test('a dome light is listed and handed back as data', async () => {
  const asset = await stage(`${TRIANGLE}def DomeLight "D"\n{\n    float inputs:intensity = 2\n    float inputs:exposure = 1\n    asset inputs:texture:file = @sky.hdr@\n}`);
  assert.ok(asset.issues.some((i) => /dome light/.test(i.message)));
  const dome = domeLight(asset);
  assert.equal(dome.path, '/D');
  assert.equal(dome.intensity, 4);
  assert.match(dome.file, /sky\.hdr/);
});
