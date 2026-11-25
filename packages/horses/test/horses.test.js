// Measured bounds of @margoengine/horses: anatomy against the published weights and heights, gait timing and stride
// length against equine biomechanics, hooves that stay planted through the stance, the rig and glTF document, the rider
// seat, the motion clock's determinism and the slider rows. Every test fails on a tree without the package.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HORSE_TYPES, handsToMetres, horseBody, horseMass } from '../dist/anatomy.js';
import {
  GAITS,
  GAIT_PATTERNS,
  froude,
  gaitFor,
  hoofPhase,
  hoovesDown,
  preferredSpeed,
  speedAtFroude,
  stride,
  strideFrequency,
  strideLength,
  trunkMotion,
} from '../dist/gaits.js';
import {
  BREAKOVER,
  COAT_COLORS,
  HORSE_COATS,
  coatAtlas,
  coatAtlasUV,
  horseDocument,
  horseGLB,
  horseJointTranslation,
  horsePose,
  horseSkeleton,
  horseTailFlick,
  poseHooves,
  poseJoints,
  poseSaddle,
} from '../dist/model.js';
import { SeatFollower, mountRider, riderSeat } from '../dist/seat.js';
import { HORSE_SETTINGS, horseOptionsFromSettings, horseSettingDefaults } from '../dist/settings.js';
import { HorseMotion, blendPoses } from '../dist/index.js';
import { addHorseCrowd, saddleFrame } from '../dist/crowd.js';

test('anatomy: weights from girth and length fall in each breed group published range', () => {
  // Carroll and Huntington 1988; ranges: Thoroughbred 450-550 kg, remount 950-1200 lb, heavy draft 750-1000 kg.
  const ranges = { riding: [450, 550], cavalry: [430, 545], draft: [750, 1000] };
  for (const type of HORSE_TYPES) {
    const b = horseBody({ type });
    assert.ok(b.mass >= ranges[type][0] && b.mass <= ranges[type][1], `${type} ${b.mass.toFixed(0)} kg`);
  }
  assert.ok(Math.abs(horseMass(1.85, 1.65) - (185 ** 2 * 165) / 11880) < 1e-9);
  assert.ok(Math.abs(handsToMetres(16) - 1.6256) < 1e-9);
  assert.ok(Math.abs(handsToMetres(15.2) - 62 * 0.0254) < 1e-9);
  assert.throws(() => handsToMetres(15.5), RangeError);
  // The draft horse is deeper in the chest and shorter in the leg for its height, with heavier bone.
  const r = horseBody({ type: 'riding' }),
    d = horseBody({ type: 'draft' });
  assert.ok(d.chestDepth / d.withers > r.chestDepth / r.withers);
  assert.ok(d.elbow / d.withers < r.elbow / r.withers);
  assert.ok(d.cannon / d.withers > r.cannon / r.withers);
  assert.ok(horseBody({ condition: 1.2 }).mass > r.mass * 1.4);
  assert.throws(() => horseBody({ type: 'pony' }), TypeError);
  assert.throws(() => horseBody({ withers: 3 }), RangeError);
});

test('gaits: stride length follows Alexander and Jayes and lands in the measured horse ranges', () => {
  const b = horseBody();
  for (const v of [1, 2, 4, 7, 12, 16]) {
    const fr = v ** 2 / (9.80665 * b.hipJoint);
    assert.ok(Math.abs(strideLength(b, v) - 2.3 * b.hipJoint * fr ** 0.3) < 1e-12);
  }
  // Published strides of riding horses: walk about 1.6-1.9 m at 1.5-1.7 m/s (Hildebrand 1965), working trot 2.5-3.0 m
  // at 3.5-4.5 m/s (Clayton 1994), canter 3.3-4.2 m at 6-8 m/s (Clayton 1993), racing gallop 5.5-7.5 m at 14-17 m/s.
  const within = (v, lo, hi) => {
    const s = strideLength(b, v);
    assert.ok(s >= lo && s <= hi, `${v} m/s: ${s.toFixed(2)} m`);
  };
  within(1.6, 1.5, 1.9);
  within(4, 2.5, 3.0);
  within(7, 3.3, 4.2);
  within(16, 5.5, 7.5);
  // Gallop stride frequency 2.0-2.6 Hz (Heglund et al. 1974); stride grows with speed.
  assert.ok(strideFrequency(b, 16) > 2 && strideFrequency(b, 16) < 2.6);
  for (let v = 0.5; v < 20; v += 0.5) assert.ok(strideLength(b, v + 0.5) > strideLength(b, v));
  assert.equal(strideLength(b, 0), 0);
  assert.ok(Math.abs(froude(b, speedAtFroude(b, 1.7)) - 1.7) < 1e-12);
});

test('gaits: the gait follows speed by Froude number, so a bigger horse changes gait at a higher speed', () => {
  const b = horseBody();
  assert.deepEqual(
    [1.5, 3.5, 6, 12].map((v) => gaitFor(b, v)),
    ['walk', 'trot', 'canter', 'gallop'],
  );
  // Walk-trot near Froude 0.4 (Alexander 1989): about 2 m/s for this horse.
  const wt = speedAtFroude(b, 0.4);
  assert.ok(wt > 1.9 && wt < 2.3, `walk to trot at ${wt.toFixed(2)} m/s`);
  const pony = horseBody({ withers: 1.3 });
  assert.equal(gaitFor(pony, 1.95), 'trot');
  assert.equal(gaitFor(b, 1.95), 'walk');
  for (const g of GAITS) assert.equal(gaitFor(b, preferredSpeed(b, g)), g);
});

test('gaits: footfall order, pairs, duty factors and suspensions match Hildebrand and Clayton', () => {
  const b = horseBody(),
    at = (g, k = 1) => stride(b, preferredSpeed(b, g) * k, g);
  // Walk: lateral sequence LH, LF, RH, RF a quarter stride apart, never fewer than two hooves down, duty 0.6-0.75.
  const walk = at('walk');
  assert.deepEqual(walk.strike, [0, 0.25, 0.5, 0.75]);
  assert.ok(walk.duty >= 0.6 && walk.duty <= 0.75);
  for (let p = 0; p < 1; p += 0.005) assert.ok(hoovesDown(walk, p) >= 2);
  // Trot: diagonal pairs strike together, half a stride apart, with two suspensions.
  const trot = at('trot');
  assert.equal(trot.strike[0], trot.strike[3]);
  assert.equal(trot.strike[1], trot.strike[2]);
  assert.equal(Math.abs(trot.strike[0] - trot.strike[1]), 0.5);
  const air = (s) => {
    let runs = 0,
      prev = hoovesDown(s, 0.999) === 0;
    for (let p = 0; p < 1; p += 0.001) {
      const now = hoovesDown(s, p) === 0;
      if (now && !prev) runs++;
      prev = now;
    }
    return runs;
  };
  assert.equal(air(walk), 0);
  assert.equal(air(trot), 2);
  // Canter (left lead): trailing hind, diagonal pair, leading fore, one suspension. Gallop: RH, LH, RF, LF, one suspension.
  const canter = at('canter'),
    gallop = at('gallop'),
    order = (s) => [0, 1, 2, 3].sort((x, y) => s.strike[x] - s.strike[y]);
  assert.deepEqual(order(canter), [2, 0, 3, 1]);
  assert.deepEqual(order(gallop), [2, 0, 3, 1]);
  assert.ok(canter.strike[3] - canter.strike[0] < 0.08, 'the canter diagonal pair lands nearly together');
  assert.equal(air(canter), 1);
  assert.equal(air(gallop), 1);
  // Duty factor falls with speed within each gait, and the gallop's is the shortest.
  for (const g of GAITS) assert.ok(at(g, 1.2).duty <= at(g, 0.9).duty);
  assert.ok(gallop.duty < 0.33 && gallop.duty > 0.2);
  assert.ok(trot.duty > 0.36 && trot.duty < 0.48);
  assert.deepEqual(hoofPhase(trot, 0, 0), { stance: true, t: 0 });
});

test('gaits: the trunk rises and falls twice a stride at walk and trot, once at canter and gallop', () => {
  const b = horseBody();
  for (const g of GAITS) {
    const s = stride(b, preferredSpeed(b, g), g);
    let lo = Infinity,
      hi = -Infinity,
      peaks = 0,
      prev = trunkMotion(b, s, 0.999).rise,
      prev2 = trunkMotion(b, s, 0.998).rise;
    for (let p = 0; p < 1; p += 0.001) {
      const r = trunkMotion(b, s, p).rise;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
      if (prev > prev2 && prev > r) peaks++;
      prev2 = prev;
      prev = r;
    }
    assert.equal(peaks, GAIT_PATTERNS[g].bounces, g);
    assert.ok(Math.abs(hi - lo - GAIT_PATTERNS[g].rise * b.withers) < 1e-3, `${g} rise ${(hi - lo).toFixed(3)}`);
  }
  // About 8 cm at the trot for a 1.63 m horse (Buchner et al. 1996).
  assert.ok(Math.abs(GAIT_PATTERNS.trot.rise * 1.63 - 0.08) < 0.01);
});

test('model: stance hooves stay planted and swing hooves lift, every gait, type and speed', () => {
  for (const type of HORSE_TYPES) {
    const b = horseBody({ type }),
      sk = horseSkeleton(b);
    for (const g of GAITS)
      for (const k of [0.8, 1, 1.25]) {
        const s = stride(b, preferredSpeed(b, g) * k, g);
        for (let h = 0; h < 4; h++) {
          let first,
            slide = 0,
            high = 0,
            lift = 0;
          for (let i = 0; i <= 40; i++) {
            const t = (i / 40) * BREAKOVER,
              loc = t * s.duty,
              p = poseHooves(sk, horsePose(sk, s, (s.strike[h] + loc) % 1))[h],
              z = p[2] + s.speed * loc * s.duration;
            first ??= z;
            slide = Math.max(slide, Math.abs(z - first));
            high = Math.max(high, p[1]);
          }
          for (let i = 1; i < 20; i++)
            lift = Math.max(
              lift,
              poseHooves(sk, horsePose(sk, s, (s.strike[h] + s.duty + ((1 - s.duty) * i) / 20) % 1))[h][1],
            );
          const label = `${type} ${g} x${k} hoof ${h}`;
          assert.ok(slide < 0.03, `${label} slides ${slide.toFixed(3)} m in stance`);
          assert.ok(high < 0.035, `${label} rises ${high.toFixed(3)} m in stance`);
          assert.ok(lift > 0.06 * b.withers, `${label} lifts only ${lift.toFixed(3)} m in swing`);
        }
      }
  }
});

test('model: each limb travels continuously through lift-off and follows its anatomical hinge', () => {
  const bend = (points, start) => {
    const [a, b, c] = points.slice(start, start + 3);
    const incoming = Math.atan2(b[2] - a[2], b[1] - a[1]);
    const outgoing = Math.atan2(c[2] - b[2], c[1] - b[1]);
    return Math.atan2(Math.sin(outgoing - incoming), Math.cos(outgoing - incoming));
  };
  for (const type of HORSE_TYPES) {
    const b = horseBody({ type }),
      sk = horseSkeleton(b);
    for (const gait of GAITS) {
      const cycle = stride(b, preferredSpeed(b, gait), gait);
      const count = 1000;
      let previous = poseJoints(sk, horsePose(sk, cycle, 0));
      for (let frame = 1; frame <= count; frame++) {
        const phase = frame / count;
        const joints = poseJoints(sk, horsePose(sk, cycle, phase));
        for (const [hoof, leg] of sk.legs.entries()) {
          const label = `${type} ${gait}, hoof ${hoof}, phase ${phase}`;
          for (const i of leg) {
            const jump = Math.hypot(...joints[i].map((v, axis) => v - previous[i][axis]));
            assert.ok(jump < 0.024 * b.withers, `${label}: ${sk.joints[i].name} jumps ${jump.toFixed(3)} m`);
          }
          const hinge = bend(
            leg.map((i) => joints[i]),
            2,
          );
          const fore = hoof % 2 === 1;
          assert.ok(fore ? hinge >= -1e-8 : hinge <= 1e-8, `${label}: reversed hinge`);
          const step = hoofPhase(cycle, hoof, phase);
          if (fore && step.stance && step.t > 0.25 && step.t < 0.72)
            assert.ok(hinge < 0.17, `${label}: carpus buckles while bearing weight`);
        }
        previous = joints;
      }
    }
  }
});

test('model: the rig, the standing pose and the document', () => {
  const b = horseBody(),
    sk = horseSkeleton(b);
  assert.equal(sk.joints.length, 37);
  assert.equal(sk.joints[0].parent, -1);
  sk.joints.forEach((j, i) => assert.ok(j.parent < i));
  const stand = horsePose(sk, null, 0, 0),
    hooves = poseHooves(sk, stand);
  hooves.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - sk.ground[i][k]) < 1e-9)));
  // The withers and croup tops stand at their measured heights; the saddle sits just behind the withers.
  const saddle = poseSaddle(sk, stand).position;
  assert.ok(Math.abs(saddle[1] - 0.99 * b.withers) < 1e-9 && saddle[2] > 0);
  assert.deepEqual(
    horsePose(sk, stride(b, 4), 0.3),
    horsePose(sk, stride(b, 4), 0.3),
    'a pose is a pure function of the phase',
  );
  assert.equal(poseJoints(sk, stand).length, sk.joints.length);
  const full = horseDocument(),
    { doc } = full;
  assert.deepEqual(
    doc.materials.map((m) => m.name),
    ['Coat', 'Hoof', 'Mane', 'Tail', 'Eye'],
  );
  assert.deepEqual(
    doc.animations.map((a) => a.name),
    ['stand', 'walk', 'trot', 'canter', 'gallop'],
  );
  assert.equal(doc.skins[0].joints.length, sk.joints.length);
  assert.ok(doc.nodes.some((n) => n.name === 'saddle'));
  // Model height: the poll stands above the withers, the muzzle reaches past the chest, nothing below the ground.
  const pos = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];
  assert.ok(pos.max[1] > 1.15 * b.withers && pos.max[1] < 1.4 * b.withers, `top ${pos.max[1]}`);
  assert.ok(pos.min[1] >= -1e-6 && pos.max[2] - pos.min[2] > 1.4 * b.bodyLength);
  // Weights sum to one; joint indices are in the rig.
  for (const prim of doc.meshes[0].primitives) {
    const wv = full.buffers[doc.bufferViews[doc.accessors[prim.attributes.WEIGHTS_0].bufferView].buffer],
      w = new Float32Array(wv.buffer, wv.byteOffset, wv.byteLength / 4),
      jv = full.buffers[doc.bufferViews[doc.accessors[prim.attributes.JOINTS_0].bufferView].buffer],
      j = new Uint16Array(jv.buffer, jv.byteOffset, jv.byteLength / 2);
    for (let i = 0; i < w.length; i += 4) assert.ok(Math.abs(w[i] + w[i + 1] + w[i + 2] + w[i + 3] - 1) < 1e-5);
    assert.ok(j.every((x) => x < sk.joints.length));
  }
  // Detail levels fall away for a far crowd; clips last one stride at their speed.
  assert.ok(
    horseDocument({ detail: 0 }).vertices < horseDocument({ detail: 1 }).vertices &&
      horseDocument({ detail: 1 }).vertices < full.vertices,
  );
  for (const c of full.clips.slice(1)) assert.ok(Math.abs(c.duration - c.strideLength / c.speed) < 1e-12);
  const glb = horseGLB({ detail: 0 });
  assert.equal(new DataView(glb.buffer).getUint32(0, true), 0x46546c67);
  assert.equal(new DataView(glb.buffer).getUint32(8, true), glb.length);
  assert.throws(() => horseDocument({ coat: 'purple' }), TypeError);
  assert.throws(() => horseDocument({ markings: { socks: [1, 0, 0] } }), RangeError);
  assert.throws(() => horseDocument({ speeds: { trot: 0 } }), RangeError);
});

test('scapulae slide on the thorax and the exported trot carries both translation tracks', () => {
  const document = horseDocument(),
    sk = document.skeleton,
    b = sk.body,
    cycle = stride(b, preferredSpeed(b, 'trot'), 'trot'),
    left = sk.index('scapulaL'),
    right = sk.index('scapulaR');
  const poses = Array.from({ length: 129 }, (_, i) => horsePose(sk, cycle, i / 128));
  for (const side of [0, 1]) {
    const z = poses.map((p) => p.scapulaOffsets[side][2]),
      y = poses.map((p) => p.scapulaOffsets[side][1]);
    assert.ok(Math.abs(Math.max(...z) - Math.min(...z) - 0.049 * b.withers) < 0.0001);
    assert.ok(Math.max(...y) > 0.024 && Math.min(...y) === 0);
    assert.deepEqual(poses[0].scapulaOffsets[side], poses.at(-1).scapulaOffsets[side]);
  }
  const trot = document.doc.animations.find((clip) => clip.name === 'trot');
  for (const index of [left, right]) {
    const track = trot.channels.find((ch) => ch.target.node === index && ch.target.path === 'translation');
    const accessor = document.doc.accessors[trot.samplers[track.sampler].output];
    const view = document.doc.bufferViews[accessor.bufferView];
    const bytes = document.buffers[view.buffer];
    const values = new Float32Array(
      bytes.buffer,
      bytes.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
      accessor.count * 3,
    );
    for (let k = 0; k < accessor.count; k++) {
      const start = k * 3;
      const expected = horseJointTranslation(sk, horsePose(sk, cycle, k / (accessor.count - 1)), index);
      assert.deepEqual([...values.subarray(start, start + 3)], expected.map(Math.fround));
    }
  }
});

test('a tail flick begins at the dock and travels through the hair without disturbing the feet', () => {
  const skeleton = horseSkeleton(horseBody());
  const pose = horsePose(skeleton, null, 0, 0.3);
  const dock = skeleton.index('tail1'),
    tip = skeleton.index('tailHair5');
  const early = horseTailFlick(skeleton, pose, 0.08);
  assert.notDeepEqual(early.rotations[dock], pose.rotations[dock]);
  assert.deepEqual(early.rotations[tip], pose.rotations[tip]);
  const end = horseTailFlick(skeleton, pose, 0.33),
    across = horseTailFlick(skeleton, pose, 0.33, 1, -1);
  assert.notDeepEqual(end.rotations[tip], pose.rotations[tip]);
  const delta = Math.abs(poseJoints(skeleton, end)[tip][0] - poseJoints(skeleton, across)[tip][0]);
  assert.ok(delta > 0.25, `a visible swat has ${delta} m of side-to-side tail movement`);
  assert.deepEqual(poseHooves(skeleton, end), poseHooves(skeleton, pose));
  assert.equal(horseTailFlick(skeleton, pose, 1.1), pose);
});

test('a walking tail flick leads to the requested side and relaxes through a smaller return', () => {
  const body = horseBody();
  const skeleton = horseSkeleton(body);
  const walk = stride(body, preferredSpeed(body, 'walk'), 'walk');
  const dock = skeleton.index('tail1');
  const tip = skeleton.index('tailHair5');
  const moving = horsePose(skeleton, walk, 0.371, 2);
  const rest = poseJoints(skeleton, moving)[tip];
  const flick = (seconds, side = 1) => horseTailFlick(skeleton, moving, seconds, 0.85, side);
  const changes = Array.from({ length: 114 }, (_, frame) => {
    const pose = flick(frame / 120);
    const point = poseJoints(skeleton, pose)[tip];
    return { x: point[0] - rest[0], dockZ: pose.rotations[dock][2] - moving.rotations[dock][2] };
  });
  const swing = changes.map((sample) => sample.x);
  const peak = Math.max(...swing);
  const returnSwing = -Math.min(...swing);
  const dockPeak = Math.max(...changes.map((sample) => sample.dockZ));
  const dockAt = changes.findIndex((sample) => sample.dockZ === dockPeak);
  assert.ok(peak > 0.36, `outward movement is ${peak} m`);
  assert.ok(returnSwing > 0.03 && returnSwing < 0.32 * peak, `return movement is ${returnSwing} m`);
  assert.ok(swing.indexOf(peak) - dockAt >= 4, 'the hair peaks at least 33 ms after the dock');
  assert.ok(poseJoints(skeleton, flick(0.33, -1))[tip][0] < rest[0] - 0.32, 'right flick mirrors the outward sweep');
  assert.deepEqual(poseHooves(skeleton, flick(0.37)), poseHooves(skeleton, moving));
  assert.equal(flick(0), moving);
  assert.equal(flick(0.94), moving);
  assert.equal(horseTailFlick(skeleton, moving, 0.3, 0), moving);
});

test('model: coats, markings and the crowd atlas', () => {
  const { doc, buffers } = horseDocument({ coat: 'bay', markings: { socks: [0.4, 0, 0, 0], blaze: true }, detail: 0 }),
    prim = doc.meshes[0].primitives[0],
    view = (a) => {
      const v = buffers[doc.bufferViews[doc.accessors[a].bufferView].buffer];
      return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    },
    pos = view(prim.attributes.POSITION),
    col = view(prim.attributes.COLOR_0);
  let white = 0,
    black = 0;
  for (let i = 0; i < pos.length; i += 3) {
    if (col[i] > 0.7) white++;
    if (pos[i + 1] < 0.2 && col[i] < 0.05 && pos[i] < 0) black++;
  }
  assert.ok(white > 0 && black > 0, 'a white sock and blaze, and black points on the other legs of a bay');
  for (const coat of HORSE_COATS) assert.ok(COAT_COLORS[coat].body.every((v) => v >= 0 && v <= 1));
  const atlas = coatAtlas();
  assert.equal(atlas.data.length, 6 * 4 * 4);
  assert.deepEqual(coatAtlasUV('grey', 'mane'), [3.5 / 6, 2.5 / 4]);
});

test('seat: rider joints keep their segment lengths and the knee angle, and the legs clear the barrel', () => {
  const seat = riderSeat({ height: 1.8, knee: 2 }),
    d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let s = 0; s < 2; s++) {
    assert.ok(Math.abs(d(seat.hips[s], seat.knees[s]) - 0.245 * 1.8) < 1e-9);
    const shank = d(seat.knees[s], seat.ankles[s]);
    assert.ok(Math.abs(shank - 0.246 * 1.8) < 0.002);
    assert.ok(
      Math.abs(Math.abs(seat.knees[s][0]) - (0.21 * 1.63 + 0.06)) < 1e-9,
      'the knee lies outside the barrel and saddle',
    );
    assert.ok(seat.stirrups[s][1] < seat.knees[s][1] && seat.hands[s][1] > seat.hip[1]);
    const t = seat.knees[s].map((v, k) => seat.hips[s][k] - v),
      u = seat.ankles[s].map((v, k) => v - seat.knees[s][k]),
      // The angle in the side plane between thigh and shank.
      a = Math.PI - Math.acos((t[1] * -u[1] + t[2] * -u[2]) / (Math.hypot(t[1], t[2]) * Math.hypot(u[1], u[2])));
    assert.ok(Math.abs(Math.PI - a - 2) < 1e-6 || Math.abs(a - 2) < 1e-6, `knee ${a}`);
  }
  assert.throws(() => riderSeat({ height: 3 }), RangeError);
});

test('seat: the rider hip rides the saddle, a little behind and damped, and resets for a seek', () => {
  const f = new SeatFollower(),
    dt = 1 / 240,
    hz = 2.8,
    amp = 0.04;
  let peakIn = 0,
    peakOut = 0,
    tIn = 0,
    tOut = 0;
  for (let i = 0; i < 240 * 4; i++) {
    const t = i * dt,
      y = amp * Math.sin(2 * Math.PI * hz * t),
      out = f.step(dt, [0, y, 0])[1];
    if (t > 3 && y > peakIn) [peakIn, tIn] = [y, t];
    if (t > 3 && out > peakOut) [peakOut, tOut] = [out, t];
  }
  const ratio = peakOut / peakIn,
    lag = (((tOut - tIn) % (1 / hz)) + 1 / hz) % (1 / hz);
  assert.ok(ratio > 0.85 && ratio < 1.2, `amplitude ratio ${ratio.toFixed(3)}`);
  assert.ok(lag > 0 && lag < 0.04, `lag ${lag.toFixed(4)} s`);
  f.reset();
  assert.deepEqual(f.step(dt, [1, 2, 3]), [1, 2, 3]);
  // mountRider on a horse's step hook: the rider's root follows, and a seek's reset starts it on the saddle again.
  const listeners = [],
    horse = {
      body: horseBody(),
      onStep: (step, reset) => (listeners.push({ step, reset }), () => listeners.splice(0)),
      frame: () => ({ position: [0, 0, 0], heading: 0, saddle: [0, 1.6, 0.2], saddleRotation: [0, 0, 0, 1] }),
    },
    placed = [],
    rider = { root: { setPosition: (p) => placed.push(p), setQuaternion() {} } },
    mount = mountRider(horse, rider, { height: 1.75 });
  assert.ok(Math.abs(mount.hip[1] - (1.6 + 0.055 * 1.75)) < 1e-9);
  assert.ok(Math.abs(placed.at(-1)[1] - (mount.hip[1] - 0.53 * 1.75)) < 1e-9);
  listeners[0].step(dt, horse);
  assert.equal(placed.length, 2);
  mount.dispose();
  assert.equal(listeners.length, 0);
  assert.throws(() => mountRider({}, rider), TypeError);
});

test('motion: speed eases, the gait follows with hysteresis, and replays are exact', () => {
  const b = horseBody(),
    run = () => {
      const m = new HorseMotion(b),
        log = [];
      for (let i = 0; i < 240 * 12; i++) {
        const t = i / 240;
        m.step(1 / 240, { speed: t < 4 ? 4 : t < 8 ? 9 : 1.2, heading: t < 6 ? 0 : 1, gait: 'auto' });
        if (i % 240 === 0) log.push([m.gait, m.speed, m.distance, m.x, m.z]);
      }
      return { m, log };
    },
    a = run(),
    b2 = run();
  assert.deepEqual(a.log, b2.log, 'the same commands give the same motion');
  assert.ok(a.log[1][1] <= (3 * 241) / 240 + 1e-9, 'acceleration is limited to 3 m/s^2');
  const seen = [...new Set(a.log.map((r) => r[0]))];
  assert.ok(
    seen.indexOf('trot') < seen.indexOf('canter') && seen.indexOf('canter') < seen.indexOf('gallop'),
    seen.join(' '),
  );
  assert.ok(a.log.some((r) => r[0] === 'gallop'));
  assert.equal(a.m.gait, 'walk');
  // Hysteresis: holding a speed just over the walk-trot boundary after slowing from a trot stays a trot.
  const m = new HorseMotion(b),
    edge = speedAtFroude(b, 0.41);
  for (let i = 0; i < 2400; i++) m.step(1 / 240, { speed: i < 1200 ? 3 : edge, heading: 0, gait: 'auto' });
  assert.equal(m.gait, 'trot');
  assert.equal(m.pick(edge * 0.9, 'auto'), 'walk');
  assert.equal(m.pick(3, 'canter'), 'canter');
  const p0 = horsePose(horseSkeleton(b), null),
    p1 = horsePose(horseSkeleton(b), stride(b, 4), 0.2),
    half = blendPoses(p0, p1, 0.5);
  assert.ok(Math.abs(half.bodyOffset[1] - (p0.bodyOffset[1] + p1.bodyOffset[1]) / 2) < 1e-12);
});

test('settings: rows on the shared shape map to addHorse, motion and mount options', () => {
  const names = HORSE_SETTINGS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const r of HORSE_SETTINGS)
    assert.ok(typeof r.about === 'string' && 'default' in r && typeof r.live === 'boolean');
  assert.equal(horseSettingDefaults().coat, 'bay');
  const o = horseOptionsFromSettings({
    type: 'draft',
    withers: 1.8,
    coat: 'grey',
    blaze: 'yes',
    socks: 0.3,
    speed: 5,
    gait: 'trot',
    knee: 2,
    followFrequency: 7,
  });
  assert.equal(o.options.type, 'draft');
  assert.equal(o.options.withers, 1.8);
  assert.deepEqual(o.options.markings, { blaze: true, socks: [0.3, 0, 0.3, 0] });
  assert.deepEqual(o.motion, { speed: 5, gait: 'trot' });
  assert.equal(o.mount.knee, 2);
  assert.equal(o.mount.frequency, 7);
  assert.equal(horseOptionsFromSettings({ withers: 0 }).options.withers, undefined);
  assert.throws(() => horseOptionsFromSettings({ colour: 'bay' }), TypeError);
  assert.throws(() => horseOptionsFromSettings({ speed: 99 }), RangeError);
});

test('crowd: bad options are refused before the loader or a GPU is touched', async () => {
  const engine = new Proxy({}, { get: () => assert.fail('the engine must not be touched for bad options') });
  await assert.rejects(addHorseCrowd(engine, { fps: 5 }), /fps must be 10 to 120/);
  await assert.rejects(addHorseCrowd(engine, { capacity: 0 }), /capacity must be 1 to 65536/);
  await assert.rejects(addHorseCrowd(engine, { coats: ['piebald'] }), TypeError);
  await assert.rejects(addHorseCrowd(engine, { ground: 3 }), TypeError);
});

test('crowd: each horse carries a saddle frame read back from the bone texture, on the back the GPU draws', async () => {
  const { Engine, TransformStore } = await import('../../core/dist/extension.js');
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(4096),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    },
  );
  // The crowd draw needs WebGPU; here it is only recorded, so the bake and the saddle read-back run on the CPU.
  engine.use = () => engine;
  const herd = await addHorseCrowd(engine, { type: 'cavalry', capacity: 8 }),
    body = herd.body,
    skeleton = herd.skeleton;
  const horses = [
    { x: 3, z: -2, heading: 0.7, speed: preferredSpeed(body, 'trot'), distance: 5.3 },
    { x: -4, z: 9, heading: -2.1, speed: preferredSpeed(body, 'gallop'), distance: 17.9 },
    { x: 0, z: 0, heading: 0, speed: preferredSpeed(body, 'walk'), distance: 0.6 },
  ];
  herd.update(horses);
  assert.equal(herd.saddles.length, 8 * 16);
  let worst = 0;
  horses.forEach((h, i) => {
    const p = herd.pose(h.speed, h.distance),
      clip = herd.clips[p.clip],
      phase = p.offset / clip.duration,
      // The pose the clip was keyed from at this phase, through the model's own saddle function.
      want = poseSaddle(skeleton, horsePose(skeleton, stride(body, clip.speed, clip.name), phase)).position,
      c = Math.cos(h.heading),
      s = Math.sin(h.heading),
      world = [h.x + c * want[0] + s * want[2], want[1], h.z - s * want[0] + c * want[2]],
      got = herd.saddles.subarray(i * 16 + 12, i * 16 + 15);
    worst = Math.max(worst, Math.hypot(got[0] - world[0], got[1] - world[1], got[2] - world[2]));
    // +Z of the seat frame points the way the horse faces, within the trunk's pitch.
    assert.ok(herd.saddles[i * 16 + 8] * s + herd.saddles[i * 16 + 10] * c > 0.9, 'the seat faces forward');
  });
  // Between keys the clip interpolates rotations and the bake samples at 30 a second: the seat stays within 5 mm
  // (1.1 mm measured).
  assert.ok(worst < 0.005, `saddle ${worst.toFixed(4)} m from the model's own saddle`);
  // The seat rises and falls with the trot: two rises a stride, about 5 percent of the withers height peak to peak.
  const trot = herd.clips.find((c) => c.name === 'trot'),
    ys = [];
  for (let k = 0; k < 24; k++) {
    herd.update([{ x: 0, z: 0, heading: 0, speed: trot.speed, distance: (k / 24) * trot.strideLength }]);
    ys.push(herd.saddles[13]);
  }
  const rise = Math.max(...ys) - Math.min(...ys);
  assert.ok(rise > 0.02 && rise < 0.15, `the trot moves the saddle ${rise.toFixed(3)} m`);
  assert.equal(
    saddleFrame([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [0, 1.5, 0.2], { x: 1, y: 0.5, z: 2, heading: 0 })[13],
    2,
  );
  herd.dispose();
});

test('crowd: the coat atlas goes with the draw however the draw is let go, once', async () => {
  const { Engine, TransformStore } = await import('../../core/dist/extension.js');
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(4096),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    },
  );
  engine.use = () => engine;
  // A scene or engine disposal disposes the draw plugin and never reaches the herd's own dispose.
  const herd = await addHorseCrowd(engine, { capacity: 2 }),
    map = herd.crowd.map,
    real = map.dispose.bind(map);
  let released = 0;
  map.dispose = () => {
    released++;
    real();
  };
  herd.crowd.dispose();
  assert.equal(released, 1, 'the atlas is released with the draw alone');
  herd.dispose();
  herd.crowd.dispose();
  assert.equal(released, 1, 'and not again by the herd or a repeated disposal');
});

test('forelimb flexion peaks in anatomical order and the loaded carpus stays extended on an authored rig', () => {
  const native = horseSkeleton(horseBody());
  // This forward carpus is intentionally bent in bind, as an authored, weighted model often is.
  const fitted = {
    ...native,
    joints: native.joints.map((joint) =>
      joint.name.startsWith('foreCannon')
        ? { ...joint, rest: [joint.rest[0], joint.rest[1], joint.rest[2] + 0.052] }
        : joint,
    ),
  };
  const angle = (a, b) => Math.atan2(b[2] - a[2], b[1] - a[1]);
  const difference = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  for (const rig of [native, fitted])
    for (const hoof of [1, 3])
      for (const [gait, speed, maxDegrees] of [
        ['walk', 1.52, 55],
        ['trot', 3.2, 76],
      ]) {
        const cycle = stride(rig.body, speed, gait),
          leg = rig.legs[hoof];
        const samples = Array.from({ length: 320 }, (_, i) => {
          const phase = i / 320,
            pose = horsePose(rig, cycle, phase + cycle.strike[hoof]),
            joints = poseJoints(rig, pose),
            [, shoulder, elbow, carpus, fetlock, coronet] = leg.map((j) => joints[j]);
          return {
            phase,
            elbow: Math.abs(difference(angle(shoulder, elbow), angle(elbow, carpus))),
            carpus: difference(angle(elbow, carpus), angle(carpus, fetlock)),
            fetlock: difference(angle(carpus, fetlock), angle(fetlock, coronet)),
            coffin: -2 * Math.atan2(pose.rotations[leg[5]][0], pose.rotations[leg[5]][3]),
          };
        });
        const beforeLift = samples.filter((row) => row.phase > 0.08 && row.phase < cycle.duty * 0.76);
        assert.ok(
          beforeLift.every((row) => row.carpus > -1e-7 && row.carpus < 0.15),
          'loaded foreleg stays nearly straight',
        );
        const swing = samples.filter((row) => row.phase > cycle.duty);
        const peak = (key) => swing.reduce((a, b) => (a[key] > b[key] ? a : b));
        const fold = peak('carpus'),
          distal = peak('coffin'),
          upper = peak('elbow');
        assert.ok(Math.abs((fold.carpus * 180) / Math.PI - maxDegrees) < 7, 'swing carpus fold is gait-specific');
        assert.ok(
          upper.phase > fold.phase && distal.phase > fold.phase,
          'the carpus folds before the elbow and coffin release',
        );
        if (gait === 'walk') {
          assert.ok(Math.abs(fold.phase - 0.76) < 0.027, 'walking carpus peaks near 76% of a stride');
          assert.ok(Math.abs(distal.phase - 0.84) < 0.02, 'walking coffin peaks near 84% of a stride');
          const tuck = peak('fetlock');
          const angles = samples.map((row) => row.fetlock);
          const excursion = Math.max(...angles) - Math.min(...angles);
          assert.ok(
            Math.abs(tuck.phase - 0.81) < 0.04 && tuck.fetlock > 0.12,
            'the fetlock folds relative to the cannon in mid-swing',
          );
          assert.ok(
            excursion > 0.9 && excursion < 1.38,
            'walking fetlock spans the measured flexion and extension range',
          );
        }
      }
});
