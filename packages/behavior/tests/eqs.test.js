// Environment queries: the chapter's criteria and worked numbers, fallbacks, and that the late evaluation gives the
// answer full evaluation gives while calling expensive criteria less.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '@margoengine/math/mathutils';
import { NavMesh } from '@margoengine/navmesh';
import {
  coverFrom,
  directness,
  distance,
  explainQuery,
  gridAround,
  queryPoints,
  reachBefore,
  ringsAround,
  visibleFrom,
} from '../dist/eqs.js';
import { sphereOcclusion } from '../dist/perception.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const at = (...positions) => positions.map((position) => ({ position }));

test('directness: the chapter example scores 0.5', () => {
  const goal = [50, 0, 0];
  // 10 m from the agent and 45 m from the goal.
  const x = (50 * 50 + 10 * 10 - 45 * 45) / (2 * 50);
  const point = [x, 0, Math.sqrt(100 - x * x)];
  near(directness([0, 0, 0], goal).value({ position: point }), 0.5);
  near(directness([0, 0, 0], goal).value({ position: [10, 0, 0] }), 1);
  near(directness([0, 0, 0], goal).value({ position: [-10, 0, 0] }), -1);
  assert.equal(directness([0, 0, 0], goal).value({ position: [0, 0, 0] }), 0);
});

test('a flanking query keeps moves that make no progress either way', () => {
  const me = [0, 0, 0];
  const enemy = [20, 0, 0];
  const [best] = queryPoints([
    {
      candidates: at([10, 0, 0], [-10, 0, 0], [0, 0, 10], [0, 0, 4], [5, 0, 5]),
      conditions: [{ test: directness(me, enemy), min: -0.1, max: 0.1 }],
      weights: [{ test: distance(me), weight: -1 }],
    },
  ]);
  assert.deepEqual(best.position, [0, 0, 4], 'sideways and the nearest of those');
});

test('weights scale by their limits and clamp, so a far point cannot swamp the rest', () => {
  const me = [0, 0, 0];
  const [best] = queryPoints([{ candidates: at([15, 0, 0]), weights: [{ test: distance(me, 30), weight: 2 }] }]);
  near(best.score, 1);
  const [far] = queryPoints([{ candidates: at([900, 0, 0]), weights: [{ test: distance(me, 30), weight: 2 }] }]);
  near(far.score, 2);
  // Conditions see the raw value, not the scaled one.
  assert.equal(
    queryPoints([{ candidates: at([900, 0, 0]), conditions: [{ test: distance(me, 30), max: 100 }] }]).length,
    0,
  );
});

test('the highest or least negative score wins, and a tie goes to the first collected', () => {
  const me = [0, 0, 0];
  const [best] = queryPoints([
    { candidates: at([5, 0, 0], [3, 0, 0], [3, 0, 0.0], [9, 0, 0]), weights: [{ test: distance(me), weight: -1 }] },
  ]);
  assert.deepEqual(best.position, [3, 0, 0]);
  const results = queryPoints(
    [
      {
        candidates: [
          { position: [1, 0, 0], data: 'a' },
          { position: [2, 0, 0], data: 'b' },
        ],
      },
    ],
    {
      count: 2,
    },
  );
  assert.deepEqual(
    results.map((result) => result.data),
    ['a', 'b'],
  );
});

test('fallback options run in order, and every option failing gives an empty list', () => {
  const me = [0, 0, 0];
  const none = { candidates: at([1, 0, 0]), conditions: [{ test: distance(me), min: 5 }] };
  const some = { candidates: at([6, 0, 0]) };
  const [found] = queryPoints([none, some]);
  assert.equal(found.option, 1);
  assert.deepEqual(queryPoints([none]), []);
  assert.deepEqual(queryPoints([]), []);
});

test('reachBefore throws out a spot the rival gets to first', () => {
  const test1 = reachBefore([0, 0, 0], [10, 0, 0]);
  assert.equal(test1.value({ position: [4, 0, 0] }), 1);
  assert.equal(test1.value({ position: [6, 0, 0] }), 0);
  assert.equal(test1.value({ position: [5, 0, 0] }), 0, 'a dead heat is not first');
});

test('coverFrom accepts a spot only when its cover faces the threat', () => {
  const threat = [10, 0, 0];
  const cover = coverFrom(threat);
  assert.equal(cover.value({ position: [0, 0, 0], facing: [1, 0, 0] }), 1);
  assert.equal(cover.value({ position: [0, 0, 0], facing: [1, 0, 0.9] }), 1, 'inside 45 degrees');
  assert.equal(cover.value({ position: [0, 0, 0], facing: [1, 0, 1.1] }), 0, 'outside 45 degrees');
  assert.equal(cover.value({ position: [0, 0, 0], facing: [-1, 0, 0] }), 0);
  assert.equal(cover.value({ position: [0, 0, 0] }), 0, 'a point in the open gives no cover');
});

test('a hide query finds the far side of a pillar from the threat, using a real line of sight', () => {
  const pillar = { position: [5, 0, 0], radius: 1 };
  const los = sphereOcclusion([pillar]);
  const threat = [0, 0, 0];
  const me = [6, 0, 6];
  const [spot] = queryPoints([
    {
      candidates: gridAround(me, 10, 1),
      conditions: [{ test: visibleFrom(threat, los), max: 0 }],
      weights: [{ test: distance(me), weight: -1 }],
    },
  ]);
  assert.equal(los(threat, spot.position), false);
  assert.ok(spot.position[0] > 5, 'the far side from the threat');
});

test('generators make the points they promise and read the centre on every run', () => {
  const center = [1, 2, 3];
  const grid = gridAround(center, 2, 1);
  assert.equal(grid().length, 25);
  assert.deepEqual(grid()[0].position, [-1, 2, 1]);
  center[0] = 11;
  assert.deepEqual(grid()[0].position, [9, 2, 1]);
  const rings = ringsAround([0, 0, 0], 6, 2, 4)();
  assert.equal(rings.length, 8);
  near(Math.hypot(...rings[0].position), 3);
  near(Math.hypot(...rings[7].position), 6);
});

test('a custom expensive criterion over a real navmesh route picks the shorter walk, not the nearer point', () => {
  // A U-shaped floor: the right arm is close in a straight line and long to walk to.
  const vertices = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 8],
    [0, 0, 8],
    [2, 0, 10],
    [0, 0, 10],
    [6, 0, 8],
    [6, 0, 10],
    [8, 0, 8],
    [8, 0, 10],
    [6, 0, 0],
    [8, 0, 0],
  ];
  const mesh = new NavMesh(vertices, [
    [0, 1, 2, 3],
    [3, 2, 4, 5],
    [2, 6, 7, 4],
    [6, 8, 9, 7],
    [10, 11, 8, 6],
  ]);
  const start = [1, 0, 1];
  const route = {
    expensive: true,
    limits: [0, 40],
    value: ({ position }) => {
      const path = mesh.path(start, position);
      let length = 0;
      for (let i = 1; i < path.length; i++)
        length += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]);
      return length;
    },
  };
  const [walk] = queryPoints([{ candidates: at([7, 0, 1], [1, 0, 9]), weights: [{ test: route, weight: -1 }] }]);
  assert.deepEqual(walk.position, [1, 0, 9]);
  const [straight] = queryPoints([
    { candidates: at([7, 0, 1], [1, 0, 9]), weights: [{ test: distance(start), weight: -1 }] },
  ]);
  assert.deepEqual(straight.position, [7, 0, 1]);
});

const expensiveCount = (fn, counter) => ({
  expensive: true,
  value: (candidate) => {
    counter.calls++;
    return fn(candidate);
  },
});
const fullBest = (option) => {
  const list = explainQuery(option).filter((entry) => entry.failed < 0);
  return list[0] ?? null;
};

test('property: the late evaluation returns the score and ordering of full evaluation, on 300 random queries', () => {
  const random = createRandom(94);
  for (let round = 0; round < 300; round++) {
    const candidates = Array.from({ length: 1 + Math.floor(random() * 40) }, () => ({
      position: [random() * 40 - 20, 0, random() * 40 - 20],
    }));
    const seed = random() * 1000;
    const noise = (salt) => (c) => Math.abs(Math.sin(c.position[0] * 12.9 + c.position[2] * 78.2 + seed + salt));
    const option = {
      candidates,
      conditions: [
        { test: distance([0, 0, 0]), min: random() * 5 },
        { test: { expensive: true, value: noise(1) }, min: random() * 0.5 },
      ],
      weights: [
        { test: distance([3, 0, 3]), weight: random() * 4 - 2 },
        { test: { expensive: true, value: noise(2) }, weight: random() * 4 - 2 },
        { test: { expensive: true, value: noise(3) }, weight: random() * 4 - 2 },
      ],
    };
    const [late] = queryPoints([option]);
    const full = fullBest(option);
    assert.equal(late === undefined, full === null);
    if (late) near(late.score, full.score, 1e-9);
    const all = queryPoints([option], { count: 1000 });
    const expected = explainQuery(option).filter((entry) => entry.failed < 0);
    assert.equal(all.length, expected.length);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].score >= all[i].score);
    for (let i = 0; i < all.length; i++) near(all[i].score, expected[i].score, 1e-9);
  }
});

test('expensive criteria run only where they can change the answer', () => {
  const candidates = Array.from({ length: 200 }, (_, i) => ({ position: [i, 0, 0] }));
  const counter = { calls: 0 };
  const [best] = queryPoints([
    {
      candidates,
      conditions: [{ test: expensiveCount(() => 1, counter), min: 1 }],
      weights: [{ test: distance([0, 0, 0], 200), weight: -1 }],
    },
  ]);
  assert.deepEqual(best.position, [0, 0, 0]);
  assert.equal(counter.calls, 1, 'the best point passed, so nothing else was tested');

  // A cheap weight of 1 and an expensive weight of 0.25: only points within 0.25 of the top need the second.
  const weighted = { calls: 0 };
  queryPoints([
    {
      candidates,
      weights: [
        { test: distance([0, 0, 0], 200), weight: -1 },
        { test: expensiveCount(() => 0.5, weighted), weight: 0.25 },
      ],
    },
  ]);
  // Point i has an upper bound of 0.25 - i/200 and the winner scores 0.125, so i must be below 25.
  assert.ok(weighted.calls <= 26, `${weighted.calls} calls`);
  assert.ok(weighted.calls >= 1);

  const cheap = { calls: 0 };
  queryPoints([
    {
      candidates,
      conditions: [
        { test: distance([0, 0, 0]), max: 3 },
        { test: expensiveCount(() => 0, cheap), min: 1 },
      ],
    },
  ]);
  assert.equal(cheap.calls, 4, 'cheap conditions ran first; the expensive one saw only the four left');
});

test('explainQuery shows every candidate, with the condition that failed it', () => {
  const me = [0, 0, 0];
  const list = explainQuery({
    candidates: at([1, 0, 0], [2, 0, 0], [8, 0, 0]),
    conditions: [{ test: distance(me), max: 5 }],
    weights: [{ test: distance(me), weight: 1 }],
  });
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((entry) => entry.failed),
    [-1, -1, 0],
  );
  assert.deepEqual(list[0].position, [2, 0, 0]);
});

test('the same query gives the same answer', () => {
  const run = () =>
    queryPoints(
      [
        {
          candidates: ringsAround([0, 0, 0], 12),
          conditions: [{ test: visibleFrom([4, 0, 0], sphereOcclusion([{ position: [2, 0, 1], radius: 1 }])), min: 1 }],
          weights: [{ test: directness([0, 0, 0], [20, 0, 5]), weight: 1 }],
        },
      ],
      { count: 5 },
    );
  assert.deepEqual(run(), run());
});

test('malformed queries are refused with a message that names the fix', () => {
  const me = [0, 0, 0];
  assert.throws(() => queryPoints('x'), /array of options/);
  assert.throws(() => queryPoints([{}]), /candidates/);
  assert.throws(() => queryPoints([{ candidates: [], conditions: [{ min: 1 }] }]), /criterion in test/);
  assert.throws(() => queryPoints([{ candidates: [], conditions: [{ test: distance(me) }] }]), /min, max or both/);
  assert.throws(() => queryPoints([{ candidates: [], weights: [{ weight: 1 }] }]), /criterion in test/);
  assert.throws(
    () => queryPoints([{ candidates: [], weights: [{ test: distance(me), weight: Number.NaN }] }]),
    /finite/,
  );
  assert.throws(
    () => queryPoints([{ candidates: [], weights: [{ test: { limits: [1, 1], value: () => 0 }, weight: 1 }] }]),
    /low below high/,
  );
  assert.throws(() => queryPoints([{ candidates: at([0, 0]) }]), /Candidate position/);
  assert.throws(() => queryPoints([], { count: 0 }), /count/);
  assert.throws(
    () => queryPoints([{ candidates: at([0, 0, 0]), conditions: [{ test: { value: () => Number.NaN }, min: 0 }] }]),
    /finite number/,
  );
  assert.throws(() => gridAround(me, 1, 0), /spacing/);
  assert.throws(() => ringsAround(me, 1, 0), /whole numbers/);
  assert.throws(() => visibleFrom(me, null), /function/);
  assert.throws(() => coverFrom(me, 0), /halfAngle/);
  assert.throws(() => distance(me, 0), /limit/);
});
