// Stairs to flat roofs (limits gap row 19): the flight on from the top storey, the open well in the ceiling and the
// roof covering, the stair house and its door, the guard round the roof, and a code for a roof left without.
// IBC 1011.12 and 1011.3 (80 in of headroom), Japan's Order art. 126 (a guard of 1.1 m).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBuilding } from '@margoengine/procedural/building-rules';
import { generateBuildingPlan } from '@margoengine/procedural/building-plans';
import { buildingOptionsFromSettings } from '@margoengine/procedural/building-settings';

let state = 1;
const range = (a, b) => a + ((state = (state * 48271) % 2147483647) / 2147483647) * (b - a);
const STYLES = ['japan-2011-concrete', 'western-1910-brick', 'western-1910-false-front', 'japan-2011-warehouse'];

/** Level triangles of the named parts that cover the plan point, as their heights. */
function levelsAt(b, names, x, z) {
  const out = [];
  for (const name of names) {
    const g = b.parts[name];
    if (!g) continue;
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, c, d] = [0, 1, 2].map((k) => g.positions.subarray(3 * g.indices[t + k], 3 * g.indices[t + k] + 3));
      if (Math.max(a[1], c[1], d[1]) - Math.min(a[1], c[1], d[1]) > 1e-4) continue;
      const side = (p, q) => (q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]),
        s = [side(a, c), side(c, d), side(d, a)];
      if (s.every((v) => v > 0) || s.every((v) => v < 0)) out.push(a[1]);
    }
  }
  return out;
}

function checkRoof(b, label, wrong) {
  const { level, house } = b.roofAccess,
    flights = b.stairs.filter((s) => s.roof);
  if (flights.length !== 1) return wrong.push(`${label}: ${flights.length} roof flights`);
  const [s] = flights,
    top = b.floors.length - 1;
  if (s.floor !== top || s.escape) wrong.push(`${label}: the roof flight starts on floor ${s.floor}`);
  if (Math.abs(b.floors[top] + s.risers * s.rise - level) > 1e-6) wrong.push(`${label}: the risers miss the roof`);
  if (!['dog-leg', 'straight', 'winder'].includes(s.kind)) wrong.push(`${label}: a ${s.kind} to the roof`);
  const inside = ([x, z]) => x > house.min[0] && x < house.max[0] && z > house.min[1] && z < house.max[1];
  if (!inside(s.head) || !inside(s.min) || !inside(s.max)) wrong.push(`${label}: the stair leaves its house`);
  // The house stands on the roof, inside the walls.
  const ix = b.options.width / 2 - b.options.wall,
    iz = b.options.depth / 2 - b.options.wall;
  if (house.min[0] < -ix - 1e-6 || house.max[0] > ix + 1e-6 || house.min[1] < -iz - 1e-6 || house.max[1] > iz + 1e-6)
    wrong.push(`${label}: the house passes the walls`);
  // Over the flights, nothing level between a little under the roof and the head's height: the well is open.
  for (const fx of [0.2, 0.5, 0.8])
    for (const fz of [0.2, 0.5, 0.8]) {
      const x = s.min[0] + fx * (s.max[0] - s.min[0]),
        z = s.min[1] + fz * (s.max[1] - s.min[1]),
        lid = levelsAt(b, ['roof', 'interior'], x, z).filter((y) => y > level - 0.25 && y < level + 2.03);
      if (lid.length) wrong.push(`${label}: the well is shut at ${lid[0] - level} m over the roof`);
    }
  // The door is in a wall of the house, beside where the flight arrives, and as high as it says.
  const { door } = house,
    n = door.normal === 'x' ? 0 : 1,
    at = n ? door.centre[2] : door.centre[0];
  if (Math.min(Math.abs(at - house.min[n]), Math.abs(at - house.max[n])) > 0.07)
    wrong.push(`${label}: the door stands off the house`);
  if (Math.abs(door.centre[1] - door.height / 2 - level) > 1e-6) wrong.push(`${label}: the door is off the roof`);
  const across = n ? door.centre[0] : door.centre[2],
    m = 1 - n;
  if (across - door.width / 2 < house.min[m] + 0.1 || across + door.width / 2 > house.max[m] - 0.1)
    wrong.push(`${label}: the door passes a corner`);
  if (Math.abs(at - s.head[n]) > Math.abs(at - (s.min[n] + s.max[n]) / 2))
    wrong.push(`${label}: the door is at the far end from the head`);
  // A guard 1.1 m over the roof round it: parapet, coping or rail.
  const m4 = b.options.wall / 2;
  for (const [x, z] of [
    [0, b.options.depth / 2 - m4],
    [b.options.width / 2 - m4, 0.01],
    [0, -b.options.depth / 2 + m4],
    [-b.options.width / 2 + m4, 0.01],
  ]) {
    const high = Math.max(-Infinity, ...levelsAt(b, ['walls', 'trim', 'metalwork'], x + 0.003, z + 0.003));
    if (high < level + 1.067 - 1e-6) wrong.push(`${label}: the roof's edge is guarded ${(high - level).toFixed(2)} m`);
  }
}

test('a stair reaches flat roofs: open well, stair house, door and guard', () => {
  const wrong = [];
  let built = 0,
    asked = 0;
  state = 31;
  for (let i = 0; i < 240; i++) {
    const style = STYLES[i % 4],
      storey = range(2.8, 3.4),
      o = {
        style,
        roof: 'flat',
        roofStair: true,
        width: range(8, 40),
        depth: range(8, 24),
        parapet: [0, 0.5, 1, 1.2][(i >> 2) % 4],
        storeys: Array(1 + (i % 5)).fill(storey),
      },
      b = generateBuilding(o),
      label = `#${i} ${style} ${o.width.toFixed(2)} x ${o.depth.toFixed(2)} x ${o.storeys.length}`;
    asked++;
    if (!b.roofAccess.house) {
      assert.equal(b.roofAccess.unmet, 'no-room', label);
      continue;
    }
    built++;
    checkRoof(b, label, wrong);
    assert.ok(b.top >= b.roofAccess.level + b.roofAccess.house.height - 1e-9, label);
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} failures`);
  assert.equal(built, asked);
});

test('the code asks four storeys of a western commercial block for it, and a roof without says why', () => {
  const four = { style: 'western-1910-brick', storeys: [4.1, 3.5, 3.5, 3.5] },
    b = generateBuilding(four);
  assert.deepEqual([b.roofAccess.required, !!b.roofAccess.house, b.roofAccess.unmet], [true, true, undefined]);
  assert.equal(b.options.roofStair, true);
  // Built again from its own resolved options, the same.
  assert.deepEqual(generateBuilding(b.options).roofAccess, b.roofAccess);
  const three = generateBuilding({ style: 'western-1910-brick' });
  assert.equal(three.roofAccess, undefined);
  assert.equal(three.stairs.filter((s) => s.roof).length, 0);
  assert.equal(generateBuilding({ style: 'japan-2011-concrete', storeys: [3, 3, 3, 3, 3] }).roofAccess, undefined);
  const why = (o) => {
    const r = generateBuilding(o).roofAccess;
    return [r.required, r.unmet, !!r.house];
  };
  assert.deepEqual(why({ ...four, roofStair: false }), [true, 'stair-off', false]);
  assert.deepEqual(why({ ...four, interior: 'cells' }), [true, 'stair-off', false]);
  assert.deepEqual(why({ ...four, stairs: false }), [true, 'stair-off', false]);
  assert.deepEqual(why({ ...four, roof: 'gable', pitch: 10 }), [true, 'pitched', false]);
  assert.deepEqual(why({ style: 'japan-2011-house', roofStair: true }), [false, 'pitched', false]);
  assert.deepEqual(why({ style: 'japan-2011-concrete', roofStair: true, width: 3, depth: 3 }), [
    false,
    'no-room',
    false,
  ]);
  // One storey: a single stair up from the ground floor.
  const one = generateBuilding({ style: 'japan-2011-concrete', roofStair: true, storeys: [3.2] });
  assert.equal(one.stairs.length, 1);
  assert.ok(one.stairs[0].roof && one.roofAccess.house);
  // The slider row: auto leaves the style's own answer.
  assert.equal('roofStair' in buildingOptionsFromSettings({ roofStair: 'auto' }), false);
  assert.equal(buildingOptionsFromSettings({ roofStair: 'off' }).roofStair, false);
});

test('in a joined plan the stair house stands clear of every other block', () => {
  let houses = 0;
  const wrong = [];
  for (const shape of ['L', 'T', 'U', 'cross'])
    for (const tower of ['none', 'front-left'])
      for (const storeys of [2, 4]) {
        const plan = generateBuildingPlan({
            style: 'western-1910-brick',
            plan: shape,
            tower,
            width: 18,
            depth: 12,
            roofStair: true,
            storeys: Array(storeys).fill(3.2),
          }),
          label = `${shape} ${tower} ${storeys}`;
        for (const { house } of plan.roofAccess) {
          if (!house) continue;
          houses++;
          // No other block's solid holds a corner of the house, on the roof or just under it.
          const owner = plan.blocks.findIndex((_, i) =>
            plan.insideBlock(i, (house.min[0] + house.max[0]) / 2, 0.5, (house.min[1] + house.max[1]) / 2),
          );
          for (const x of [house.min[0] + 0.01, house.max[0] - 0.01])
            for (const z of [house.min[1] + 0.01, house.max[1] - 0.01])
              for (let i = 0; i < plan.blocks.length; i++)
                if (i !== owner && plan.insideBlock(i, x, house.door.centre[1], z))
                  wrong.push(`${label}: block ${i} holds the stair house`);
        }
        assert.equal(plan.stairs.filter((s) => s.roof).length, plan.roofAccess.filter((r) => r.house).length, label);
      }
  assert.deepEqual(wrong, []);
  assert.ok(houses >= 8, `${houses} stair houses`);
});
