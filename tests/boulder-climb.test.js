// The Boulder demo's plain logic in Node: the tier table, the wall and its routes, the rig's numbers against the shipped
// GLB, hold picking, and Climb's moves, reaches, falls and gaze. scripts/test-boulder-browser.mjs runs the same demo on a
// real GPU with the solver and the bones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLTFAsset } from '@margoengine/gltf-pro';
import {
  Climb,
  contactPoint,
  legReach,
  matFoot,
  MAX_LEG_REACH,
  MIN_ARM_REACH,
  MIN_LEG_REACH,
  newFrame,
  newPelvis,
  place,
  REACH_TOLERANCE,
  solvePelvis,
} from '../examples/boulder/climb.ts';
import { CHARACTER, measureRig, RIG } from '../examples/boulder/rig.ts';
import { TIERS } from '../examples/boulder/tiers.ts';
import { buildWall, LEFT_FOOT, MAT_TOP, pickHold, RIGHT_FOOT, wallAt, WALL_LENGTH } from '../examples/boulder/wall.ts';

const { holds, routes } = buildWall(),
  route = (name) => routes.find((r) => r.name === name);

/** The positions of a route's stance after `moves` moves. */
function stance(r, moves) {
  const at = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    on = [r.start[0], r.start[1], -1, -1];
  contactPoint(0, holds[r.start[0]], at[0]);
  contactPoint(1, holds[r.start[1]], at[1]);
  const x = (at[0][0] + at[1][0]) / 2;
  matFoot(LEFT_FOOT, x, MAT_TOP, at[2]);
  matFoot(RIGHT_FOOT, x, MAT_TOP, at[3]);
  for (let i = 0; i < moves; i++) {
    const m = r.moves[i];
    on[m.limb] = m.hold;
    contactPoint(m.limb, holds[m.hold], at[m.limb]);
  }
  return { on, at };
}

/** A climber standing on a route's first stance, or part way up it. */
function climbAt(name, moves = 0) {
  const climb = new Climb(holds),
    s = stance(route(name), moves);
  climb.teleport(s.on, s.at);
  return climb;
}

function settleMove(climb) {
  for (let i = 0; i < 2000 && climb.moving >= 0; i++) climb.update(1 / 60);
}

test('each tier asks for less than the one above it, and the phone stays cheap', () => {
  assert.deepEqual(Object.keys(TIERS).sort(), ['high', 'light', 'phone']);
  assert.ok(TIERS.high.shadow.resolution > TIERS.light.shadow.resolution);
  assert.ok(TIERS.light.shadow.resolution > TIERS.phone.shadow.resolution);
  assert.equal(TIERS.high.ssao, true);
  assert.equal(TIERS.light.ssao, false);
  assert.equal(TIERS.phone.ssao, false);
  assert.equal(TIERS.phone.bloom, false);
  assert.equal(TIERS.phone.probeLive, false);
  assert.ok(TIERS.phone.chalkCapacity < TIERS.high.chalkCapacity);
});

test('the wall is the same on every load, inside its own length', () => {
  assert.deepEqual(buildWall(), buildWall());
  assert.deepEqual(routes.map((r) => r.name).sort(), ['blue', 'green', 'red']);
  for (const hold of holds) {
    assert.ok(hold.s >= 0 && hold.s <= WALL_LENGTH);
    assert.ok(Math.abs(Math.hypot(...hold.normal) - 1) < 1e-9);
  }
});

test('every stance of every route is reachable, with the body under the hands', () => {
  for (const r of routes)
    for (let moves = 0; moves <= r.moves.length; moves++) {
      const { at } = stance(r, moves),
        plan = solvePelvis(at, [true, true, true, true], newPelvis());
      assert.ok(plan.error < REACH_TOLERANCE, `${r.name} after ${moves} moves misses by ${plan.error}`);
      // Regression: with no room left, the arms' minimum reach used to slide the pelvis up to 0.25 m sideways, and the
      // arm on that side then crossed the head.
      const middle = (at[0][0] + at[1][0]) / 2;
      assert.ok(Math.abs(plan.position[0] - middle) < 0.06, `${r.name} after ${moves} moves: pelvis off to the side`);
      for (const limb of [LEFT_FOOT, RIGHT_FOOT]) {
        const reach = legReach(plan.frame, plan.position, limb, at[limb]);
        assert.ok(reach > MIN_LEG_REACH - REACH_TOLERANCE && reach < MAX_LEG_REACH + REACH_TOLERANCE);
      }
    }
});

test('a hand hold sits outside its shoulder, so a straight arm passes beside the head', () => {
  for (const r of routes)
    for (const move of r.moves.filter((m) => m.limb < 2)) {
      const shoulder = RIG.roots[move.limb][0],
        { at } = stance(r, r.moves.indexOf(move) + 1),
        middle = (at[0][0] + at[1][0]) / 2;
      assert.ok(Math.abs(at[move.limb][0] - middle) >= Math.abs(shoulder) - 0.05, `${r.name} hold ${move.hold}`);
    }
});

test('RIG holds the shipped GLB, both arms are equal, and measureRig reads any file', () => {
  const bytes = readFileSync(new URL('../examples/assets/boulder-robot.glb', import.meta.url)),
    jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)),
    asset = new GLTFAsset(doc, [bytes.subarray(20 + jsonLength + 8)]);
  return asset.decode().then(() => {
    const skin = doc.skins[0],
      names = skin.joints.map((j) => doc.nodes[j].name),
      ibm = asset.accessor(skin.inverseBindMatrices),
      before = structuredClone(RIG);
    for (const limb of CHARACTER.bones.limbs) for (const bone of limb) assert.ok(names.includes(bone), bone);
    measureRig(names, ibm);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `${a} and ${b}`);
    for (let i = 0; i < 4; i++) {
      near(RIG.upper[i], before.upper[i]);
      near(RIG.lower[i], before.lower[i]);
      for (let a = 0; a < 3; a++) near(RIG.roots[i][a], before.roots[i][a]);
    }
    for (let a = 0; a < 3; a++) near(RIG.head[a], before.head[a]);
    near(RIG.upper[0], RIG.upper[1]);
    near(RIG.lower[0], RIG.lower[1]);
    // A different file gives different numbers: the demo must not depend on the old lengths.
    const longer = Float32Array.from(ibm);
    longer[names.indexOf('Hand') * 16 + 13] += 0.1;
    measureRig(names, longer);
    assert.ok(Math.abs(RIG.lower[0] - before.lower[0]) > 0.01);
    measureRig(names, ibm);
    assert.throws(() => measureRig(['Nope'], ibm), /no bone named/);
  });
});

test('pickHold finds the hold under a ray, the nearest to the ray, and misses open wall', () => {
  const hold = holds[10],
    [x, y, z] = hold.position;
  assert.equal(pickHold(holds, x, y, z + 2, 0, 0, -1, 0.01), 10);
  assert.equal(pickHold(holds, x, y, z + 2, 0, 0, 1, 0.01), -1, 'pointing away');
  assert.equal(pickHold([hold], x + 1, y, z + 2, 0, 0, -1, 0.01), -1);
});

test('a move plants the limb on the hold and reports contact', () => {
  const climb = climbAt('blue'),
    r = route('blue'),
    { limb, hold } = r.moves[0],
    events = [];
  climb.onEvent = (event, which) => events.push([event, which]);
  assert.equal(climb.move(limb, hold), true);
  assert.equal(climb.move(limb, hold), false, 'busy while moving');
  settleMove(climb);
  assert.deepEqual(events, [['contact', limb]]);
  assert.equal(climb.on[limb], hold);
  const wanted = contactPoint(limb, holds[hold], [0, 0, 0]);
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(climb.targets[limb][a] - wanted[a]) < 1e-6);
});

test('a hold out of reach comes back short and leaves the stance as it was', () => {
  const climb = climbAt('blue'),
    far = holds.reduce((best, h, i) => (h.position[1] > holds[best].position[1] ? i : best), 0),
    before = climb.on.join(),
    contact = [...climb.contacts[0]],
    events = [];
  climb.onEvent = (event) => events.push(event);
  climb.move(0, far);
  settleMove(climb);
  assert.deepEqual(events, ['short']);
  assert.equal(climb.on.join(), before);
  assert.deepEqual([...climb.contacts[0]], contact);
});

test('a fall lands on the mat with free arms, then a route starts from the feet', () => {
  const climb = climbAt('blue', 8);
  let landed = 0;
  climb.onEvent = (event) => {
    if (event === 'landed') landed++;
  };
  climb.fall(MAT_TOP);
  for (let i = 0; i < 600 && climb.falling; i++) climb.update(1 / 60);
  assert.equal(landed, 1);
  assert.deepEqual(climb.on, [-1, -1, -1, -1]);
  assert.deepEqual(climb.bound, [false, false, true, true]);
  for (let i = 0; i < 120; i++) climb.update(1 / 60);
  assert.ok(climb.pelvis[1] < 1.1);
  const { at } = stance(route('blue'), 0);
  climb.settle(at);
  assert.deepEqual(climb.bound, [false, false, true, true], 'the hands take their holds as moves of their own');
});

// Regression: a free hand's contact stays where it last held on, up to 2.4 m away on another route, and the torso leant
// toward it as it walked across the mat, which drove the arm into the chest.
test('a free hand does not lean the torso', () => {
  const near = (x) => {
    const c = [
      [x, 3, 0],
      [x, 3, 0],
      [-0.14, 0.27, 0.42],
      [0.14, 0.27, 0.42],
    ];
    return solvePelvis(c, [false, false, true, true], newPelvis()).frame.up[0];
  };
  assert.ok(Math.abs(near(0)) < 1e-9);
  assert.equal(near(2.4), near(0));
});

// Regression: a free arm's move started from the contact it last held, so the hand jumped across the wall.
test('a free arm leaves from where it hangs', () => {
  const climb = climbAt('blue', 8);
  climb.fall(MAT_TOP);
  for (let i = 0; i < 600 && climb.falling; i++) climb.update(1 / 60);
  const hang = [0.3, 0.6, 0.5];
  for (let a = 0; a < 3; a++) climb.targets[0][a] = hang[a];
  climb.settle(stance(route('blue'), 0).at);
  climb.move(0, route('blue').start[0]);
  climb.update(1e-4);
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(climb.targets[0][a] - hang[a]) < 0.01, `axis ${a}`);
});

// Regression: damping the look point pulled it past the face on the way from a foot hold to a hand hold, and the head
// whipped round into the arm as it went by.
test('the gaze turns as a direction, a metre from the face, at a bounded rate', () => {
  const climb = climbAt('blue', 7),
    r = route('blue'),
    face = [0, 0, 0],
    localFace = () => [RIG.head[0], RIG.head[1] + CHARACTER.faceAbove, RIG.head[2]];
  climb.move(LEFT_FOOT, r.moves[6].hold);
  settleMove(climb);
  for (let i = 0; i < 60; i++) climb.update(1 / 60);
  const down = r.moves.find((m) => m.limb === 0 && m.hold > 0).hold;
  climb.moving = -1;
  climb.lookAt(...holds[down].position);
  let last = null,
    fastest = 0;
  for (let i = 0; i < 120; i++) {
    climb.update(1 / 60);
    place(climb.frame, localFace(), climb.pelvis, face);
    const d = [climb.look[0] - face[0], climb.look[1] - face[1], climb.look[2] - face[2]];
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-6, 'one metre from the face');
    if (last) fastest = Math.max(fastest, Math.hypot(d[0] - last[0], d[1] - last[1], d[2] - last[2]) * 60);
    last = d;
  }
  assert.ok(fastest < 4.5, `the gaze swept at ${fastest} rad/s`);
});

test('the torso frame stays square, and the wall normal is unit', () => {
  const n = [0, 0, 0];
  for (const y of [0, 1, 1.75, 2.5, 3.25, 4]) {
    wallAt(y, n);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9);
  }
  const f = newFrame();
  assert.deepEqual(
    [[...f.right], [...f.up], [...f.back]],
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  );
  assert.ok(MIN_ARM_REACH < RIG.upper[0] + RIG.lower[0]);
});

// V8 can widen a plain array to hold tagged values, and then each number written to it is boxed: 15 a frame, when the
// torso frame's arrays went that way. Whether it happens depends on when code is optimized, so this holds both ends.
test('what a frame of Climb writes lives in typed arrays', () => {
  const climb = climbAt('blue', 4),
    { right, up, back } = climb.frame,
    written = [climb.pelvis, climb.look, right, up, back, ...climb.targets, ...climb.contacts, ...climb.handNormals];
  written.push(newPelvis().position);
  for (const v of written) assert.ok(v instanceof Float64Array);
});

test('a frame of Climb allocates nothing when V8 optimizes on the main thread', { skip: !!process.env.CLIMB_NESTED }, () => {
  const run = spawnSync(
    process.execPath,
    ['--no-concurrent-recompilation', '--experimental-test-module-mocks', fileURLToPath(import.meta.url)],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CLIMB_NESTED: '1' } },
  );
  assert.equal(run.status, 0, run.stdout.slice(-2000));
});

test('the plaque carries the dedication', () => {
  const gym = readFileSync(new URL('../examples/boulder/gym.ts', import.meta.url), 'utf8'),
    main = readFileSync(new URL('../examples/boulder/main.ts', import.meta.url), 'utf8');
  assert.match(gym, /EGG = 'Margo engine ❤️ made for Margie'/);
  assert.match(main, /say\(EGG\)/);
});

test('a frame of Climb allocates nothing', () => {
  const climb = climbAt('blue', 4),
    r = route('blue');
  climb.move(r.moves[4].limb, r.moves[4].hold);
  const windows = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    globalThis.gc?.();
    for (let i = 0; i < 200; i++) climb.update(1 / 600);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20_000; i++) climb.update(1 / 600000);
    const grown = process.memoryUsage().heapUsed - before;
    windows.push(grown);
    // A frame allocating 16 bytes would fill 320 KB here.
    if (grown >= 0 && grown < 64_000) return;
  }
  assert.fail(`every window of 20,000 frames allocated: ${JSON.stringify(windows)}`);
});
