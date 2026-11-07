// UsdSkel against OpenUSD's own skinned points. fixtures/skel/openusd.json holds what its public UsdSkel.Cache and
// BlendShapeQuery give at five times, over two real rigged files and cases.usda, a stand-in written here for what they lack.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeUSDFiles, parseUSDFiles } from '../dist/compose.js';
import { skeletons } from '../dist/skel.js';
import { nodeOf, pose, transform, vertices } from './pose.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  truth = JSON.parse(readFileSync(join(fixtures, 'skel', 'openusd.json'), 'utf8'));
const open = (file) => {
  const path = join(fixtures, ...file.split('/')),
    folder = dirname(path);
  return parseUSDFiles(path.split(sep).at(-1), (id) => {
    const at = resolve(folder, id);
    return existsSync(at) ? new Uint8Array(readFileSync(at)) : undefined;
  }, { extensions: [skeletons()] });
};

for (const [file, want] of Object.entries(truth))
  test(`a skinned stage moves as OpenUSD computes it: ${file}`, async () => {
    const asset = await open(file),
      base = asset.document.nodes[0].matrix,
      key = (p) => p.map((x) => (+x.toFixed(5) + 0).toFixed(5)).join(' ');
    assert.deepEqual(asset.issues, []);
    assert.ok(asset.document.animations[0].channels.length);
    for (const [path, mesh] of Object.entries(want.meshes)) {
      const id = nodeOf(asset, path),
        ours = asset.meshes.find((m) => m.path === path),
        points = new Map();
      mesh.rest.forEach((p, i) => {
        const list = points.get(key(p));
        if (list) list.push(i);
        else points.set(key(p), [i]);
      });
      const behind = Array.from({ length: ours.positions.length / 3 }, (_, v) =>
        points.get(key(Array.from(ours.positions.subarray(v * 3, v * 3 + 3)))),
      );
      assert.ok(behind.every(Boolean), `${path} has the points OpenUSD has`);
      want.times.forEach((time, k) => {
        const posed = vertices(asset, id, pose(asset, (time - want.start) / want.tcps));
        posed.forEach((p, v) => {
          // float32 joints and offsets over a figure a few units tall, and truth stored to five places.
          const gap = Math.min(...behind[v].map((i) => Math.hypot(...transform(base, mesh.frames[k][i]).map((x, d) => x - p[d]))));
          assert.ok(gap < 1e-3 * want.meters, `${path} vertex ${v} at ${time} is ${gap} off`);
        });
      });
    }
  });

test('a binding outside a SkelRoot means nothing, and a skinned mesh ignores its own transform', async () => {
  const asset = await open('skel/cases.usda'),
    outside = asset.document.nodes[nodeOf(asset, '/Outside')],
    strip = asset.document.nodes[nodeOf(asset, '/Rig/Strip')];
  assert.equal(outside.skin, undefined);
  assert.notEqual(strip.skin, undefined);
  assert.equal(strip.matrix[12], 100);
});

test('an in-between gets a morph target of its own and a key where a weight crosses it', async () => {
  const asset = await open('skel/cases.usda'),
    id = nodeOf(asset, '/Rig/Strip'),
    { mesh } = asset.document.nodes[id];
  assert.equal(asset.document.meshes[mesh].primitives[0].targets.length, 3);
  const { channels, samplers } = asset.document.animations[0],
    channel = channels.find((c) => c.target.path === 'weights'),
    input = asset.document.accessors[samplers[channel.sampler].input];
  // Keys 0, 2, 4, 8, and weight 0.5 and 1 crossed by Lift, 0 crossed twice by Bulge.
  assert.ok(input.count > 4);
});

test('the clip takes its name from the default prim and its seconds from timeCodesPerSecond', async () => {
  const asset = await open('skel/cases.usda'),
    [clip] = asset.document.animations;
  assert.equal(clip.name, 'Rig');
  assert.equal(asset.document.accessors[clip.samplers[0].input].max[0], 2);
});

const influences = (count) => `#usda 1.0
def SkelRoot "Rig" {
  def Skeleton "Bones" {
    uniform token[] joints = [${Array.from({ length: count }, (_, i) => `"J${i}"`).join(', ')}]
    uniform matrix4d[] bindTransforms = [${Array(count).fill('((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1))').join(', ')}]
  }
  def Mesh "Tri" {
    uniform token subdivisionScheme = "none"
    rel skel:skeleton = </Rig/Bones>
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
    int[] primvars:skel:jointIndices = [${Array.from({ length: count }, (_, i) => i).join(', ')}] (elementSize = ${count}; interpolation = "constant")
    float[] primvars:skel:jointWeights = [${Array.from({ length: count }, (_, i) => i + 1).join(', ')}] (elementSize = ${count}; interpolation = "constant")
  }
}`;
const stage = (text) =>
  parseUSDFiles('root.usda', (id) => (id === 'root.usda' ? new TextEncoder().encode(text) : undefined), { extensions: [skeletons()] });

test('past eight influences the strongest stay, keep the total, and the import says so', async () => {
  const asset = await stage(influences(10)),
    { attributes } = asset.document.meshes[0].primitives[0],
    read = (accessor) => asset.buffers[asset.document.bufferViews[asset.document.accessors[accessor].bufferView].buffer];
  assert.ok(asset.issues.some((i) => /more than 8 influences/.test(i.message)));
  const total = [...read(attributes.WEIGHTS_0).subarray(0, 4), ...read(attributes.WEIGHTS_1).subarray(0, 4)];
  assert.equal(Math.round(total.reduce((a, b) => a + b, 0) * 1e4) / 1e4, 55);
  assert.equal(read(attributes.JOINTS_0)[0], 9);
});

test('up to four influences take one set, eight take two', async () => {
  const four = (await stage(influences(4))).document.meshes[0].primitives[0].attributes,
    eight = (await stage(influences(8))).document.meshes[0].primitives[0].attributes;
  assert.equal(four.JOINTS_1, undefined);
  assert.notEqual(eight.JOINTS_1, undefined);
});

test('a skeleton that cannot be used is listed and the mesh stays', async () => {
  const asset = await stage(influences(2).replace(/uniform matrix4d\[\] bindTransforms.*/, ''));
  assert.ok(asset.issues.some((i) => /no usable joints/.test(i.message)));
  assert.equal(asset.meshes.length, 1);
});

test('without the entry the same stage has no skin', async () => {
  const { specs } = await composeUSDFiles('root.usda', () => new TextEncoder().encode(influences(2)));
  assert.equal(specs['/Rig/Tri'].fields.typeName, 'Mesh');
});
