// Every human motion capture in the repository, played frame by frame through the human anatomy limits
// (`@margoengine/rigging/anatomy`), which are on by default. The record (fixtures/anatomy-clips.json) is what the
// structural stops change in each clip: the joint, the motion, the most degrees taken off on any frame and on how many
// frames. A motion that is not listed plays untouched. A change in the record means a table number, a naming or a
// reader changed what a body does: look at it, then run this test with UPDATE_ANATOMY_CLIPS=1 to write the new record.
//
// Each clip is fitted twice: first as its joint positions show it, then with the roll of its straight limbs read from
// its own motion (`hingeRolls`), which is how a capture should be fitted. The CMU skeleton's upper arms are rolled about
// 20 degrees in its rest pose; read without that, its elbows seem to bend up to 38 degrees sideways (docs/limits.md).
//
// The Aeroplane take of the mocap theatre ("brisk") is the one KB-RIG-ARMS2 holds off the stage: its capture keeps both
// elbows past straight, which the limits bring back to the stop of 5 degrees.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { readCapture } from '../demos/the-mocap-theatre/source/captures.js';
import { parseAMC, parseASF, parseBVH } from '../packages/loaders/dist/mocap.js';
import { fitHuman } from '../packages/rigging/dist/anatomy-human.js';
import { clampPose, hingeRolls, jointAngles } from '../packages/rigging/dist/anatomy.js';

const text = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tenth = (value) => Math.round(value * 10) / 10 + 0;

/** Plays a parsed capture through the limits and returns what they changed. */
function scan({ bones, clip, frames }) {
  const names = bones.map((bone) => bone.name),
    n = bones.length,
    rest = new Float64Array(n * 10);
  bones.forEach((bone, i) => rest.set([...bone.translation, ...bone.rotation, 1, 1, 1], i * 10));
  const rig = { names, parents: bones.map((bone) => bone.parent), rest },
    tracks = clip.tracks.map((track) => ({
      at: names.indexOf(track.target) * 10 + (track.path === 'rotation' ? 3 : 0),
      keys: track.keys,
    })),
    count = frames ?? Math.max(...tracks.map((track) => track.keys.length)),
    pose = new Float64Array(n * 10);
  function* play() {
    for (let frame = 0; frame < count; frame++) {
      pose.set(rest);
      for (const { at, keys } of tracks) if (keys[frame]) pose.set(keys[frame].value, at);
      yield pose;
    }
  }
  const unaware = fitHuman(rig),
    roll = hingeRolls(unaware, play()),
    body = fitHuman(rig, { roll }),
    issues = [],
    worst = new Map();
  let sideways = 0,
    unrolled = 0;
  for (const frame of play()) {
    for (const [fitted, most] of [
      [body, (v) => (sideways = Math.max(sideways, v))],
      [unaware, (v) => (unrolled = Math.max(unrolled, v))],
    ]) {
      const angles = jointAngles(fitted, frame);
      most(Math.max(Math.abs(angles.l_elbow.abduction), Math.abs(angles.r_elbow.abduction)));
    }
    issues.length = 0;
    clampPose(body, frame, { issues });
    for (const issue of issues) {
      const key = issue.joint + ' ' + issue.motion,
        entry = worst.get(key) ?? [0, 0];
      worst.set(key, [Math.max(entry[0], Math.abs(issue.value - issue.limit)), entry[1] + 1]);
    }
  }
  return {
    naming: body.preset,
    rest: body.restPose,
    joints: body.joints.length,
    frames: count,
    roll: Object.fromEntries(
      Object.entries(roll)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, degrees]) => [id, tenth(degrees)]),
    ),
    elbowSideways: [tenth(unrolled), tenth(sideways)],
    changed: Object.fromEntries(
      [...worst].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, [most, on]]) => [key, [tenth(most), on]]),
    ),
  };
}

const clips = {};
for (const file of readdirSync(new URL('./fixtures/cmu-mocap/', import.meta.url)).sort())
  if (file.endsWith('.bvh'))
    clips['tests/fixtures/cmu-mocap/' + file] = () => parseBVH(text('./fixtures/cmu-mocap/' + file));
clips['packages/loaders/tests/fixtures/cmu/35_01-every-20th.amc'] = () =>
  parseAMC(
    text('../packages/loaders/tests/fixtures/cmu/35_01-every-20th.amc'),
    parseASF(text('../packages/loaders/tests/fixtures/cmu/35.asf')),
    { frameTime: 1 / 6 },
  );
for (const take of ['walk', 'brisk'])
  clips['demos/the-mocap-theatre: ' + take] = () =>
    readCapture(
      take,
      gunzipSync(
        readFileSync(new URL('../demos/the-mocap-theatre/source/' + take + '.motion', import.meta.url)),
      ).toString(),
    ).data;

const RECORD = new URL('./fixtures/anatomy-clips.json', import.meta.url);

test('the structural limits change the repository clips only where recorded', () => {
  const found = Object.fromEntries(Object.entries(clips).map(([name, load]) => [name, scan(load())]));
  if (process.env.UPDATE_ANATOMY_CLIPS) writeFileSync(RECORD, JSON.stringify(found, null, 1) + '\n');
  assert.deepEqual(found, JSON.parse(readFileSync(RECORD, 'utf8')));
  // Read from its own motion, every CMU clip's elbows are hinges: what looked like a sideways bend was the roll.
  for (const [name, clip] of Object.entries(found)) {
    if (!name.startsWith('tests/fixtures/cmu-mocap/')) continue;
    assert.ok(
      clip.elbowSideways[1] < 20,
      name + ': elbows stay within their carrying angle once the roll is read (' + clip.elbowSideways[1] + ')',
    );
    assert.equal(
      Object.keys(clip.changed).filter((key) => /elbow (valgus|varus|flexion)/.test(key)).length,
      0,
      name + ': no elbow is clamped sideways',
    );
  }
  // The Aeroplane take's elbows are past straight in the capture itself, and are held at the stop.
  const brisk = found['demos/the-mocap-theatre: brisk'].changed;
  assert.ok(brisk['l_elbow hyperextension'][0] > 1 && brisk['r_elbow hyperextension'][0] > 1);
});
