// Reset transform stacks against OpenUSD. fixtures/xform/reset.usda is a stand-in written by OpenUSD's own API, as none of
// the 546 real files here resets one; reset.json holds what OpenUSD's public API computes for it (oracle/reset-truth.py).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { animation } from '../dist/anim.js';
import { parseUSDFiles } from '../dist/compose.js';
import { parseUSDA } from '../dist/index.js';
import { lights } from '../dist/lux.js';
import { skeletons } from '../dist/skel.js';
import { nodeAt, nodeOf, pose, shown, vertices } from './pose.js';

const folder = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xform'),
  truth = JSON.parse(readFileSync(join(folder, 'reset.json'), 'utf8')),
  open = (extensions) =>
    parseUSDFiles(
      'reset.usda',
      (id) => {
        const at = resolve(folder, id);
        return existsSync(at) ? new Uint8Array(readFileSync(at)) : undefined;
      },
      { extensions },
    ),
  multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  };

test('the stand-in resets where OpenUSD says it does', () => {
  assert.equal(truth.resets.length, 15);
});

test('every prim of the stage plays where OpenUSD puts it, and shows when it does', async () => {
  const asset = await open([animation(), skeletons(), lights()]),
    base = asset.document.nodes[0].matrix,
    unit = Math.hypot(base[0], base[1], base[2]);
  for (const [path, prim] of Object.entries(truth.prims)) {
    const id = nodeAt(asset, path);
    assert.notEqual(id, undefined, `${path} has a node`);
    truth.times.forEach((time, k) => {
      const posed = pose(asset, Math.fround(time / truth.tcps)),
        stage = multiply(base, prim.world[k]),
        gap = Math.max(...stage.map((x, i) => Math.abs(x - posed.world[id][i]))) / unit,
        size = Math.max(1, ...prim.world[k].map(Math.abs));
      // Between time codes a node's rotation and scale cannot follow a blended matrix, as in anim.test.js.
      assert.ok(gap <= (Number.isInteger(time) ? 1e-4 : 3.1e-3) * size, `${path} at ${time} is ${gap} off`);
      assert.equal(shown(asset, id, posed), prim.visible[k], `${path} visibility at ${time}`);
    });
  }
});

test('a rig that resets skins as OpenUSD skins it', async () => {
  const asset = await open([animation(), skeletons()]),
    base = asset.document.nodes[0].matrix,
    unit = Math.hypot(base[0], base[1], base[2]),
    id = nodeOf(asset, '/World/Rig/Skin');
  truth.times.forEach((time, k) => {
    const points = vertices(asset, id, pose(asset, Math.fround(time / truth.tcps))),
      want = truth.skinned['/World/Rig/Skin'][k],
      corners = [0, 1, 2];
    for (const corner of corners) {
      const [x, y, z] = want[corner],
        stage = [0, 1, 2].map((r) => base[r] * x + base[4 + r] * y + base[8 + r] * z + base[12 + r]),
        gap = Math.max(...stage.map((v, r) => Math.abs(v - points[corner][r]))) / unit;
      assert.ok(gap <= 1e-4 * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(z)), `corner ${corner} at ${time} is ${gap} off`);
    }
  });
});

test('a node that left its parent says which prim it is', async () => {
  const asset = await open([animation()]),
    { nodes } = asset.document;
  for (const path of truth.resets) {
    const id = nodes.findIndex((node) => node.extras?.usdPath === path);
    assert.ok(id > 0, `${path} is marked`);
    assert.ok(nodes[0].children.includes(id), `${path} hangs from the stage's node`);
  }
  assert.equal(nodes.filter((node) => node.extras?.usdPath).length, truth.resets.length);
});

test('an op before the reset does not play', async () => {
  const asset = await open([animation()]),
    still = nodeAt(asset, '/World/Still'),
    moving = nodeAt(asset, '/World/Moving'),
    targets = asset.document.animations[0].channels.map((channel) => channel.target.node);
  assert.ok(targets.includes(moving));
  assert.ok(!targets.includes(still));
});

test('hidden in turn by itself and its parent, a node that reset is never shown', async () => {
  const asset = await open([animation()]),
    id = nodeAt(asset, '/Blink/Never');
  assert.ok(truth.prims['/Blink/Never'].visible.every((visible) => !visible));
  assert.equal(asset.document.nodes[id].extensions.KHR_node_visibility.visible, false);
});

test('a static layer resets without any entry', () => {
  const asset = parseUSDA(`#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Xform "Parent"
{
    double3 xformOp:translate = (10, 0, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Mesh "Pinned"
    {
        double3 xformOp:translate = (1, 2, 3)
        double3 xformOp:translate:ignored = (50, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate:ignored", "!resetXformStack!", "xformOp:translate"]
        uniform token subdivisionScheme = "none"
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
    }
}
`);
  const { nodes } = asset.document,
    id = nodes.findIndex((node) => node.name === 'Pinned');
  assert.ok(nodes[0].children.includes(id));
  assert.deepEqual(Array.from(nodes[id].matrix.slice(12, 15)), [1, 2, 3]);
});

test('samples of an op before the reset add no keys', async () => {
  const text = `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "Pinned"
{
    double3 xformOp:translate:ignored.timeSamples = { 0: (0, 0, 0), 6: (1, 0, 0), 12: (2, 0, 0), 24: (3, 0, 0) }
    double3 xformOp:translate.timeSamples = { 0: (0, 0, 0), 24: (0, 24, 0) }
    uniform token[] xformOpOrder = ["xformOp:translate:ignored", "!resetXformStack!", "xformOp:translate"]
    uniform token subdivisionScheme = "none"
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
}
`,
    asset = await parseUSDFiles('pinned.usda', () => new TextEncoder().encode(text), { extensions: [animation()] }),
    { channels, samplers } = asset.document.animations[0];
  assert.equal(channels.length, 1);
  assert.equal(asset.document.accessors[samplers[channels[0].sampler].input].count, 2);
});
