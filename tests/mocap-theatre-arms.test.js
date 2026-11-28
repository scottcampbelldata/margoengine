// The mocap theatre's two takes, retargeted onto Elias the way the demo does it, checked frame by frame against the
// ranges a human arm can reach, and Elias's skinned mesh checked against his bones. Guards KB-RIG-ARMS2: Scott saw arms
// that "do not bend like that" in the Arms-wide walk's side view; these hold the transfer and the skin to anatomy.
//
//
// Third report (2026-11-28): Scott saw the Aeroplane take's elbows bend the wrong way in the source stick figure too. A
// referee that is not Margo (Blender's BVH importer, fixtures/mocap-theatre/aeroplane-referee.json) reads the file to
// the same joint positions, so the reading is right and the capture itself holds both elbows past straight on every
// frame. A take like that is held off the stage: no take the page lists may pass straight by more than 2 degrees.
//
// Ranges: elbow flexion 0 to 150 degrees with no more than 2 past straight on a listed take, a carrying angle (valgus) of 5 to 20 degrees
// (Paraskevas et al. 2004, "Study of the carrying angle of the human elbow joint in full extension", Surgical and
// Radiologic Anatomy 26:19-23; Zampagni et al. 2008, "Estimating the elbow carrying angle with an electrogoniometer",
// Ergonomics 51(2)); wrist flexion and extension within about 70 degrees, forearm pronation and supination within
// about 90 each way of the rest (American Academy of Orthopaedic Surgeons, "Joint Motion: Method of Measuring and
// Recording", 1965; Ryu et al. 1991, "Functional ranges of motion of the wrist joint", J Hand Surg 16A:409-419).
// Skinning: linear blend skinning moves a vertex rigidly with its dominant bone except where weights blend
// (Magnenat-Thalmann, Laperriere and Thalmann 1988, "Joint-dependent local deformations for hand animation and object
// grasping", Graphics Interface), so in that bone's own frame a forearm or hand vertex barely moves.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Skeleton, Skin, applyKeyframeClip, createKeyframeClip } from '../packages/animation/dist/index.js';
import { parseBVH } from '../packages/loaders/dist/mocap.js';
import { capture, listed, readCapture, recordings } from '../demos/the-mocap-theatre/source/captures.js';
import { readPerformer } from '../demos/the-mocap-theatre/source/performer.js';

const dir = new URL('../demos/the-mocap-theatre/source/', import.meta.url);
const read = (name) => gunzipSync(readFileSync(new URL(name, dir)));
const bytes = read('performer.skin');
const { bones, meshes } = readPerformer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const deg = (r) => (r * 180) / Math.PI;
const at = (sk, i) => {
  const m = sk.matrices;
  return [m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]];
};
// A bone's world axes (unit columns), and a vector taken into / out of them.
const frame = (sk, i) =>
  [0, 1, 2].map((c) => unit(Array.from(sk.matrices.subarray(i * 16 + c * 4, i * 16 + c * 4 + 3))));
const into = (f, v) => f.map((c) => dot(c, v));
const out = (f, v) => [0, 1, 2].map((k) => f[0][k] * v[0] + f[1][k] * v[1] + f[2][k] * v[2]);
const across = (v, axis) =>
  unit(
    sub(
      v,
      axis.map((x) => x * dot(v, axis)),
    ),
  );
const turn = (a, b, axis) => deg(Math.atan2(dot(axis, cross(a, b)), dot(a, b)));

const SIDES = ['Left', 'Right'];
function arm(sk, side) {
  const id = (n) => sk.index(side + n);
  return {
    upper: id('Arm'),
    fore: id('ForeArm'),
    hand: id('Hand'),
    index: id('HandIndex1'),
    little: id('HandPinky1'),
    middle: id('HandMiddle1'),
  };
}

// Elias's bind pose fixes each arm's anatomy: his elbows are modelled bent 46 degrees toward the crease, so the crease
// in the upper arm's own frame is where his forearm leans off the upper arm's line; the palm-across direction (little
// finger base to index base) in the forearm's and the hand's frames is the forearm twist the mesh was modelled in.
const elias = new Skeleton(bones);
const anatomy = Object.fromEntries(
  SIDES.map((side) => {
    const a = arm(elias, side),
      up = unit(sub(at(elias, a.fore), at(elias, a.upper))),
      fo = unit(sub(at(elias, a.hand), at(elias, a.fore))),
      palm = unit(sub(at(elias, a.index), at(elias, a.little)));
    return [
      side,
      {
        bend: deg(Math.acos(dot(up, fo))),
        crease: into(frame(elias, a.upper), across(fo, up)),
        creaseFore: into(frame(elias, a.fore), across(fo, up)),
        palmFore: into(frame(elias, a.fore), palm),
        palmHand: into(frame(elias, a.hand), palm),
      },
    ];
  }),
);

function measure(sk, side) {
  const a = arm(sk, side),
    ref = anatomy[side],
    up = unit(sub(at(sk, a.fore), at(sk, a.upper))),
    fo = unit(sub(at(sk, a.hand), at(sk, a.fore))),
    hand = unit(sub(at(sk, a.middle), at(sk, a.hand))),
    crease = unit(out(frame(sk, a.upper), ref.crease)),
    hinge = unit(cross(up, crease));
  return {
    // flexion toward the crease in the hinge plane; negative is hyperextension
    flexion: deg(Math.atan2(dot(fo, crease), dot(fo, up))),
    // the forearm off the hinge plane: the carrying angle
    valgus: Math.abs(deg(Math.asin(dot(fo, hinge)))),
    // the forearm's roll about its own axis against the upper arm's, from the bind
    forearmRoll: turn(across(crease, fo), across(out(frame(sk, a.fore), ref.creaseFore), fo), fo),
    // pronation and supination: the hand's palm-across against the forearm's, about the forearm
    pronation: turn(
      across(out(frame(sk, a.fore), ref.palmFore), fo),
      across(out(frame(sk, a.hand), ref.palmHand), fo),
      fo,
    ),
    wrist: deg(Math.acos(Math.min(1, dot(fo, hand)))),
  };
}

function takes() {
  return ['walk', 'brisk'].map((name) => {
    const target = new Skeleton(bones),
      take = capture(name, readCapture(name, read(`${name}.motion`).toString()), target);
    return { name, target, take };
  });
}

test("Elias's bind pose has the bent elbows the anatomy checks read their crease from", () => {
  for (const side of SIDES) assert.ok(anatomy[side].bend > 30, `${side} bind elbow bend ${anatomy[side].bend}`);
});

// The furthest either elbow sits past straight in a take, in degrees (negative is past straight).
const pastStraight = {};

test('every frame of every listed take keeps both arms inside human joint ranges', () => {
  for (const { name, target, take } of takes()) {
    const shown = listed.includes(name);
    const frames = Math.round(take.duration * 30);
    const worst = {};
    for (let f = 0; f <= frames; f++) {
      take.draw(Math.min(take.duration, f / 30));
      for (const side of SIDES) {
        const m = measure(target, side);
        for (const [k, v] of Object.entries(m)) {
          const w = (worst[`${side} ${k}`] ??= { min: Infinity, max: -Infinity });
          w.min = Math.min(w.min, v);
          w.max = Math.max(w.max, v);
        }
        const where = `${name} ${side} arm at ${(f / 30).toFixed(2)} s`;
        // The arm points where the capture's arm points: upper arm and forearm within half a degree of the source's.
        const s = take.source,
          chain = (
            name === 'brisk'
              ? ['UpperArm', 'LowerArm', 'Hand'].map((n) => side.toLowerCase() + n)
              : ['humerus', 'radius', 'wrist'].map((n) => side[0].toLowerCase() + n)
          ).map((n) => s.index(n)),
          a = arm(target, side);
        for (const [i, [from, to]] of [
          [a.upper, a.fore],
          [a.fore, a.hand],
        ].entries()) {
          const want = unit(sub(at(s, chain[i + 1]), at(s, chain[i]))),
            have = unit(sub(at(target, to), at(target, from)));
          assert.ok(
            dot(want, have) > Math.cos(Math.PI / 360),
            `${where}: segment ${i} is ${deg(Math.acos(Math.min(1, dot(want, have)))).toFixed(2)} degrees off the capture`,
          );
        }
        if (!shown) continue;
        assert.ok(m.flexion >= -2 && m.flexion <= 150, `${where}: elbow flexion ${m.flexion.toFixed(1)} degrees`);
        assert.ok(m.valgus <= 20, `${where}: forearm ${m.valgus.toFixed(1)} degrees off the elbow's hinge plane`);
        assert.ok(Math.abs(m.forearmRoll) <= 30, `${where}: forearm rolled ${m.forearmRoll.toFixed(1)} degrees`);
        assert.ok(
          Math.abs(m.pronation) <= 90,
          `${where}: hand turned ${m.pronation.toFixed(1)} degrees on the forearm`,
        );
        assert.ok(m.wrist <= 70, `${where}: wrist bent ${m.wrist.toFixed(1)} degrees`);
      }
    }
    // The ranges these takes actually use (2026-11-28): walk elbows 18 to 32 degrees of flexion; the Aeroplane
    // capture's elbows 3 to 6.5 degrees past straight with a 8 to 14 degree carrying angle.
    pastStraight[name] = Math.min(...SIDES.map((side) => worst[`${side} flexion`].min));
    if (name === 'walk')
      for (const side of SIDES) assert.ok(worst[`${side} flexion`].min > 10, `${side} walking elbows stay bent`);
  }
});

test('a take whose elbows pass straight is held off the stage, and only such a take is held', () => {
  const page = readFileSync(new URL('../index.html', dir), 'utf8'),
    start = readFileSync(new URL('start.js', dir), 'utf8');
  assert.ok(listed.length > 0, 'the stage lists a take');
  for (const name of Object.keys(recordings)) {
    const past = pastStraight[name] < -2,
      held = Boolean(recordings[name].held),
      onPage = page.includes(`id="${name}"`) || start.includes(`${name}.motion`);
    assert.equal(held, past, `${name}: elbows reach ${pastStraight[name].toFixed(1)} degrees, held is ${held}`);
    assert.equal(listed.includes(name), !held, `${name} is listed only when it is not held`);
    assert.equal(onPage, !held, `${name}: the page offers or loads it only when it is not held`);
  }
});

// The referee: Blender's BVH importer read the shipped Aeroplane take; its joint positions are the fixture.
const referee = JSON.parse(readFileSync(new URL('./fixtures/mocap-theatre/aeroplane-referee.json', import.meta.url)));

test('the Aeroplane take reads joint for joint as the referee reads it, and the stage draws that skeleton', () => {
  const packed = read('brisk.motion');
  assert.equal(createHash('sha256').update(packed).digest('hex'), referee.takeSha256, 'the fixture is of this take');
  const data = parseBVH(packed.toString(), { scale: 0.01 }),
    plain = new Skeleton(data.bones),
    clip = createKeyframeClip(data.clip),
    names = Object.keys(referee.frames[0]).filter((n) => !n.endsWith('_End'));
  assert.equal(names.length, data.bones.length, 'the referee and the loader see the same joints');
  // The stage plays the take in place, turned to face the front: the same skeleton about its hips.
  const staged = capture('brisk', readCapture('brisk', packed.toString()), new Skeleton(bones)),
    first = referee.frames[0].Hips,
    last = referee.frames[data.frames - 1].Hips,
    heading = Math.atan2(last[0] - first[0], last[2] - first[2]),
    c = Math.cos(heading),
    s = Math.sin(heading),
    turn = (v) => [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
  for (const [f, joints] of Object.entries(referee.frames)) {
    applyKeyframeClip(clip, plain, f * data.frameTime);
    staged.draw(f * data.frameTime);
    const hips = plain.index('Hips');
    for (const name of names) {
      const i = plain.index(name),
        off = Math.hypot(...sub(at(plain, i), joints[name]));
      assert.ok(off < 2e-4, `frame ${f} ${name}: the loader is ${off.toExponential(2)} m off the referee`);
      const want = turn(sub(joints[name], joints.Hips)),
        have = sub(at(staged.source, i), at(staged.source, hips)),
        apart = Math.hypot(...sub(want, have));
      assert.ok(
        apart < 2e-4,
        `frame ${f} ${name}: the stage's skeleton is ${apart.toExponential(2)} m off the referee`,
      );
    }
  }
  // What the referee itself shows: both forearms leave the upper arm's line toward the back of the body.
  for (const joints of Object.values(referee.frames)) {
    const up = unit(sub(joints.Neck, joints.Hips)),
      forward = unit(cross(up, sub(joints.RightHip, joints.LeftHip)));
    assert.ok(dot(sub(joints.RightToe, joints.RightAnkle), forward) > 0, 'forward is where the toes point');
    for (const side of SIDES) {
      const ua = unit(sub(joints[side + 'Elbow'], joints[side + 'Shoulder'])),
        fa = unit(sub(joints[side + 'Wrist'], joints[side + 'Elbow']));
      const lean = deg(
        Math.asin(
          dot(
            sub(
              fa,
              ua.map((x) => x * dot(fa, ua)),
            ),
            forward,
          ),
        ),
      );
      assert.ok(lean < -5 && lean > -15, `the referee's ${side} forearm leans ${lean.toFixed(1)} degrees forward`);
    }
  }
});

test("Elias's skinned arms follow their bones in every take", () => {
  const rest = new Skeleton(bones);
  const names = SIDES.flatMap((s) => ['Arm', 'ForeArm', 'Hand'].map((n) => s + n));
  // Each vertex in its dominant bone's frame, at the bind pose and posed.
  const local = (sk) => {
    const rows = Object.fromEntries(names.map((n) => [n, []]));
    for (const m of meshes) {
      const skin = new Skin(sk, m.joints, m.weights),
        p = skin.pose(m.position).positions;
      for (let i = 0; i < p.length / 3; i++) {
        let best = 0;
        for (let c = 1; c < 4; c++) if (m.weights[i * 4 + c] > m.weights[i * 4 + best]) best = c;
        const name = sk.names[m.joints[i * 4 + best]];
        if (!rows[name]) continue;
        const b = sk.index(name);
        rows[name].push(into(frame(sk, b), sub([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], at(sk, b))));
      }
    }
    return rows;
  };
  const bind = local(rest);
  for (const { name, target, take } of takes())
    for (const time of [0, take.duration / 2, take.duration]) {
      take.draw(time);
      const now = local(target);
      for (const bone of names) {
        const drift = bind[bone].map((v, i) => Math.hypot(...sub(v, now[bone][i])));
        const mean = drift.reduce((s, d) => s + d, 0) / drift.length;
        // Upper arms blend with the shoulder and chest at the armpit; forearms and hands are rigid but for the elbow
        // and wrist seams.
        const limit = /ForeArm|Hand/.test(bone) ? 0.004 : 0.015;
        assert.ok(drift.length > 100, `${bone} has its own vertices`);
        assert.ok(
          mean < limit,
          `${name} at ${time.toFixed(2)} s: ${bone} vertices drift ${mean.toFixed(4)} m off the bone`,
        );
      }
    }
});
