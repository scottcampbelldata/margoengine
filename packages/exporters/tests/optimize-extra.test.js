import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { optimizeExtraGLB } from '@margoengine/exporters/optimize-extra';
import { joinGLB, readAccessor, splitGLB } from '../dist/glb.js';
import { validate } from './helpers.js';

async function fixture() {
  return splitGLB(await readFile(new URL('./fixtures/Box.glb', import.meta.url)));
}

function track(parts, values, width = 3, interpolation = 'LINEAR', path = 'translation') {
  const json = parts.json,
    arrays = [Float32Array.from(values.map((_, i) => i)), Float32Array.from(values.flat())];
  // Each value is one key's vector (or morph-weight row).
  arrays[0] = Float32Array.from({ length: values.length }, (_, i) => i);
  let bin = parts.bin,
    accessors = [];
  for (const [i, data] of arrays.entries()) {
    const offset = bin.length,
      next = new Uint8Array(offset + data.byteLength);
    next.set(bin);
    next.set(new Uint8Array(data.buffer), offset);
    bin = next;
    const view = json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength }) - 1;
    accessors.push(
      json.accessors.push({
        bufferView: view,
        componentType: 5126,
        type: i === 0 || path === 'weights' ? 'SCALAR' : `VEC${width}`,
        count: i === 0 ? values.length : data.length / (path === 'weights' ? 1 : width),
        ...(i === 0 ? { min: [0], max: [values.length - 1] } : {}),
      }) - 1,
    );
  }
  parts.bin = bin;
  json.buffers[0].byteLength = bin.length;
  json.animations = [
    {
      channels: [{ sampler: 0, target: { node: 1, path } }],
      samplers: [{ input: accessors[0], output: accessors[1], interpolation }],
    },
  ];
}

test('resample preserves linear trajectories and source bytes; removes all interior collinear keys', async () => {
  const parts = await fixture();
  track(parts, [
    [0, 0, 0],
    [1, 2, 3],
    [2, 4, 6],
    [3, 6, 9],
  ]);
  const source = joinGLB(parts),
    copy = source.slice(),
    result = optimizeExtraGLB(source, { instance: false });
  assert.equal(result.stats.keys, 2);
  assert.deepEqual(source, copy);
  const out = splitGLB(result.glb),
    sampler = out.json.animations[0].samplers[0];
  assert.deepEqual([...readAccessor(out, sampler.input).values], [0, 3]);
  assert.deepEqual([...readAccessor(out, sampler.output).values], [0, 0, 0, 3, 6, 9]);
  const report = await validate(result.glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('STEP discontinuities and non-collinear linear keys remain intact', async () => {
  const parts = await fixture();
  track(
    parts,
    [
      [0, 0, 0],
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 0],
    ],
    3,
    'STEP',
  );
  const out = splitGLB(optimizeExtraGLB(joinGLB(parts), { instance: false }).glb);
  assert.deepEqual([...readAccessor(out, out.json.animations[0].samplers[0].input).values], [0, 2, 3]);
  const bent = await fixture();
  track(bent, [
    [0, 0, 0],
    [1, 9, 0],
    [2, 0, 0],
  ]);
  assert.equal(optimizeExtraGLB(joinGLB(bent)).stats.keys, 0);
});

test('rotation arcs, morph rows and shared sampler accessors reduce independently', async () => {
  const parts = await fixture();
  track(
    parts,
    [
      [0, 0, 0, 1],
      [0, 0, 0, -1],
      [0, 0, 0, 1],
    ],
    4,
    'LINEAR',
    'rotation',
  );
  assert.equal(optimizeExtraGLB(joinGLB(parts)).stats.keys, 1);
  const weights = await fixture();
  track(
    weights,
    [
      [0, 1],
      [0.5, 0.5],
      [1, 0],
    ],
    2,
    'LINEAR',
    'weights',
  );
  const out = splitGLB(optimizeExtraGLB(joinGLB(weights)).glb),
    sampler = out.json.animations[0].samplers[0];
  assert.equal(out.json.accessors[sampler.output].count, 4);
  assert.deepEqual([...readAccessor(out, sampler.output).values], [0, 1, 1, 0]);
});

test('prune removes unreachable nodes, material texture chains and binary bytes', async () => {
  const parts = await fixture(),
    j = parts.json;
  j.nodes.push({ mesh: j.meshes.length });
  j.meshes.push(structuredClone(j.meshes[0]));
  j.materials.push({ name: 'unused', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
  j.textures = [{ source: 0, sampler: 0 }];
  j.samplers = [{}];
  j.images = [{ uri: 'unused.png' }];
  const source = joinGLB(parts),
    result = optimizeExtraGLB(source, { instance: false }),
    out = splitGLB(result.glb).json;
  assert.equal(out.nodes.length, 2);
  assert.equal(out.meshes.length, 1);
  assert.equal(out.materials.length, 1);
  assert.equal(out.textures, undefined);
  assert.equal(out.images, undefined);
  assert.ok(result.glb.length < source.length);
  assert.ok(result.stats.resources >= 5);
});

test('instances preserve parent transforms, children and animated mesh nodes', async () => {
  const parts = await fixture(),
    j = parts.json;
  j.nodes[0].children = [];
  for (let i = 0; i < 10; i++) j.nodes[0].children.push(j.nodes.push({ mesh: 0, translation: [i, 2, 3] }) - 1);
  const result = optimizeExtraGLB(joinGLB(parts)),
    out = splitGLB(result.glb);
  assert.equal(result.stats.instances, 10);
  assert.equal(result.stats.batches, 1);
  const batch = out.json.nodes.find((n) => n.extensions?.EXT_mesh_gpu_instancing);
  assert.deepEqual(
    [...readAccessor(out, batch.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION).values],
    Array.from({ length: 10 }, (_, i) => [i, 2, 3]).flat(),
  );
  assert.ok(out.json.extensionsRequired.includes('EXT_mesh_gpu_instancing'));
  assert.equal(out.json.nodes.filter((n) => n.mesh !== undefined).length, 1);
  const report = await validate(result.glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('multi-scene shared nodes and opaque extension references are never destructively rewritten', async () => {
  const parts = await fixture(),
    j = parts.json;
  j.nodes = [{ mesh: 0 }, { mesh: 0 }];
  j.scenes = [{ nodes: [0, 1] }, { nodes: [0, 1] }];
  assert.equal(optimizeExtraGLB(joinGLB(parts)).stats.instances, 0);
  j.extensionsUsed = ['VENDOR_links'];
  j.extensions = { VENDOR_links: { node: 1, accessor: 0 } };
  const out = splitGLB(optimizeExtraGLB(joinGLB(parts)).glb);
  assert.deepEqual(out.json.extensions, j.extensions);
  assert.deepEqual(out.json.nodes, j.nodes);
});

test('abort and invalid batch options fail before doing work', async () => {
  const bytes = joinGLB(await fixture());
  assert.throws(() => optimizeExtraGLB(bytes, { minInstances: 1 }), /MARGO_EXPORT_OPTIMIZE_MIN/);
  assert.throws(() => optimizeExtraGLB(bytes, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('prune retains skins reached through animation targets and their ancestors', async () => {
  for (const targetIsAncestor of [false, true]) {
    const parts = await fixture(), j = parts.json;
    const attributes = j.meshes[0].primitives[0].attributes, count = j.accessors[attributes.POSITION].count;
    for (const [name, data, componentType] of [
      ['JOINTS_0', new Uint8Array(count * 4), 5121],
      ['WEIGHTS_0', Float32Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 5126],
    ]) {
      const offset = parts.bin.length, bin = new Uint8Array(offset + data.byteLength);
      bin.set(parts.bin); bin.set(new Uint8Array(data.buffer), offset); parts.bin = bin;
      const bufferView = j.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength }) - 1;
      attributes[name] = j.accessors.push({ bufferView, componentType, count, type: 'VEC4' }) - 1;
    }
    const root = j.nodes.push({ name: 'joint-root', children: [j.nodes.length + 1] }) - 1;
    const joint = j.nodes.push({ name: 'joint' }) - 1;
    const skinned = j.nodes.push({ name: 'animated-skin', mesh: 0, skin: 0, translation: [2, 3, 4] }) - 1;
    const target = targetIsAncestor ? j.nodes.push({ name: 'animated-child' }) - 1 : skinned;
    if (targetIsAncestor) j.nodes[skinned].children = [target];
    j.skins = [{ joints: [joint], skeleton: root }];
    track(parts, [[0, 0, 0], [1, 0, 0]]);
    j.animations[0].channels[0].target.node = target;
    const source = joinGLB(parts), before = await validate(source);
    assert.equal(before.errors, 0, JSON.stringify(before.messages));
    const result = optimizeExtraGLB(source, { instance: false });
    const out = splitGLB(result.glb).json;
    const owner = out.nodes.find(n => n.name === 'animated-skin');
    assert.deepEqual(owner.translation, [2, 3, 4]);
    const skin = out.skins[owner.skin];
    assert.equal(out.nodes[skin.joints[0]]?.name, 'joint');
    assert.equal(out.nodes[skin.skeleton]?.name, 'joint-root');
    assert.deepEqual(out.nodes[skin.skeleton].children, skin.joints);
    assert.equal(out.nodes[out.animations[0].channels[0].target.node].name, targetIsAncestor ? 'animated-child' : 'animated-skin');
    const after = await validate(result.glb);
    assert.equal(after.errors, 0, JSON.stringify(after.messages));
  }
});
