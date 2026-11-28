// The bone a walk travels on (@margoengine/animator rootMotionJoint, KB-HUM-SKINDRIFT1): a Character Creator walk keys
// its travel on CC_Base_BoneRoot, the skin's top joint above the hips, and leaves the hips' translation in place. Root
// motion and warping with no joint given take the travel from that bone, so the walk plays in place over the whole
// clip and warping measures the clip's real speed; a rig whose hips travel still gets its hips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addWarping } from '../packages/animator/dist/warping.js';
import { addRootMotion, rootMotionJoint } from '../packages/animator/dist/index.js';
import { animatorDocument, animatorRun, BIPED, bipedWalk } from './support/animator-rig.js';

// The walk as Character Creator keys it: the root bone carries the 1 m/s travel, the hips only bob and sway.
function rootKeyed() {
  const walk = bipedWalk({ duration: 1, speed: 1 }),
    { 'Hips.translation': _, ...legs } = walk.tracks;
  return {
    ...walk,
    tracks: {
      ...legs,
      'Root.translation': (t) => [0, 0, t],
      'Hips.translation': (t) => [0.02 * Math.sin(2 * Math.PI * t), 1 + 0.03 * Math.cos(4 * Math.PI * t), 0],
    },
  };
}
const legsOf = (f) =>
  ['Left', 'Right'].map((side) => ({
    hip: f.index.get(`${side}UpLeg`),
    knee: f.index.get(`${side}Leg`),
    ankle: f.index.get(`${side}Foot`),
  }));

test('the travel bone is the root bone on a root-keyed walk and the hips on a hips-keyed one', async (t) => {
  const cc = await animatorRun(animatorDocument(BIPED, { Walk: rootKeyed() }), { initial: 'walk', states: { walk: 'Walk' } }),
    mixamo = await animatorRun(animatorDocument(BIPED, { Walk: bipedWalk() }), { initial: 'walk', states: { walk: 'Walk' } }),
    still = await animatorRun(
      animatorDocument(BIPED, { Stand: { duration: 1, tracks: { 'Hips.translation': () => [0, 1, 0] } } }),
      { initial: 'stand', states: { stand: 'Stand' } },
    );
  t.after(() => [cc, mixamo, still].forEach((f) => f.release()));
  assert.equal(rootMotionJoint(cc.animation), cc.index.get('Root'));
  assert.equal(rootMotionJoint(mixamo.animation), mixamo.index.get('Hips'));
  assert.equal(rootMotionJoint(still.animation), -1);
  assert.throws(() => addRootMotion(still.animator), RangeError);
});

test('root motion with no joint keeps a root-keyed walk in place through the whole clip and moves the character', async (t) => {
  const f = await animatorRun(animatorDocument(BIPED, { Walk: rootKeyed() }), { initial: 'walk', states: { walk: 'Walk' } });
  t.after(() => f.release());
  const motion = addRootMotion(f.animator);
  let moved = 0;
  for (let frame = 0; frame < 300; frame++) {
    f.step(1 / 60);
    moved += motion.translation[2];
    // The hips stay over the character's root, which carries the travel: never the 1 m/s drift ahead of it.
    const hips = f.world('Hips');
    assert.ok(Math.abs(hips[2] - f.store.transforms.z[f.model.root.id]) < 1e-4, `frame ${frame}: hips ${hips[2]}`);
  }
  assert.ok(Math.abs(moved - 5) < 1e-3, `travelled ${moved} m in 5 s`);
});

test('warping with no speed joint measures a root-keyed walk at its real speed', async (t) => {
  const f = await animatorRun(animatorDocument(BIPED, { Walk: rootKeyed() }), { initial: 'walk', states: { walk: 'Walk' } });
  t.after(() => f.release());
  const warp = addWarping(f.animator, { pelvis: f.index.get('Hips'), legs: legsOf(f), velocity: [0, 0, 1.3] });
  f.step(1 / 60, 30);
  assert.ok(Math.abs(warp.stride - 1.3) < 1e-4, `stride ${warp.stride} for 1.3 m/s on a 1 m/s clip`);
});
