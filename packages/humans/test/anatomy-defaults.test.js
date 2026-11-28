// @margoengine/humans: every person obeys a human body with no configuration (Scott, 2026-11-28: anatomy limits on by
// default). addPerson fits the rig's anatomy, hands it to the Animator's IK and holds every clip inside the body's
// limits; `anatomy: false` leaves the rig free, and a rig with no human naming gets no body.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGLTFAsync } from '../../gltf/dist/pbr.js';
import { anatomyOf } from '../../animator/dist/index.js';
import { addPerson } from '../dist/index.js';
import { quat, riggedTestGLB } from './rigged-body.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const DEG = 180 / Math.PI;

// A T-pose humanoid whose one clip bends the left elbow 70 degrees the wrong way (the forearm swung behind the arm)
// and the right one 40 degrees the right way.
const REVERSED = { leftLowerArm: quat([0, 1, 0], 70), rightLowerArm: quat([0, 1, 0], 40) };

async function person(t, options, clip = REVERSED) {
  const engine = await loadedPBREngine(),
    model = await parseGLTFAsync(engine, riggedTestGLB('T', clip), {}),
    p = await addPerson(engine, model, { skin: false, hair: false, eyes: false, ...options });
  t.after(() => {
    p.dispose();
    model.dispose();
    engine.dispose();
  });
  p.play('pose', { fade: 0 });
  p.playing = false;
  return { engine, model, p };
}
const turn = ({ engine, model }, name) => {
  const id = model.nodes.find((node) => node.name === name).id,
    t = engine.store.transforms;
  return 2 * Math.acos(Math.min(1, Math.abs(t.qw[id]))) * DEG;
};

test('addPerson fits the body and holds a reversed elbow by default', async (t) => {
  const on = await person(t, {}),
    off = await person(t, { anatomy: false });
  assert.equal(on.p.body?.preset, 'humanoid');
  assert.equal(anatomyOf(on.p.animator), on.p.body, 'the Animator IK reads the same body');
  assert.equal(off.p.body, undefined);
  assert.equal(anatomyOf(off.p.animator) ?? undefined, undefined);
  for (const x of [on, off]) {
    x.p.time = 0.999;
    x.p.animator.onPreUpdate(0);
  }
  // Free, the clip's 70 degrees stand; on the body the elbow stops at its straight arm (a few degrees of
  // hyperextension at most), and the right elbow's real bend is kept.
  assert.ok(Math.abs(turn(off, 'leftLowerArm') - 70) < 0.5, `free ${turn(off, 'leftLowerArm')}`);
  assert.ok(turn(on, 'leftLowerArm') < 10, `held ${turn(on, 'leftLowerArm')}`);
  assert.ok(Math.abs(turn(on, 'rightLowerArm') - 40) < 0.5, `kept ${turn(on, 'rightLowerArm')}`);
  assert.deepEqual(on.p.check('structural'), []);
  assert.ok(off.p.check === undefined || off.p.check().length === 0, 'with no body there is nothing to check against');
});

test('anatomy options: limits off keeps the body for IK; the reports go to onClamp', async (t) => {
  const free = await person(t, { anatomy: { limits: false } });
  assert.ok(free.p.body, 'the body is still fitted');
  assert.equal(free.p.body.limits, false);
  free.p.time = 0.999;
  free.p.animator.onPreUpdate(0);
  assert.ok(Math.abs(turn(free, 'leftLowerArm') - 70) < 0.5, `free ${turn(free, 'leftLowerArm')}`);
  // The check still names what the pose breaks.
  assert.ok(free.p.check().some((issue) => issue.joint === 'l_elbow'));

  const issues = [],
    held = await person(t, { anatomy: { onClamp: (found) => issues.push(...found) } });
  held.p.time = 0.999;
  held.p.animator.onPreUpdate(0);
  assert.ok(
    issues.some((issue) => issue.joint === 'l_elbow'),
    JSON.stringify(issues),
  );
});

test('addPerson checks its anatomy options and names a rig it cannot read', async (t) => {
  const engine = await loadedPBREngine();
  t.after(() => engine.dispose());
  const model = await parseGLTFAsync(engine, riggedTestGLB('T', REVERSED), {});
  await assert.rejects(addPerson(engine, model, { anatomy: 'on' }), TypeError);
  await assert.rejects(addPerson(engine, model, { anatomy: { tier: 'loose' } }), RangeError);
  await assert.rejects(addPerson(engine, model, { anatomy: { onClamp: 1 } }), TypeError);
  await assert.rejects(addPerson(engine, model, { anatomy: { map: { l_elbow: 'nowhere' } } }), (error) => {
    assert.equal(error.code, 'unsupported');
    return true;
  });
  model.dispose();
});
