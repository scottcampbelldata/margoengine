// @margoengine/humans/body: addBody makes a person from bones and skinned meshes built in code, with the defaults a
// loaded person gets (the human anatomy among them), and bodyGLTF writes the glTF it loads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBody, bodyGLTF } from '../dist/body.js';
import { quat, riggedTestBody } from './rigged-body.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const DEG = 180 / Math.PI;
const description = (clips) => {
  const b = riggedTestBody('T');
  return {
    bones: b.bones,
    meshes: [{ positions: b.positions, normals: b.normals, indices: b.indices, joints: b.joints, weights: b.weights }],
    ...(clips ? { clips } : {}),
  };
};

test('bodyGLTF writes bone nodes from the binds, their inverse binds and a rest clip', () => {
  const d = description(),
    { doc, buffer } = bodyGLTF(d);
  assert.equal(doc.nodes.length, d.bones.length + 1);
  assert.equal(doc.skins[0].joints.length, d.bones.length);
  assert.equal(doc.buffers[0].byteLength, buffer.byteLength);
  const hips = d.bones.findIndex((b) => b.name === 'hips'),
    spine = d.bones.findIndex((b) => b.name === 'spine');
  // A child's local translation is its bind position less its parent's (these binds carry no rotation).
  const local = doc.nodes[spine].translation;
  [0, 1, 2].forEach((i) =>
    assert.ok(Math.abs(local[i] - (d.bones[spine].bind[12 + i] - d.bones[hips].bind[12 + i])) < 1e-6),
  );
  assert.deepEqual(
    doc.nodes[spine].rotation.map((v) => Math.round(v * 1e6) / 1e6),
    [0, 0, 0, 1],
  );
  assert.deepEqual(
    doc.animations.map((a) => a.name),
    ['rest'],
  );
  assert.equal(doc.materials[0].name, 'Skin');
  // A rotated bind comes back as the same rotation.
  const h = Math.SQRT1_2,
    turned = bodyGLTF({
      bones: [{ name: 'root', parent: -1, bind: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] }],
      meshes: [
        {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
          indices: [0, 1, 2],
          joints: Array(12).fill(0),
          weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        },
      ],
    });
  const r = turned.doc.nodes[0].rotation;
  assert.ok(Math.abs(r[2] - h) < 1e-6 && Math.abs(r[3] - h) < 1e-6, `rotation ${r}`);
});

test('bodyGLTF names a malformed body', () => {
  const d = description();
  assert.throws(() => bodyGLTF({ ...d, bones: [] }), TypeError);
  assert.throws(() => bodyGLTF({ ...d, meshes: [] }), TypeError);
  assert.throws(() => bodyGLTF({ ...d, bones: [{ ...d.bones[0], parent: 3 }, ...d.bones.slice(1)] }), RangeError);
  assert.throws(() => bodyGLTF({ ...d, bones: [{ ...d.bones[0], bind: [1, 0, 0] }, ...d.bones.slice(1)] }), TypeError);
  assert.throws(
    () => bodyGLTF({ ...d, meshes: [{ ...d.meshes[0], joints: d.meshes[0].joints.map(() => 99) }] }),
    RangeError,
  );
  assert.throws(() => bodyGLTF({ ...d, meshes: [{ ...d.meshes[0], normals: [0, 0, 1] }] }), TypeError);
  assert.throws(
    () =>
      bodyGLTF({
        ...d,
        clips: [{ name: 'x', channels: [{ bone: 'nobody', path: 'rotation', times: [0], values: [0, 0, 0, 1] }] }],
      }),
    RangeError,
  );
  assert.throws(
    () =>
      bodyGLTF({
        ...d,
        clips: [
          {
            name: 'x',
            channels: [{ bone: 'hips', path: 'rotation', times: [1, 0], values: [0, 0, 0, 1, 0, 0, 0, 1] }],
          },
        ],
      }),
    RangeError,
  );
});

test('addBody makes a person with a body that holds a reversed elbow, and disposes its model', async (t) => {
  const engine = await loadedPBREngine();
  t.after(() => engine.dispose());
  const clip = {
      name: 'bend',
      channels: [
        { bone: 'leftLowerArm', path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...quat([0, 1, 0], 70)] },
        { bone: 'rightLowerArm', path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...quat([0, 1, 0], 40)] },
      ],
    },
    person = await addBody(engine, description([clip]), { skin: false, hair: false, eyes: false });
  assert.deepEqual(person.clips, ['bend']);
  assert.equal(person.body?.preset, 'humanoid');
  person.play('bend', { fade: 0 });
  person.playing = false;
  person.time = 0.999;
  person.animator.onPreUpdate(0);
  const t2 = engine.store.transforms,
    turn = (name) =>
      2 * Math.acos(Math.min(1, Math.abs(t2.qw[person.model.nodes.find((n) => n.name === name).id]))) * DEG;
  assert.ok(turn('leftLowerArm') < 10, `held ${turn('leftLowerArm')}`);
  assert.ok(Math.abs(turn('rightLowerArm') - 40) < 0.5, `kept ${turn('rightLowerArm')}`);
  // Count outer calls only: the engine calls the model's dispose again from inside it while removing the plugin.
  let disposed = 0,
    inside = false;
  const model = person.model,
    own = model.dispose.bind(model);
  model.dispose = () => {
    if (inside) return own();
    disposed++;
    inside = true;
    own();
    inside = false;
  };
  person[Symbol.dispose]();
  assert.equal(disposed, 1, 'the person takes its model with it');

  const rest = await addBody(engine, description(), { skin: false, hair: false, eyes: false });
  assert.deepEqual(rest.clips, ['rest']);
  rest.dispose();
});
