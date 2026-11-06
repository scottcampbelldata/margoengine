// Partial ragdolls: one limb or the upper body physical while the rest keeps animating, on a real rig and clip in a
// stepping Rapier world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { realRig, skip } from './rig.js';

const rtest = (name, fn) => test(name, { skip, timeout: 60_000 }, fn);
const WALKER = 'kaykit/adventurers/animations/Rig_Medium/Rig_Medium_MovementBasic.glb';
const local = (rig, node) => {
  const t = rig.engine.store.transforms,
    id = node.id;
  return [t.x[id], t.y[id], t.z[id], t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const turnedFrom = (a, b) =>
  2 * Math.acos(Math.min(1, Math.abs(a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6])));

async function walker() {
  const rig = await realRig(WALKER, { states: { walk: 'Walking_A' }, floor: false }),
    { animator } = rig;
  rig.frames(1);
  return { rig, animator };
}
/** Every node's local pose after `count` frames of the clip alone, frame by frame. */
async function clipAlone(count) {
  const { rig } = await walker(),
    frames = [];
  rig.frames(30);
  rig.frames(count, 1 / 60, () => frames.push(new Map(rig.model.nodes.map((node) => [node.name, local(rig, node)]))));
  rig.dispose();
  return frames;
}

rtest('one limp arm leaves the clip; every other bone matches a run with no ragdoll, exactly', async () => {
  const alone = await clipAlone(60),
    { rig } = await walker(),
    ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips'), joint: { type: 'free' } }),
    arm = rig.node('upperarm.l'),
    limb = ['upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l'];
  rig.frames(30);
  ragdoll.activate(arm);
  assert.equal(ragdoll.active, true);
  for (const part of ragdoll.bones)
    assert.equal(part.limp, limb.includes(part.node.name), `${part.node.name} is limp only in the arm`);
  ragdoll.part(arm).body.applyImpulse([0, 4, -8]);
  let off = 0;
  rig.frames(60, 1 / 60, (i) => {
    for (const node of rig.model.nodes) {
      const expected = alone[i].get(node.name),
        actual = local(rig, node);
      if (limb.includes(node.name)) off = Math.max(off, turnedFrom(actual, expected));
      else assert.deepEqual(actual, expected, `${node.name} is on the clip at frame ${i}`);
    }
  });
  assert.ok(off > 0.3, `the arm left the clip (${off} rad)`);
  // Stays attached: the shoulder's body sits on its joint on the chest's body, drawn where the arm's node is.
  const shoulder = ragdoll.part(arm).body.position,
    m = arm.matrix;
  assert.ok(Math.hypot(m[12] - shoulder[0], m[13] - shoulder[1], m[14] - shoulder[2]) < 0.05, 'the arm stays on');
  ragdoll.dispose();
  rig.dispose();
});

rtest('the spine takes the whole upper body, with the legs still walking', async () => {
  const alone = await clipAlone(45),
    { rig } = await walker(),
    ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips'), joint: { type: 'free' } });
  rig.frames(30);
  ragdoll.activate(rig.node('spine'));
  const legs = ['hips', 'upperleg.l', 'lowerleg.l', 'foot.l', 'upperleg.r', 'lowerleg.r', 'foot.r'];
  assert.deepEqual(
    ragdoll.bones.filter((part) => !part.limp).map((part) => part.node.name).sort(),
    [...legs].sort(),
  );
  const chest = rig.node('chest');
  let off = 0;
  rig.frames(45, 1 / 60, (i) => {
    for (const name of legs) assert.deepEqual(local(rig, rig.node(name)), alone[i].get(name), `${name}, frame ${i}`);
    off = Math.max(off, turnedFrom(local(rig, chest), alone[i].get('chest')));
  });
  assert.ok(off > 0.1, `the chest is physical (${off} rad off the clip)`);
  ragdoll.dispose();
  rig.dispose();
});

rtest('a limb blends back alone, a second can go limp meanwhile, and activate() takes the rest', async () => {
  const { rig } = await walker(),
    ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips'), joint: { type: 'free' } }),
    left = rig.node('upperarm.l'),
    right = rig.node('upperarm.r');
  rig.frames(30);
  ragdoll.activate([left, right]);
  ragdoll.part(left).body.applyImpulse([0, 4, -8]);
  rig.frames(30);
  ragdoll.deactivate(0.5, left);
  assert.equal(ragdoll.part(left).limp, false);
  assert.equal(ragdoll.part(right).limp, true);
  assert.equal(ragdoll.active, true, 'the right arm is still limp');
  assert.equal(ragdoll.part(left).body.type, 'kinematicPosition');
  rig.frames(15);
  assert.ok(Math.abs(ragdoll.part(left).weight - 0.5) < 0.02, 'halfway');
  assert.equal(ragdoll.part(right).weight, 1, 'the other arm keeps all its weight');
  assert.equal(ragdoll.weight, 1, 'and the ragdoll reads the largest');
  const blending = ragdoll.part(left).weight;
  ragdoll.weight = 0.25;
  assert.equal(ragdoll.part(right).weight, 0.25, 'a set weight goes to the limp bones');
  assert.equal(ragdoll.part(left).weight, blending, 'and leaves a bone blending back alone');
  ragdoll.weight = 1;
  rig.frames(16);
  assert.equal(ragdoll.part(left).weight, 0);
  // Back on the animation exactly: the bone is not written any more.
  const before = local(rig, left);
  rig.frames(1);
  const again = local(rig, left);
  assert.notDeepEqual(before, again, 'the clip moves it again');
  ragdoll.activate();
  assert.ok(ragdoll.bones.every((part) => part.limp));
  ragdoll.deactivate(0);
  assert.equal(ragdoll.active, false);
  assert.equal(ragdoll.weight, 0);
  ragdoll.dispose();
  rig.dispose();
});

rtest('a limp limb hung from a moving body swings: the joint carries the walk into it', async () => {
  const { rig } = await walker();
  // The whole character slides at 1 m/s under the clip, before the ragdoll runs.
  let x = 0;
  rig.engine.use({
    name: 'slider',
    setup() {},
    onPreUpdate(delta) {
      x += delta;
      rig.model.root.setPosition([x, 0, 0]);
    },
  });
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips'), joint: { type: 'free' } }),
    arm = ragdoll.part(rig.node('upperarm.l'));
  rig.frames(30);
  ragdoll.activate(arm.node);
  rig.frames(90);
  const body = arm.body.position[0],
    m = rig.node('chest').matrix;
  assert.ok(Math.abs(body - m[12]) < 0.5, `the arm came along (${body} against the chest at ${m[12]})`);
  assert.ok(x > 1.9, 'the character did move');
  ragdoll.dispose();
  rig.dispose();
});

rtest('a limb must be a bone of this ragdoll', async () => {
  const { rig } = await walker(),
    ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') });
  assert.throws(() => ragdoll.activate(rig.engine.createMesh()), { name: 'RangeError', message: /not a bone/ });
  assert.throws(() => ragdoll.deactivate(0.2, rig.engine.createMesh()), { name: 'RangeError', message: /not a bone/ });
  assert.equal(ragdoll.active, false, 'nothing went limp');
  ragdoll.activate(ragdoll.bones[1]);
  assert.equal(ragdoll.bones[1].limp, true, 'a part works as well as a node');
  ragdoll.dispose();
  rig.dispose();
});
