// Board sheds and the launch rail (KB-PROC-SHED1): the default is the 1903 hangar's size, boards stop at the
// openings, the gable boards stay under the roof, the roof overhangs the walls, and the rail is 60 ft of timber that
// follows the ground.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLaunchRail, generatePlankShed } from '@margoengine/procedural/sheds';

function bounds(data) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], data.positions[i + c]);
      hi[c] = Math.max(hi[c], data.positions[i + c]);
    }
  return { lo, hi };
}
const finite = (data) => data.positions.every(Number.isFinite) && data.normals.every(Number.isFinite);

test('the default shed is the 44 by 16 ft hangar with a roof over its walls', () => {
  const shed = generatePlankShed(),
    // The walls alone (the default's awning door swings out past the front wall).
    walls = bounds(generatePlankShed({ openings: [] }).parts.siding),
    roof = bounds(shed.parts.roof);
  for (const part of Object.values(shed.parts)) {
    assert.ok(part.indices.length > 0 && finite(part));
    assert.equal(part.tangents?.length, (part.positions.length / 3) * 4, 'tangents for normal-mapped wood');
  }
  assert.ok(Math.abs(walls.hi[0] - walls.lo[0] - 13.4) < 0.12, `length ${walls.hi[0] - walls.lo[0]}`);
  assert.ok(Math.abs(walls.hi[2] - walls.lo[2] - 4.9) < 0.15, `width ${walls.hi[2] - walls.lo[2]}`);
  assert.ok(roof.hi[0] - roof.lo[0] > 13.4 + 0.3 && roof.hi[2] - roof.lo[2] > 4.9 + 0.3, 'the roof overhangs');
  // The gable boards stop under the roof: nothing of the walls sticks up through it.
  assert.ok(walls.hi[1] <= shed.ridge + 0.02, `walls top ${walls.hi[1]} ridge ${shed.ridge}`);
  assert.ok(Math.abs(shed.ridge - (2.4 + 2.45 * Math.tan((18 * Math.PI) / 180))) < 1e-9);
});

test('openings cut the boards, and leaves hang as asked', () => {
  const opening = { wall: 'front', width: 2, height: 1.8 },
    holed = generatePlankShed({ openings: [{ ...opening, leaf: 'none' }] }),
    shut = generatePlankShed({ openings: [{ ...opening, leaf: 'closed' }] }),
    awning = generatePlankShed({ openings: [{ ...opening, leaf: 'awning' }] });
  // Triangles in the front wall's plane (z = 2.45) that cover the middle of the doorway, (0, 0.9).
  const crossing = (data) => {
    const p = data.positions,
      idx = data.indices;
    let n = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const v = [0, 1, 2].map((k) => [p[idx[t + k] * 3], p[idx[t + k] * 3 + 1], p[idx[t + k] * 3 + 2]]);
      if (!v.every((q) => Math.abs(q[2] - 2.45) < 0.03)) continue;
      const side = (a, b) => (b[0] - a[0]) * (0.9 - a[1]) - (b[1] - a[1]) * (0 - a[0]),
        s = [side(v[0], v[1]), side(v[1], v[2]), side(v[2], v[0])];
      if (s.every((x) => x >= 0) || s.every((x) => x <= 0)) n++;
    }
    return n;
  };
  assert.equal(crossing(holed.parts.siding), 0, 'the doorway is open');
  assert.ok(crossing(shut.parts.siding) > 0, 'a closed leaf fills it');
  // The awning leaf swings out past the wall and up.
  const out = bounds(awning.parts.siding);
  assert.ok(out.hi[2] > 2.45 + 1.2, `awning reach ${out.hi[2]}`);
  assert.throws(() => generatePlankShed({ openings: [{ wall: 'front', width: 20, height: 1 }] }), RangeError);
  assert.throws(() => generatePlankShed({ openings: [{ wall: 'side', width: 1, height: 1 }] }), RangeError);
  assert.throws(() => generatePlankShed({ pitch: 80 }), RangeError);
  assert.throws(() => generatePlankShed({ siding: 'diagonal' }), RangeError);
});

test('vertical siding and the same seed give the same shed', () => {
  const a = generatePlankShed({ siding: 'vertical', length: 7.6, pitch: 30, seed: 4 }),
    b = generatePlankShed({ siding: 'vertical', length: 7.6, pitch: 30, seed: 4 });
  assert.deepEqual(a.parts.siding.positions, b.parts.siding.positions);
  assert.ok(finite(a.parts.siding));
});

test('the launch rail is 60 ft of timber on edge, capped with metal, lying on the ground', () => {
  const flat = generateLaunchRail(),
    wood = bounds(flat.parts.wood),
    metal = bounds(flat.parts.metal);
  assert.ok(Math.abs(wood.hi[0] - wood.lo[0] - 18.3) < 0.05, `length ${wood.hi[0] - wood.lo[0]}`);
  assert.ok(Math.abs(wood.hi[2] - wood.lo[2] - 0.038) < 1e-6, 'a 2 by 4 laid on edge');
  // Each length is laid within 2 mm of the next (seeded unevenness), so the strip sits within 4.5 mm of the tallest.
  assert.ok(metal.lo[1] >= wood.hi[1] - 0.0045 && metal.lo[1] > wood.lo[1] + 0.07, 'the strip is on top');
  const slope = generateLaunchRail({ ground: (x) => x * 0.2 }),
    sloped = bounds(slope.parts.wood);
  assert.ok(sloped.hi[1] > 18.3 * 0.2 - 0.05, 'follows rising ground');
  assert.equal(generateLaunchRail({ strip: false }).parts.metal, undefined);
  assert.throws(() => generateLaunchRail({ length: 100 }), RangeError);
});
