// GAP-FILM-TIME: an animation started at film time T poses what a continuous run poses at T. Run A takes n + 1 live
// frame updates; run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs,
// posing nothing), then takes one live update. Clocks, play state and every posed node transform must be equal, bit
// for bit, at n = 1, 600 and 54,000 steps (15 minutes at 60 fps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation, AnimationGroup, Skeleton, createKeyframeClip } from '../dist/index.js';
import { PlaybackAnimation, LoopPingPong } from '../dist/playback.js';
import { AnimationMixer, LoopOnce } from '../dist/mixer.js';
import { AnimationLOD } from '../dist/lod.js';
import { MorphWeightPlayer } from '../dist/morph-gpu.js';
import { VATCrowd, bakeVAT } from '../dist/vat.js';
import { PBRModel, GLTFAsset } from '../../gltf/dist/pbr.js';
import { skinnedStrip } from '../test/fixture.js';
import { ownerEngine } from './owner-lifetime.fixture.js';
import { engine, model, position, quaternion } from './support/models.js';

const dt = 1 / 60,
  counts = [1, 600, 54000];
/** Every node's local position and rotation, as stored. */
const pose = (m) => m.nodes.map((node) => [...position(node), ...quaternion(node)]);
/** Runs A (n + 1 live updates) and B (n replayed steps, one live update) and returns both. */
function replay(make, n, live = (x) => x.onPreUpdate(dt)) {
  const a = make(),
    b = make();
  assert.equal(b.clock.time, 0, 'a fresh clock reads 0, as seek needs');
  for (let i = 0; i <= n; i++) live(a.clock);
  for (let i = 0; i < n; i++) b.clock.advanceTime(dt);
  live(b.clock);
  return [a, b];
}

async function strip(t, make) {
  const e = await ownerEngine(t),
    data = skinnedStrip({ extraClip: true }),
    m = new PBRModel(e, new GLTFAsset(data.doc, data.buffers)),
    clock = make(m);
  t.after(() => {
    clock.dispose();
    m.dispose();
  });
  return { model: m, clock };
}

for (const n of counts)
  for (const options of [{}, { loop: false }, { speed: 1.5 }])
    test(`Animation ${JSON.stringify(options)} replayed ${n} steps poses as a continuous run`, async (t) => {
      const runs = [
          await strip(t, (m) => Animation.attach(m, options)),
          await strip(t, (m) => Animation.attach(m, options)),
        ],
        [a, b] = runs;
      for (let i = 0; i <= n; i++) a.clock.onPreUpdate(dt);
      assert.equal(b.clock.time, 0);
      for (let i = 0; i < n; i++) b.clock.advanceTime(dt);
      assert.deepEqual(
        pose(b.model),
        pose((await strip(t, (m) => Animation.attach(m, options))).model),
        'a replayed step poses nothing',
      );
      b.clock.onPreUpdate(dt);
      assert.ok(Object.is(b.clock.time, a.clock.time), `time ${b.clock.time} != ${a.clock.time}`);
      assert.equal(b.clock.playing, a.clock.playing);
      assert.deepEqual(pose(b.model), pose(a.model));
      if (options.loop === false && n >= 600)
        assert.equal(a.clock.playing, false, 'a clip that does not loop stops at its end');
    });

for (const n of [1, 90, 600, 54000])
  for (const options of [{ repetitions: 3 }, { loopMode: LoopPingPong, repetitions: 7 }, { timeScale: -1 }])
    test(`PlaybackAnimation ${JSON.stringify(options)} replayed ${n} steps lands on the cursor, loops and pose of a continuous run`, async (t) => {
      const make = async () => {
        const run = await strip(t, (m) => new PlaybackAnimation(m, { ...options, timeScale: undefined })),
          events = [];
        if (options.timeScale) run.clock.timeScale = options.timeScale;
        run.clock.on('loop', () => events.push('loop'));
        run.clock.on('finished', () => events.push('finished'));
        run.clock.play();
        return { ...run, events };
      };
      const a = await make(),
        b = await make();
      for (let i = 0; i <= n; i++) a.clock.onPreUpdate(dt);
      for (let i = 0; i < n; i++) b.clock.advanceTime(dt);
      assert.deepEqual(b.events, [], 'a replayed step sends no loop or finished event');
      b.clock.onPreUpdate(dt);
      for (const key of ['cursor', 'completed', 'terminal', 'settled'])
        assert.ok(Object.is(b.clock[key], a.clock[key]), `${key}: ${b.clock[key]} != ${a.clock[key]}`);
      assert.ok(Object.is(b.clock.time, a.clock.time), `time ${b.clock.time} != ${a.clock.time}`);
      assert.equal(b.clock.playing, a.clock.playing);
      assert.deepEqual(pose(b.model), pose(a.model));
      if (a.clock.terminal) {
        assert.equal((await b.clock.finished).type, 'finished', 'a replayed end still settles `finished`');
        assert.equal(a.events.at(-1), 'finished');
      }
      if (options.repetitions && n >= 600)
        assert.equal(a.clock.terminal, true, 'three or seven one-second runs end inside 10 s');
    });

for (const n of counts)
  test(`AnimationGroup replayed ${n} steps poses every member as a continuous run`, async () => {
    const make = async () => {
      const e = await engine(),
        members = [0, 0.25, -0.5].map(() => new Animation(model(e, skinnedStrip({ extraClip: true })))),
        clock = new AnimationGroup('bend', { speed: 1.25 });
      members.forEach((member, i) => clock.add(member, i * 0.3));
      return { clock, models: members.map((m) => m.model) };
    };
    const a = await make(),
      b = await make();
    for (let i = 0; i <= n; i++) a.clock.update(dt);
    for (let i = 0; i < n; i++) b.clock.advanceTime(dt);
    b.clock.update(dt);
    assert.ok(Object.is(b.clock.time, a.clock.time));
    assert.deepEqual(b.models.map(pose), a.models.map(pose));
  });

for (const n of counts)
  test(`AnimationLOD with a fixed camera replayed ${n} steps gives the same turns, times and poses`, async () => {
    const make = async () => {
      const e = await engine();
      e.camera.position = [0, 0, 0];
      e.camera.target = [0, 0, -1];
      e.camera.far = 1000;
      e.camera.update(1, true);
      const clock = AnimationLOD.attach(e),
        copies = [-5, -40, -120, 30].map((z) => {
          const m = model(e, skinnedStrip());
          m.root.setPosition([0, 0, z]);
          e.store.tick(false);
          const animation = new Animation(m);
          clock.add(animation);
          return animation;
        });
      return { clock, copies };
    };
    const a = await make(),
      b = await make();
    for (let i = 0; i <= n; i++) a.clock.onPreUpdate(dt);
    for (let i = 0; i < n; i++) b.clock.advanceTime(dt);
    b.clock.onPreUpdate(dt);
    assert.ok(Object.is(b.clock.time, a.clock.time));
    assert.deepEqual(b.clock.stats, a.clock.stats);
    assert.deepEqual(
      b.copies.map((c) => [b.clock.tierOf(c), c.time, pose(c.model)]),
      a.copies.map((c) => [a.clock.tierOf(c), c.time, pose(c.model)]),
    );
  });

const translate = (name, from, to, duration = 1) =>
  createKeyframeClip({
    name,
    tracks: [
      {
        target: 'root',
        path: 'translation',
        keys: [
          { time: 0, value: from },
          { time: duration, value: to },
        ],
      },
    ],
  });

for (const n of counts)
  test(`AnimationMixer with fades, a warp, a start time and a run that ends replayed ${n} steps blends as a continuous run`, () => {
    const make = () => {
      const root = new Skeleton([{ name: 'root', parent: -1 }]),
        clock = new AnimationMixer(root),
        walk = clock.clipAction(translate('walk', [0, 0, 0], [10, 0, 0])).play(),
        run = clock.clipAction(translate('run', [0, 5, 0], [20, 5, 0], 0.7)).play(),
        wave = clock
          .clipAction(translate('wave', [0, 0, 1], [0, 0, 3], 2))
          .startAt(0.4)
          .play();
      walk.crossFadeTo(run, 0.5, true);
      wave.setLoop(LoopOnce);
      wave.clampWhenFinished = true;
      clock.timeScale = 0.75;
      return { clock, root, actions: [walk, run, wave] };
    };
    const [a, b] = replay(make, n);
    assert.ok(Object.is(b.clock.time, a.clock.time));
    const state = (r) => ({
      pose: r.root.getPose(0),
      actions: r.actions.map((x) => [x.time, x.enabled, x.paused, x.getEffectiveWeight(), x.getEffectiveTimeScale()]),
    });
    assert.deepEqual(state(b), state(a));
  });

test('a replayed mixer step writes no property; the next update writes the blend at the time reached', () => {
  const root = new Skeleton([{ name: 'root', parent: -1 }]),
    mixer = new AnimationMixer(root);
  mixer.clipAction(translate('walk', [0, 0, 0], [10, 0, 0])).play();
  for (let i = 0; i < 30; i++) mixer.advanceTime(dt);
  assert.deepEqual([...root.getPose(0).translation], [0, 0, 0]);
  mixer.update(dt);
  assert.ok(Math.abs(root.getPose(0).translation[0] - (31 / 60) * 10) < 1e-9);
});

for (const n of counts)
  test(`MorphWeightPlayer and VATCrowd replayed ${n} steps read the time of a continuous run`, async () => {
    const e = await engine(),
      vat = bakeVAT(new Animation(model(e, skinnedStrip())), { fps: 4 });
    const morph = () => {
      const clock = new MorphWeightPlayer('Talk');
      clock.speed = 1.5;
      return { clock };
    };
    const [ma, mb] = replay(morph, n);
    assert.ok(Object.is(mb.clock.time, ma.clock.time));
    const [va, vb] = replay(() => ({ clock: new VATCrowd(vat) }), n);
    assert.ok(Object.is(vb.clock.time, va.clock.time));
  });

test('advanceTime takes frame deltas only, and a disposed clock stays where it is', async () => {
  const e = await engine(),
    group = new AnimationGroup('bend'),
    lod = new AnimationLOD(),
    mixer = new AnimationMixer(new Skeleton([{ name: 'root', parent: -1 }])),
    crowd = new VATCrowd(bakeVAT(new Animation(model(e, skinnedStrip())), { fps: 4 })),
    morph = new MorphWeightPlayer(0);
  for (const clock of [group, lod, crowd, morph]) {
    assert.throws(() => clock.advanceTime(-1), RangeError);
    assert.throws(() => clock.advanceTime(Number.NaN), RangeError);
  }
  assert.throws(() => mixer.advanceTime(Number.NaN), /mixer delta/);
  for (const clock of [lod, crowd, morph]) {
    clock.dispose();
    clock.advanceTime(dt);
    assert.equal(clock.time, 0);
  }
});

test('KB-GLTFA B1: bakeVAT of a joint scaled to zero writes finite unit normals (+Y where the normal is flattened)', async () => {
  const e = await engine(),
    m = model(e, skinnedStrip());
  m.nodes[2].setScale([0, 0, 0]);
  const vat = bakeVAT(new Animation(m), { fps: 4 });
  let up = 0;
  for (let o = 0; o < vat.texels.length; o += 8) {
    const n = vat.texels.subarray(o + 4, o + 7);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-5, `texel ${o}: ${n}`);
    if (n[1] === 1) up++;
  }
  assert.ok(up > 0, 'vertices on the flattened joint face +Y');
});
