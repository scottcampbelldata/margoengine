// Per-member morph weights on a bone-texture crowd: bakeMorphBones keeps the targets' offsets beside the bones,
// morphVertices and poseMorphedBones (the shader's twins) match the analytic strip, and MorphedCrowd holds a row of
// weights per member with its bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { SKINNED_CROWD_STRIDE, SkinnedCrowd, bakeBones, skinnedCrowdVertex } from '../dist/instanced-skin.js';
import {
  MORPH_TARGET_LIMIT,
  MorphedCrowd,
  bakeMorphBones,
  morphVertices,
  morphedCrowdVertex,
  poseMorphedBones,
} from '../dist/instanced-morph.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { morphedBent, morphedStrip } from '../test/fixture.js';
import { engine as headless, model as load, near } from './support/models.js';

const strip = async (options) => {
  const engine = await headless(),
    data = morphedStrip(options),
    model = load(engine, data);
  return { engine, model, animation: new Animation(model), positions: data.positions, data };
};

test('bakeMorphBones bakes the unmorphed shape and keeps each target live beside the bones', async () => {
  const { engine, model, animation, positions } = await strip({ extra: true }),
    weights = model.primitives[0].weights,
    plain = bakeBones(animation, { fps: 4 }),
    bake = bakeMorphBones(animation, { fps: 4 }),
    count = positions.length / 3;
  assert.deepEqual([...weights], [0.25, 0], 'the model keeps its weights');
  assert.deepEqual(bake.morphs.names, ['lift', 'stretch']);
  assert.deepEqual([...bake.morphs.weights], [0.25, 0], 'a new member starts at the model weights');
  assert.equal(bake.morphs.blocks, 2, 'the strip has two targets, the plain triangle none');
  assert.equal(bake.vertexCount, count + 3);
  assert.equal(bake.bones, plain.bones);
  assert.deepEqual(bake.clips, plain.clips);
  const table = bake.rows * bake.bones * 3;
  assert.deepEqual(
    [...bake.texels.subarray(0, table * 4)],
    [...plain.texels.subarray(0, table * 4)],
    "the bone rows are bakeBones's",
  );
  for (let v = 0; v < count; v++) {
    near(bake.vertices.subarray(v * 6, v * 6 + 3), positions.slice(v * 3, v * 3 + 3), 1e-6, 'unmorphed position');
    assert.deepEqual([...bake.morphs.vertices.subarray(v * 4, v * 4 + 4)], [table, 2, v, 0]);
    // bakeBones had the model's 0.25 of lift baked in.
    near([plain.vertices[v * 6 + 1]], [positions[v * 3 + 1] + 0.125], 1e-6, 'bakeBones bakes the weight in');
  }
  for (let v = count; v < count + 3; v++)
    assert.equal(bake.morphs.vertices[v * 4 + 1], 0, 'the plain triangle has no blocks');
  // Entries: [first offset texel, weight index]; offsets: two texels a vertex, position then normal.
  const first = table + 2;
  assert.deepEqual([...bake.texels.subarray(table * 4, table * 4 + 8)], [first, 0, 0, 0, first + count * 2, 1, 0, 0]);
  assert.deepEqual(
    [...bake.texels.subarray(first * 4, first * 4 + 8)].map(Math.fround),
    [0, 0.5, 0, 0, 0.1, 0, 0, 0].map(Math.fround),
  );
  const stretch = (first + count * 2 + (count - 1) * 2) * 4;
  assert.deepEqual(
    [...bake.texels.subarray(stretch, stretch + 8)],
    [1, 0, 0, 0, 0, 0, 0, 0],
    'the last vertex stretches by 1; no normal offset',
  );
  assert.equal(bake.texels.length % (bake.width * 4), 0, 'whole texture rows');

  // The CPU twin of the morph step, against the targets written out.
  for (const w of [
    [0, 0],
    [1, 0],
    [0.25, -0.5],
    [1.5, 2],
  ]) {
    const morphed = morphVertices(bake, w);
    for (let v = 0; v < count; v++) {
      const x = positions[v * 3],
        y = positions[v * 3 + 1];
      near(
        morphed.subarray(v * 6, v * 6 + 6),
        [x + x * 0.5 * w[1], y + 0.5 * w[0], 0, 0.1 * w[0], 0, 1],
        1e-6,
        `weights ${w}`,
      );
    }
    near(morphed.subarray(count * 6), bake.vertices.subarray(count * 6), 0, 'the plain triangle does not morph');
  }
  near(morphVertices(bake), morphVertices(bake, [0.25, 0]), 0, 'default: the bake weights');
  near(
    morphVertices(bake, { stretch: 1 }),
    morphVertices(bake, [0.25, 1]),
    0,
    'by name, the others keep the bake weight',
  );
  near(morphVertices(bake, [1]), morphVertices(bake, [1, 0]), 0, 'a short array sets the first weights');
  // Morphed, then skinned: frame rows of the bend clip are exact rotations.
  for (const [t, w] of [
    [0, [0, 0]],
    [0.5, [1, 0]],
    [0.5, [0.25, 1]],
    [0.75, [-0.5, 0.75]],
  ]) {
    const posed = poseMorphedBones(bake, { clip: 0, speed: 0, offset: t, morphs: w }, 0);
    for (let v = 0; v < count; v++)
      near(
        posed.subarray(v * 3, v * 3 + 3),
        morphedBent(positions[v * 3], positions[v * 3 + 1], t, w),
        1e-5,
        `t ${t} weights ${w}`,
      );
  }
  model.dispose();
  engine.dispose();
});

test('a bake names its live targets, bakes the rest in and has a limit', async () => {
  const { engine, model, animation, positions, data } = await strip(),
    bake = bakeMorphBones(animation, { fps: 2, morphs: ['stretch'] });
  assert.deepEqual(bake.morphs.names, ['stretch']);
  assert.equal(bake.morphs.blocks, 1);
  near([bake.vertices[1]], [positions[1] + 0.125], 1e-6, 'lift stays baked in at the model weight');
  assert.deepEqual(bakeMorphBones(animation, { fps: 2, morphs: [1, 0] }).morphs.names, ['stretch', 'lift']);
  for (const morphs of [['smile'], [2], ['lift', 'lift'], [], [0.5]])
    assert.throws(() => bakeMorphBones(animation, { morphs }), /Unknown or repeated morph target/);
  assert.throws(() => bakeMorphBones(animation, { fps: 0 }), /Invalid bone bake fps/);
  assert.deepEqual([...model.primitives[0].weights], [0.25, 0], 'a failed bake restores the weights');
  model.dispose();
  // More targets than the limit: every one named, or the bake refuses.
  const many = load(engine, data),
    primitive = data.doc.meshes[0].primitives[0];
  many.dispose();
  primitive.targets = Array.from({ length: MORPH_TARGET_LIMIT + 1 }, () => primitive.targets[1]);
  data.doc.meshes[0].weights = primitive.targets.map(() => 0);
  data.doc.meshes[0].extras = { targetNames: primitive.targets.map((_, i) => 'shape' + i) };
  const wide = load(engine, data),
    wideAnimation = new Animation(wide);
  assert.throws(() => bakeMorphBones(wideAnimation), /65 live morph targets exceed 64/);
  const picked = bakeMorphBones(wideAnimation, { fps: 2, morphs: ['shape64', 'shape3'] });
  assert.deepEqual(picked.morphs.names, ['shape64', 'shape3']);
  const full = bakeMorphBones(wideAnimation, { fps: 2, morphs: Array.from({ length: 64 }, (_, i) => i) });
  assert.equal(new MorphedCrowd(full)['stride'], SKINNED_CROWD_STRIDE + 64);
  wide.dispose();
  // No targets at all.
  const { engine: other, model: plain, animation: plainAnimation } = await strip();
  for (const p of plain.primitives) delete p.definition.targets;
  assert.throws(() => bakeMorphBones(plainAnimation), /no morph targets/);
  plain.dispose();
  other.dispose();
  engine.dispose();
});

test('each member has its own row of weights, checked on the way in', async () => {
  const { engine, model, animation } = await strip({ extraClip: true }),
    bake = bakeMorphBones(animation, { fps: 4 });
  model.dispose();
  engine.dispose();
  assert.throws(() => new MorphedCrowd(bakeBones), /pass the result of bakeMorphBones/);
  const gpu = mockGPU(),
    crowd = new MorphedCrowd(bake),
    stride = SKINNED_CROWD_STRIDE + 4,
    host = {
      gpu: gpu.device,
      sceneOf() {
        return undefined;
      },
      lighting: { direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.2]) },
      stats: { visible: 0, drawCalls: 0 },
    };
  crowd.setup(host);
  assert.ok(crowd instanceof SkinnedCrowd);
  const weights = (i) => [...crowd['data'].subarray(i * stride + SKINNED_CROWD_STRIDE, (i + 1) * stride)];
  const a = crowd.add(),
    b = crowd.add({ clip: 1, blendClip: 1, blend: 0.5, morphs: { stretch: 2 } }),
    c = crowd.add({ morphs: [1] });
  assert.deepEqual(weights(a), [0.25, 0, 0, 0], 'the bake weights');
  assert.deepEqual(weights(b), [0.25, 2, 0, 0]);
  assert.deepEqual(weights(c), [1, 0, 0, 0]);
  assert.deepEqual(
    [...crowd['data'].subarray(b * stride + 16, b * stride + 20)],
    [1, 0, 1, 0.5],
    'the crowd fields stay',
  );
  assert.deepEqual([...crowd['data'].subarray(b * stride + 24, b * stride + 28)], [1, 0, 1, 0]);
  crowd
    .set(a, { morphs: new Float32Array([-1, 0.5]) })
    .setMorph(c, 'stretch', 0.75)
    .setMorph(c, 0, 0);
  assert.deepEqual(weights(a), [-1, 0.5, 0, 0]);
  assert.deepEqual(weights(c), [0, 0.75, 0, 0]);
  assert.equal(crowd.getMorph(c, 'stretch'), 0.75);
  assert.equal(crowd.getMorph(a, 0), -1);
  crowd.set(a, { blend: 0.25 });
  assert.deepEqual(weights(a), [-1, 0.5, 0, 0], 'a set without morphs keeps them');
  for (const bad of [
    () => crowd.setMorph(a, 'smile', 1),
    () => crowd.setMorph(a, 2, 1),
    () => crowd.setMorph(a, 0, NaN),
    () => crowd.setMorph(9, 0, 1),
    () => crowd.getMorph(9, 0),
    () => crowd.getMorph(a, -1),
    () => crowd.set(a, { morphs: [0, 0, 0] }),
    () => crowd.set(a, { morphs: { lift: Infinity } }),
    () => crowd.set(a, { morphs: { lift: '1' } }),
    () => crowd.set(a, { morphs: [3], blend: 7 }),
    () => crowd.add({ morphs: { smile: 1 } }),
  ])
    assert.throws(bad, RangeError);
  assert.deepEqual(weights(a), [-1, 0.5, 0, 0], 'a refused set changes nothing');
  assert.equal(crowd.count, 3, 'a refused add adds nothing');

  // The draw: SkinnedCrowd's, with one more vertex buffer and the longer rows.
  const run = passes(crowd),
    view = context(gpu, { samples: 4 }),
    frame = (i) =>
      gpu.record(() => {
        view.begin(i);
        crowd.onPreUpdate(1 / 60);
        run(view.c);
        view.end();
      }),
    rows = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 3 * stride * 8).length,
    first = frame(0),
    pipeline = first.find((e) => e[0] === 'renderPipeline')[2];
  assert.deepEqual(pipeline.vertex.buffers.at(-1), {
    arrayStride: 16,
    attributes: [{ shaderLocation: 7, offset: 0, format: 'uint32x4' }],
  });
  assert.deepEqual(
    first.filter((e) => e[0] === 'pass.drawIndexed').map((e) => e.slice(1, 3)),
    [[bake.indices.length, 3]],
    'one call',
  );
  assert.equal(
    first.filter((e) => e[0] === 'pass.setVertexBuffer').length,
    5,
    'UVs, vertices, joints, weights, blocks',
  );
  assert.equal(rows(first), 1, 'the rows upload once');
  assert.equal(rows(frame(1)), 0, 'unchanged weights upload nothing');
  crowd.setMorph(b, 'lift', 1);
  assert.equal(rows(frame(2)), 1, 'a changed weight uploads the rows');
  crowd.dispose();
});

test("the vertex stage is the skinned crowd's with the morph before the skin", () => {
  const code = morphedCrowdVertex(3);
  assert.ok(!code.includes('//'), 'comments stay outside the WGSL');
  assert.ok(code.includes('struct Instance {m:mat4x4f,p:vec4f,uv:vec4f,q:vec4f,w:array<vec4f,3>}'));
  assert.ok(code.includes('@location(7) morph:vec4u,@builtin(instance_index) id:u32'));
  assert.ok(code.includes('let b=morphed(s,position,normal,morph);let k=skinned(s,b.position,b.normal,j0,j1,w0,w1);'));
  assert.ok(code.includes('fn morphed(s:Instance,position:vec3f,normal:vec3f,morph:vec4u)->SkinnedVertex'));
  // Nothing else of SkinnedCrowd's stage changed: taking the additions out gives its text back.
  const back = code
    .replace(',w:array<vec4f,3>', '')
    .replace(/fn morphTexel[\s\S]*?(?=@vertex fn vertex)/, '')
    .replace('@location(7) morph:vec4u,', '')
    .replace('let b=morphed(s,position,normal,morph);', '')
    .replace('skinned(s,b.position,b.normal,', 'skinned(s,position,normal,');
  assert.equal(back, skinnedCrowdVertex);
});
