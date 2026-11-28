// The mocap theatre's two takes, retargeted onto Elias the way the demo does it, checked frame by frame against the
// ranges a human arm can reach, and Elias's skinned mesh checked against his bones. Guards KB-RIG-ARMS2: Scott saw arms
// that "do not bend like that" in the Arms-wide walk's side view; these hold the transfer and the skin to anatomy.
//
// Ranges: elbow flexion 0 to 150 degrees with up to 10 of hyperextension, a carrying angle (valgus) of 5 to 20 degrees
// (Paraskevas et al. 2004, "Study of the carrying angle of the human elbow joint in full extension", Surgical and
// Radiologic Anatomy 26:19-23; Zampagni et al. 2008, "Estimating the elbow carrying angle with an electrogoniometer",
// Ergonomics 51(2)); wrist flexion and extension within about 70 degrees, forearm pronation and supination within
// about 90 each way of the rest (American Academy of Orthopaedic Surgeons, "Joint Motion: Method of Measuring and
// Recording", 1965; Ryu et al. 1991, "Functional ranges of motion of the wrist joint", J Hand Surg 16A:409-419).
// Skinning: linear blend skinning moves a vertex rigidly with its dominant bone except where weights blend
// (Magnenat-Thalmann, Laperriere and Thalmann 1988, "Joint-dependent local deformations for hand animation and object
// grasping", Graphics Interface), so in that bone's own frame a forearm or hand vertex barely moves.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Skeleton, Skin } from '../packages/animation/dist/index.js';
import { capture, readCapture } from '../demos/the-mocap-theatre/source/captures.js';
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

test('every frame of both retargeted takes keeps both arms inside human joint ranges', () => {
  for (const { name, target, take } of takes()) {
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
        assert.ok(m.flexion >= -10 && m.flexion <= 150, `${where}: elbow flexion ${m.flexion.toFixed(1)} degrees`);
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
    // capture's elbows locked 3 to 6.5 degrees past straight with a 8 to 14 degree carrying angle.
    if (name === 'brisk')
      for (const side of SIDES)
        assert.ok(worst[`${side} flexion`].max < 0, `${side} Aeroplane elbows are locked straight`);
    if (name === 'walk')
      for (const side of SIDES) assert.ok(worst[`${side} flexion`].min > 10, `${side} walking elbows stay bent`);
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
