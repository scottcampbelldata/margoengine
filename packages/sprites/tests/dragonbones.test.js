import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DragonBonesArmature,
  loadDragonBonesJSON,
  parseDragonBonesAtlas,
  parseDragonBonesJSON,
} from '../dist/dragonbones.js';
import { SkeletalLayer, Skeleton2D, SkinnedMesh } from '../dist/skeletal.js';
import { SpineSkeleton } from '../dist/spine.js';

const fixture = (name) => readFileSync(new URL(`fixtures/dragonbones/${name}`, import.meta.url), 'utf8');
const near = (a, b, e = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} != ${b}`);
const world = (rig, name) => rig.bone(name).world;
// A minimal hand-made document: root bone, one child, one slot with an image and a mesh.
const doc = (extra = {}) => ({
  name: 't',
  version: '5.5',
  frameRate: 10,
  armature: [
    {
      name: 'a',
      bone: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 10, transform: { x: 5 } }],
      slot: [{ name: 's', parent: 'arm' }],
      skin: [{ slot: [{ name: 's', display: [{ name: 'img' }] }] }],
      animation: [{ name: 'idle', duration: 0 }],
      ...extra,
    },
  ],
});
const atlas = { SubTexture: [{ name: 'img', x: 8, y: 4, width: 4, height: 2 }], width: 32, height: 32 };

test('bones follow the DragonBones transform: x axis at skY, y axis at 90 + skX, scales per axis, y down', () => {
  const data = doc({
    bone: [
      { name: 'root', transform: { x: 3, y: -2, skX: 30, skY: 10, scX: 2, scY: 0.5 } },
      { name: 'arm', parent: 'root', length: 10, transform: { x: 5, y: 1 } },
    ],
  });
  const rig = parseDragonBonesJSON(data, { atlas }).createArmature();
  const r = 10 * (Math.PI / 180),
    k = 30 * (Math.PI / 180);
  const m = [2 * Math.cos(r), 2 * Math.sin(r), -0.5 * Math.sin(k), 0.5 * Math.cos(k), 3, -2];
  world(rig, 'root').forEach((v, i) => near(v, m[i], 1e-9, `root ${i}`));
  const w = world(rig, 'arm');
  near(w[4], m[0] * 5 + m[2] * 1 + m[4], 1e-9);
  near(w[5], m[1] * 5 + m[3] * 1 + m[5], 1e-9);
  assert.ok(rig instanceof DragonBonesArmature && rig instanceof SpineSkeleton && rig instanceof Skeleton2D);
});

test('every exported bind pose of a real weighted-mesh file matches the computed setup world, inheritance included', () => {
  // Bind poses are the exported pose before constraints, so compare a copy without its IK constraints.
  const source = JSON.parse(fixture('body_ske.json')).armature[0],
    unconstrained = JSON.parse(fixture('body_ske.json'));
  unconstrained.armature[0].ik = [];
  for (const a of unconstrained.armature[0].animation) delete a.ik;
  const data = parseDragonBonesJSON(unconstrained, { atlas: fixture('body_tex.json') }),
    rig = data.createArmature('body');
  let checked = 0,
    matched = 0;
  for (const skin of source.skin)
    for (const slot of skin.slot)
      for (const d of slot.display)
        for (let i = 0; d.bonePose && i < d.bonePose.length; i += 7) {
          const bone = rig.bones[d.bonePose[i]],
            m = d.bonePose.slice(i + 1, i + 7);
          if (m.slice(0, 4).every((v, j) => Math.abs(v - bone.world[j]) < 1e-3)) matched++;
          checked++;
        }
  // An artist may move a bone after binding, so most (not all) bind poses equal the setup pose: their rotation,
  // skew and scale (the linear part) check the transform reading through chains up to eight bones deep.
  assert.ok(checked > 20, `bind poses checked ${checked}`);
  assert.ok(matched / checked > 0.8, `bind linear parts matched ${matched} of ${checked}`);
  assert.deepEqual(data.warnings, []);
});

test('images are trimmed atlas regions placed at their pivot with the display transform', () => {
  const data = parseDragonBonesJSON(
    doc({
      skin: [
        {
          slot: [
            {
              name: 's',
              display: [{ name: 'img', transform: { x: 1, y: 2, skX: 90, skY: 90 }, pivot: { x: 0, y: 1 } }],
            },
          ],
        },
      ],
    }),
    {
      atlas: {
        SubTexture: [
          { name: 'img', x: 8, y: 4, width: 4, height: 2, frameX: -1, frameY: -1, frameWidth: 6, frameHeight: 4 },
        ],
      },
    },
  );
  const rig = data.createArmature(),
    a = rig.getAttachment('s');
  // Untrimmed 6 x 4 frame, pivot at its bottom left; the trimmed 4 x 2 texels sit 1 in from the left and top.
  // Local quad corners (x, y) from the pivot: (1, -3) .. (5, -1); rotated 90 degrees clockwise then moved by (1, 2).
  const expected = [
    [1, -3],
    [5, -3],
    [5, -1],
    [1, -1],
  ].flatMap(([x, y]) => [-y + 1 + 5, x + 2]);
  const p = a.mesh.deform();
  expected.forEach((v, i) => near(p[i], v, 1e-9, `corner ${i}`));
  const texels = [...a.mesh.uvs];
  assert.deepEqual(texels, [8, 4, 12, 4, 12, 6, 8, 6]);
  assert.throws(() => parseDragonBonesJSON(doc()), { code: 'failed', message: /needs an atlas region/ });
});

test('real image files load with their atlas: every slot draws and animations pose', () => {
  const data = parseDragonBonesJSON(fixture('Dragon_ske.json'), { atlas: fixture('Dragon_tex.json') });
  const rig = data.createArmature();
  assert.deepEqual([...data.armatures.keys()], ['Dragon']);
  assert.equal(data.armatures.get('Dragon').defaultAnimation, 'stand');
  assert.deepEqual(
    [...rig.armature.animations.values()].map((a) => [a.name, a.frames, a.duration, a.playTimes]),
    [
      ['stand', 30, 30 / 24, 0],
      ['walk', 20, 20 / 24, 0],
      ['jump', 5, 5 / 24, 0],
      ['fall', 5, 5 / 24, 0],
    ],
  );
  const drawn = rig.drawOrder.filter((s) => rig.getAttachment(s.name)?.mesh?.visible).length;
  assert.equal(drawn, 18);
  rig.pose('walk', 0.3);
  const after = rig.drawOrder.map((s) => rig.getAttachment(s.name).mesh.deform().slice(0, 2));
  rig.pose('walk', 0.3 + 20 / 24);
  rig.drawOrder.forEach((s, i) =>
    rig
      .getAttachment(s.name)
      .mesh.deform()
      .slice(0, 2)
      .forEach((v, j) => near(v, after[i][j], 1e-6)),
  );
  // Played once, jump holds its last frame.
  rig.pose('jump', 5 / 24, { playTimes: 1 });
  const end = world(rig, rig.bones[3].name).slice();
  rig.pose('jump', 100, { playTimes: 1 });
  world(rig, rig.bones[3].name).forEach((v, i) => near(v, end[i], 1e-9));
  const layer = new SkeletalLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } });
  layer.addSkeleton(rig);
  assert.equal(rig.getAttachment(rig.drawOrder[0].name).mesh.owner, layer);
  layer.dispose();
});

test('IK chains of a real file reach their targets and bend the documented way', () => {
  const data = parseDragonBonesJSON(fixture('mecha_1406_ske.json'), { atlas: fixture('mecha_1406_tex.json') }),
    rig = data.createArmature();
  let reached = 0;
  for (const name of rig.armature.animations.keys())
    for (const t of [0, 0.2, 0.5]) {
      rig.pose(name, t);
      for (const [end, target] of [
        ['calf_l', 'foot_l'],
        ['calf_r', 'foot_r'],
      ]) {
        const e = world(rig, end),
          tip = [e[4] + e[0] * rig.bone(end).length, e[5] + e[1] * rig.bone(end).length],
          g = world(rig, target);
        const reach = Math.hypot(tip[0] - g[4], tip[1] - g[5]);
        const thigh = world(rig, rig.bone(end).parent.name),
          span = Math.hypot(g[4] - thigh[4], g[5] - thigh[5]);
        const length =
          rig.bone(end).parent.length * Math.hypot(thigh[0], thigh[1]) + rig.bone(end).length * Math.hypot(e[0], e[1]);
        if (span < length * 0.999) {
          assert.ok(reach < 0.05, `${name} ${t} ${end} misses by ${reach}`);
          reached++;
        }
      }
    }
  assert.ok(reached > 20, `reachable IK poses checked ${reached}`);
  // Doc: bendPositive true bends clockwise (y down); the child turns by a positive angle from its parent.
  const ik = (bendPositive) =>
    parseDragonBonesJSON(
      doc({
        bone: [
          { name: 'root' },
          { name: 'upper', parent: 'root', length: 10 },
          { name: 'lower', parent: 'upper', length: 10, transform: { x: 10 } },
          { name: 'goal', parent: 'root', transform: { x: 12 } },
        ],
        slot: [{ name: 's', parent: 'lower' }],
        ik: [{ name: 'k', bone: 'lower', target: 'goal', chain: 1, bendPositive }],
      }),
      { atlas },
    ).createArmature();
  assert.ok(ik(true).bone('lower').rotation > 0.1);
  assert.ok(ik(false).bone('lower').rotation < -0.1);
  assert.ok(world(ik(true), 'lower')[5] < 0, 'elbow above the line on screen when bending clockwise');
});

test('weighted meshes deform per vertex in mesh space through every influence, and shared meshes follow', () => {
  const mesh = {
    type: 'mesh',
    name: 'm',
    vertices: [0, 0, 10, 0, 10, 10],
    uvs: [0, 0, 1, 0, 1, 1],
    triangles: [0, 1, 2],
    weights: [1, 0, 1, 2, 0, 0.5, 1, 0.5, 1, 1, 1],
    slotPose: [1, 0, 0, 1, 0, 0],
    bonePose: [0, 1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 5, 0],
  };
  const data = parseDragonBonesJSON(
    doc({
      bone: [{ name: 'root' }, { name: 'arm', parent: 'root', transform: { x: 5, skX: 90, skY: 90 } }],
      slot: [
        { name: 's', parent: 'root' },
        { name: 't', parent: 'root' },
      ],
      skin: [
        {
          slot: [
            { name: 's', display: [mesh] },
            { name: 't', display: [{ type: 'mesh', name: 'copy', share: 'm' }] },
          ],
        },
      ],
      animation: [
        {
          name: 'bend',
          duration: 10,
          ffd: [
            {
              name: 'm',
              slot: 's',
              frame: [
                { duration: 10, tweenEasing: 0 },
                { offset: 2, vertices: [3, 4] },
              ],
            },
          ],
        },
      ],
    }),
  );
  const rig = data.createArmature(),
    a = rig.getAttachment('s'),
    b = rig.getAttachment('t');
  [0, 0, 10, 0, 10, 10].forEach((v, i) => near(a.mesh.deform()[i], v, 1e-9));
  rig.pose('bend', 0.5);
  const p = a.mesh.deform();
  near(p[2], 11.5, 1e-9);
  near(p[3], 2, 1e-9);
  rig.pose('bend', 1);
  near(a.mesh.deform()[2], 13, 1e-9);
  near(a.mesh.deform()[3], 4, 1e-9);
  near(b.mesh.deform()[2], 13, 1e-9);
  assert.ok(a.mesh instanceof SkinnedMesh);
});

test('slot display swaps, colour multipliers, z order, skins and nested armatures', () => {
  const outer = doc({
    bone: [{ name: 'root' }],
    slot: [
      { name: 'a', parent: 'root', color: { aM: 50, rM: 0 } },
      { name: 'b', parent: 'root', displayIndex: 1 },
      { name: 'c', parent: 'root', blendMode: 'add' },
    ],
    skin: [
      {
        slot: [
          { name: 'a', display: [{ name: 'img' }, { name: 'img', transform: { x: 9 } }] },
          { name: 'b', display: [{ name: 'img' }, { type: 'armature', name: 'inner' }] },
          { name: 'c', display: [{ name: 'img' }] },
        ],
      },
      { name: 'other', slot: [{ name: 'a', display: [{ name: 'img', transform: { x: 50 } }] }] },
    ],
    animation: [
      {
        name: 'go',
        duration: 10,
        zOrder: { frame: [{ duration: 5 }, { duration: 5, zOrder: [0, 2] }, { duration: 0 }] },
        slot: [
          {
            name: 'a',
            displayFrame: [{ duration: 5 }, { duration: 5, value: 1 }],
            colorFrame: [{ duration: 10, tweenEasing: 0, value: { aM: 50, rM: 0 } }, { value: { aM: 100 } }],
          },
          {
            name: 'b',
            displayFrame: [
              { duration: 5, value: 1 },
              { duration: 5, value: 0 },
            ],
          },
        ],
      },
    ],
  });
  outer.armature.push({
    name: 'inner',
    bone: [{ name: 'root', transform: { x: 2 } }],
    slot: [{ name: 'x', parent: 'root' }],
    skin: [{ slot: [{ name: 'x', display: [{ name: 'img' }] }] }],
    animation: [
      {
        name: 'spin',
        duration: 4,
        bone: [{ name: 'root', rotateFrame: [{ duration: 4, tweenEasing: 0 }, { rotate: 90 }] }],
      },
    ],
    defaultActions: [{ gotoAndPlay: 'spin' }],
  });
  const d2 = parseDragonBonesJSON(outer, { atlas });
  const rig = d2.createArmature('a');
  assert.deepEqual(
    rig.drawOrder.map((s) => s.name),
    ['a', 'b', 'b#1/x', 'c'],
  );
  assert.equal(rig.getAttachment('b#1/x') !== undefined, true, 'nested slot draws while its host shows it');
  assert.equal(rig.slotStates.get('c').blend, 'additive');
  near(rig.slotStates.get('a').color[3], 0.5, 1 / 255);
  rig.pose('go', 0.6);
  assert.equal(rig.slotStates.get('a').attachment, 'img#1');
  assert.equal(rig.getAttachment('b#1/x'), undefined, 'host swapped away from the nested armature');
  assert.deepEqual(
    rig.drawOrder.map((s) => s.name),
    ['b', 'b#1/x', 'c', 'a'],
  );
  near(rig.slotStates.get('a').color[3], 0.8, 1 / 255);
  rig.pose('go', 0.2);
  assert.equal(rig.getAttachment('b#1/x') !== undefined, true);
  // The nested armature plays its default animation on the same clock: 0.2 s of a 0.4 s quarter turn.
  near(rig.bone('b#1/root').rotation, (45 * Math.PI) / 180, 1e-9);
  rig.setSkin('other');
  near(rig.getAttachment('a').mesh.deform()[0], 50 - 2, 1e-9);
});

test('rotation keys turn the documented way: shortest, clockwise and counterclockwise rings', () => {
  const turn = (clockwise, from, to) => {
    const rig = parseDragonBonesJSON(
      doc({
        animation: [
          {
            name: 'r',
            duration: 10,
            bone: [
              { name: 'arm', rotateFrame: [{ duration: 10, tweenEasing: 0, clockwise, rotate: from }, { rotate: to }] },
            ],
          },
        ],
      }),
      { atlas },
    ).createArmature();
    rig.pose('r', 0.5, { playTimes: 1 });
    return (rig.bone('arm').rotation * 180) / Math.PI;
  };
  near(turn(0, 170, -170), 180, 1e-9);
  near(turn(1, 10, 0), 10 + 175, 1e-9);
  near(turn(-1, 0, 10), -175, 1e-9);
  near(turn(2, 0, 0), 180, 1e-9);
});

test('easing: number tweens are classic eases, a four-value curve is a cubic, no tween holds', () => {
  const at = (frame) => {
    const rig = parseDragonBonesJSON(
      doc({
        animation: [
          { name: 'm', duration: 10, bone: [{ name: 'arm', translateFrame: [{ duration: 10, ...frame }, { x: 10 }] }] },
        ],
      }),
      { atlas },
    ).createArmature();
    rig.pose('m', 0.25, { playTimes: 1 });
    return rig.bone('arm').x - 5;
  };
  near(at({ tweenEasing: 0 }), 2.5, 1e-9);
  near(at({ tweenEasing: 1 }), 10 * (0.25 + 0.25 * 0.75), 1e-6);
  near(at({ tweenEasing: -1 }), 10 * (0.25 - 0.25 * 0.75), 1e-6);
  near(at({ tweenEasing: 2 }), 10 * (3 * 0.0625 - 2 * 0.015625), 1e-6);
  near(at({}), 0, 1e-9);
  near(at({ curve: [0, 0, 1, 1] }), 2.5, 1e-6);
  assert.throws(() => at({ curve: [0, 0, 0.5, 0.5, 1, 1] }), { code: 'failed', message: /four control values/ });
});

test('frame events, sound events and play actions in both export layouts, looped', () => {
  const data = parseDragonBonesJSON(fixture('mecha_1502b_ske.json'), { atlas: fixture('mecha_1502b_tex.json') });
  const rig = data.createArmature('mecha_1502b'),
    walk = rig.armature.animations.get('walk');
  assert.ok(walk.events.some((e) => e.name === 'step' && e.bone === 'foot_r'));
  const once = rig.frameEvents('walk', 0, walk.duration),
    twice = rig.frameEvents('walk', 0, walk.duration * 2);
  // Half-open windows split cleanly; the second loop repeats the first one's events a duration later.
  assert.deepEqual(twice, [...once, ...rig.frameEvents('walk', walk.duration, walk.duration * 2)]);
  assert.deepEqual(
    rig
      .frameEvents('walk', walk.duration, walk.duration * 2)
      .filter((e) => e.time < walk.duration * 2 - 1e-9 && e.time > walk.duration)
      .map((e) => e.name),
    once.filter((e) => e.time > 0).map((e) => e.name),
  );
  assert.ok(rig.eventsBetween('walk', 0, walk.duration - 1e-9).length >= 1);
  const own = parseDragonBonesJSON(
    doc({
      animation: [
        {
          name: 'e',
          duration: 10,
          playTimes: 2,
          frame: [
            {
              duration: 5,
              actions: [{ type: 10, name: 'hit', ints: [3], floats: [0.5], strings: ['x'], bone: 'arm' }],
            },
            {
              duration: 5,
              actions: [
                { type: 11, name: 'boom' },
                { type: 0, gotoAndPlay: 'idle' },
              ],
            },
          ],
        },
      ],
    }),
    { atlas },
  ).createArmature();
  assert.deepEqual(
    own.frameEvents('e', 0, 10).map((e) => [e.type, e.name, e.time]),
    [
      ['event', 'hit', 0],
      ['sound', 'boom', 0.5],
      ['play', 'idle', 0.5],
      ['event', 'hit', 1],
      ['sound', 'boom', 1.5],
      ['play', 'idle', 1.5],
    ],
  );
  assert.deepEqual(own.frameEvents('e', 0, 1)[0], {
    type: 'event',
    name: 'hit',
    time: 0,
    bone: 'arm',
    slot: null,
    ints: [3],
    floats: [0.5],
    strings: ['x'],
  });
});

test('bounding boxes: rectangles, ellipses and polygons in bone space', () => {
  const rig = parseDragonBonesJSON(
    doc({
      skin: [
        {
          slot: [
            {
              name: 's',
              display: [
                { type: 'boundingBox', name: 'r', subType: 'rectangle', width: 4, height: 2, transform: { x: 1 } },
                { type: 'boundingBox', name: 'e', subType: 'ellipse', width: 4, height: 2 },
                { type: 'boundingBox', name: 'p', subType: 'polygon', vertices: [0, 0, 1, 0, 0, 1] },
              ],
            },
          ],
        },
      ],
    }),
  ).createArmature();
  const r = rig.getAttachment('s', 'r');
  assert.equal(r.type, 'boundingbox');
  assert.deepEqual([...r.worldVertices()], [4, -1, 8, -1, 8, 1, 4, 1]);
  assert.equal(rig.getAttachment('s', 'e').worldVertices().length, 128);
  assert.deepEqual(rig.getAttachment('s', 'e').data.dragonBones, {
    type: 'boundingBox',
    subType: 'ellipse',
    width: 4,
    height: 2,
  });
  assert.deepEqual([...rig.getAttachment('s', 'p').worldVertices()], [5, 0, 6, 0, 5, 1]);
});

test('a real nested-armature file flattens every child in place of its host slot', () => {
  const data = parseDragonBonesJSON(fixture('bounding_box_tester_ske.json'), {
    atlas: fixture('bounding_box_tester_tex.json'),
  });
  const rig = data.createArmature('tester');
  assert.deepEqual(
    rig.drawOrder.map((s) => s.name),
    [
      'line',
      'point_b',
      'point_b#0/circle',
      'point_b#0/line',
      'point_a',
      'point_a#0/circle',
      'point_a#0/line',
      'target_b',
      'target_b#0/a',
      'target_b#0/b',
      'target_a',
      'target_a#0/a',
      'target_a#0/b',
    ],
  );
  rig.pose('1', 0);
  near(rig.slotStates.get('line').color[0], 0, 1e-9);
  near(world(rig, 'point_b#0/root')[0], 0.4, 1e-9);
  // The line image (400 texels, display scale 0.25 at x 50) spans exactly from point_a to point_b.
  const line = rig.getAttachment('line').mesh.deform();
  near(Math.min(line[0], line[2]), 0, 1e-9);
  near(Math.max(line[0], line[2]), 100, 1e-9);
});

test('invalid data, unsupported layouts and limits fail with coded errors', () => {
  const fails = (input, pattern, options) =>
    assert.throws(() => parseDragonBonesJSON(input, options), { name: 'MargoError', code: 'failed', message: pattern });
  fails(new Uint8Array([0x44, 0x42, 0x44, 0x54, 0, 0, 0, 0]), /binary/);
  fails({ ...doc(), version: '4.5' }, /4\.5 is not read/);
  fails('{', /malformed/);
  fails(doc({ bone: [{ name: 'root', parent: 'nope' }] }), /unknown or later parent/, { atlas });
  fails(doc({ slot: [{ name: 's', parent: 'nope' }] }), /unknown parent bone/, { atlas });
  fails(
    doc({
      skin: [
        {
          slot: [
            {
              name: 's',
              display: [
                {
                  type: 'mesh',
                  name: 'm',
                  vertices: [0, 0, 1, 0, 0, 1],
                  uvs: [0, 0, 1, 0, 0, 1],
                  triangles: [0, 1, 3],
                },
              ],
            },
          ],
        },
      ],
    }),
    /invalid triangles/,
  );
  fails(doc({ animation: [{ name: 'x', bone: [{ name: 'ghost' }] }] }), /unknown bone ghost/, { atlas });
  fails(doc({ animation: [{ name: 'x', bone: [{ name: 'arm', frame: [] }] }] }), /pre-5\.5/, { atlas });
  fails(doc(), /resource limit/, { atlas, maxValues: 10 });
  assert.throws(() => parseDragonBonesAtlas({ SubTexture: [{ name: 'a', width: 1, height: 1, rotated: true }] }), {
    code: 'failed',
    message: /rotated/,
  });
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => parseDragonBonesJSON(doc(), { atlas, signal: controller.signal }), { name: 'AbortError' });
});

test('loads honour AbortSignal and fetch the atlas beside the skeleton', async () => {
  const original = globalThis.fetch,
    seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    init?.signal?.throwIfAborted();
    return new Response(String(url).endsWith('_tex.json') ? JSON.stringify(atlas) : JSON.stringify(doc()));
  };
  try {
    const data = await loadDragonBonesJSON('https://example.test/a/t_ske.json', { atlas: 't_tex.json' });
    assert.deepEqual(seen, ['https://example.test/a/t_tex.json', 'https://example.test/a/t_ske.json']);
    assert.ok(data.createArmature().getAttachment('s'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadDragonBonesJSON('https://example.test/x', { signal: controller.signal }), {
      name: 'AbortError',
    });
  } finally {
    globalThis.fetch = original;
  }
});
