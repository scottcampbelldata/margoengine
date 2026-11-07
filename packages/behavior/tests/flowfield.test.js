// Flow fields: the eikonal distances, walls and costs, the line of sight flags against an exact test, cost stamps,
// several goals, and thousands of units reaching one goal on one field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '@margoengine/math/mathutils';
import { FlowField, WALL } from '../dist/flowfield.js';

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const at = (field, x, z) => field.integration[z * field.width + x];

test('integration is close to the true distance in every direction, with no diamond', () => {
  const field = new FlowField({ size: [101, 101] });
  field.setGoal([50.5, 0, 50.5]);
  let worst = 0;
  for (let z = 0; z < 101; z++)
    for (let x = 0; x < 101; x++) {
      const truth = Math.hypot(x - 50, z - 50);
      if (truth > 5) worst = Math.max(worst, Math.abs(at(field, x, z) - truth) / truth);
    }
  near(at(field, 90, 50), 40);
  // First order fast marching overshoots most on the diagonal near the goal: (2 + sqrt 2) / 2 against sqrt 2 is 21% one
  // cell out, and the overshoot grows far slower than the distance. Four-neighbour steps would read 41% everywhere there.
  assert.ok(worst < 0.11, `worst relative error ${worst}`);
  let far = 0;
  for (let z = 0; z < 101; z++)
    for (let x = 0; x < 101; x++) {
      const truth = Math.hypot(x - 50, z - 50);
      if (truth > 40) far = Math.max(far, Math.abs(at(field, x, z) - truth) / truth);
    }
  assert.ok(far < 0.03, `worst relative error past 40 cells ${far}`);
});

test('a unit goes around a wall through the gap, and the route length matches the corner route', () => {
  const field = new FlowField({ size: [40, 40], cost: (x, z) => (x > 20 && x < 21 && z > 5 ? WALL : 1) });
  field.setGoal([35.5, 0, 35.5]);
  assert.equal(field.reachable([5, 0, 35]), true);
  const units = { x: [5.5], z: [35.5] };
  let steps = 0;
  while (field.steer(units, 1, 4, 0.05) > 0 && steps < 2000) {
    steps++;
    assert.notEqual(field.cost[field.cellAt([units.x[0], 0, units.z[0]])], WALL);
  }
  assert.ok(Math.hypot(units.x[0] - 35.5, units.z[0] - 35.5) < 0.5, 'reached the goal');
  const shortest = Math.hypot(15, 30) + Math.hypot(15, 30);
  const walked = steps * 0.2;
  assert.ok(walked >= shortest - 0.5, `${walked} cannot beat ${shortest}`);
  assert.ok(walked < shortest * 1.2, `${walked} against ${shortest}`);
});

test('dear ground is walked around when the way round is cheaper, and crossed when it is not', () => {
  const swamp = (cost) => (x, z) => (x > 10 && x < 20 && z < 16 ? cost : 1);
  const units = () => ({ x: [5.5], z: [2.5] });
  const crossed = (cost) => {
    const field = new FlowField({ size: [30, 20], cost: swamp(cost) });
    field.setGoal([25.5, 0, 2.5]);
    const u = units();
    const dear = new Set();
    for (let i = 0; i < 3000 && field.steer(u, 1, 2, 0.05) > 0; i++) {
      const cell = field.cellAt([u.x[0], 0, u.z[0]]);
      if (field.cost[cell] > 1) dear.add(cell);
    }
    assert.ok(Math.hypot(u.x[0] - 25.5, u.z[0] - 2.5) < 0.5, 'reached the goal');
    return dear.size;
  };
  // Straight across is all ten columns. Around it, a diagonal step past the far corner may graze that one cell.
  assert.ok(crossed(2) >= 10);
  assert.ok(crossed(20) <= 1);
});

test('walls: no cell cuts a wall corner, cut-off cells stay still, and a goal in a wall gives nothing', () => {
  const walled = (x, z) => (x > 5 && x < 6 ? WALL : 1);
  const field = new FlowField({ size: [12, 12], cost: walled });
  assert.equal(field.setGoal([2, 0, 2]), true);
  assert.equal(field.reachable([9, 0, 9]), false);
  assert.deepEqual(field.direction([9, 0, 9]), [0, 0, 0]);
  assert.equal(field.reachable([5.5, 0, 5]), false, 'a wall itself');
  assert.equal(field.reachable([99, 0, 0]), false, 'outside the grid');
  assert.deepEqual(field.direction([99, 0, 0]), [0, 0, 0]);
  assert.equal(field.setGoal([5.5, 0, 5]), false);
  assert.equal(field.setGoal([500, 0, 5]), false);
  assert.equal(field.reachable([1, 0, 1]), false);

  const corner = new FlowField({ size: [5, 5], cost: (x, z) => (x > 2 && x < 3 && z > 2 && z < 3 ? WALL : 1) });
  corner.setGoal([4.5, 0, 4.5]);
  const step = corner.flow[1 * 5 + 2];
  assert.ok(![4, 5, 6, 7].includes(step) || corner.cost[1 * 5 + 3] !== WALL);
  for (let z = 0; z < 5; z++)
    for (let x = 0; x < 5; x++) {
      const s = corner.flow[z * 5 + x];
      if (s < 4) continue;
      const stepX = [0, 0, 0, 0, 1, 1, -1, -1][s];
      const stepZ = [0, 0, 0, 0, 1, -1, 1, -1][s];
      assert.notEqual(corner.cost[z * 5 + x + stepX], WALL);
      assert.notEqual(corner.cost[(z + stepZ) * 5 + x], WALL);
    }
});

test('following the flow from any reachable cell always goes downhill to the goal', () => {
  const random = createRandom(5);
  const cost = Array.from({ length: 60 * 60 }, () => (random() < 0.25 ? WALL : 1 + Math.floor(random() * 4)));
  cost[30 * 60 + 30] = 1;
  const field = new FlowField({ size: [60, 60], cost });
  field.setGoal([30.5, 0, 30.5]);
  const stepX = [1, -1, 0, 0, 1, 1, -1, -1];
  const stepZ = [0, 0, 1, -1, 1, -1, 1, -1];
  let checked = 0;
  for (let cell = 0; cell < cost.length; cell++) {
    if (field.integration[cell] === Number.POSITIVE_INFINITY || field.integration[cell] === 0) continue;
    const s = field.flow[cell];
    assert.ok(s >= 0, `cell ${cell} has a cost to the goal and no way to go`);
    const x = (cell % 60) + stepX[s];
    const z = Math.floor(cell / 60) + stepZ[s];
    assert.ok(field.integration[z * 60 + x] < field.integration[cell]);
    checked++;
  }
  assert.ok(checked > 1000);
});

test('every cell flagged line of sight has a clear straight line to the goal cell', () => {
  const random = createRandom(11);
  for (let round = 0; round < 20; round++) {
    const cost = Array.from({ length: 50 * 50 }, () => (random() < 0.1 ? WALL : 1));
    cost[25 * 50 + 25] = 1;
    const field = new FlowField({ size: [50, 50], cost });
    field.setGoal([25.5, 0, 25.5]);
    let flagged = 0;
    for (let cell = 0; cell < cost.length; cell++) {
      if (!field.lineOfSight[cell]) continue;
      flagged++;
      const x = (cell % 50) + 0.5;
      const z = Math.floor(cell / 50) + 0.5;
      for (let t = 0; t <= 1; t += 1 / 200) {
        const sample = field.cellAt([x + (25.5 - x) * t, 0, z + (25.5 - z) * t]);
        assert.notEqual(cost[sample], WALL, `cell ${cell} is flagged and its line hits a wall`);
      }
    }
    assert.ok(flagged >= 1);
  }
});

test('open ground is all line of sight, a shadow is not, and in sight units steer exactly at the goal', () => {
  const open = new FlowField({ size: [30, 30] });
  open.setGoal([15.5, 0, 15.5]);
  assert.equal(
    open.lineOfSight.reduce((a, b) => a + b, 0),
    900,
  );
  const [dx, , dz] = open.direction([3.25, 0, 7.75]);
  near(Math.atan2(dz, dx), Math.atan2(15.5 - 7.75, 15.5 - 3.25));

  const field = new FlowField({ size: [30, 30], cost: (x, z) => (x > 10 && x < 11 && z > 10 && z < 20 ? WALL : 1) });
  field.setGoal([20.5, 0, 15.5]);
  assert.equal(field.lineOfSight[15 * 30 + 5], 0, 'behind the wall');
  assert.equal(field.lineOfSight[15 * 30 + 15], 1);
});

test('a unit stops at the goal and does not overshoot', () => {
  const field = new FlowField({ size: [10, 10] });
  field.setGoal([5.25, 0, 5.25]);
  const units = { x: [5], z: [5] };
  for (let i = 0; i < 20; i++) field.steer(units, 1, 10, 0.1);
  near(units.x[0], 5.25);
  near(units.z[0], 5.25);
  assert.equal(field.steer(units, 1, 10, 0.1), 0);
});

test('a cost stamp reroutes at once, and its undo restores the field exactly', () => {
  const field = new FlowField({ size: [20, 20] });
  field.setGoal([18.5, 0, 10.5]);
  const before = field.integration.slice();
  const undo = field.stamp(10, 0, 1, 18, WALL);
  assert.ok(at(field, 2, 10) > before[10 * 20 + 2]);
  assert.equal(field.lineOfSight[10 * 20 + 2], 0);
  undo();
  assert.deepEqual(field.integration, before);
});

test('with several goals each unit heads for its cheapest', () => {
  const field = new FlowField({ size: [40, 10] });
  field.setGoal([
    [2.5, 0, 5.5],
    [37.5, 0, 5.5],
  ]);
  assert.ok(field.direction([10.5, 0, 5.5])[0] < 0);
  assert.ok(field.direction([30.5, 0, 5.5])[0] > 0);
  assert.equal(
    field.lineOfSight.reduce((a, b) => a + b, 0),
    0,
  );
});

test('two goals in one cell seed it once, and the field matches a single goal', () => {
  const one = new FlowField({ size: [16, 16] });
  one.setGoal([5.5, 0, 5.5]);
  const two = new FlowField({ size: [16, 16] });
  assert.equal(
    two.setGoal([
      [5.25, 0, 5.25],
      [5.75, 0, 5.75],
    ]),
    true,
  );
  assert.deepEqual(two.integration, one.integration);
  // More goals than cells must not run off the end of the heap.
  const tiny = new FlowField({ size: [2, 1] });
  assert.equal(tiny.setGoal(Array.from({ length: 9 }, () => [0.5, 0, 0.5])), true);
  assert.ok(tiny.reachable([1.5, 0, 0.5]));
});

test('no speed jumps a wall: a long step goes a cell at a time', () => {
  const field = new FlowField({ size: [40, 40], cost: (x, z) => (x > 20 && x < 21 && z > 5 ? WALL : 1) });
  field.setGoal([35.5, 0, 35.5]);
  const units = { x: [15.5], z: [35.5] };
  field.steer(units, 1, 100, 0.08); // 8 cells in one call, and the wall is 5 cells off
  assert.ok(units.x[0] < 20, `crossed the wall to ${units.x[0]}`);
  for (let i = 0; i < 100; i++) {
    field.steer(units, 1, 100, 0.08);
    assert.notEqual(field.cost[field.cellAt([units.x[0], 0, units.z[0]])], WALL);
  }
  near(units.x[0], 35.5);
  near(units.z[0], 35.5);
});

test('min and cell place the grid in the world', () => {
  const field = new FlowField({ min: [-10, 100], size: [10, 10], cell: 2 });
  assert.equal(field.cellAt([-10, 0, 100]), 0);
  assert.equal(field.cellAt([-7.5, 0, 102.5]), 11);
  assert.equal(field.cellAt([-10.5, 0, 100]), -1);
  assert.equal(field.cellAt([10, 0, 100]), -1);
  field.setGoal([9, 0, 119]);
  near(field.integration[0], 1 * Math.hypot(9, 9), 1.5);
});

test('a cost function sees cell centres and writing costs takes effect on rebuild', () => {
  const seen = [];
  const field = new FlowField({
    min: [0, 0],
    size: [2, 1],
    cell: 4,
    cost: (x, z) => {
      seen.push([x, z]);
      return 1;
    },
  });
  assert.deepEqual(seen, [
    [2, 2],
    [6, 2],
  ]);
  field.setGoal([1, 0, 1]);
  assert.equal(field.reachable([7, 0, 1]), true);
  field.cost[1] = WALL;
  field.rebuild();
  assert.equal(field.reachable([7, 0, 1]), false);
});

test('one field takes 10,000 units through a gap to one goal', () => {
  const field = new FlowField({
    size: [128, 128],
    cost: (x, z) => (x > 64 && x < 66 && (z < 60 || z > 68) ? WALL : 1),
  });
  field.setGoal([120.5, 0, 64.5]);
  const random = createRandom(9);
  const count = 10_000;
  const units = { x: new Float32Array(count), z: new Float32Array(count) };
  for (let i = 0; i < count; i++) {
    units.x[i] = 1 + random() * 50;
    units.z[i] = 1 + random() * 126;
  }
  let moving = count;
  for (let i = 0; i < 4000 && moving > 0; i++) {
    moving = field.steer(units, count, 8, 1 / 30);
    if (i % 50 === 0)
      for (let u = 0; u < count; u += 97) assert.notEqual(field.cost[field.cellAt([units.x[u], 0, units.z[u]])], WALL);
  }
  let arrived = 0;
  for (let i = 0; i < count; i++) if (Math.hypot(units.x[i] - 120.5, units.z[i] - 64.5) < 1) arrived++;
  assert.equal(arrived, count);
});

test('malformed input is refused with a message that names the fix', () => {
  assert.throws(() => new FlowField(null), /must be \{size/);
  assert.throws(() => new FlowField({ size: [0, 1] }), /two whole numbers/);
  assert.throws(() => new FlowField({ size: [1, 1], cell: 0 }), /cell/);
  assert.throws(() => new FlowField({ size: [2, 2], cost: [1] }), /must hold 4 cells/);
  assert.throws(() => new FlowField({ size: [1, 1], cost: [0] }), /1 to 255/);
  assert.throws(() => new FlowField({ size: [1, 1], cost: () => 300 }), /1 to 255/);
  const field = new FlowField({ size: [2, 2] });
  assert.throws(() => field.setGoal([[Number.NaN, 0, 0]]), /goal/);
  assert.throws(() => field.setGoal(null), /goal/);
  assert.throws(() => field.stamp(0, 0, 1, 1, 0), /1 to 255/);
  assert.throws(() => field.stamp(Number.NaN, 0, 1, 1, 1), /finite/);
  assert.throws(() => field.stamp(0, 0, 0, 1, 1), /whole numbers/);
  assert.throws(() => field.steer({ x: [], z: [] }, -1, 1, 1), /count/);
  assert.throws(() => field.steer({ x: [], z: [] }, 0, -1, 1), /speed/);
  assert.throws(() => field.steer({ x: [], z: [] }, 0, 1, -1), /delta/);
});
