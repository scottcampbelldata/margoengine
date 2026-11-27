// Character-Ragdoll Controller bridge (@margoengine/ragdoll/character) + ragdoll & controller debugRender().
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ragdoll } from '../dist/index.js';
import { addCharacterRagdoll } from '../dist/character.js';
import { realRig } from './rig.js';

const rtest = (name, fn) => test(name, { timeout: 60_000 }, fn);
const GENERAL = 'kaykit/adventurers/animations/Rig_Medium/Rig_Medium_General.glb';

function reversed(animation, clip, name) {
  const source = animation.clips.find((c) => c.name === clip),
    tracks = source.tracks.map((track) => {
      const count = track.times.length,
        times = new Float32Array(count),
        values = new Float32Array(track.values.length);
      for (let i = 0; i < count; i++) {
        times[i] = source.duration - track.times[count - 1 - i];
        values.set(track.values.subarray((count - 1 - i) * track.width, (count - i) * track.width), i * track.width);
      }
      return { ...track, times, values, sample: new Float32Array(track.width) };
    });
  animation.clips.push({ ...source, name, tracks });
}

rtest(
  'CharacterRagdoll isolates self-collision, walks and pushes crates, knocks down, settles and recovers with zero pop',
  async () => {
    const rig = await realRig(GENERAL, {
      states: { idle: 'Idle_A', back: 'GetUpBack', front: 'GetUpFront' },
      prepare(animation) {
        reversed(animation, 'Death_A', 'GetUpBack');
        reversed(animation, 'Death_B', 'GetUpFront');
      },
    });
    rig.frames(2);

    // Pushable crate ahead of the character (+Z)
    const crate = rig.physics.addBody(null, {
      position: [0, 0.35, 1.0],
      colliders: { shape: 'box', halfExtents: [0.35, 0.35, 0.35], density: 80 },
    });

    // Kinematic character controller capsule standing at origin (feet at y = 0, center at y = 0.9)
    const capsuleBody = rig.physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 0.9, 0],
      colliders: { shape: 'capsule', halfHeight: 0.55, radius: 0.35 },
    });
    const controller = rig.physics.createCharacterController(capsuleBody, {
      applyImpulsesToDynamicBodies: true,
      characterMass: 70,
      autostep: { maxHeight: 0.35, minWidth: 0.2 },
      snapToGround: 0.2,
    });

    const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') });
    const bridge = addCharacterRagdoll({
      controller,
      ragdoll,
      animator: rig.animator,
      getUp: { faceUp: 'back', faceDown: 'front', then: 'idle', blend: 0.35 },
      root: rig.model.root,
    });

    // 1. Walk forward into the crate: no self-collision with ragdoll hitboxes, real push force moves crate!
    assert.equal(bridge.state, 'walking');
    for (let i = 0; i < 45; i++) {
      bridge.move([0, -0.16, 0.045]);
      rig.frames(1);
    }
    assert.equal(bridge.grounded, true, 'character stays grounded while walking');
    assert.ok(
      capsuleBody.position[2] > 0.5,
      `character walked forward without hitting own ragdoll (z=${capsuleBody.position[2]})`,
    );
    assert.ok(crate.position[2] > 1.3, `character pushed crate forward (crate z=${crate.position[2]})`);

    // Debug render exports non-empty segments for both controller and ragdoll
    const kinDebug = bridge.debugRender();
    assert.ok(kinDebug.vertices.length > 0 && kinDebug.colors.length === (kinDebug.vertices.length / 3) * 4);
    const ragDebug = ragdoll.debugRender({ capsules: true, limits: true, bones: true });
    assert.ok(ragDebug.vertices.length > 0);
    const ctrlDebug = controller.debugRender();
    assert.ok(ctrlDebug.vertices.length > 0);

    // 2. Partial ragdoll on left arm keeps character walking
    const arm = rig.node('upperarm.l');
    if (arm) {
      bridge.knockdown(arm, [0, 1, -8], { limb: arm });
      assert.equal(bridge.state, 'walking', 'partial limb hit keeps walking state');
      assert.equal(ragdoll.active, true);
      rig.frames(10);
      ragdoll.deactivate(0, arm);
      rig.frames(2);
    }

    // 3. Full knockdown disables controller sweep and capsule body while limp, and the fall keeps the walk's momentum: the
    // hit boxes followed the walking pose, so the limp hips go on at the speed the capsule walked.
    for (let i = 0; i < 10; i++) {
      bridge.move([0, -0.16, 0.03]);
      rig.frames(1);
    }
    const walked = controller.computedMovement()[2] / rig.physics.fixedTimestep;
    const beforeZ = capsuleBody.position[2];
    bridge.knockdown(rig.node('chest'), [0, 3, -35]);
    const hipsSpeed = ragdoll.bones[0].body.linearVelocity[2];
    assert.ok(
      Math.abs(hipsSpeed - walked) < 0.25 * walked,
      `limp hips carry the walking speed (${hipsSpeed} m/s against ${walked} m/s)`,
    );
    assert.equal(bridge.state, 'ragdoll');
    assert.equal(capsuleBody.enabled, false, 'controller body disabled while limp');
    const blocked = bridge.move([0, 0, 1]);
    assert.deepEqual(blocked.movement, [0, 0, 0], 'move is disabled while limp');
    assert.equal(capsuleBody.position[2], beforeZ, 'capsule does not move while limp');

    // Let ragdoll fall and settle on the floor
    rig.frames(180);
    const settledHips = ragdoll.rootPosition;
    assert.ok(settledHips[1] < 0.7, `hips fell to floor (y=${settledHips[1]})`);

    // 4. Recover: relocates capsule to settled hips, runs GetUp blend, re-enables controller with zero pop
    const recoveryPromise = bridge.recover();
    assert.equal(bridge.state, 'recovering');
    assert.equal(ragdoll.active, false, 'ragdoll handed back to GetUp blend');
    rig.frames(180);
    const result = await recoveryPromise;
    assert.ok(result.side === 'faceUp' || result.side === 'faceDown');
    assert.equal(bridge.state, 'walking');
    assert.equal(capsuleBody.enabled, true, 'controller body re-enabled after recovery');

    // Verify capsule relocated near the settled hips XZ and stands cleanly on the floor
    const dx = capsuleBody.position[0] - settledHips[0],
      dz = capsuleBody.position[2] - settledHips[2];
    assert.ok(Math.hypot(dx, dz) < 1.2, `capsule relocated to settled ragdoll (dist=${Math.hypot(dx, dz)})`);

    // Walk one more step after recovery to confirm zero pop and full control restored
    rig.engine.store.tick(false);
    const rootBefore = [rig.model.root.matrix[12], rig.model.root.matrix[13], rig.model.root.matrix[14]];
    bridge.move([0, -0.16, 0.03]);
    rig.frames(1);
    rig.engine.store.tick(false);
    const rootAfter = [rig.model.root.matrix[12], rig.model.root.matrix[13], rig.model.root.matrix[14]];
    const jumpDist = Math.hypot(
      rootAfter[0] - rootBefore[0],
      rootAfter[1] - rootBefore[1],
      rootAfter[2] - rootBefore[2],
    );
    assert.ok(jumpDist < 0.15, `smooth walk resumption with no pop (step=${jumpDist} m)`);

    bridge.dispose();
    ragdoll.dispose();
    controller.dispose();
    rig.dispose();
  },
);

rtest(
  'ragdoll.debugRender tints kinematic, limp and blending modes differently and respects option toggles',
  async () => {
    const rig = await realRig(GENERAL, { states: { idle: 'Idle_A' } });
    rig.frames(2);
    const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') });
    rig.frames(2);

    const kin = ragdoll.debugRender({ capsules: true, limits: false, bones: false });
    const kinColor = [...kin.colors.slice(0, 3)];
    const withLimits = ragdoll.debugRender({ capsules: true, limits: true, bones: false });
    assert.ok(withLimits.vertices.length > kin.vertices.length, 'limits add swing cones and hinge arcs');
    const withBones = ragdoll.debugRender({ capsules: false, limits: false, bones: true });
    assert.ok(withBones.vertices.length > 0, 'bones option draws skeleton links');

    ragdoll.activate();
    rig.frames(2);
    const limp = ragdoll.debugRender({ capsules: true, limits: false, bones: false });
    const limpColor = [...limp.colors.slice(0, 3)];
    assert.notDeepEqual(limpColor, kinColor, 'limp mode has distinct tint from kinematic');

    ragdoll.deactivate(0.5);
    rig.frames(2);
    const blend = ragdoll.debugRender({ capsules: true, limits: false, bones: false });
    const blendColor = [...blend.colors.slice(0, 3)];
    assert.notDeepEqual(blendColor, limpColor, 'blending mode has distinct tint from limp');
    assert.notDeepEqual(blendColor, kinColor, 'blending mode has distinct tint from kinematic');

    ragdoll.dispose();
    rig.dispose();
  },
);

rtest('the same walk and knockdown give the same world, bit for bit', async () => {
  const run = async () => {
    const rig = await realRig(GENERAL, { states: { idle: 'Idle_A' } });
    rig.frames(2);
    const capsule = rig.physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 0.9, 0],
      colliders: { shape: 'capsule', halfHeight: 0.55, radius: 0.35 },
    });
    const controller = rig.physics.createCharacterController(capsule),
      ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') }),
      bridge = addCharacterRagdoll({ controller, ragdoll, root: rig.model.root });
    for (let i = 0; i < 20; i++) {
      bridge.move([0.01, -0.16, 0.03]);
      rig.frames(1);
    }
    bridge.knockdown(rig.node('chest'), [0, 3, -35]);
    rig.frames(30);
    const bytes = rig.physics.takeSnapshot().bytes.slice();
    bridge.dispose();
    ragdoll.dispose();
    controller.dispose();
    rig.dispose();
    return bytes;
  };
  assert.deepEqual(await run(), await run());
});

rtest('bad bridge input is a coded error with its help link', async () => {
  const rig = await realRig(GENERAL, { states: { idle: 'Idle_A' } });
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') });
  assert.throws(() => addCharacterRagdoll({ ragdoll }), { name: 'MargoError', message: /errors#ragdolls/ });
  assert.throws(() => ragdoll.debugRender({ limitScale: 0 }), { name: 'MargoError', message: /limitScale/ });
  ragdoll.dispose();
  rig.dispose();
});
