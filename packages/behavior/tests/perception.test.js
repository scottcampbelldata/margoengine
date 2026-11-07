// Perception: the sight shapes' edges, the detection timer, points in view, hearing, the memory's fade and prediction,
// what reaches the blackboard, a behaviour tree driven by it, and the occupancy map's equations and search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NavVolume } from '@margoengine/navmesh/volume';
import { BehaviorTree, Blackboard, action, condition, selector } from '../dist/index.js';
import {
  OccupancyMap,
  Perception,
  perceptionLevel,
  perceptionPosition,
  perceptionTarget,
  perceptionVisible,
  sphereOcclusion,
} from '../dist/perception.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const guard = () => ({ position: [0, 0, 0], forward: [0, 0, 1] });
const cone = (extra = {}) => ({ kind: 'cone', range: 10, fov: Math.PI / 2, nearTime: 1, farTime: 1, ...extra });
const run = (eyes, targets, seconds, step = 0.05) => {
  for (let time = 0; time < seconds - 1e-9; time += step) eyes.update(step, targets);
};

test('a cone sees inside its angle and range and nothing past either edge', () => {
  const eyes = new Perception(guard(), { sight: [cone()] });
  assert.equal(eyes.canSee([0, 0, 9.99]), true);
  assert.equal(eyes.canSee([0, 0, 10.01]), false);
  assert.equal(eyes.canSee([0, 0, -1]), false);
  // 45 degrees either side is the edge of a 90 degree cone.
  assert.equal(eyes.canSee([3.9, 0, 4]), true);
  assert.equal(eyes.canSee([4.1, 0, 4]), false);
  assert.equal(eyes.canSee([0, 4.1, 4]), false, 'the cone is round, so up counts as much as sideways');
  assert.equal(eyes.canSee([0, 0, 0]), true, 'its own position is in view');
});

test('a full circle cone sees behind the agent', () => {
  const eyes = new Perception(guard(), { sight: [cone({ fov: 2 * Math.PI })] });
  assert.equal(eyes.canSee([0, 0, -5]), true);
});

test('a coffin narrows past its shoulder, where a cone of the same opening goes on widening', () => {
  const box = new Perception(guard(), { sight: [{ kind: 'coffin', range: 30, shoulder: 10, width: 10 }] });
  // At the shoulder the half width is 5, the same as a cone through that point.
  const opening = 2 * Math.atan(5 / 10);
  const wide = new Perception(guard(), { sight: [{ kind: 'cone', range: 40, fov: opening }] });
  assert.equal(box.canSee([4.9, 0, 10]), true);
  assert.equal(box.canSee([5.1, 0, 10]), false);
  // Half way along the taper the half width is 2.5; the cone would allow 10 here.
  assert.equal(box.canSee([2.4, 0, 20]), true);
  assert.equal(box.canSee([2.6, 0, 20]), false);
  assert.equal(wide.canSee([2.6, 0, 20]), true);
  assert.equal(wide.canSee([9, 0, 20]), true);
  assert.equal(box.canSee([0, 0, -1]), false);
  assert.equal(box.canSee([0, 0, 30.5]), false);
});

test('the timer scales linearly with distance, and the quickest shape holding the target wins', () => {
  const timeToNotice = (distance, sight, target = {}) => {
    const eyes = new Perception(guard(), { sight });
    const step = 0.01;
    for (let time = step; time < 20; time += step) {
      eyes.update(step, [{ id: 't', position: [0, 0, distance], ...target }]);
      if (eyes.memory.get('t')?.level === 'aware') return time;
    }
    return Number.POSITIVE_INFINITY;
  };
  const sight = [cone({ nearTime: 0.5, farTime: 2.5 })];
  near(timeToNotice(0, sight), 0.5, 0.02);
  near(timeToNotice(5, sight), 1.5, 0.02);
  near(timeToNotice(10, sight), 2.5, 0.02);
  near(timeToNotice(5, sight, { visibility: 0.5 }), 3, 0.02);
  const two = [...sight, cone({ range: 6, nearTime: 0.1, farTime: 0.1 })];
  near(timeToNotice(5, two), 0.1, 0.02);
  near(timeToNotice(8, two), 2.1, 0.02);
  assert.equal(timeToNotice(11, two), Number.POSITIVE_INFINITY);
});

test('detection starts only with enough body points in view', () => {
  const wall = sphereOcclusion([{ position: [0, 0.2, 2.5], radius: 0.4 }]);
  const eyes = new Perception(guard(), { sight: [cone()], lineOfSight: wall });
  const body = [0, 0.5, 1, 1.5, 1.8].map((y) => [0, y, 5]);
  const inView = body.filter((at) => wall([0, 0, 0], at)).length;
  assert.ok(inView >= 1 && inView < body.length, `the sphere hides some of the points, not all (${inView} in view)`);
  const target = { id: 'in cover', position: [0, 1, 5], points: body };
  eyes.update(0.1, [{ ...target, pointsNeeded: inView + 1 }]);
  assert.equal(eyes.memory.size, 0);
  eyes.update(0.1, [{ ...target, pointsNeeded: inView }]);
  assert.equal(eyes.memory.get('in cover').visible, true);
});

test('sphereOcclusion blocks through a sphere, not beside it, and not from inside it', () => {
  const clear = sphereOcclusion([{ position: [0, 0, 5], radius: 1 }]);
  assert.equal(clear([0, 0, 0], [0, 0, 10]), false);
  assert.equal(clear([1.1, 0, 0], [1.1, 0, 10]), true);
  assert.equal(clear([0, 0, 0], [0, 0, 3]), true, 'the sphere is past the end of the line');
  assert.equal(clear([0, 0, 5], [0, 0, 10]), true);
  assert.equal(clear([0, 0, 0], [0, 0, 5]), true);
  assert.equal(clear([2, 2, 2], [2, 2, 2]), true);
});

test('a real NavVolume blocks sight through its wall', () => {
  // A wall across z = 5, from x -20 to 20 and y -20 to 20.
  const positions = [-20, -20, 5, 20, -20, 5, 20, 20, 5, -20, 20, 5];
  const volume = new NavVolume(positions, [0, 1, 2, 0, 2, 3], { voxelSize: 0.5, padding: 7 });
  const eyes = new Perception(guard(), { sight: [cone()], lineOfSight: (a, b) => volume.lineOfSight(a, b) });
  assert.equal(eyes.canSee([0, 0, 3]), true);
  assert.equal(eyes.canSee([0, 0, 7]), false);
});

test('hearing reaches the radius, scales per agent, and goes around walls', () => {
  const eyes = new Perception(guard(), { sight: [cone()] });
  assert.equal(eyes.hear({ position: [0, 0, -6.1], radius: 6 }), false);
  assert.equal(eyes.memory.size, 0);
  assert.equal(eyes.hear({ position: [0, 0, -5.9], radius: 6, priority: 0.6 }), true);
  const heard = eyes.memory.get('sound');
  assert.deepEqual([...heard.position], [0, 0, -5.9]);
  assert.equal(heard.level, 'suspicious');
  assert.equal(heard.sense, 'hearing');
  assert.equal(heard.visible, false);

  const deaf = new Perception(guard(), { hearing: 0.5 });
  assert.equal(deaf.hear({ position: [4, 0, 0], radius: 6 }), false);
  assert.equal(deaf.hear({ position: [2.9, 0, 0], radius: 6 }), true);

  // Ten metres apart in a straight line, thirty around the wall.
  const walled = new Perception(guard(), { soundDistance: (from, to) => Math.abs(from[0] - to[0]) * 3 });
  assert.equal(walled.hear({ position: [10, 0, 0], radius: 20 }), false);
  const unreachable = new Perception(guard(), { soundDistance: () => Number.POSITIVE_INFINITY });
  assert.equal(unreachable.hear({ position: [1, 0, 0], radius: 1e9 }), false);
});

test('a priority sound raises awareness, a quieter one never lowers it', () => {
  const eyes = new Perception(guard());
  eyes.hear({ position: [1, 0, 0], radius: 5, priority: 1, source: 'bang' });
  assert.equal(eyes.memory.get('bang').level, 'aware');
  eyes.hear({ position: [2, 0, 0], radius: 5, priority: 0.1, source: 'bang' });
  assert.equal(eyes.memory.get('bang').awareness, 1);
  assert.deepEqual([...eyes.memory.get('bang').position], [2, 0, 0]);
});

test('a sound does not move the memory of a target in plain view', () => {
  const eyes = new Perception(guard(), { sight: [cone()] });
  eyes.update(0.1, [{ id: 'p', position: [0, 0, 5] }]);
  eyes.hear({ position: [1, 0, -2], radius: 9, source: 'p' });
  assert.deepEqual([...eyes.memory.get('p').position], [0, 0, 5]);
  assert.equal(eyes.memory.get('p').sense, 'sight');
});

test('a memory keeps the last seen place, fades over forgetTime and is forgotten at zero', () => {
  const eyes = new Perception(guard(), { sight: [cone({ nearTime: 0.1, farTime: 0.1 })], forgetTime: 10 });
  run(eyes, [{ id: 'p', position: [0, 0, 5] }], 0.2);
  assert.equal(eyes.memory.get('p').level, 'aware');
  run(eyes, [], 2);
  const held = eyes.memory.get('p');
  assert.equal(held.visible, false);
  assert.deepEqual([...held.position], [0, 0, 5]);
  near(held.age, 2, 1e-6);
  near(held.awareness, 0.8, 1e-6);
  assert.equal(held.level, 'suspicious');
  run(eyes, [], 5);
  assert.equal(eyes.memory.get('p').level, 'calm');
  run(eyes, [], 3.1);
  assert.equal(eyes.memory.has('p'), false);
});

test('predict carries a target along its velocity, and no further than predictTime', () => {
  const eyes = new Perception(guard(), { sight: [cone()], predictTime: 1, forgetTime: 1000 });
  eyes.update(1, [{ id: 'p', position: [0, 0, 5], velocity: [2, 0, 0] }]);
  assert.deepEqual(eyes.predict('p'), [0, 0, 5]);
  eyes.update(0.5, []);
  assert.deepEqual(eyes.predict('p'), [1, 0, 5]);
  eyes.update(9, []);
  assert.deepEqual(eyes.predict('p'), [2, 0, 5]);
  assert.equal(eyes.predict('nobody'), null);
});

test('the blackboard follows the focus and is written only when something changed', () => {
  const blackboard = new Blackboard();
  const eyes = new Perception(guard(), { sight: [cone({ nearTime: 1, farTime: 1 })], blackboard, forgetTime: 10 });
  const player = { id: 'player', position: [0, 0, 5] };
  eyes.update(0.2, [player]);
  assert.equal(blackboard.get(perceptionTarget), null, 'not noticed below suspiciousAt');
  assert.equal(blackboard.get(perceptionLevel), 'calm');
  eyes.update(0.3, [player]);
  assert.equal(blackboard.get(perceptionTarget), 'player');
  assert.equal(blackboard.get(perceptionLevel), 'suspicious');
  assert.equal(blackboard.get(perceptionVisible), true);
  const position = blackboard.get(perceptionPosition);
  assert.deepEqual([...position], [0, 0, 5]);
  const { version } = blackboard;
  eyes.update(0.01, [player]);
  assert.equal(blackboard.version, version, 'an unchanged target writes nothing');
  assert.equal(blackboard.get(perceptionPosition), position);
  eyes.update(1, [player]);
  assert.equal(blackboard.get(perceptionLevel), 'aware');
  eyes.update(1, []);
  assert.equal(blackboard.get(perceptionVisible), false);
  assert.deepEqual([...blackboard.get(perceptionPosition)], [0, 0, 5], 'the last seen place stays');
  eyes.forget();
  assert.equal(blackboard.get(perceptionTarget), null);
  assert.equal(blackboard.get(perceptionPosition), null);
});

test('focus picks the highest awareness', () => {
  const eyes = new Perception(guard());
  assert.equal(eyes.focus(), null);
  eyes.hear({ position: [1, 0, 0], radius: 5, source: 'a', priority: 0.5 });
  eyes.hear({ position: [1, 0, 0], radius: 5, source: 'b', priority: 0.7 });
  assert.equal(eyes.focus().id, 'b');
  eyes.forget('b');
  assert.equal(eyes.focus().id, 'a');
});

test('a behaviour tree reads what perception wrote', () => {
  const blackboard = new Blackboard();
  const eyes = new Perception(guard(), { sight: [cone({ nearTime: 0.1, farTime: 0.1 })], blackboard });
  const log = [];
  const tree = new BehaviorTree(selector(condition('seen'), action('patrol')), {
    blackboard,
    handlers: {
      conditions: { seen: ({ blackboard: board }) => board.get(perceptionLevel) === 'aware' },
      actions: {
        patrol: () => {
          log.push('patrol');
          return 'success';
        },
      },
    },
  });
  tree.tick(0.1);
  run(eyes, [{ id: 'p', position: [0, 0, 5] }], 0.2);
  tree.tick(0.1);
  assert.deepEqual(log, ['patrol']);
});

test('the same calls give the same memory', () => {
  const play = () => {
    const eyes = new Perception(guard(), { sight: [cone({ nearTime: 0.3, farTime: 1.1 })] });
    for (let i = 0; i < 100; i++) eyes.update(0.03, i % 7 ? [{ id: 'p', position: [Math.sin(i), 0, 4] }] : []);
    return JSON.stringify([...eyes.memory.values()]);
  };
  assert.equal(play(), play());
});

test('malformed input is refused with a message that names the fix', () => {
  assert.throws(() => new Perception(null), TypeError);
  assert.throws(() => new Perception({ position: [0, 0, 0], forward: [0, 0, 0] }), /forward must not be zero/);
  assert.throws(() => new Perception({ position: [0, Number.NaN, 0], forward: [0, 0, 1] }), /Agent position/);
  assert.throws(() => new Perception(guard(), { sight: [{ kind: 'box', range: 1 }] }), /Unknown sight shape/);
  assert.throws(() => new Perception(guard(), { sight: [cone({ fov: 0 })] }), /fov/);
  assert.throws(
    () => new Perception(guard(), { sight: [{ kind: 'coffin', range: 5, shoulder: 6, width: 1 }] }),
    /shoulder/,
  );
  assert.throws(() => new Perception(guard(), { suspiciousAt: 1 }), /suspiciousAt/);
  const eyes = new Perception(guard());
  assert.throws(() => eyes.update(-1, []), /delta/);
  assert.throws(() => eyes.update(0.1, [{ id: 'p', position: [0] }]), /Target position/);
  assert.throws(() => eyes.update(0.1, [{ id: 'p', position: [0, 0, 1], visibility: 0 }]), /visibility/);
  assert.throws(() => eyes.update(0.1, [{ id: 'p', position: [0, 0, 1], pointsNeeded: 0 }]), /pointsNeeded/);
  assert.throws(() => eyes.hear({ position: [0, 0, 0], radius: 1, priority: 2 }), /priority/);
  assert.throws(() => eyes.hear({ position: [0, 0, 0], radius: -1 }), /radius/);
});

const sum = (map) => map.probability.reduce((a, b) => a + b, 0);

test('observe pins the map and reports how surprising the place was (equation 1.8)', () => {
  const map = OccupancyMap.grid({ min: [0, 0], size: [5, 1], cell: 1, diffusion: 0.5 });
  assert.equal(map.best(), null);
  assert.equal(map.observe([2.5, 0, 0.5]), 0, 'nothing was expected yet');
  assert.deepEqual(map.best(), [2.5, 0, 0.5]);
  map.diffuse();
  // 0.5 stays, 0.25 goes each way.
  assert.deepEqual([...map.probability], [0, 0.25, 0.5, 0.25, 0]);
  assert.equal(map.observe([1.5, 0, 0.5]), (0.5 - 0.25) / 0.25);
  map.diffuse();
  assert.equal(map.observe([4.5, 0, 0.5]), Number.POSITIVE_INFINITY, 'that node held no chance at all');
});

test('diffuse keeps the total, at walls too', () => {
  const map = OccupancyMap.grid({ min: [0, 0], size: [6, 6], cell: 1, diffusion: 0.8 });
  map.observe([0.5, 0, 0.5]);
  for (let i = 0; i < 40; i++) map.diffuse();
  near(sum(map), 1);
  const lone = new OccupancyMap([0, 0, 0], [[]]);
  lone.observe([0, 0, 0]);
  lone.diffuse();
  assert.deepEqual([...lone.probability], [1]);
});

test('velocity pushes the spread its way (equation 1.4), with rates scaled back to 1', () => {
  const map = OccupancyMap.grid({ min: [0, 0], size: [5, 1], cell: 1, diffusion: 0.2 });
  map.observe([2.5, 0, 0.5]);
  map.diffuse([0.3, 0, 0]);
  near(map.probability[1], 0.1);
  near(map.probability[3], 0.1 + 0.3);
  near(map.probability[2], 0.5);
  map.observe([2.5, 0, 0.5]);
  map.diffuse([5, 0, 0]);
  near(sum(map), 1);
  near(map.probability[2], 0, 1e-12);
  near(map.probability[3] / map.probability[1], 5.1 / 0.1);
});

test('cull zeroes what was seen empty, renormalizes the rest and returns the share removed', () => {
  const map = OccupancyMap.grid({ min: [0, 0], size: [5, 1], cell: 1, diffusion: 0.5 });
  map.observe([2.5, 0, 0.5]);
  map.diffuse();
  near(
    map.cull((at) => at[0] < 2),
    0.25,
  );
  near(map.probability[2], 2 / 3);
  near(map.probability[3], 1 / 3);
  near(sum(map), 1);
  near(
    map.cull(() => true),
    1,
  );
  assert.equal(map.best(), null);
  assert.equal(
    map.cull(() => true),
    0,
  );
});

test('searching behind two pillars: looking clears the open floor, then one hiding place, then the other', () => {
  const pillars = [
    { position: [3, 0, 5], radius: 1.2 },
    { position: [9, 0, 5], radius: 1.2 },
  ];
  const inPillar = (at) => pillars.some((p) => Math.hypot(at[0] - p.position[0], at[2] - p.position[2]) < p.radius);
  const map = OccupancyMap.grid({ min: [0, 0], size: [12, 12], cell: 1, diffusion: 0.4, blocked: inPillar });
  map.observe([6, 0, 6]);
  for (let i = 0; i < 30; i++) map.diffuse();
  const eyes = new Perception(
    { position: [6, 0, 0], forward: [0, 0, 1] },
    { sight: [{ kind: 'cone', range: 30, fov: 2 * Math.PI }], lineOfSight: sphereOcclusion(pillars) },
  );
  const culled = map.cull((at) => eyes.canSee(at));
  assert.ok(culled > 0.5, 'most of the room was in view');
  const first = map.best();
  assert.ok(!eyes.canSee(first), 'the best guess is out of sight');
  assert.ok(first[2] > 5, 'behind a pillar');
  // Walk to the first guess and look around it: the other hiding place is what is left.
  map.cull((at) => Math.hypot(at[0] - first[0], at[2] - first[2]) < 4);
  const second = map.best();
  assert.ok(second != null);
  assert.notEqual(Math.sign(second[0] - 6), Math.sign(first[0] - 6), 'the search moved to the other pillar');
});

test('probability cannot cross a wall of blocked cells', () => {
  const map = OccupancyMap.grid({
    min: [0, 0],
    size: [7, 3],
    cell: 1,
    diffusion: 0.5,
    blocked: (at) => at[0] > 3 && at[0] < 4,
  });
  map.observe([1.5, 0, 1.5]);
  for (let i = 0; i < 100; i++) map.diffuse();
  for (let node = 0; node < map.probability.length; node++)
    if (map.positions[node * 3] > 4) assert.equal(map.probability[node], 0);
});

test('malformed occupancy maps are refused', () => {
  assert.throws(() => new OccupancyMap([0, 0], [[]]), /three numbers/);
  assert.throws(() => new OccupancyMap([0, 0, 0], []), /one array per node/);
  assert.throws(() => new OccupancyMap([0, 0, 0], [[3]]), /node numbers below 1/);
  assert.throws(() => new OccupancyMap([0, 0, 0], [[]], { diffusion: 2 }), /diffusion/);
  assert.throws(() => OccupancyMap.grid({ min: [0, 0], size: [0, 1], cell: 1 }), /size/);
  assert.throws(() => OccupancyMap.grid({ min: [0, 0], size: [1, 1], cell: 0 }), /cell/);
  assert.throws(
    () => OccupancyMap.grid({ min: [0, 0], size: [1, 1], cell: 1, blocked: () => true }),
    /at least one node/,
  );
});
