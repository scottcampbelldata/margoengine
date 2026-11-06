// AnimationLOD: how often each copy updates, that skipped time is never lost, and what fewer bones means.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { AnimationLOD, defaultLODTiers } from '../dist/lod.js';
import { skinnedStrip } from '../test/fixture.js';
import { axisAngle, engine, model, near, position, quaternion, sameRotation } from './support/models.js';

const dt = 1 / 8;
/** A clip that moves node 1 (level 0) and turns node 2 (level 1). */
function twoLevels() {
  const fixture = skinnedStrip({ extraClip: true }),
    [clip, extra] = fixture.doc.animations;
  clip.samplers.push(extra.samplers[0]);
  clip.channels.push({ sampler: 1, target: extra.channels[0].target });
  return fixture;
}
/** A real engine with its camera's planes computed, looking down -Z from the origin. */
async function scene() {
  const e = await engine();
  e.camera.position = [0, 0, 0];
  e.camera.target = [0, 0, -1];
  e.camera.far = 1000;
  e.camera.update(1, true);
  return e;
}
function copyAt(e, z, fixture = skinnedStrip()) {
  const m = model(e, fixture);
  m.root.setPosition([0, 0, z]);
  e.store.tick(false);
  const animation = new Animation(m);
  animation.playing = false;
  return animation;
}
/** Counts one copy's poses, without changing what they do. */
function counted(animation) {
  const seek = animation.seek,
    log = { poses: 0 };
  animation.seek = function (time) {
    log.poses++;
    return seek.call(this, time);
  };
  return log;
}

test('a near copy updates every frame and matches a plain Animation at every step', async () => {
  const e = await scene(),
    a = copyAt(e, -5),
    lod = AnimationLOD.attach(e);
  lod.add(a);
  for (let i = 1; i <= 4; i++) {
    lod.update(dt);
    assert.deepEqual(lod.stats, { updated: 1, skipped: 0, hidden: 0 });
    sameRotation(quaternion(a.model.nodes[2]), axisAngle([0, 0, 1], 90 * dt * i), 1e-6, `frame ${i}`);
  }
  assert.equal(lod.tierOf(a), defaultLODTiers[0]);
  lod.dispose();
});

test('a far copy updates on its turns and loses no time: each pose is where it should be', async () => {
  const e = await scene(),
    a = copyAt(e, -20),
    lod = AnimationLOD.attach(e);
  lod.add(a);
  const log = counted(a);
  let elapsed = 0;
  for (let i = 0; i < 6; i++) {
    lod.update(dt);
    elapsed += dt;
    if (lod.stats.updated) sameRotation(quaternion(a.model.nodes[2]), axisAngle([0, 0, 1], 90 * elapsed), 1e-6);
  }
  assert.equal(lod.tierOf(a), defaultLODTiers[1], 'from 15 units');
  assert.equal(log.poses, 3, 'every second frame');
  lod.dispose();
});

test('copies on one interval take turns, so no frame carries them all', async () => {
  const e = await scene(),
    copies = [0, 1, 2, 3].map(() => copyAt(e, -50)),
    lod = AnimationLOD.attach(e);
  for (const copy of copies) lod.add(copy);
  for (let i = 0; i < 8; i++) {
    lod.update(dt);
    assert.deepEqual(lod.stats, { updated: 1, skipped: 3, hidden: 0 }, `frame ${i}`);
  }
  lod.dispose();
});

test('an off-screen copy drops to the hidden tier at any distance, then catches up when seen', async () => {
  const e = await scene(),
    a = copyAt(e, 5),
    lod = AnimationLOD.attach(e, { hidden: { distance: 0, interval: 1000 } });
  lod.add(a, { radius: 1 });
  lod.update(dt); // frame 0 is every interval's turn
  const held = quaternion(a.model.nodes[2]);
  for (let i = 0; i < 3; i++) lod.update(dt);
  assert.equal(lod.stats.hidden, 1, 'behind the camera');
  assert.equal(lod.tierOf(a).interval, 1000);
  assert.deepEqual(quaternion(a.model.nodes[2]), held, 'not posed while hidden');
  a.model.root.setPosition([0, 0, -5]);
  e.store.tick(false);
  lod.update(dt);
  assert.equal(lod.stats.hidden, 0);
  assert.equal(lod.tierOf(a), defaultLODTiers[0]);
  sameRotation(quaternion(a.model.nodes[2]), axisAngle([0, 0, 1], 90 * dt * 5), 1e-6, 'all five frames applied');
  lod.dispose();
});

test('the radius keeps a copy on screen while any of it can show', async () => {
  const e = await scene(),
    a = copyAt(e, 1),
    lod = AnimationLOD.attach(e);
  lod.add(a, { radius: 3 });
  lod.update(dt);
  assert.equal(lod.stats.hidden, 0, 'a sphere reaching past the camera still counts');
  lod.add(a, { radius: 0.1 }); // adding again changes the radius
  assert.equal(lod.count, 1);
  lod.update(dt);
  assert.equal(lod.stats.hidden, 1);
  lod.dispose();
});

test('a tier with a depth animates only the upper levels; deeper nodes hold their pose', async () => {
  const e = await scene(),
    a = copyAt(e, -5, twoLevels()),
    lod = AnimationLOD.attach(e, { tiers: [{ distance: 0, interval: 1, depth: 0 }] });
  lod.add(a);
  const deep = quaternion(a.model.nodes[2]),
    shallow = position(a.model.nodes[1]);
  lod.update(0.5);
  assert.deepEqual(quaternion(a.model.nodes[2]), deep, 'level 1 holds');
  assert.notDeepEqual(position(a.model.nodes[1]), shallow, 'level 0 moves');
  assert.equal(a.time, 0.5, 'the time still advances');
  lod.dispose();
  // Handing back poses every bone again, at the time reached.
  sameRotation(quaternion(a.model.nodes[2]), axisAngle([0, 0, 1], 45), 1e-6, 'full pose restored');
});

test('remove hands a copy back at the time it reached, owed time included, playing as it was', async () => {
  const e = await scene(),
    a = copyAt(e, -50),
    lod = AnimationLOD.attach(e);
  a.playing = true;
  lod.add(a);
  assert.equal(a.playing, false, 'the LOD owns playback');
  lod.update(dt); // posed
  lod.update(dt); // owed
  assert.ok(lod.remove(a));
  assert.equal(lod.remove(a), false);
  assert.equal(lod.tierOf(a), undefined);
  assert.equal(a.playing, true);
  assert.equal(a.time, dt * 2);
  lod.dispose();
});

test('the speed option applies, and a disposed copy or model leaves by itself', async () => {
  const e = await scene(),
    fast = model(e, skinnedStrip()),
    gone = copyAt(e, -5),
    closed = copyAt(e, -5),
    lod = AnimationLOD.attach(e);
  fast.root.setPosition([0, 0, -5]);
  e.store.tick(false);
  const a = new Animation(fast, { speed: 2 });
  lod.add(a).add(gone).add(closed);
  closed.dispose();
  gone.model.dispose();
  lod.update(dt);
  assert.equal(lod.count, 1);
  assert.equal(a.time, dt * 2);
  lod.dispose();
  lod.dispose();
  assert.throws(() => lod.add(a), /disposed/);
});

test('bad input is refused with the fix in the message', async () => {
  const e = await scene(),
    a = copyAt(e, -5);
  assert.throws(() => new AnimationLOD({ tiers: [] }), /non-empty array/);
  assert.throws(() => new AnimationLOD({ tiers: [{ distance: 5, interval: 1 }] }), /start at distance 0/);
  assert.throws(
    () =>
      new AnimationLOD({
        tiers: [
          { distance: 0, interval: 1 },
          { distance: 0, interval: 2 },
        ],
      }),
    /increase/,
  );
  assert.throws(() => new AnimationLOD({ tiers: [{ distance: 0, interval: 0.5 }] }), /integer interval/);
  assert.throws(() => new AnimationLOD({ hidden: { distance: 0, interval: 1, depth: -1 } }), /hidden tier/);
  const lod = new AnimationLOD();
  assert.throws(() => lod.add(a, { radius: -1 }), /radius/);
  assert.throws(() => lod.update(-1), /Invalid animation delta/);
  near([a.time], [0], 0);
});
