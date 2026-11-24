// Joined plans, dormers, towers and interiors (sheet row 14). Every bound is a code, survey or trade figure:
// - the framing square's hip and valley table: equal pitch roofs at right angles meet in a valley at 45 degrees in plan
//   that falls tan(pitch) / sqrt(2) (16.97 in of valley run per 12 in of common run);
// - IRC 2021 R310.2.1 (escape openings 5.7 sq ft net, 24 in high, 20 in wide), R905.2.8.3 (step flashing 4 in up a
//   dormer cheek), R905.3.2 / R905.7.2 / R905.10.2 minimum slopes, R304.1 / R304.2 (habitable rooms 70 sq ft, no side
//   under 7 ft), R305.1 (ceiling 7 ft);
// - Japan Building Standard Law Enforcement Order art. 21 (habitable ceiling 2.1 m) and the Edo-ma tatami (0.88 by
//   1.76 m; a 4.5 jo room is the smallest living room of the style sets).
// The entry, the rooms, furniture and doorways did not exist before this change, so every test fails on the old tree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBuilding } from '../dist/building-rules.js';
import { generateBuildingPlan } from '../dist/building-plans.js';

const tris = (g, fn) => {
  const P = g.positions,
    I = g.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = [P[3 * I[t]], P[3 * I[t] + 1], P[3 * I[t] + 2]],
      b = [P[3 * I[t + 1]], P[3 * I[t + 1] + 1], P[3 * I[t + 1] + 2]],
      c = [P[3 * I[t + 2]], P[3 * I[t + 2] + 1], P[3 * I[t + 2] + 2]];
    fn(a, b, c);
  }
};
// Highest point of a part's triangles straight above (x, z), or -Infinity.
function topAt(g, x, z) {
  let best = -Infinity;
  tris(g, (a, b, c) => {
    const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(d) < 1e-12) return;
    const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / d,
      v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / d;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) return;
    best = Math.max(best, a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]));
  });
  return best;
}

const tee = () => generateBuildingPlan({ style: 'western-1910-house', plan: 'T', ridge: 'x', width: 12, depth: 8, pitch: 40, gutters: false, chimney: false, porch: 0, detail: 'far' });

test('a T plan: the main front wall opens into the wing, and no roof is left hidden under another', () => {
  const b = tee(),
    ww = Math.min(0.75 * 8, 0.45 * 12),
    eaves = b.blocks[0].eaves;
  assert.deepEqual(b.blocks.map((x) => x.kind), ['main', 'wing']);
  let inJunction = 0;
  tris(b.parts.walls, (a, p, c) => {
    const m = [0, 1, 2].map((k) => (a[k] + p[k] + c[k]) / 3);
    if (Math.abs(m[0]) < ww / 2 - 0.3 && Math.abs(m[2] - 4) < 0.1 && m[1] > 1 && m[1] < eaves - 0.5) inJunction++;
  });
  assert.equal(inJunction, 0, 'no main front wall left between the main block and the wing');
  // Within the walls of either block, every roof triangle is at most a roof slab under the roof of the whole.
  let hidden = 0;
  tris(b.parts.roof, (a, p, c) => {
    const m = [0, 1, 2].map((k) => (a[k] + p[k] + c[k]) / 3),
      inMain = Math.abs(m[0]) < 6 && Math.abs(m[2]) < 4,
      inWing = Math.abs(m[0]) < ww / 2 && m[2] > 0 && m[2] < 4 + 0.6 * 8;
    if ((inMain || inWing) && m[1] < b.roofHeight(m[0], m[2]) - 0.3) hidden++;
  });
  assert.equal(hidden, 0, 'no roof triangle hidden under another block');
  // The roof drawn is the upper envelope: no holes, no strays above it.
  for (const [x, z] of [[0, -1.5], [-4, 1], [4, -2], [1, 7.5], [-1.2, 4.3], [5.5, 3.9], [-0.3, 2.5], [0.6, 6]]) {
    const top = topAt(b.parts.roof, x, z),
      want = b.roofHeight(x, z);
    assert.ok(Math.abs(top - want) < 0.03, `roof at ${x}, ${z}: drawn ${top}, envelope ${want}`);
  }
});

test('a T plan: the valley runs at 45 degrees in plan and falls tan(pitch) / sqrt(2) (framing square table)', () => {
  const b = tee(),
    t = Math.tan((40 * Math.PI) / 180);
  // Where along x the drawn roof stops following the wing's side slope and meets the main front slope, at depth z.
  const crease = (z) => {
    const flat = topAt(b.parts.roof, 5, z);
    let lo = 0,
      hi = 3.5;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (topAt(b.parts.roof, mid, z) > flat + 1e-4) lo = mid;
      else hi = mid;
    }
    return { x: (lo + hi) / 2, y: flat };
  };
  const a = crease(2.0),
    c = crease(3.0);
  const run = Math.hypot(c.x - a.x, 1);
  assert.ok(Math.abs((c.x - a.x) - 1) < 0.02, `valley plan angle: dx/dz ${c.x - a.x}`);
  assert.ok(Math.abs((a.y - c.y) / run - t / Math.SQRT2) < 0.01 * t, `valley fall ${(a.y - c.y) / run} against ${t / Math.SQRT2}`);
  assert.ok(Math.abs(run - 16.97 / 12) < 0.02, 'valley run per common run is 16.97 / 12');
});

test('dormers: escape-size windows above a 4 in flashing, cut through the main roof', () => {
  const b = generateBuildingPlan({ style: 'western-1910-house', plan: 'rect', ridge: 'x', width: 11, depth: 8, pitch: 40, dormers: 2 });
  assert.equal(b.dormers.length, 2);
  for (const d of b.dormers) {
    const w = d.window;
    assert.ok(w.width >= 0.508 && w.height >= 0.61 && w.width * w.height >= 0.5295, `IRC R310.2.1 opening ${w.width} by ${w.height}`);
    assert.ok(w.centre[1] - w.height / 2 - d.roofAtFace >= 0.1016, 'sill clears the roof by the 4 in step flashing');
    // The main roof is cut out behind the face: the roof over a point just inside it is the dormer's, above the main slope.
    const inside = topAt(b.parts.roof, w.centre[0], w.centre[2] - 0.6);
    assert.ok(inside > w.centre[1] + w.height / 2, 'the dormer roof covers the cut');
    let glass = 0;
    tris(b.parts.glass, (a, p, c) => {
      const m = [0, 1, 2].map((k) => (a[k] + p[k] + c[k]) / 3);
      if (Math.hypot(m[0] - w.centre[0], m[1] - w.centre[1], m[2] - w.centre[2]) < 0.3) glass++;
    });
    assert.ok(glass > 0, 'the dormer window is glazed');
  }
  for (const kind of ['shed', 'hip']) {
    const k = generateBuildingPlan({ style: 'western-1910-house', plan: 'rect', ridge: 'x', width: 11, depth: 8, pitch: 40, dormers: 1, dormerKind: kind });
    assert.equal(k.dormers.length, 1, kind);
    assert.ok(k.blocks[1].pitch >= 14.04, `${kind} dormer roof at least the 3:12 of wood shingles (IRC R905.7.2)`);
  }
  // A roof too low for a dormer gets none rather than one poking through its ridge.
  assert.equal(generateBuildingPlan({ style: 'japan-2011-house', plan: 'rect', dormers: 2 }).dormers.length, 0);
});

test('a corner tower rises past the main roof, keeps its floors and opens into the main block', () => {
  const b = generateBuildingPlan({ style: 'western-1910-house', plan: 'L', tower: 'front-right', towerStoreys: 1 }),
    main = b.blocks[0],
    tower = b.blocks.find((x) => x.kind === 'tower'),
    ti = b.blocks.indexOf(tower);
  assert.ok(tower.top > main.top + 1, 'the tower top stands over the main roof');
  assert.ok(tower.eaves > main.eaves + 2.2, 'one storey more than the main block');
  const minSlope = { shingle: 14.04, tile: 11.77, metal: 1.19 };
  for (const blk of b.blocks) if (blk.pitch > 0) assert.ok(blk.pitch >= minSlope[blk.roofing], `${blk.kind} pitch ${blk.pitch}`);
  // Nothing of the main block's walls or roof is left deep inside the tower.
  const deep = (m) => [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]].every(([dx, dz]) => b.insideBlock(ti, m[0] + dx, m[1], m[2] + dz));
  for (const part of ['walls', 'roof'])
    tris(b.parts[part], (a, p, c) => {
      const m = [0, 1, 2].map((k) => (a[k] + p[k] + c[k]) / 3);
      if (m[1] < main.eaves - 0.3 && deep(m)) assert.fail(`a ${part} triangle at ${m.map((v) => v.toFixed(2))} inside the tower`);
    });
  assert.ok(b.openings.every((o) => !(o.side === 1 && Math.abs(o.centre[0] - 7.3 / 2) < 0.05 && o.centre[1] < main.eaves && b.insideBlock(ti, o.centre[0] - 0.3, o.centre[1], o.centre[2]))));
});

test('U and cross plans and wings given by hand join the same way', () => {
  for (const plan of ['U', 'cross']) {
    const b = generateBuildingPlan({ style: 'western-1910-depot', plan, detail: 'far' });
    assert.equal(b.blocks.length, 3, plan);
    for (const [x, z] of [[0, -1.5], [b.blocks[1].footprint[0][0] + 2, b.blocks[1].footprint[0][1] - 1]])
      assert.ok(Math.abs(topAt(b.parts.roof, x, z) - b.roofHeight(x, z)) < 0.03, `${plan} roof at ${x}, ${z}: ${topAt(b.parts.roof, x, z)} ${b.roofHeight(x, z)}`);
  }
  const hand = generateBuildingPlan({ style: 'japan-2011-house', wings: [{ at: [6, 0], width: 4, depth: 6, turn: 1 }] });
  assert.equal(hand.blocks[1].kind, 'wing');
  assert.throws(() => generateBuildingPlan({ plan: 'H' }), RangeError);
  assert.throws(() => generateBuildingPlan({ wings: [{ at: [0] }] }), RangeError);
  assert.throws(() => generateBuildingPlan({ dormers: 1.5 }), RangeError);
});

test('interiors: rooms of code size and height, doorways through every partition, furniture clear of windows and doors', () => {
  const cases = [
    ['western-1910-house', 70 * 0.09290304, 2.1336, 2.1336],
    ['japan-2011-house', 4.5 * 0.88 * 1.76, 0, 2.1],
  ];
  for (const [style, area, side, ceiling] of cases) {
    const b = generateBuilding({ style });
    assert.ok(b.rooms.length >= 4, style);
    for (const r of b.rooms) {
      assert.ok(r.area >= area, `${style} room of ${r.area.toFixed(2)} m2`);
      assert.ok(Math.min(r.max[0] - r.min[0], r.max[1] - r.min[1]) >= side, `${style} room side`);
      assert.ok(r.height >= ceiling, `${style} ceiling ${r.height}`);
    }
    // Rooms that share a partition are joined by a doorway in it.
    assert.ok(b.doorways.length >= b.rooms.length - b.options.storeys.length, `${style} doorways`);
    for (const d of b.doorways) assert.ok(d.width >= (style.startsWith('japan') ? 0.86 : 0.81) && d.height >= 1.8);
    assert.ok(b.furniture.length >= b.rooms.length, `${style} furnished`);
    const sills = b.openings.filter((o) => o.kind === 'window');
    for (const f of b.furniture) {
      const room = b.rooms.find((r) => r.floor === f.floor && f.min[0] >= r.min[0] - 1e-9 && f.max[0] <= r.max[0] + 1e-9 && f.min[2] >= r.min[1] - 1e-9 && f.max[2] <= r.max[1] + 1e-9);
      assert.ok(room, `${f.kind} inside a room`);
      for (const d of b.doorways.filter((q) => q.floor === f.floor)) {
        const [cx, , cz] = d.centre,
          [ex, ez] = d.normal === 'x' ? [0.9, d.width / 2] : [d.width / 2, 0.9];
        assert.ok(!(f.min[0] < cx + ex && f.max[0] > cx - ex && f.min[2] < cz + ez && f.max[2] > cz - ez), `${f.kind} in a doorway approach`);
      }
      for (const w of sills.filter((o) => o.floor === f.floor)) {
        const sill = w.centre[1] - w.height / 2,
          dist = Math.max(f.min[0] - w.centre[0], w.centre[0] - f.max[0], f.min[2] - w.centre[2], w.centre[2] - f.max[2]);
        if (f.max[1] > sill + 0.05) assert.ok(dist > w.width / 2 + 0.05, `${f.kind} (top ${f.max[1]}) in front of a window (sill ${sill})`);
      }
    }
  }
  const shop = generateBuilding({ style: 'western-1910-false-front' });
  assert.ok(shop.furniture.some((f) => f.kind === 'counter' && f.floor === 0), 'a storefront floor has a counter');
  const far = generateBuilding({ style: 'western-1910-house', detail: 'far' }),
    none = generateBuilding({ style: 'western-1910-house', detail: 'far', interior: 'none' });
  assert.equal(far.options.interior, 'cells');
  assert.equal(far.rooms.length, 0);
  // One five-faced cell (ten triangles) behind each window.
  const cells = far.openings.filter((o) => o.kind !== 'door' && o.kind !== 'transom').length;
  assert.equal(far.parts.interior.indices.length / 3 - none.parts.interior.indices.length / 3, cells * 10);
  assert.equal(none.furniture.length + none.rooms.length + none.doorways.length, 0);
  assert.throws(() => generateBuilding({ interior: 'lobby' }), RangeError);
});

test('plan and interior slider rows: shared shape, rebuild rows, mapped onto the generators', async () => {
  const { BUILDING_PLAN_SETTINGS, BUILDING_SETTINGS, buildingPlanOptionsFromSettings, buildingPlanSettingDefaults } = await import(
    '../dist/building-settings.js'
  );
  for (const r of BUILDING_PLAN_SETTINGS) {
    assert.equal(r.live, false, r.name);
    if (r.kind === 'number') assert.ok(r.default >= r.min && r.default <= r.max, r.name);
    else assert.ok(r.choices.includes(r.default), r.name);
  }
  assert.ok(BUILDING_SETTINGS.some((r) => r.name === 'interior'));
  const d = buildingPlanSettingDefaults();
  assert.equal(d.plan, 'L');
  assert.equal(d.dormers, 0);
  const o = buildingPlanOptionsFromSettings({ style: 'western-1910-house', plan: 'T', tower: 'back-left', interior: 'cells', storeys: 1 });
  assert.equal(o.plan, 'T');
  assert.equal(o.tower, 'back-left');
  assert.equal(o.interior, 'cells');
  assert.deepEqual(o.storeys, [2.95]);
  assert.equal(generateBuildingPlan(o).blocks.length, 3);
  assert.throws(() => buildingPlanOptionsFromSettings({ plan: 'H' }), RangeError);
  assert.throws(() => buildingPlanOptionsFromSettings({ wings: 2 }), TypeError);
});
