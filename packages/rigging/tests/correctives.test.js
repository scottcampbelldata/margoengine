// Corrective shapes: the hinge reading, cones, starts and curves as plain data, pose spaces hitting their samples, and a
// real rig (the Khronos Fox's bones, with a stand-in shape added to its mesh) driven through an Animator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';
import { Correctives, addCorrectives } from '../dist/correctives.js';

const about = (axis, angle) => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const X = [1, 0, 0],
  Y = [0, 1, 0],
  Z = [0, 0, 1];
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const weigh = (correctives, rotation) => correctives.evaluate(() => rotation);

test('a hinge reads its bend from rest to pose, clamps past both ends, and ignores twist', () => {
  const shape = { node: 1, target: 0, joint: 2, pose: about(X, 2) },
    correctives = new Correctives({ shapes: [shape] });
  near(weigh(correctives, [0, 0, 0, 1])[0].weight, 0);
  near(weigh(correctives, about(X, 1))[0].weight, 0.5);
  near(weigh(correctives, about(X, 2))[0].weight, 1);
  near(weigh(correctives, about(X, 2.6))[0].weight, 1);
  near(weigh(correctives, about(X, -1))[0].weight, 0);
  near(weigh(correctives, about(Y, 1.2))[0].weight, 0, 1e-9);
  assert.deepEqual(
    Object.keys(weigh(correctives, [0, 0, 0, 1])[0]).sort(),
    ['node', 'target', 'weight'],
  );
});

test('a sign flipped quaternion reads the same, and a rest away from identity is measured from', () => {
  const rest = about(Y, 0.5),
    pose = about(Y, 1.5),
    correctives = new Correctives({ shapes: [{ node: 1, target: 0, joint: 2, pose, rest }] });
  near(weigh(correctives, rest)[0].weight, 0);
  near(weigh(correctives, about(Y, 1))[0].weight, 0.5);
  near(weigh(correctives, about(Y, 1).map((v) => -v))[0].weight, 0.5);
  // With no rest of its own, the joint's rest from the rig is used.
  const rigged = new Correctives({ shapes: [{ node: 1, target: 0, joint: 2, pose }] });
  near(rigged.evaluate(() => about(Y, 1), () => rest)[0].weight, 0.5);
});

test('start, smooth curve, amount and cone shape the reading', () => {
  const base = { node: 1, target: 0, joint: 2, pose: about(X, 2) },
    at = (extra, rotation) => weigh(new Correctives({ shapes: [{ ...base, ...extra }] }), rotation)[0].weight;
  near(at({ start: 0.5 }, about(X, 1)), 0);
  near(at({ start: 0.5 }, about(X, 1.5)), 0.5);
  near(at({ curve: 'smooth' }, about(X, 0.5)), 0.15625);
  near(at({ curve: 'smooth' }, about(X, 1)), 0.5);
  near(at({ amount: 0.25 }, about(X, 2)), 0.25);
  near(at({ cone: 0.5 }, about(X, 2)), 1);
  const swung = multiply(about(X, 2), about(Z, 0.8));
  assert.ok(at({}, swung) > 0.8, 'with no cone a swing away still reads');
  near(at({ cone: 0.5 }, swung), 0);
});

function multiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

test('shapes on one target add and clamp', () => {
  const pose = about(X, 1),
    correctives = new Correctives({
      shapes: [
        { node: 1, target: 0, joint: 2, pose, amount: 0.7 },
        { node: 1, target: 0, joint: 3, pose, amount: 0.7 },
      ],
    }),
    weights = weigh(correctives, pose);
  assert.equal(weights.length, 1);
  near(weights[0].weight, 1);
});

test('a pose space gives each sample exactly its weights and blends between', () => {
  const space = {
      joint: 2,
      shapes: [
        { node: 1, target: 0 },
        { node: 1, target: 1 },
      ],
      samples: [
        { rotation: [0, 0, 0, 1], weights: [0, 0] },
        { rotation: about(Z, 1.4), weights: [1, 0] },
        { rotation: about(X, 1.4), weights: [0, 1] },
        { rotation: about(X, -1.4), weights: [0.5, 0.5] },
      ],
    },
    correctives = new Correctives({ spaces: [space] });
  for (const { rotation, weights } of space.samples) {
    const out = weigh(correctives, rotation);
    near(out[0].weight, weights[0], 1e-9);
    near(out[1].weight, weights[1], 1e-9);
  }
  const halfway = weigh(correctives, about(Z, 0.7));
  assert.ok(halfway[0].weight > 0.2 && halfway[0].weight < 0.9, `${halfway[0].weight}`);
  near(weigh(correctives, about(Z, 1.4).map((v) => -v))[0].weight, 1, 1e-9);
});

test('bad settings are refused', () => {
  const shape = { node: 1, target: 0, joint: 2, pose: about(X, 1) },
    make = (extra) => new Correctives({ shapes: [{ ...shape, ...extra }] });
  assert.throws(() => make({ pose: [0, 0, 1] }), RangeError);
  assert.throws(() => make({ pose: [0, 0, 0, 0] }), RangeError);
  assert.throws(() => make({ rest: [Infinity, 0, 0, 1] }), RangeError);
  assert.throws(() => make({ cone: 0 }), RangeError);
  assert.throws(() => make({ start: 1 }), RangeError);
  assert.throws(() => make({ curve: 'cubic' }), RangeError);
  assert.throws(() => make({ amount: 2 }), RangeError);
  assert.throws(() => weigh(make({ pose: [0, 0, 0, 1] }), [0, 0, 0, 1]), /differ from its rest/);
  const space = {
    joint: 1,
    shapes: [{ node: 1, target: 0 }],
    samples: [
      { rotation: [0, 0, 0, 1], weights: [0] },
      { rotation: [0, 0, 0, 1], weights: [1] },
    ],
  };
  assert.throws(() => new Correctives({ spaces: [space] }), /separate the samples/);
  assert.throws(() => new Correctives({ spaces: [{ ...space, width: 1 }] }), /repeat/);
  assert.throws(() => new Correctives({ spaces: [{ ...space, samples: [] }] }), RangeError);
  assert.throws(() => new Correctives({ spaces: [{ ...space, shapes: [] }] }), RangeError);
  assert.throws(
    () => new Correctives({ spaces: [{ ...space, samples: [{ rotation: [0, 0, 0, 1], weights: [] }] }] }),
    RangeError,
  );
});

/** The real Fox with a stand-in morph target on its mesh: a real rig, no real corrective exists for it. */
function foxWithShape() {
  const bytes = readFileSync(new URL('../../../examples/assets/khronos/Fox/Fox.glb', import.meta.url)),
    chunks = glbChunks(new Uint8Array(bytes)),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    bin = chunks.find((c) => c.type === GLB_BIN).data,
    mesh = doc.meshes[0],
    primitive = mesh.primitives[0],
    vertices = doc.accessors[primitive.attributes.POSITION].count,
    delta = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) delta[v * 3 + 1] = 2;
  doc.buffers = [{ byteLength: bin.byteLength }, { byteLength: delta.byteLength }];
  doc.bufferViews.push({ buffer: 1, byteLength: delta.byteLength });
  doc.accessors.push({
    bufferView: doc.bufferViews.length - 1,
    componentType: 5126,
    count: vertices,
    type: 'VEC3',
    min: [0, 2, 0],
    max: [0, 2, 0],
  });
  primitive.targets = [{ POSITION: doc.accessors.length - 1 }];
  mesh.weights = [0];
  mesh.extras = { targetNames: ['KneeFix'] };
  const copy = new Uint8Array(bin);
  return { doc, buffers: [copy, new Uint8Array(delta.buffer)] };
}

test('on a real rig (stand-in shape): a clip bends a Fox leg joint and the shape follows it, then stops', async (t) => {
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = foxWithShape(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    clip = animation.clips.find((c) => /run/i.test(c.name)) ?? animation.clips[0],
    animator = new Animator(animation, { initial: 'go', states: { go: clip.name } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  const node = f.doc.nodes.findIndex((n) => n.mesh === 0),
    tracked = clip.tracks.find((track) => track.path === 'rotation' && /leg|knee|thigh/i.test(f.doc.nodes[track.node]?.name ?? ''));
  assert.ok(tracked, 'the clip turns a leg joint');
  const joint = tracked.node,
    rest = animator.restRotation(joint),
    t0 = store.transforms,
    id = model.nodes[joint].id,
    rotation = () => [t0.qx[id], t0.qy[id], t0.qz[id], t0.qw[id]],
    frames = [];
  for (let frame = 0; frame < 30; frame++) {
    animator.onPreUpdate(1 / 30);
    frames.push(rotation());
  }
  // The pose of the frame farthest from rest is where the shape is full.
  const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[0] * rest[0] + q[1] * rest[1] + q[2] * rest[2] + q[3] * rest[3]))),
    pose = frames.reduce((a, b) => (angle(b) > angle(a) ? b : a));
  assert.ok(angle(pose) > 0.05, `the leg moves: ${angle(pose)}`);
  const handle = addCorrectives(animator, { shapes: [{ node, target: 0, joint, pose }] }),
    primitive = model.primitives.find((p) => p.nodeIndex === node),
    seen = [];
  for (let frame = 0; frame < 60; frame++) {
    animator.onPreUpdate(1 / 30);
    seen.push(primitive.weights[0]);
  }
  assert.ok(Math.max(...seen) > 0.8 && Math.min(...seen) < Math.max(...seen) - 0.2, `${Math.min(...seen)} to ${Math.max(...seen)}`);
  handle.dispose();
  assert.equal(primitive.weights[0], 0);
  animator.onPreUpdate(1 / 30);
  assert.equal(primitive.weights[0], 0, 'stopped');
  handle.dispose();
  assert.throws(() => addCorrectives(animator, { shapes: [{ node: 9999, target: 0, joint, pose }] }), RangeError);
  assert.throws(() => addCorrectives(animator, { shapes: [{ node, target: 0, joint: 9999, pose }] }), RangeError);
});
