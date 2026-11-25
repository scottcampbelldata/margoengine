// @margoengine/ragdoll/getup: a real rig falls in a stepping solver world, the clip that fits how it lies is chosen, the
// character moves to the body, and the bones blend into the clip without a pop.
// Stand-in: no asset in the repository has a get-up clip, so these clips are the rig's own Death_A (ends on its back) and
// Death_B (ends on its front), played backward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { addGetUp } from '../dist/getup.js';
import { realRig } from './rig.js';

const rtest = (name, fn) => test(name, { timeout: 60_000 }, fn);
const GENERAL = 'kaykit/adventurers/animations/Rig_Medium/Rig_Medium_General.glb';

/** `clip` played backward, as a new clip of `animation` called `name`. */
function reversed(animation, clip, name) {
  const source = animation.clips.find((c) => c.name === clip),
    tracks = source.tracks.map((track) => {
      assert.notEqual(track.interpolation, 'CUBICSPLINE', 'reversing keys here needs linear or step keys');
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

/**
 * The rig standing on a floor, turned `yaw` radians about up, with its ragdoll and get-up, thrown over forward (`push` > 0)
 * or backward along where it faces, sliding away from the character's root as it falls. How it lands is chaotic, so each push
 * used here lands the same way for every push within 4 of it on the solver as it stands: backward 30 does, from 26 to 34, by
 * at least 2.05 rad between the two clips' fits, straight or turned. Backward 40 did not: one kernel turned it onto its side
 * at 40 and 44 (0.74 rad against 2.11), the one before at 37.
 */
async function fallen(push, { yaw = 0, ...options } = {}) {
  const rig = await realRig(GENERAL, {
    states: { idle: 'Idle_A', back: 'GetUpBack', front: 'GetUpFront' },
    prepare(animation) {
      reversed(animation, 'Death_A', 'GetUpBack');
      reversed(animation, 'Death_B', 'GetUpFront');
    },
  });
  rig.model.root.setQuaternion([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  rig.frames(1);
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') }),
    getUp = addGetUp(ragdoll, rig.animator, { faceUp: 'back', faceDown: 'front', then: 'idle', ...options });
  rig.frames(5);
  ragdoll.activate();
  const forward = [Math.sin(yaw), 0, Math.cos(yaw)],
    slide = Math.sign(push) * 2;
  for (const part of ragdoll.bones) part.body.setLinearVelocity(forward.map((v) => v * slide));
  ragdoll.part(rig.node('chest')).body.applyImpulse(forward.map((v) => v * push));
  rig.frames(240);
  return { rig, ragdoll, getUp };
}
const worldPosition = (node) => Array.from(node.matrix.subarray(12, 15));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const across = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

rtest('a body on its back gets the face-up clip, a body on its front the face-down clip', async () => {
  const back = await fallen(-30),
    front = await fallen(20);
  assert.equal(back.getUp.pick(), 'faceUp');
  assert.equal(front.getUp.pick(), 'faceDown');
  back.rig.dispose();
  front.rig.dispose();
});

/** The head's place on each of the 26 frames a get-up starts with, from `state`'s clip played alone on a rig with no ragdoll. */
async function clipHeadPath(state) {
  const rig = await realRig(GENERAL, {
    states: { idle: 'Idle_A', back: 'GetUpBack', front: 'GetUpFront' },
    prepare(animation) {
      reversed(animation, 'Death_A', 'GetUpBack');
      reversed(animation, 'Death_B', 'GetUpFront');
    },
  });
  rig.frames(1);
  rig.animator.cancelFade();
  rig.animator.transition(state, 0);
  rig.engine.store.tick(false);
  const head = rig.node('head'),
    hips = rig.node('hips'),
    path = [];
  rig.frames(1);
  path.push(worldPosition(head));
  const reach = distance(worldPosition(head), worldPosition(hips));
  rig.frames(25, 1 / 60, () => {
    rig.engine.store.tick(false);
    path.push(worldPosition(head));
  });
  rig.dispose();
  return { path, reach };
}
const steps = (path) => path.slice(1).map((p, i) => distance(p, path[i]));

// A pop is a jump in the head's path that the clip and the blend do not make. Over the blend the drawn head is, to first order,
// p = c + w g with g = r - c: c the clip's head, r the ragdoll's (still), w the ragdoll's weight. Differencing twice, frame by
// frame, d2 p = (1 - w) d2 c + d2w g - 2 dw d c, so |d2 p| <= (1 - w) |d2 c| + |d2w| D + 2 |dw| |d c| + dw^2 D pi: |d c| and |d2 c|
// are the clip's own step and its change at that frame, dw and d2w the weight's (read each frame), D = 2 * (hips-to-head reach)
// bounds |g|, and the last term bounds the bend of a blend of rotations, the head swinging on an arc of at most pi between the two
// poses. A pop breaks this bound on one frame; the clip's own rise (to 10 cm a frame at the end of a get-up from the back) does not.
// Regression: with a linear fade the weight stopped dead on the blend's last frame (d2w = 1/24 there) and the head's step changed
// by the pose gap over 24, 2.8 cm at push 40; the eased fade has d2w of at most 6/24^2 and no stop. The positions are f32, so the
// bound carries their rounding too. Every push is checked: how
// a limp body lands is chaotic (forward pushes of 20 land it face down, 60 and 80 face up, 40 is the edge), and no landing may pop.
for (const push of [-30, 20, 40, 60, 80])
  rtest(
    `pushed by ${push}: the character comes to the body, and the bones blend into the clip with no pop`,
    async () => {
      const { rig, ragdoll, getUp } = await fallen(push),
        hips = rig.node('hips'),
        head = rig.node('head'),
        body = ragdoll.bones[0].body.position,
        side = getUp.pick(),
        state = side === 'faceUp' ? 'back' : 'front';
      rig.engine.store.tick(false);
      const before = [worldPosition(hips), worldPosition(head)],
        wasRoot = worldPosition(rig.model.root);
      assert.ok(distance(before[0], body) < 0.05, 'the hips are drawn at their body');
      assert.ok(
        across(body, wasRoot) > 0.2,
        `the body fell away from the character's root (${across(body, wasRoot)} m)`,
      );
      const finished = getUp.start();
      assert.equal(ragdoll.active, false, 'the bones are handed back');
      assert.equal(rig.animator.state, state);
      // The character's root now stands so that the clip's first frame lies on the body.
      rig.engine.store.tick(false);
      assert.ok(Math.abs(rig.model.root.matrix[13]) < 0.02, 'on the ground');
      // The drawn bones hold the ragdoll's pose on the first frame of the blend.
      rig.frames(1);
      assert.ok(distance(worldPosition(hips), before[0]) < 0.06, 'the hips stay put');
      assert.ok(distance(worldPosition(head), before[1]) < 0.12, 'the head stays put');
      const path = [worldPosition(head)],
        weights = [ragdoll.weight];
      rig.frames(25, 1 / 60, () => {
        rig.engine.store.tick(false);
        path.push(worldPosition(head));
        weights.push(ragdoll.weight);
      });
      assert.equal(ragdoll.weight, 0, 'the 0.4 s blend is over');
      const clip = await clipHeadPath(state),
        drawn = steps(path),
        own = steps(clip.path),
        reach = 2 * clip.reach,
        // Both paths are read from f32 matrices: each position is off by up to half an ulp of its size, and a change of steps
        // takes four positions from each path, so eight half-ulps of the largest coordinate either path reaches.
        largest = Math.max(...path.flat().map(Math.abs), ...clip.path.flat().map(Math.abs)),
        rounding = 8 * 2 ** -24 * largest;
      for (let k = 1; k < 25; k++) {
        const dw = weights[k + 1] - weights[k],
          d2w = dw - (weights[k] - weights[k - 1]),
          jump = Math.abs(drawn[k] - drawn[k - 1]),
          bound =
            (1 - weights[k]) * Math.abs(own[k] - own[k - 1]) +
            Math.abs(d2w) * reach +
            2 * Math.abs(dw) * own[k] +
            dw * dw * reach * Math.PI +
            rounding;
        assert.ok(
          jump <= bound,
          `push ${push}, frame ${k}: the head's step changed by ${jump} m, past the ${bound} m clip and blend allow`,
        );
      }
      assert.ok(across(worldPosition(hips), body) < 0.3, 'the clip goes on from where the body lay');
      let result = null;
      finished.then((value) => (result = value));
      for (let i = 0; i < 200 && !result; i++) {
        rig.frames(1);
        await Promise.resolve();
      }
      assert.equal(result?.side, side);
      assert.ok(result.mismatch < 1, `the clip fits the body (${result.mismatch} rad)`);
      assert.equal(rig.animator.state, 'idle', 'and goes on to the next state');
      rig.frames(30);
      assert.ok(worldPosition(head)[1] > 1, `standing (head at ${worldPosition(head)[1]} m)`);
      assert.equal(ragdoll.bones[0].body.type, 'kinematicPosition', 'hit boxes again');
      assert.ok(distance(ragdoll.bones[0].body.position, worldPosition(hips)) < 0.1, 'following the drawn hips');
      rig.dispose();
    },
  );

rtest(
  'facing does not matter: turned a radian and more, the same clips fit as well, and a side can be forced',
  async () => {
    const straight = await fallen(-30),
      turned = await fallen(-30, { yaw: 2.2 }),
      fits = straight.getUp.mismatch('faceUp'),
      wrong = straight.getUp.mismatch('faceDown');
    // Back and front differ by about half a turn at the hips, less what the fall leaves of the clip's pose.
    assert.ok(wrong - fits > 1.5, `the other clip is far off (${fits} against ${wrong} rad)`);
    assert.equal(turned.getUp.pick(), 'faceUp');
    assert.ok(Math.abs(turned.getUp.mismatch('faceUp') - fits) < 0.3, 'the same fall, turned, fits about the same');
    void turned.getUp.start({ side: 'faceDown' });
    assert.equal(turned.rig.animator.state, 'front', 'forced');
    turned.getUp.dispose();
    straight.rig.dispose();
    turned.rig.dispose();
  },
);

rtest('sampling the clips leaves the animator as it was', async () => {
  const rig = await realRig(GENERAL, {
    states: { idle: 'Idle_A', back: 'Death_A', front: 'Death_B' },
  });
  rig.frames(20);
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('hips') }),
    { time, entryTime, state } = rig.animator;
  addGetUp(ragdoll, rig.animator, { faceUp: 'back', faceDown: 'front' });
  assert.deepEqual([rig.animator.state, rig.animator.time, rig.animator.entryTime], [state, time, entryTime]);
  rig.dispose();
});

rtest('states are checked, there must be something to get up from, and an abort rejects', async () => {
  const { rig, ragdoll, getUp } = await fallen(-30);
  assert.throws(() => addGetUp(ragdoll, rig.animator, { faceUp: 'nope', faceDown: 'front' }), {
    name: 'RangeError',
    message: /Unknown animator state/,
  });
  assert.throws(() => addGetUp(ragdoll, null, {}), { name: 'TypeError' });
  assert.throws(() => addGetUp(ragdoll, rig.animator, { faceUp: 'back', faceDown: 'front', blend: -1 }), {
    name: 'RangeError',
  });
  const stop = new AbortController(),
    finished = getUp.start({ signal: stop.signal });
  assert.throws(() => getUp.start(), { code: 'state', message: /not limp/ });
  ragdoll.activate();
  assert.throws(() => getUp.start(), { code: 'state', message: /already running/ });
  stop.abort(new Error('stopped'));
  await assert.rejects(finished, /stopped/);
  getUp.dispose();
  assert.throws(() => getUp.pick(), { code: 'disposed' });
  rig.dispose();
});
