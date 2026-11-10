import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVRMA, loadVRMA, playVRMA, vrmaGaze } from '../dist/vrma.js';
import { VRMExpressions } from '../dist/vrm.js';
import { multiplyQuaternions, axisAngleToQuaternion } from '../../math/dist/quat.js';

export function fixture(interpolation = 'LINEAR') {
  const parts = [],
    doc = {
      asset: { version: '2.0' },
      nodes: [{ translation: [0, 1, 0], children: [1] }, {}, {}, {}],
      extensionsUsed: ['VRMC_vrm_animation'],
      extensionsRequired: ['VRMC_vrm_animation'],
      extensions: {
        VRMC_vrm_animation: {
          specVersion: '1.0',
          humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } },
          expressions: { preset: { happy: { node: 2 } } },
          lookAt: { node: 3 },
          extras: { copyright: 'test author' },
        },
      },
      buffers: [],
      bufferViews: [],
      accessors: [],
      animations: [{ name: 'wave', samplers: [], channels: [] }],
    };
  let offset = 0;
  const add = (values, type) => {
    const data = new Float32Array(values),
      index = doc.accessors.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: index,
      componentType: 5126,
      count: data.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4),
      type,
    });
    parts.push(new Uint8Array(data.buffer));
    offset += data.byteLength;
    return index;
  };
  const times = add([0, 1], 'SCALAR');
  for (const [node, path, first, last] of [
    [0, 'translation', [0, 1, 0], [1, 2, 0]],
    [1, 'rotation', [0, 0, 0, 1], [0, 0, 1, 0]],
    [2, 'translation', [-1, 0, 0], [3, 0, 0]],
    [3, 'rotation', [0, 0, 0, 1], [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
  ]) {
    const zero = first.map(() => 0),
      values =
        interpolation === 'CUBICSPLINE' ? [...zero, ...first, ...zero, ...zero, ...last, ...zero] : [...first, ...last];
    const sampler = doc.animations[0].samplers.length;
    doc.animations[0].samplers.push({
      input: times,
      output: add(values, path === 'rotation' ? 'VEC4' : 'VEC3'),
      interpolation,
    });
    doc.animations[0].channels.push({ sampler, target: { node, path } });
  }
  doc.buffers.push({ byteLength: offset });
  const buffer = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) {
    buffer.set(part, cursor);
    cursor += part.length;
  }
  return { doc, buffer };
}
function target() {
  const f = fixture(),
    q = [
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ],
    p = [
      [0, 2, 0],
      [0, 0, 0],
    ],
    plugins = new Map(),
    callbacks = new Set();
  f.doc.nodes = [{ translation: [0, 2, 0], children: [1] }, {}];
  const scene = {
    use(plugin) {
      assert.ok(!plugins.has(plugin.name));
      plugins.set(plugin.name, plugin);
    },
    removePlugin(name) {
      plugins.delete(name);
    },
  };
  const t = { qx: [0, 0], qy: [0, 0], qz: [0, 0], qw: [1, 1], x: [0, 0], y: [2, 0], z: [0, 0] };
  const model = {
    asset: { doc: f.doc },
    root: { id: 7, scene, engine: { store: { transforms: t } } },
    nodes: [0, 1].map((id) => ({
      id,
      setQuaternion(v) {
        q[id] = [...v];
      },
      setPosition(v) {
        p[id] = [...v];
      },
    })),
    onDispose(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
  };
  const avatar = {
    humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } },
    expressions: { preset: { happy: {} } },
  };
  const vrm = {
    expressions: new VRMExpressions(avatar),
    lookAtGaze: null,
    addPoseSource(fn) {
      plugins.set('pose', fn);
      return () => plugins.delete('pose');
    },
  };
  return { animation: { model }, avatar, vrm, q, p, plugins, callbacks };
}
test('reader retains metadata, decodes channels, handles multiple clips without mutating the source', async () => {
  const { doc, buffer } = fixture(),
    original = structuredClone(doc);
  doc.animations.push({ ...doc.animations[0], name: 'second' });
  const data = await readVRMA(doc, { buffers: [buffer] });
  assert.equal(data.clips.length, 2);
  assert.equal(data.clips[0].duration, 1);
  assert.equal(data.clips[0].tracks.length, 4);
  assert.equal(data.extension.extras.copyright, 'test author');
  doc.animations.pop();
  assert.deepEqual(doc, original);
  data.document.nodes[0].translation[1] = 100;
  assert.equal(doc.nodes[0].translation[1], 1);
});
for (const interpolation of ['STEP', 'LINEAR', 'CUBICSPLINE'])
  test(`FK playback, expressions, gaze, hip scaling and restoration: ${interpolation}`, async () => {
    const f = fixture(interpolation),
      data = await readVRMA(f.doc, { buffers: [f.buffer] }),
      t = target();
    t.vrm.expressions.set('happy', 0.25);
    const player = await playVRMA(data, t.animation, t.avatar, { vrm: t.vrm });
    assert.equal(t.plugins.size, 1);
    player.seek(0.5);
    assert.ok(Math.abs(t.p[0][0] - (interpolation === 'STEP' ? 0 : 1)) < 1e-6);
    assert.ok(Math.abs(t.p[0][1] - (interpolation === 'STEP' ? 2 : 3)) < 1e-6);
    assert.ok(Math.abs(t.q[1][2] - (interpolation === 'STEP' ? 0 : Math.SQRT1_2)) < 1e-6);
    assert.equal(t.vrm.expressions.get('happy'), interpolation === 'STEP' ? 0 : 1);
    assert.ok(Math.abs(t.vrm.lookAtGaze.yaw - (interpolation === 'STEP' ? 0 : 45)) < 1e-5);
    player.seek(1);
    assert.equal(t.vrm.expressions.get('happy'), 1);
    player.update(0.25);
    assert.equal(player.time, 0.25);
    player.loop = false;
    player.update(1);
    assert.equal(player.time, 1);
    assert.equal(player.playing, false);
    player.playing = true;
    player.speed = -1;
    player.update(0.5);
    assert.equal(player.time, 0.5);
    player.dispose();
    player.dispose();
    assert.equal(t.plugins.size, 0);
    assert.deepEqual(t.q[1], [0, 0, 0, 1]);
    assert.deepEqual(t.p[0], [0, 2, 0]);
    assert.equal(t.vrm.expressions.get('happy'), 0.25);
    assert.equal(t.vrm.lookAtGaze, null);
    assert.throws(() => player.seek(0), { code: 'disposed' });
  });
test('gaze follows specified extrinsic ZXY for combined yaw, pitch, roll and nonunit input', () => {
  const q = multiplyQuaternions(
    multiplyQuaternions(axisAngleToQuaternion([0, 1, 0], 0.8), axisAngleToQuaternion([1, 0, 0], 0.3)),
    axisAngleToQuaternion([0, 0, 1], -0.7),
  );
  const gaze = vrmaGaze(q.map((v) => v * 2));
  assert.ok(Math.abs(gaze.yaw - (0.8 * 180) / Math.PI) < 1e-10);
  assert.ok(Math.abs(gaze.pitch - (0.3 * 180) / Math.PI) < 1e-10);
});
test('rejects malformed references, cycles, duplicate targets, forbidden channels and invalid samples', async () => {
  for (const mutate of [
    (d) => (d.extensions.VRMC_vrm_animation.specVersion = '2.0'),
    (d) => (d.extensions.VRMC_vrm_animation.humanoid.humanBones.head.node = 9),
    (d) => (d.extensions.VRMC_vrm_animation.humanoid.humanBones.leftEye = { node: 1 }),
    (d) => (d.nodes[1].children = [0]),
    (d) => d.animations[0].channels.push(d.animations[0].channels[0]),
    (d) => (d.animations[0].channels[1].target.path = 'scale'),
    (d) => (d.animations[0].samplers[0].output = 999),
    (d) => (d.animations[0].samplers[0].interpolation = 'bad'),
    (d) => (d.accessors[0].componentType = 5123),
  ]) {
    const f = fixture();
    mutate(f.doc);
    await assert.rejects(readVRMA(f.doc, { buffers: [f.buffer] }));
  }
  const f = fixture();
  new DataView(f.buffer.buffer).setFloat32(4, 0, true);
  await assert.rejects(readVRMA(f.doc, { buffers: [f.buffer] }));
});
test('loads external buffers relative to URL, checks HTTP/budget and cancellation', async () => {
  const f = fixture();
  f.doc.buffers[0].uri = 'motion.bin';
  const urls = [];
  const fake = async (url) => {
    urls.push(String(url));
    return new Response(String(url).endsWith('.bin') ? f.buffer : JSON.stringify(f.doc));
  };
  assert.equal((await loadVRMA('https://example.test/data/motion.gltf', { fetch: fake })).clips[0].duration, 1);
  assert.deepEqual(urls, ['https://example.test/data/motion.gltf', 'https://example.test/data/motion.bin']);
  await assert.rejects(
    loadVRMA('https://example.test/a.vrma', { fetch: async () => new Response('', { status: 404 }) }),
    { code: 'failed' },
  );
  await assert.rejects(loadVRMA('https://example.test/a.vrma', { fetch: fake, maxDownloadBytes: 10 }));
  await assert.rejects(readVRMA(f.doc, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('model disposal releases playback without writing to destroyed nodes', async () => {
  const f = fixture(),
    t = target(),
    player = await playVRMA(await readVRMA(f.doc, { buffers: [f.buffer] }), t.animation, t.avatar);
  t.animation.model.nodes.forEach((n) => (n.setQuaternion = () => assert.fail('disposed node')));
  for (const fn of t.callbacks) fn();
  player.dispose();
  assert.equal(t.plugins.size, 0);
  assert.equal(player.playing, false);
});
