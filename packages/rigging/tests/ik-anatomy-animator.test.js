// The Animator's solvers on a fitted body: an IK chain, foot placement, full-body IK, a look-at, a CCD chain and contact
// IK each obey the body's joint ranges once `setAnatomy(animator, body)` has named it, and solve as before with
// `limits: false`. Guards the faults Scott saw in the human demos: knees and elbows folded backwards by a pole, a spine
// bent 46 degrees at every joint in any direction, a head turned further than a neck can.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Animation } from '@margoengine/animation';
import { Animator } from '@margoengine/animator';

import { addFullBodyIK } from '@margoengine/animator/fbik';
import { addCCDChain, addFootPlacement, addLookAt } from '@margoengine/animator';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { GLTFAsset, PBRModel } from '@margoengine/gltf/pbr';
import { clampPose, fitAnatomy, jointAngles, regionAngles } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { solveContactIK } from '@margoengine/rigging/contact';
import { setAnatomy } from '@margoengine/animator/ik';
import { addIKChain } from '@margoengine/rigging/ik';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';
import { bodyRig, sub } from './anatomy-fixtures.js';

/** A standing body (arms down, facing +z) as a glTF skeleton on an Animator, with its fitted anatomy. */
async function person(t, { fit = true } = {}) {
  const result = animatedTriangle(),
    { doc, buffers } = result,
    joints = bodyRig({ arms: 0, fingers: false }),
    FIRST = doc.nodes.length;
  doc.nodes[0].name = 'Triangle';
  joints.forEach((joint, i) => {
    const from = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
    doc.nodes.push({ name: joint.name, translation: sub(joint.position, from) });
    const parent = doc.nodes[joint.parent < 0 ? 1 : FIRST + joint.parent];
    (parent.children ??= []).push(FIRST + i);
  });
  doc.skins[0].joints = doc.nodes.map((_, i) => i).slice(1);
  const add = (values, type) => {
    const data = new Float32Array(values);
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC4: 4 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
  doc.animations.push({
    name: 'Stand',
    channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    samplers: [
      { input: add([0, 1], 'SCALAR'), output: add([0, 0, 0, 1, 0, 0, 0, 1], 'VEC4'), interpolation: 'LINEAR' },
    ],
  });
  const store = await TransformStore.create(128),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'stand', states: { stand: 'Stand' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  // The rig the anatomy is fitted to: the model's own nodes, index for index.
  const names = doc.nodes.map((node, i) => node.name ?? `node${i}`),
    parents = doc.nodes.map(() => -1);
  doc.nodes.forEach((node, i) => {
    for (const child of node.children ?? []) parents[child] = i;
  });
  const rest = new Float64Array(names.length * 10);
  doc.nodes.forEach((node, i) => rest.set([...(node.translation ?? [0, 0, 0]), 0, 0, 0, 1, 1, 1, 1], i * 10));
  const body = fitAnatomy({ names, parents, rest }, { species: human });
  if (fit) setAnatomy(animator, body);
  const bone = (name) => names.indexOf(name),
    tr = store.transforms;
  return {
    animator,
    body,
    bone,
    store,
    model,
    step: () => animator.onPreUpdate(1 / 60),
    /** Where a bone is in the world now. */
    at: (name) => {
      store.tick(false);
      return Array.from(model.nodes[bone(name)].matrix.subarray(12, 15));
    },
    /** The local pose now, as the anatomy reads it. */
    pose: () => {
      const pose = rest.slice();
      model.nodes.forEach((node, i) => {
        pose.set(
          [tr.x[node.id], tr.y[node.id], tr.z[node.id], tr.qx[node.id], tr.qy[node.id], tr.qz[node.id], tr.qw[node.id]],
          i * 10,
        );
      });
      return pose;
    },
    limb: (side, kind) =>
      (kind === 'arm' ? ['Arm', 'ForeArm', 'Hand'] : ['UpLeg', 'Leg', 'Foot']).map((part) => bone(`${side}${part}`)),
  };
}

/** The limb and spine joints a pose holds outside the stops no body passes. */
function outside(body, pose) {
  const issues = [];
  clampPose(body, pose.slice(), { issues });
  return (
    issues
      // The Animator keeps rotations as 32-bit floats: a joint held exactly at its stop reads a hair either side of it.
      .filter((issue) => Math.abs(issue.value - issue.limit) > 1e-3)
      .filter((issue) =>
        /hip|knee|shoulder|elbow|trunk|neck|^[TLC]\d|vc\d|skullbase|radiocarpal|talocrural/.test(issue.joint),
      )
      .map((issue) => `${issue.joint} ${issue.motion} ${issue.value.toFixed(1)} (limit ${issue.limit.toFixed(1)})`)
  );
}

test('addIKChain on a fitted Animator: a pole behind the arm cannot fold the elbow backwards', async (t) => {
  for (const limits of [true, false]) {
    const p = await person(t),
      shoulder = p.at('LeftArm'),
      chain = {
        joints: p.limb('Left', 'arm'),
        target: [shoulder[0], shoulder[1] - 0.2, 0.3],
        pole: [shoulder[0], 3, 1],
        limits,
      },
      results = [];
    chain.onSolve = (result) => results.push({ ...result });
    addIKChain(p.animator, chain);
    let least = Infinity;
    for (let frame = 0; frame < 20; frame++) {
      chain.target[2] = 0.3 + 0.1 * Math.sin(frame / 3);
      p.step();
      const { l_elbow } = jointAngles(p.body, p.pose());
      least = Math.min(least, l_elbow.flexion);
      if (!limits) continue;
      assert.ok(results.at(-1).reached, `frame ${frame}: ${results.at(-1).distance}`);
      assert.ok(l_elbow.flexion > 20, `frame ${frame}: elbow ${l_elbow.flexion}`);
      assert.deepEqual(outside(p.body, p.pose()), []);
      const hand = p.at('LeftHand');
      assert.ok(Math.hypot(...sub(hand, chain.target)) < 1e-3);
    }
    // The pole above and in front asks for an elbow that points up: free, the elbow turns inside out to do it.
    if (!limits) assert.ok(least < -20, `a free chain reversed the elbow to ${least}`);
  }
});

test('addFootPlacement on a fitted Animator: a step up bends the knee forward whatever the pole says', async (t) => {
  for (const limits of [true, false]) {
    const p = await person(t),
      legs = ['Left', 'Right'].map((side) => {
        const [hip, knee, ankle] = p.limb(side, 'leg');
        // A pole behind the body: the mistake that folds a knee backwards.
        return { hip, knee, ankle, pole: [0, 0.5, -4] };
      }),
      floor = p.at('LeftFoot')[1],
      handle = addFootPlacement(p.animator, {
        pelvis: p.bone('Hips'),
        legs,
        ground: p.model.root,
        // A 15 cm step under the left foot; the flat floor the clip stands on under the right.
        raycast: (origin) => ({ position: [origin[0], origin[0] > 0 ? 0.15 : 0, origin[2]], normal: [0, 1, 0] }),
        limits,
      });
    p.step();
    const { l_knee } = jointAngles(p.body, p.pose()),
      foot = p.at('LeftFoot');
    assert.ok(Math.abs(foot[1] - (floor + 0.15)) < 1e-3, `the foot stands on the step: ${foot[1]}`);
    if (limits) {
      assert.ok(l_knee.flexion > 25, `knee ${l_knee.flexion}`);
      assert.ok(p.at('LeftLeg')[2] > 0.05, 'the knee is in front of the hip');
      assert.deepEqual(outside(p.body, p.pose()), []);
    } else assert.ok(l_knee.flexion < -25, `a free leg follows the pole backwards: ${l_knee.flexion}`);
    handle.dispose();
  }
});

test('addFullBodyIK on a fitted Animator: the spine shares a deep reach inside each level and the trunk as a whole', async (t) => {
  const seen = {};
  for (const limits of [true, false]) {
    const p = await person(t),
      limb = (side, kind) => {
        const [upper, lower, end] = p.limb(side, kind);
        return { upper, lower, end };
      },
      hand = { ...limb('Left', 'arm'), target: [0.9, 0.5, 0.5] },
      ik = addFullBodyIK(p.animator, {
        pelvis: p.bone('Hips'),
        spine: ['Spine', 'Spine1', 'Spine2'].map(p.bone),
        legs: [limb('Left', 'leg'), limb('Right', 'leg')],
        arms: [hand, limb('Right', 'arm')],
        head: { joint: p.bone('Head') },
        balance: false,
        limits,
      });
    for (let frame = 0; frame < 5; frame++) p.step();
    const pose = p.pose(),
      angles = jointAngles(p.body, pose),
      trunk = regionAngles(p.body, pose).trunk;
    seen[limits] = { trunk, out: outside(p.body, pose), distance: ik.result.distance };
    assert.ok(angles.l_knee.flexion >= -1e-6 && angles.r_knee.flexion >= -1e-6 && angles.l_elbow.flexion >= -1e-6);
    ik.dispose();
  }
  // Free, the three spine joints each take up to 46 degrees any way: more side bend and twist than a trunk has.
  assert.ok(seen.false.out.length > 0, 'the free solve passes a stop');
  assert.deepEqual(seen.true.out, []);
  const trunk = p_trunk(seen.true.trunk);
  assert.ok(trunk > 10, `the fitted spine still bends to help the reach: ${trunk} degrees`);
});
const p_trunk = (angles) => Math.hypot(angles.flexion, angles.abduction, angles.rotation);

test('addLookAt on a fitted Animator: the head turns as far as a neck can, not to a target behind it', async (t) => {
  const turned = {};
  for (const limits of [true, false]) {
    const p = await person(t),
      head = p.at('Head');
    addLookAt(p.animator, {
      joints: [p.bone('Neck'), p.bone('Head')],
      target: [head[0] + 0.3, head[1], head[2] - 5],
      limits,
    });
    p.step();
    const pose = p.pose();
    turned[limits] = regionAngles(p.body, pose).neck;
    if (limits) assert.deepEqual(outside(p.body, pose), []);
  }
  const range = (await person(t)).body.regions.find((region) => region.id === 'neck').structural;
  assert.ok(Math.abs(turned.false.rotation) > 150, `free, the head faces backwards: ${turned.false.rotation}`);
  assert.ok(Math.abs(turned.true.rotation) <= Math.max(-range[4], range[5]) + 1e-6, `fitted: ${turned.true.rotation}`);
  assert.ok(Math.abs(turned.true.rotation) > 40, 'and it still turns as far as it can');
});

test('addCCDChain and solveContactIK take the body ranges by default: hinges stop at straight', async (t) => {
  for (const body of [undefined, null]) {
    const p = await person(t),
      shoulder = p.at('LeftArm'),
      // Behind and above the shoulder: free, CCD curls the elbow backwards to get there.
      chain = { joints: p.limb('Left', 'arm'), target: [shoulder[0] + 0.1, shoulder[1] + 0.25, -0.3], body };
    addCCDChain(p.animator, chain);
    let least = Infinity;
    for (let frame = 0; frame < 10; frame++) {
      p.step();
      least = Math.min(least, jointAngles(p.body, p.pose()).l_elbow.flexion);
      if (body !== null) assert.deepEqual(outside(p.body, p.pose()), [], `frame ${frame}`);
    }
    if (body === null) assert.ok(least < -5, `a free CCD chain bent the elbow to ${least}`);
    else assert.ok(least >= -1e-6, `the elbow stayed at or inside straight: ${least}`);
  }
  // Contact IK on a pose: the palm on a point behind the back.
  const p = await person(t),
    joints = p.limb('Left', 'arm'),
    solve = (body) => {
      // The pose carries its body; `body: null` on the contact leaves it out.
      const pose = { parents: p.body.parents.slice(), local: p.body.rest.slice(), body: p.body },
        result = solveContactIK(pose, {
          joints,
          point: [0.1, 1.2, -0.25],
          rotation: [0, 0, 0, 1],
          anchor: [0, 0, 0],
          body,
        });
      return { result, elbow: jointAngles(p.body, pose.local).l_elbow };
    };
  assert.ok(solve(undefined).elbow.flexion >= -1e-6, `fitted: ${solve(undefined).elbow.flexion}`);
  assert.ok(solve(null).elbow.flexion < -5, `free: ${solve(null).elbow.flexion}`);
});

test("the Animator's own footIK on a fitted Animator: the knee bends forward whatever the pole says (KB-ANIM-FOOTIK-ANATOMY1)", async (t) => {
  for (const fit of [true, false]) {
    const p = await person(t, { fit }),
      [hip, knee, ankle] = p.limb('Left', 'leg'),
      floor = p.at('LeftFoot')[1];
    // A pole behind the body, and a 15 cm step under the left foot.
    p.animator.addFootIK({
      hip,
      knee,
      ankle,
      pole: [0.1, 0.5, -4],
      raycast: (origin) => ({ position: [origin[0], floor + 0.15, origin[2]] }),
    });
    p.step();
    const { l_knee, l_hip } = jointAngles(p.body, p.pose()),
      foot = p.at('LeftFoot');
    assert.ok(Math.abs(foot[1] - (floor + 0.15)) < 1e-3, `the foot stands on the step: ${foot[1]}`);
    if (fit) {
      assert.ok(l_knee.flexion > 25, `knee ${l_knee.flexion}`);
      assert.ok(p.at('LeftLeg')[2] > 0.05, 'the knee is in front of the hip');
      assert.deepEqual(outside(p.body, p.pose()), []);
      // The pole behind the knee is left out: the knee points forward, not turned out to the hip's stop.
      assert.ok(Math.abs(l_hip.rotation) < 15, `hip rotation ${l_hip.rotation}`);
    } else assert.ok(l_knee.flexion < -25, `a free leg follows the pole backwards: ${l_knee.flexion}`);
  }
});

test('a pole behind the knee is left out: the leg takes its comfortable swivel, not the hip stop (KB-ANIM-POLEBEHIND1)', async (t) => {
  const place = async (pole) => {
    const p = await person(t),
      [hip, knee, ankle] = p.limb('Left', 'leg'),
      floor = p.at('LeftFoot')[1],
      handle = addFootPlacement(p.animator, {
        pelvis: p.bone('Hips'),
        legs: [{ hip, knee, ankle, pole }],
        ground: p.model.root,
        raycast: (origin) => ({ position: [origin[0], floor + 0.15, origin[2]], normal: [0, 1, 0] }),
      });
    p.step();
    const angles = jointAngles(p.body, p.pose()),
      knees = { knee: p.at('LeftLeg'), hip: p.at('LeftUpLeg'), outside: outside(p.body, p.pose()) };
    handle.dispose();
    return { ...angles, ...knees };
  };
  for (const pole of [
    [0, 0.5, -4],
    [0.3, 0.5, -4],
    [-0.3, 0.5, -4],
  ]) {
    const { l_knee, l_hip, outside: out } = await place(pole);
    assert.ok(l_knee.flexion > 25, `knee ${l_knee.flexion}`);
    assert.ok(Math.abs(l_hip.rotation) < 15, `pole ${pole}: hip rotation ${l_hip.rotation}`);
    assert.deepEqual(out, []);
  }
  // A pole at the knee's side still turns it toward that side, as far as the hip lets it.
  const side = await place([4, 0.5, 0.5]);
  assert.ok(side.knee[0] > side.hip[0] + 0.03, `the knee turns out toward a pole at its side: ${side.knee[0]}`);
});
