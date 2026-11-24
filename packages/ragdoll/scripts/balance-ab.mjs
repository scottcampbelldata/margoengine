// Balance and push recovery of the Knight rig, the scene of tests/balance.test.js, run on the package's own solver and on
// Rapier (the test oracle, packages/physics/tests/oracle.js) side by side, for finding where the two part.
//
//   node packages/ragdoll/scripts/balance-ab.mjs [options]
//
//   --solvers=kernel,rapier   which solvers to run, interleaved (default both); `kernel:projection` picks the limits per run
//   --limits=projection       how cone limits are held: `native` (the kernel's cone joint, the package's default) or
//                             `projection` (a ball joint and the ragdoll's own limit projection, what ran on Rapier; the
//                             only way Rapier can run it, as Rapier has no cone joint). Default: native on the kernel,
//                             projection on Rapier
//   --push=1.5                speed added to the upper body, m/s
//   --dirs=f,b,l,r            push directions: forward, backward, to its left, to its right
//   --substeps=8 --iterations=2 --warm=1   kernel solver settings; --sweep runs the acceptance sweep instead
//   --balance='{"stepTime":0.2}'   options passed to addRagdollBalance
//   --wide=regex              widen the cone limits of the bones whose names match to 3 rad (a diagnostic)
//   --trace=file.json         record every bone and joint for 60 frames after the push, both solvers, and print the first
//                             quantities that differ by more than --gap (default 0.05: metres, m/s or radians)
//
// Needs `npm run build:packages` and `node packages/physics/scripts/build-oracle.js`.
import { writeFileSync } from 'node:fs';
import { Ragdoll } from '../dist/index.js';
import { addRagdollBalance } from '../dist/balance.js';
import { fitRagdollShapes } from '../dist/hulls.js';
import { addRagdollMotors } from '../dist/powered.js';
import { humanoidProfile, ragdollOptions } from '../dist/profile.js';
import { Physics } from '@margoengine/physics';
import { RapierPhysics } from '../../physics/tests/oracle.js';
import { realRig } from '../tests/rig.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = '1'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const solvers = (args.solvers ?? 'kernel,rapier').split(','),
  push = Number(args.push ?? 1.5),
  directions = { f: [0, 1], b: [0, -1], l: [1, 0], r: [-1, 0] },
  dirs = (args.dirs ?? 'f,b,l,r').split(',');
await RapierPhysics.load();

/** The ragdoll's earlier joint: a ball joint whose cone the ragdoll's own projection holds. */
function projectedJoints() {
  const join = Ragdoll.prototype.join;
  Ragdoll.prototype.join = function (parent, child, spec, anchor, rest) {
    if (spec?.type !== 'cone') return join.call(this, parent, child, spec, anchor, rest);
    const swing = spec.swing ?? Math.PI / 4,
      [min, max] = spec.twist ?? [-Math.PI / 6, Math.PI / 6];
    return {
      joint: this.physics.addJoint(parent, child, { type: 'spherical', anchorA: anchor, anchorB: [0, 0, 0] }),
      cone: { swing, min, max },
      spec: { type: 'cone', swing, twist: [min, max] },
    };
  };
  return () => (Ragdoll.prototype.join = join);
}

/** Swing and twist of a bone from its rest pose, as the ragdoll's projection measures them. */
function swingTwist(ragdoll, part) {
  const up = ragdoll.bones[part.parent].body.rotation,
    q = part.body.rotation,
    rest = part.rest,
    mul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ],
    s = mul(up, rest),
    r = mul([-s[0], -s[1], -s[2], s[3]], q);
  if (r[3] < 0) for (let k = 0; k < 4; k++) r[k] = -r[k];
  const u = part.axis,
    p = r[0] * u[0] + r[1] * u[1] + r[2] * u[2],
    twist = 2 * Math.atan2(p, r[3]),
    swing = 2 * Math.atan2(Math.hypot(r[0] - u[0] * p, r[1] - u[1] * p, r[2] - u[2] * p), Math.hypot(p, r[3]));
  return [swing, twist];
}

async function run(solver, direction, { trace = false, limits, settings = {}, wide } = {}) {
  const projection = (limits ?? (solver === 'rapier' ? 'projection' : 'native')) === 'projection',
    restore = projection ? projectedJoints() : () => {};
  const rig = await realRig('kaykit/adventurers/characters/Knight.glb', {
    physics: solver === 'rapier' ? RapierPhysics : Physics,
  });
  try {
    const n = (s) => rig.node(s),
      sides = [
        ['left', 'l'],
        ['right', 'r'],
      ],
      bones = {
        hips: n('hips'),
        spine: n('spine'),
        chest: n('chest'),
        head: n('head'),
        ...Object.fromEntries(
          sides.flatMap(([side, s]) => [
            [`${side}UpperArm`, n(`upperarm.${s}`)],
            [`${side}LowerArm`, n(`lowerarm.${s}`)],
            [`${side}Hand`, n(`hand.${s}`)],
            [`${side}UpperLeg`, n(`upperleg.${s}`)],
            [`${side}LowerLeg`, n(`lowerleg.${s}`)],
            [`${side}Foot`, n(`foot.${s}`)],
          ]),
        ),
      };
    rig.frames(1);
    if (solver === 'kernel') {
      if (settings.substeps) rig.physics.substeps = settings.substeps;
      if (settings.iterations) rig.physics.iterations = settings.iterations;
      if (settings.warm !== undefined) rig.physics.setSolver({ warmStart: settings.warm });
    }
    const ragdoll = Ragdoll.attach(
      rig.physics,
      ragdollOptions(humanoidProfile(rig.model.nodes, { bones, mass: 30 }), rig.model.nodes),
    );
    restore();
    fitRagdollShapes(ragdoll, rig.model);
    if (wide)
      for (const part of ragdoll.bones)
        if (part.joint?.cone && new RegExp(wide).test(part.node.name)) part.joint.setCone(3, [-3, 3]);
    const motors = addRagdollMotors(ragdoll, { frequency: 8 }),
      keeper = addRagdollBalance(ragdoll, motors, {
        feet: [n('foot.l'), n('foot.r')],
        ...(args.balance ? JSON.parse(args.balance) : {}),
      }),
      hips = ragdoll.bones[0].body,
      height = hips.position[1],
      upper = ragdoll.bones.filter((part) => !/leg|foot|toes/.test(part.node.name));
    ragdoll.activate();
    rig.frames(120);
    const before = keeper.steps,
      was = [...hips.position],
      feet = [n('foot.l'), n('foot.r')].map((foot) => ragdoll.part(foot).body),
      feetWere = feet.map((body) => [...body.position]),
      along = (a, b) =>
        ((a[0] - b[0]) * direction[0] + (a[2] - b[2]) * direction[1]) / Math.hypot(direction[0], direction[1]);
    let went = 0,
      moved = 0;
    for (const { body } of upper) {
      const v = body.linearVelocity;
      body.setLinearVelocity([v[0] + direction[0] * push, v[1], v[2] + direction[1] * push]);
    }
    const frames = [];
    const record = () =>
      frames.push(
        ragdoll.bones.map((part) => ({
          name: part.node.name,
          p: [...part.body.position],
          v: [...part.body.linearVelocity],
          w: [...part.body.angularVelocity],
          joint:
            part.parent >= 0 && ragdoll.bones[part.parent] && part.spec?.type === 'cone'
              ? swingTwist(ragdoll, part)
              : null,
        })),
      );
    if (trace) record();
    for (let f = 0; f < 240; f++) {
      rig.frames(1);
      went = Math.max(went, along(hips.position, was));
      feet.forEach((body, i) => (moved = Math.max(moved, along(body.position, feetWere[i]))));
      if (trace && f < 60) record();
    }
    const result = {
      state: keeper.state,
      steps: keeper.steps - before,
      hips: hips.position[1] / height,
      tilt: keeper.tilt,
      went,
      moved,
    };
    rig.frames(120);
    result.speed = Math.hypot(...hips.linearVelocity);
    // What tests/balance.test.js asks of a push.
    result.ok =
      result.state !== 'fallen' &&
      result.steps > 0 &&
      result.hips > 0.8 &&
      result.tilt < 0.3 &&
      went > 0.02 &&
      moved > 0.02 &&
      result.speed < 0.5;
    return { result, frames };
  } finally {
    restore();
    rig.dispose();
  }
}

const line = ({ state, steps, hips, tilt, speed, ok }) =>
  `${ok ? 'ok  ' : 'FAIL'} ${state} steps ${steps} hips ${hips.toFixed(2)} tilt ${tilt.toFixed(2)} speed ${speed.toFixed(2)}`;

if (args.sweep) {
  // The acceptance sweep: the kernel at every setting, all four pushes.
  let failed = 0;
  const fails = [];
  for (const iterations of [2, 3, 4, 5, 6])
    for (const substeps of [4, 8, 16])
      for (const warm of [1, 0]) {
        const row = [];
        for (const key of dirs) {
          const { result } = await run('kernel', directions[key], {
            settings: { iterations, substeps, warm },
            limits: args.limits,
            wide: args.wide,
          });
          if (!result.ok) {
            failed++;
            fails.push(`${key} i${iterations} s${substeps} w${warm}: ${line(result)}`);
          }
          row.push(`${key} ${result.ok ? 'ok' : 'FAIL'}`);
        }
        console.log(`iterations ${iterations} substeps ${substeps} warm ${warm}: ${row.join('  ')}`);
      }
  console.log(`${failed} failed at ${push} m/s`);
  for (const fail of fails) console.log(`  ${fail}`);
  process.exitCode = failed ? 1 : 0;
} else {
  const settings = {
    substeps: args.substeps && Number(args.substeps),
    iterations: args.iterations && Number(args.iterations),
    warm: args.warm && Number(args.warm),
  };
  const traces = {};
  for (const key of dirs)
    for (const entry of solvers) {
      const [solver, limits = args.limits] = entry.split(':');
      const { result, frames } = await run(solver, directions[key], {
        trace: Boolean(args.trace),
        limits,
        settings,
        wide: args.wide,
      });
      console.log(`${key} ${entry.padEnd(18)} ${line(result)}`);
      (traces[key] ??= {})[entry] = frames;
    }
  if (args.trace) {
    writeFileSync(args.trace, JSON.stringify(traces));
    const gap = Number(args.gap ?? 0.05);
    for (const key of dirs) {
      const [kernel, rapier] = solvers.map((entry) => traces[key]?.[entry]);
      if (!kernel || !rapier) continue;
      const first = [];
      for (let f = 0; f < kernel.length && first.length < 8; f++)
        kernel[f].forEach((bone, i) => {
          const other = rapier[f][i],
            checks = [
              ['position', Math.hypot(...bone.p.map((x, k) => x - other.p[k]))],
              ['velocity', Math.hypot(...bone.v.map((x, k) => x - other.v[k]))],
              ['spin', Math.hypot(...bone.w.map((x, k) => x - other.w[k]))],
              ['swing', bone.joint && other.joint ? Math.abs(bone.joint[0] - other.joint[0]) : 0],
              ['twist', bone.joint && other.joint ? Math.abs(bone.joint[1] - other.joint[1]) : 0],
            ];
          for (const [what, d] of checks)
            if (d > gap && !first.some((x) => x.name === bone.name && x.what === what) && first.length < 8)
              first.push({ frame: f, name: bone.name, what, d });
        });
      console.log(
        `${key}: first to part by ${gap}: ${first.map((x) => `frame ${x.frame} ${x.name} ${x.what} ${x.d.toFixed(3)}`).join('; ')}`,
      );
    }
  }
}
