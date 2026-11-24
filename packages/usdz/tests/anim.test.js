// Time samples against OpenUSD. fixtures/anim/openusd.json holds world matrices and visibility from its public API over three
// real files and cases.usda, a stand-in written here for what they lack: blocks, wide turns, a pop-in, late visibility.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { animation } from '../dist/anim.js';
import { parseUSDFiles } from '../dist/compose.js';
import { skeletons } from '../dist/skel.js';
import { nodeAt, pose, shown } from './pose.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  truth = JSON.parse(readFileSync(join(fixtures, 'anim', 'openusd.json'), 'utf8'));
const open = (file, extensions = [animation()], text) => {
  const path = join(fixtures, ...file.split('/')),
    folder = dirname(path);
  return parseUSDFiles(path.split(sep).at(-1), (id) => {
    if (text) return new TextEncoder().encode(text);
    const at = resolve(folder, id);
    return existsSync(at) ? new Uint8Array(readFileSync(at)) : undefined;
  }, { extensions });
};
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const keysOf = (asset, id, path) => {
  const { channels, samplers } = asset.document.animations[0],
    channel = channels.find((c) => c.target.node === id && c.target.path === path);
  return channel && asset.document.accessors[samplers[channel.sampler].input].count;
};

for (const [file, want] of Object.entries(truth))
  test(`transforms and visibility play as OpenUSD computes them: ${file}`, async () => {
    const asset = await open(file),
      base = asset.document.nodes[0].matrix,
      unit = Math.hypot(base[0], base[1], base[2]),
      start = Math.min(want.start ?? Infinity, want.first);
    for (const [path, prim] of Object.entries(want.prims)) {
      // A prim never shown has no node, and a node cannot hold shear: the tests below cover both.
      if (!prim.visible.some(Boolean) || path === '/Show/Sheared') continue;
      const id = nodeAt(asset, path);
      assert.notEqual(id, undefined, `${path} has a node`);
      want.times.forEach((time, k) => {
        const posed = pose(asset, Math.fround((time - start) / want.tcps)),
          stage = multiply(base, prim.world[k]),
          gap = Math.max(...stage.map((x, i) => Math.abs(x - posed.world[id][i]))) / unit,
          size = Math.max(1, ...prim.world[k].map(Math.abs));
        // On a time code only float32 and a file's rounded quaternions differ. Between codes a node's rotation and scale
        // cannot follow a blended matrix: with keys 9 degrees apart it dips by up to 2 sin^2(theta / 4), 3.1e-3.
        const bound = Number.isInteger(time) ? 1e-4 : 3.1e-3;
        assert.ok(gap <= bound * size, `${path} at ${time} is ${gap} off`);
        assert.equal(shown(asset, id, posed), prim.visible[k], `${path} visibility at ${time}`);
      });
    }
  });

test('a straight move keeps its two keys, and a move the keys cannot follow gets one per time code', async () => {
  const asset = await open('anim/cases.usda');
  assert.equal(keysOf(asset, nodeAt(asset, '/Show'), 'translation'), 2);
  assert.equal(keysOf(asset, nodeAt(asset, '/Show/ScaledThenMoved'), 'translation'), 11);
});

test('a wide turn keeps its turns: keys stay 45 degrees apart', async () => {
  const asset = await open('anim/cases.usda');
  assert.ok(keysOf(asset, nodeAt(asset, '/Show/Spin'), 'rotation') >= 720 / 45);
});

test('neighbouring keys take the same side, so no channel spins the long way round', async () => {
  const { document: doc, buffers } = await open('anim/cases.usda');
  for (const [i, { target }] of doc.animations[0].channels.entries()) {
    if (target.path !== 'rotation') continue;
    const sampler = doc.animations[0].samplers[i],
      data = buffers[doc.bufferViews[doc.accessors[sampler.output].bufferView].buffer];
    for (let k = 4; k < data.length; k += 4)
      assert.ok(data[k] * data[k - 4] + data[k + 1] * data[k - 3] + data[k + 2] * data[k - 2] + data[k + 3] * data[k - 1] >= 0);
  }
});

test('a pop-in from zero scale takes its rotation from the next key', async () => {
  const asset = await open('anim/cases.usda'),
    node = asset.document.nodes[nodeAt(asset, '/Show/Grow')];
  assert.ok(Math.abs(node.rotation[2] - Math.sin(Math.PI / 12)) < 1e-6);
  assert.equal(keysOf(asset, nodeAt(asset, '/Show/Grow'), 'rotation'), undefined);
});

test('a prim that starts invisible stays in the scene only with animation(), and never-shown prims stay out', async () => {
  const played = await open('anim/cases.usda'),
    still = await open('anim/cases.usda', []);
  assert.notEqual(nodeAt(played, '/Show/Late/Shown'), undefined);
  assert.equal(nodeAt(still, '/Show/Late'), undefined);
  assert.equal(nodeAt(played, '/Show/NeverShown'), undefined);
  assert.equal(played.document.nodes[nodeAt(played, '/Show/Late')].extensions.KHR_node_visibility.visible, false);
  assert.deepEqual(played.document.extensionsUsed.filter((name) => /visibility|pointer/.test(name)).sort(), ['KHR_animation_pointer', 'KHR_node_visibility']);
});

test('visibility is a boolean pointer channel: STEP and unsigned bytes', async () => {
  const { document: doc } = await open('anim/cases.usda'),
    [clip] = doc.animations,
    at = clip.channels.findIndex((c) => c.target.path === 'pointer');
  assert.equal(clip.samplers[at].interpolation, 'STEP');
  assert.equal(doc.accessors[clip.samplers[at].output].componentType, 5121);
  assert.equal(clip.channels[at].target.node, undefined);
});

test('samples that never change make no channel and leave the matrix alone', async () => {
  const asset = await open('anim/cases.usda'),
    id = nodeAt(asset, '/Show/Held');
  assert.equal(keysOf(asset, id, 'translation'), undefined);
  assert.equal(asset.document.nodes[id].matrix[12], 5);
});

test('shear over time is listed, and the file still opens', async () => {
  const { issues } = await open('anim/cases.usda');
  assert.deepEqual(issues.map((i) => i.message.split(' ').slice(0, 4).join(' ')), ['the transform of /Show/Sheared']);
});

test('one clip carries transforms and joints', async () => {
  const asset = await open('skel/cases.usda', [skeletons(), animation()]);
  assert.equal(asset.document.animations.length, 1);
});

test('a lead-in past what float32 times can hold starts the clip at its first sample', async () => {
  const stage = (start) => `#usda 1.0
(
    startTimeCode = ${start}
    timeCodesPerSecond = 24
)
def Mesh "Tile"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    double3 xformOp:translate.timeSamples = { 0: (0, 0, 0), 24: (1, 0, 0) }
    uniform token[] xformOpOrder = ["xformOp:translate"]
}`,
    last = async (start) => {
      const { document: doc } = await open('anim/cases.usda', [animation()], stage(start));
      return doc.accessors[doc.animations[0].samplers[0].input].max[0];
    };
  assert.equal(await last(-24), 2);
  assert.equal(await last(-10000000), 1);
});
