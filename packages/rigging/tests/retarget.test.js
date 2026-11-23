import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HUMANOID_BONES, detectSkeleton, humanoidBones, prepareRetarget } from '../dist/retarget.js';
import { createKeyframeClip, sampleKeyframes } from '../../animation/dist/index.js';
import { Retarget } from '../../animation/dist/skeleton-utils.js';
import { rotateByQuaternion } from '@margoengine/math/quat';

/**
 * A humanoid rig under one naming, standing in a T-pose (arms along x) or an A-pose (arms 40 degrees down), y up,
 * facing +z. `name(bone)` gives each humanoid bone's name; bones it returns null for are left out.
 */
function humanoid(name, { pose = 'T', scale = 1, extraRoot } = {}) {
  const layout = [
    ['hips', null, [0, 1, 0]],
    ['spine', 'hips', [0, 0.1, 0]],
    ['chest', 'spine', [0, 0.15, 0]],
    ['upperChest', 'chest', [0, 0.15, 0]],
    ['neck', 'upperChest', [0, 0.15, 0]],
    ['head', 'neck', [0, 0.1, 0]],
    ...['left', 'right'].flatMap((s) => {
      const x = s === 'left' ? 1 : -1;
      return [
        [`${s}Shoulder`, 'upperChest', [0.05 * x, 0.1, 0]],
        [`${s}UpperArm`, `${s}Shoulder`, [0.1 * x, 0, 0]],
        [`${s}LowerArm`, `${s}UpperArm`, [0.28 * x, 0, 0]],
        [`${s}Hand`, `${s}LowerArm`, [0.25 * x, 0, 0]],
        [`${s}MiddleProximal`, `${s}Hand`, [0.08 * x, 0, 0]],
        [`${s}UpperLeg`, 'hips', [0.1 * x, -0.05, 0]],
        [`${s}LowerLeg`, `${s}UpperLeg`, [0, -0.45, 0]],
        [`${s}Foot`, `${s}LowerLeg`, [0, -0.42, 0]],
        [`${s}Toes`, `${s}Foot`, [0, -0.05, 0.12]],
      ];
    }),
  ];
  const kept = layout.filter(([bone]) => name(bone) !== null),
    names = kept.map(([bone]) => name(bone)),
    index = new Map(kept.map(([bone], i) => [bone, i])),
    // A bone's parent is the nearest kept ancestor; skipped bones' offsets fold into their children.
    parents = [],
    rest = [];
  const offsetTo = new Map();
  for (const [bone, parent, offset] of layout) {
    let p = parent,
      o = offset.map((v) => v * scale);
    while (p !== null && !index.has(p)) {
      const [, grand, up] = layout.find(([b]) => b === p);
      o = o.map((v, c) => v + up[c] * scale);
      p = grand;
    }
    offsetTo.set(bone, { parent: p, offset: o });
  }
  for (const [bone] of kept) {
    const { parent, offset } = offsetTo.get(bone);
    parents.push(parent === null ? (extraRoot ? 0 : -1) : index.get(parent) + (extraRoot ? 1 : 0));
    // The A-pose turns each upper arm 40 degrees down about z.
    let q = [0, 0, 0, 1];
    if (pose === 'A' && /UpperArm$/.test(bone)) {
      const a = (bone.startsWith('left') ? -40 : 40) * (Math.PI / 180);
      q = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
    }
    rest.push(...offset, ...q, 1, 1, 1);
  }
  if (extraRoot) {
    names.unshift(extraRoot);
    parents.unshift(-1);
    rest.unshift(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
  }
  return { names, parents, rest: Float64Array.from(rest) };
}
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const mixamo = (bone) =>
  'mixamorig:' +
  ({ spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2' }[bone] ??
    bone
      .replace(/^(left|right)(.*)$/, (_, s, rest) => capital(s) + rest)
      .replace('UpperArm', 'Arm')
      .replace('LowerArm', 'ForeArm')
      .replace('UpperLeg', 'UpLeg')
      .replace('LowerLeg', 'Leg')
      .replace('Toes', 'ToeBase')
      .replace('MiddleProximal', 'HandMiddle1')
      .replace(/^./, (c) => c.toUpperCase()));
const godot = (bone) => capital(bone);
const roblox = (bone) =>
  ({ hips: 'LowerTorso', spine: 'UpperTorso', head: 'Head' })[bone] ??
  (/^(left|right)(UpperArm|LowerArm|Hand|UpperLeg|LowerLeg|Foot)$/.test(bone) ? capital(bone) : null);

/** A clip that waves both arms and bends the knees, keyed on humanoid bones named by `name`. */
function clip(name) {
  const turn = (axis, angle) => {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
  };
  const keys = (axis, angles) => angles.map((a, i) => ({ time: i * 0.5, value: turn(axis, a) }));
  return createKeyframeClip({
    name: 'wave',
    tracks: [
      { target: name('leftUpperArm'), path: 'rotation', keys: keys([0, 0, 1], [0, 0.6, -0.3]) },
      { target: name('rightLowerArm'), path: 'rotation', keys: keys([0, 1, 0], [0, -0.8, 0.4]) },
      { target: name('leftLowerLeg'), path: 'rotation', keys: keys([1, 0, 0], [0, 0.9, 0.2]) },
      { target: name('spine'), path: 'rotation', keys: keys([0, 1, 0], [0, 0.3, -0.2]) },
      {
        target: name('hips'),
        path: 'translation',
        keys: [0, 0.5, 1].map((time, i) => ({ time, value: [0, 1 - 0.05 * i, 0.1 * i] })),
      },
    ],
  });
}

test('presets are detected from the bone names, prefixes and case included', () => {
  for (const [label, rig, preset] of [
    ['mixamo', humanoid(mixamo), 'mixamo'],
    ['mixamo1_', humanoid((b) => mixamo(b).replace('mixamorig:', 'mixamorig1_')), 'mixamo'],
    ['godot', humanoid(godot, { extraRoot: 'Root' }), 'godot'],
    ['roblox', humanoid(roblox, { extraRoot: 'HumanoidRootPart' }), 'roblox'],
    ['humanoid', humanoid((b) => b), 'humanoid'],
  ])
    assert.equal(detectSkeleton(rig.names)?.preset, preset, label);
  assert.equal(detectSkeleton(['a', 'b']), null);
  const margo = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist'];
  assert.equal(detectSkeleton(margo)?.preset, 'margo');
  assert.equal(humanoidBones(margo, 'margo').get('leftLowerArm'), 7);
  assert.equal(HUMANOID_BONES.length, 55);
  assert.throws(() => humanoidBones([], 'blender'), RangeError);
});

test('Mixamo to Godot and back round-trips every mapped rotation', () => {
  const mix = humanoid(mixamo),
    god = humanoid(godot, { scale: 1.3, extraRoot: 'Root' }),
    there = prepareRetarget(mix, god),
    back = prepareRetarget(god, mix);
  assert.equal(there.from, 'mixamo');
  assert.equal(there.to, 'godot');
  assert.equal(there.hip, 'Hips');
  assert.equal(there.names.LeftForeArm, undefined);
  assert.equal(there.names.LeftLowerArm, 'mixamorig:LeftForeArm');
  assert.equal(there.names.Root, '');
  const forward = new Retarget(mix, there.target, there),
    backward = new Retarget(god, back.target, back),
    source = clip(mixamo),
    onGodot = forward.clip(source, { fps: 20 }),
    roundTrip = backward.clip(onGodot, { fps: 20 });
  // Every keyed rotation comes back; the hip travel comes back scaled 1.3 there and 1/1.3 back.
  for (const track of source.tracks) {
    const returned = roundTrip.tracks.find((t) => t.target === track.target && t.path === track.path);
    assert.ok(returned, `${track.target} ${track.path} round-trips`);
    for (let time = 0; time <= 1; time += 0.05) {
      const a = sampleKeyframes(track, time, new Float64Array(4)),
        b = sampleKeyframes(returned, time, new Float64Array(4));
      if (track.path === 'rotation') {
        const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        assert.ok(dot > 1 - 1e-6, `${track.target} at ${time.toFixed(2)}: ${dot}`);
      } else for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) < 1e-6, `${track.target} ${c} at ${time}`);
    }
  }
});

test('rest-pose alignment drives an A-pose target into the source T-pose', () => {
  const source = humanoid(mixamo),
    target = humanoid(godot, { pose: 'A' }),
    aligned = prepareRetarget(source, target),
    raw = prepareRetarget(source, target, { alignRest: false });
  const upperArm = target.names.indexOf('LeftUpperArm'),
    // The source at rest: the retargeted target's left forearm direction in model space.
    direction = (prepared) => {
      const retarget = new Retarget(source, prepared.target, prepared),
        local = retarget.pose(source.rest),
        q = local.subarray(upperArm * 10 + 3, upperArm * 10 + 7);
      // Upper arm's rest offset to the forearm is +x; its parents (shoulder, chest...) are not turned at rest.
      const [x, y, z, w] = q;
      return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    };
  const t = direction(aligned),
    a = direction(raw);
  assert.ok(Math.abs(t[1]) < 1e-9 && t[0] > 0.999999, `aligned: the arm is level (${t})`);
  assert.ok(a[1] < -0.6, `unaligned: the arm stays 40 degrees down (${a})`);
});

test('retargeting corrects palm roll on both hands without changing their aim', () => {
  for (const [side, x] of [
    ['left', 1],
    ['right', -1],
  ]) {
    const names = ['hips', `${side}Hand`, `${side}MiddleProximal`, `${side}IndexProximal`, `${side}LittleProximal`],
      source = {
        names,
        parents: [-1, 0, 1, 1, 1],
        rest: Float64Array.from(
          [
            [0, 1, 0],
            [0.5 * x, 0, 0],
            [0.08 * x, 0, 0],
            [0.08 * x, 0, 0.03],
            [0.07 * x, 0, -0.03],
          ].flatMap((at) => [...at, 0, 0, 0, 1, 1, 1, 1]),
        ),
      },
      target = { ...source, rest: source.rest.slice() };
    target.rest.set([2, 1.5, 0.8], 7); // The wrist lives below a stretched parent.
    target.rest.set([x * Math.SQRT1_2, 0, 0, Math.SQRT1_2], 13);

    const check = (rig, options, expected) => {
      const prepared = prepareRetarget(rig, target, { from: 'humanoid', to: 'humanoid', ...options }),
        pose = new Retarget(rig, prepared.target, prepared).pose(rig.rest),
        wrist = pose.subarray(13, 17),
        aim = rotateByQuaternion([x, 0, 0], wrist),
        across = rotateByQuaternion([0, 0, 1], wrist);
      assert.ok(Math.hypot(aim[0] - x, aim[1], aim[2]) < 1e-9, `${side} hand still aims outwards`);
      assert.ok(Math.hypot(...across.map((v, i) => v - expected[i])) < 1e-9, `${side} palm points ${across}`);
    };
    check(source, {}, [0, 0, 1]);
    check(source, { alignRest: false }, [0, -x, 0]);
    const withoutLittle = {
      names: names.slice(0, 4),
      parents: source.parents.slice(0, 4),
      rest: source.rest.slice(0, 40),
    };
    check(withoutLittle, {}, [0, -x, 0]);
    const collinear = { ...source, rest: source.rest.slice() };
    collinear.rest[32] = collinear.rest[42] = 0;
    check(collinear, {}, [0, -x, 0]);
  }
});

test('Roblox R15 takes Mixamo clips: trunk and limbs map, missing bones are listed', () => {
  const mix = humanoid(mixamo),
    r15 = humanoid(roblox, { extraRoot: 'HumanoidRootPart' }),
    prepared = prepareRetarget(mix, r15);
  // VRM 1.0 humanoid.md: spine is required and chest optional, so R15's one trunk bone is the spine (Mixamo Spine).
  assert.equal(prepared.names.UpperTorso, 'mixamorig:Spine');
  assert.equal(prepared.names.HumanoidRootPart, '');
  assert.equal(prepared.hip, 'LowerTorso');
  assert.deepEqual(prepared.unmapped, []);
  const back = prepareRetarget(r15, mix);
  assert.ok(back.unmapped.includes('neck') && back.unmapped.includes('leftShoulder'));
  const onRoblox = new Retarget(mix, prepared.target, prepared).clip(clip(mixamo), { fps: 10 });
  assert.ok(onRoblox.tracks.some((t) => t.target === 'LeftUpperArm' && t.path === 'rotation'));
  assert.throws(
    () => prepareRetarget(mix, { names: ['x'], parents: [-1], rest: new Float64Array(10) }),
    /not recognised/,
  );
});

// The CMU motion capture skeleton as @margoengine/loaders/mocap's parseASF names its joints (Acclaim bone names).
const cmu = (bone) => {
  const side = /^(left|right)/.exec(bone)?.[1]?.[0] ?? '';
  const rest = bone.replace(/^(left|right)/, '');
  return (
    {
      hips: 'root',
      spine: 'lowerback',
      chest: 'upperback',
      upperChest: 'thorax',
      neck: 'lowerneck',
      head: 'head',
      Shoulder: `${side}clavicle`,
      UpperArm: `${side}humerus`,
      LowerArm: `${side}radius`,
      Hand: `${side}wrist`,
      MiddleProximal: `${side}fingers`,
      UpperLeg: `${side}femur`,
      LowerLeg: `${side}tibia`,
      Foot: `${side}foot`,
      Toes: `${side}toes`,
    }[side ? rest : bone] ?? null
  );
};

test('the CMU mocap skeleton is detected and drives a Mixamo A-pose rig as Mixamo clips do', () => {
  const names = humanoid(cmu).names;
  assert.equal(detectSkeleton(names)?.preset, 'cmu');
  // CMU's own extra joints (hip joints, upper neck, hands past the wrist, thumbs) are not humanoid bones.
  assert.equal(detectSkeleton([...names, 'lhipjoint', 'rhipjoint', 'upperneck', 'lhand', 'lthumb'])?.preset, 'cmu');
  assert.equal(humanoidBones(names, 'cmu').get('leftHand'), names.indexOf('lwrist'));
  const target = humanoid(mixamo, { pose: 'A' }),
    fromCmu = prepareRetarget(humanoid(cmu), target),
    fromMixamo = prepareRetarget(humanoid(mixamo), target);
  assert.equal(fromCmu.from, 'cmu');
  assert.equal(fromCmu.names['mixamorig:LeftForeArm'], 'lradius');
  assert.equal(fromCmu.hip, 'mixamorig:Hips');
  assert.deepEqual(fromCmu.unmapped, fromMixamo.unmapped);
  // The same motion keyed on either naming gives the same clip on the target, rest alignment included.
  const a = new Retarget(humanoid(cmu), fromCmu.target, fromCmu).clip(clip(cmu), { fps: 10 }),
    b = new Retarget(humanoid(mixamo), fromMixamo.target, fromMixamo).clip(clip(mixamo), { fps: 10 });
  assert.equal(a.tracks.length, b.tracks.length);
  for (const track of b.tracks) {
    const other = a.tracks.find((t) => t.target === track.target && t.path === track.path);
    assert.ok(other, `${track.target} ${track.path}`);
    for (const time of [0, 0.25, 0.5, 0.75, 1]) {
      const width = track.path === 'rotation' ? 4 : 3,
        x = sampleKeyframes(track, time, new Float64Array(width)),
        y = sampleKeyframes(other, time, new Float64Array(width));
      x.forEach((v, i) => assert.ok(Math.abs(v - y[i]) < 1e-12, `${track.target} at ${time}: ${x} against ${y}`));
    }
  }
});

test('rest alignment turns the limbs only: a source whose trunk and collarbones lean leaves the target standing straight', () => {
  // A motion-capture skeleton's trunk and collarbone directions are its body's layout (the neck base sits ahead of the
  // mid-back, the collarbone rises to the shoulder), not a pose: aiming the target's trunk along them hunches and shrugs it.
  const source = humanoid(cmu),
    at = (name) => source.names.indexOf(name) * 10;
  source.rest.set([0, 0.15, 0.08], at('lowerneck')); // neck base ahead of the chest
  source.rest.set([0.1, 0.05, 0], at('lhumerus')); // the collarbone rising to the shoulder
  const target = humanoid(mixamo, { pose: 'A' }),
    prepared = prepareRetarget(source, target);
  for (const bone of [
    'mixamorig:Hips',
    'mixamorig:Spine',
    'mixamorig:Spine1',
    'mixamorig:Spine2',
    'mixamorig:Neck',
    'mixamorig:LeftShoulder',
  ]) {
    const b = target.names.indexOf(bone) * 10 + 3;
    assert.deepEqual(
      Array.from(prepared.target.rest.subarray(b, b + 4)),
      Array.from(target.rest.subarray(b, b + 4)),
      bone,
    );
  }
  // The A-pose arm is still aimed along the source's level upper arm.
  const arm = target.names.indexOf('mixamorig:LeftArm') * 10 + 3,
    [x, y, z, w] = prepared.target.rest.subarray(arm, arm + 4);
  assert.ok(Math.abs(2 * (x * y + w * z)) < 1e-9 && 1 - 2 * (y * y + z * z) > 0.999999, 'the upper arm is level');
});

test("Character Creator's CC3+ skeleton is detected and takes Mixamo clips", () => {
  // The names as a CC4 export writes them, twist and share bones beside the limbs (wilbur.fbx, 2026-11-18).
  const cc = (bone) =>
    ({ hips: 'CC_Base_Hip', spine: 'CC_Base_Waist', chest: 'CC_Base_Spine01', upperChest: 'CC_Base_Spine02' })[bone] ??
    { neck: 'CC_Base_NeckTwist01', head: 'CC_Base_Head' }[bone] ??
    bone.replace(
      /^(left|right)(.*)$/,
      (_, s, part) =>
        `CC_Base_${s === 'left' ? 'L' : 'R'}_` +
        {
          Shoulder: 'Clavicle',
          UpperArm: 'Upperarm',
          LowerArm: 'Forearm',
          Hand: 'Hand',
          MiddleProximal: 'Mid1',
          UpperLeg: 'Thigh',
          LowerLeg: 'Calf',
          Foot: 'Foot',
          Toes: 'ToeBase',
        }[part],
    );
  const target = humanoid(cc, { extraRoot: 'CC_Base_BoneRoot' });
  target.names.push('CC_Base_L_UpperarmTwist01', 'CC_Base_Pelvis');
  target.parents.push(target.names.indexOf('CC_Base_L_Upperarm'), target.names.indexOf('CC_Base_Hip'));
  target.rest = Float64Array.from([...target.rest, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(detectSkeleton(target.names), { preset: 'characterCreator', bones: 24 });
  const bones = humanoidBones(target.names, 'characterCreator');
  assert.equal(target.names[bones.get('leftMiddleProximal')], 'CC_Base_L_Mid1');
  assert.equal(target.names[bones.get('rightLowerLeg')], 'CC_Base_R_Calf');
  const source = humanoid(mixamo),
    prepared = prepareRetarget(source, target);
  assert.equal(prepared.from, 'mixamo');
  assert.equal(prepared.to, 'characterCreator');
  assert.equal(prepared.hip, 'CC_Base_Hip');
  assert.equal(prepared.names.CC_Base_L_Upperarm, 'mixamorig:LeftArm');
  assert.equal(prepared.names.CC_Base_L_UpperarmTwist01, '');
  const out = new Retarget(source, prepared.target, prepared).clip(clip(mixamo), { fps: 10 });
  assert.ok(out.tracks.some((track) => track.target === 'CC_Base_L_Upperarm'));
});
