// Bone-texture crowds: bakeBones holds each clip's bone matrices, and poseBones (the shader's twin) matches the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../dist/index.js';
import {
  SKINNED_CROWD_STRIDE,
  SkinnedCrowd,
  bakeBones,
  boneTexel,
  poseBones,
  skinnedCrowdVertex,
} from '../dist/instanced-skin.js';
import { VATCrowd, VAT_STRIDE } from '../dist/vat.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { skinnedStrip } from '../test/fixture.js';
import { near } from './support/models.js';

const headless = async () =>
  new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(256), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
const strip = async (options) => {
  const engine = await headless(),
    { doc, buffers, positions } = skinnedStrip(options),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers));
  return { engine, model, animation: new Animation(model), positions, doc, buffers };
};
/** The strip's analytic pose: x >= 1 follows joint 1, turned `degrees` about +Z at (1, 0, 0). */
const bent = ([x, y], degrees) => {
  if (x < 1) return [x, y, 0];
  const h = (degrees * Math.PI) / 180,
    c = Math.cos(h),
    s = Math.sin(h);
  return [1 + (x - 1) * c - y * s, (x - 1) * s + y * c, 0];
};

test('boneTexel wraps rows of three texels per bone at the texture width', () => {
  assert.deepEqual(boneTexel(0, 0, 0, 4), [0, 0]);
  assert.deepEqual(boneTexel(0, 3, 2, 4), [11, 0]);
  assert.deepEqual(boneTexel(2, 1, 1, 4), [28, 0]);
  assert.deepEqual(boneTexel(0, 1000, 0, 2000, 64), [3000 % 64, Math.floor(3000 / 64)]);
});

test('bakeBones holds each frame of each clip, in the root space, and restores the animation', async () => {
  const { model, animation, positions } = await strip({ extraClip: true });
  animation.play('lift').seek(0.5);
  animation.playing = false;
  model.root.setPosition([5, 0, 0]).setScale([2, 2, 2]); // not baked: a crowd member has its own matrix
  const bake = bakeBones(animation, { fps: 8, clips: ['bend', 1] });
  assert.equal(bake.bones, 2);
  assert.deepEqual(
    bake.clips.map(({ name, start, frames, duration }) => [name, start, frames, duration]),
    [
      ['bend', 0, 8, 1],
      ['lift', 9, 16, 2],
    ],
  );
  assert.equal(bake.rows, 26);
  assert.equal(bake.vertexCount, positions.length / 3);
  assert.equal(animation.clip, 1, 'clip restored');
  assert.equal(animation.time, 0.5, 'time restored');
  assert.equal(animation.playing, false, 'playing restored');
  const pose = new Float32Array(bake.vertexCount * 3);
  for (const t of [0, 0.25, 0.5, 0.875]) {
    poseBones(bake, { clip: 0 }, t, pose);
    for (let v = 0; v < bake.vertexCount; v++)
      near([...pose.subarray(v * 3, v * 3 + 3)], bent(positions.slice(v * 3, v * 3 + 2), t * 90), 0.01, `t ${t} v ${v}`);
  }
  // Each frame row is exact; between rows the matrices mix, so a small error above is the frame gap.
  poseBones(bake, { clip: 0 }, 0.5, pose);
  const last = bake.vertexCount - 1;
  near([...pose.subarray(last * 3, last * 3 + 3)], bent(positions.slice(last * 3, last * 3 + 2), 45), 1e-5, 'on a row');
});

test('a member has its own clips, offsets, speeds and blend', async () => {
  const { animation, positions } = await strip({ extraClip: true }),
    bake = bakeBones(animation, { fps: 16 }),
    n = bake.vertexCount * 3,
    lift = (t) => {
      const out = new Float32Array(n);
      for (let v = 0; v < bake.vertexCount; v++) out.set([positions[v * 3], positions[v * 3 + 1] + t / 2, 0], v * 3);
      return out;
    };
  near([...poseBones(bake, { clip: 1 }, 1)], [...lift(1)], 1e-5, 'clip 1');
  near([...poseBones(bake, { clip: 1, offset: 0.5 }, 0.5)], [...lift(1)], 1e-5, 'offset');
  near([...poseBones(bake, { clip: 1, speed: 2 }, 0.5)], [...lift(1)], 1e-5, 'speed');
  near([...poseBones(bake, { clip: 1, speed: 1 }, 2.5)], [...lift(0.5)], 1e-5, 'a looping clip wraps');
  // Blend: all of the first, all of the second, and halfway mixes the two poses.
  const a = poseBones(bake, { clip: 0 }, 0.5),
    b = poseBones(bake, { clip: 1 }, 1);
  near([...poseBones(bake, { clip: 0, blendClip: 1, blendOffset: 0.5, blend: 0 }, 0.5)], [...a], 1e-6, 'blend 0');
  near([...poseBones(bake, { clip: 0, blendClip: 1, blendOffset: 0.5, blend: 1 }, 0.5)], [...b], 1e-6, 'blend 1');
  near(
    [...poseBones(bake, { clip: 0, blendClip: 1, blendOffset: 0.5, blend: 0.5 }, 0.5)],
    a.map((v, i) => (v + b[i]) / 2),
    1e-5,
    'blend half',
  );
});

test('a clip that does not loop holds its last frame', async () => {
  const engine = await headless(),
    { doc, buffers, positions } = skinnedStrip(),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    bake = bakeBones(new Animation(model, { loop: false }), { fps: 4 });
  assert.equal(bake.clips[0].loop, false);
  const pose = poseBones(bake, {}, 9),
    last = bake.vertexCount - 1;
  near([...pose.subarray(last * 3, last * 3 + 3)], bent(positions.slice(last * 3, last * 3 + 2), 90), 1e-5);
});

test('an unskinned part follows its node as a bone of its own, and skins share their bones', async () => {
  const engine = await headless(),
    { doc, buffers } = skinnedStrip();
  // A second, rigid primitive on the moving joint's child; the same skin again on a third node.
  const rigid = structuredClone(doc.meshes[0]);
  for (const name of ['JOINTS_0', 'WEIGHTS_0']) delete rigid.primitives[0].attributes[name];
  doc.meshes.push(rigid);
  doc.nodes.push({ mesh: 1, translation: [0, 3, 0] }, { mesh: 0, skin: 0 });
  doc.nodes[2].children = [3];
  doc.scenes[0].nodes.push(4);
  const model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    bake = bakeBones(new Animation(model), { fps: 4 }),
    each = bake.vertexCount / 3;
  assert.equal(bake.bones, 3, 'two joints once, and one rigid part');
  const pose = poseBones(bake, {}, 0);
  const rigidIndex = model.primitives.findIndex((p) => p.definition.attributes.JOINTS_0 === undefined);
  // Rest pose: the rigid part sits 3 up from joint 1 at x = 1.
  near([...pose.subarray(rigidIndex * each * 3, rigidIndex * each * 3 + 3)], [1, 3, 0], 1e-5);
  assert.equal(bake.weights[rigidIndex * each * 8], 1);
  assert.equal(bake.joints[rigidIndex * each * 8], 2);
});

test('bakeBones and poseBones refuse bad input, naming the fix', async () => {
  const { animation } = await strip(),
    bake = bakeBones(animation, { fps: 2 });
  assert.throws(() => bakeBones(animation, { fps: 0 }), /fps in \(0, 1000\]/);
  assert.throws(() => bakeBones(animation, { clips: ['nope'] }), /clip indices that exist/);
  assert.throws(() => poseBones(bake, { clip: 9 }, 0), /clips from bake.clips/);
  assert.throws(() => poseBones(bake, {}, 0, new Float32Array(1)), /3 floats per vertex/);
  assert.throws(() => new SkinnedCrowd({}), /result of bakeBones/);
});

test('SkinnedCrowd draws every member in one indexed call, and a member takes its own clips and blend', async () => {
  const { model, animation, engine } = await strip({ extraClip: true }),
    bake = bakeBones(animation, { fps: 4 });
  model.dispose();
  engine.dispose();
  const gpu = mockGPU(),
    crowd = new SkinnedCrowd(bake),
    host = {
      lighting: { direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.2]) },
      stats: { visible: 0, drawCalls: 0 },
    };
  crowd.setup(host);
  assert.ok(crowd instanceof VATCrowd);
  assert.equal(SKINNED_CROWD_STRIDE, VAT_STRIDE + 4);
  for (let i = 0; i < 40; i++) crowd.add({ clip: i % 2, blendClip: 1, blend: 0.25, blendOffset: 0.5, offset: i * 0.1 });
  const rows = crowd['data'],
    o = 3 * SKINNED_CROWD_STRIDE;
  assert.deepEqual([...rows.subarray(o + 16, o + 20)].map((v) => Math.fround(v)), [1, Math.fround(0.3), 1, 0.25]);
  assert.deepEqual([...rows.subarray(o + 24, o + 28)], [1, 0.5, 1, 0]);
  const plain = crowd.add();
  assert.equal(rows[plain * SKINNED_CROWD_STRIDE + 26], 1, 'the second clip defaults to full speed');
  assert.equal(rows[plain * SKINNED_CROWD_STRIDE + 19], 0, 'no blend by default');
  crowd.set(0, { blend: 1, blendClip: 0, blendSpeed: 2 });
  assert.equal(rows[19], 1);
  assert.equal(rows[26], 2);
  for (const bad of [{ blend: 2 }, { blend: -0.1 }, { blendClip: 9 }, { blendOffset: NaN }, { blendSpeed: Infinity }])
    assert.throws(() => crowd.set(0, bad), /Invalid crowd blend/);
  assert.equal(crowd.count, 41);
  const run = passes(crowd),
    view = context(gpu, { samples: 4 }),
    frame = (i) => {
      view.begin(i);
      crowd.onPreUpdate(1 / 60);
      run(view.c);
      view.end();
    },
    first = gpu.record(() => frame(0));
  assert.deepEqual(
    first.filter((e) => e[0] === 'pass.drawIndexed').map((e) => e.slice(1, 3)),
    [[bake.indices.length, 41]],
    'one call',
  );
  assert.equal(first.filter((e) => e[0] === 'pass.setVertexBuffer').length, 4, 'UVs, vertices, joints and weights');
  assert.equal(crowd['frame'][36], bake.bones, 'a texture row is its bones');
  const second = gpu.record(() => frame(1));
  assert.equal(
    second.filter((e) => e[0] === 'writeBuffer' && e[3].length === 41 * SKINNED_CROWD_STRIDE * 8).length,
    0,
    'unchanged members upload nothing',
  );
  crowd.dispose();
});

test('the vertex stage has the bindings the crowd binds, with instance rows the size the crowd writes', () => {
  assert.match(skinnedCrowdVertex, /struct Instance \{m:mat4x4f,p:vec4f,uv:vec4f,q:vec4f\}/);
  assert.equal(16 + 4 + 4 + 4, SKINNED_CROWD_STRIDE);
  for (let location = 0; location < 7; location++) assert.ok(skinnedCrowdVertex.includes(`@location(${location})`));
});
