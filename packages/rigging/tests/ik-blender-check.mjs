// Cross-checks the anatomical limb IK against Blender, an outside referee that shares no code with the engine.
// For an arm and a leg of the test body (arms down and T pose) Blender builds the two bones, decides from anatomy alone
// which turn of the lower bone is flexion (a forearm folds forward, a shin folds back), and solves the same targets
// with its own IK solver limited to that side. Checked here:
//   1. flexing the engine's hinge by 20 degrees moves the end to the same place as Blender's own forward kinematics;
//   2. for every target the engine reached, the hinge angle agrees with Blender's (the distance fixes it), and neither
//      solver bent the hinge backwards.
// Needs Blender (BLENDER=path, default C:\Tools\Blender\5.3-beta\blender.exe); run with
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/rigging/tests/ik-blender-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fitAnatomy, jointAngles, poseFromAngles } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { solvePoseIK } from '@margoengine/rigging/ik';
import { add, bodyRig, forward, mul, random, sub } from './anatomy-fixtures.js';

const blender = process.env.BLENDER ?? 'C:\\Tools\\Blender\\5.3-beta\\blender.exe';
if (!existsSync(blender)) throw new Error(`Blender is not at ${blender}; set BLENDER to its executable`);

const PROBE = 20,
  limbs = [],
  ours = [];
for (const arms of [0, 90]) {
  const joints = bodyRig({ arms, fingers: false }),
    rig = {
      names: joints.map((j) => j.name),
      parents: joints.map((j) => j.parent),
      rest: new Float64Array(joints.length * 10),
    };
  joints.forEach((joint, i) => {
    const from = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
    rig.rest.set([...sub(joint.position, from), 0, 0, 0, 1, 1, 1, 1], i * 10);
  });
  const body = fitAnatomy(rig, { species: human }),
    rest = forward(rig.parents, rig.rest).pos;
  for (const [kind, parts, id] of [
    ['arm', ['LeftArm', 'LeftForeArm', 'LeftHand'], 'l_elbow'],
    ['leg', ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], 'l_knee'],
  ]) {
    // A T pose arm lies along the body's left-right line, where Blender's two bones have no hinge axis to stand on.
    if (kind === 'arm' && arms !== 0) continue;
    const chain = parts.map((name) => rig.names.indexOf(name)),
      [root, mid, end] = chain.map((bone) => rest[bone]),
      length = Math.hypot(...sub(mid, root)) + Math.hypot(...sub(end, mid)),
      rnd = random(arms + (kind === 'arm' ? 5 : 9)),
      hinge = body.joints[body.index.get(id)],
      targets = [],
      solved = [];
    while (targets.length < 16) {
      const p = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1],
        r = Math.hypot(...p);
      // In front of the body for an arm, below the hip and not far behind it for a leg: where a body can reach.
      if (r > 1 || r < 0.35 || (kind === 'arm' ? p[2] < 0.1 : p[1] > -0.2 || p[2] < -0.3)) continue;
      const target = add(root, mul(p, length * 0.97)),
        pose = { parents: rig.parents, local: rig.rest.slice(), body },
        result = solvePoseIK(pose, { joints: chain, target, tolerance: 1e-6 });
      targets.push(target);
      solved.push({ reached: result.reached, flexion: jointAngles(body, pose.local)[id].flexion });
    }
    const flexed = forward(rig.parents, poseFromAngles(body, { [id]: { flexion: PROBE } })).pos[chain[2]];
    limbs.push({
      name: `${kind}, arms ${arms}`,
      kind,
      root,
      mid,
      end,
      targets,
      probe: PROBE,
      maxFlexion: hinge.structural[1],
    });
    ours.push({ flexed, solved });
  }
}
mkdirSync('test-results/rigging', { recursive: true });
const input = 'test-results/rigging/ik-blender-in.json',
  output = 'test-results/rigging/ik-blender-out.json';
writeFileSync(input, JSON.stringify({ limbs }));
execFileSync(
  blender,
  [
    '-b',
    '--factory-startup',
    '--python',
    fileURLToPath(new URL('./ik-blender-check.py', import.meta.url)),
    '--',
    input,
    output,
  ],
  {
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 240_000,
  },
);
const theirs = JSON.parse(readFileSync(output, 'utf8'));
let compared = 0,
  worst = 0;
theirs.limbs.forEach((limb, i) => {
  const mine = ours[i],
    gap = Math.hypot(...sub(limb.flexed, mine.flexed));
  assert.ok(
    gap < 1e-4,
    `${limb.name}: ${PROBE} degrees of flexion puts the end ${gap} m from where Blender's bones put it`,
  );
  limb.solved.forEach((their, k) => {
    assert.ok(their.turn > -0.5, `${limb.name} target ${k}: Blender's hinge is at ${their.turn}`);
    assert.ok(
      mine.solved[k].flexion >= -1e-6,
      `${limb.name} target ${k}: the engine's hinge is at ${mine.solved[k].flexion}`,
    );
    // Both reached: the distance from root to target fixes the hinge angle, whatever swivel each solver chose.
    if (!mine.solved[k].reached || their.miss > 2e-3) return;
    const off = Math.abs(their.flexion - mine.solved[k].flexion);
    worst = Math.max(worst, off);
    compared++;
    assert.ok(
      off < 1,
      `${limb.name} target ${k}: the engine bends ${mine.solved[k].flexion}, Blender ${their.flexion}`,
    );
  });
  console.log(
    `${limb.name}: flexion turns the same way as Blender's bones (end within ${gap.toExponential(1)} m); of ${limb.solved.length} targets the engine reached ${mine.solved.filter((s) => s.reached).length}, Blender ${limb.solved.filter((s) => s.miss <= 2e-3).length} (its worst miss ${Math.max(...limb.solved.map((s) => s.miss)).toFixed(4)} m), both ${limb.solved.filter((s, k) => mine.solved[k].reached && s.miss <= 2e-3).length}`,
  );
});
assert.ok(compared >= 12, `only ${compared} targets were reached by both solvers`);
console.log(`Blender ${theirs.blender}: ${compared} hinge angles agree, worst difference ${worst.toFixed(3)} degrees.`);
