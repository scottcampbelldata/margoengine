// Bay windows of the building rules: the conditions of Setagaya City 4-92-1a (underside at least 30 cm over the floor,
// out less than 50 cm, window over at least half its elevation,
// https://www.city.setagaya.lg.jp/documents/3826/4-92-1a.pdf) at the default depth, each plan shape, a way through the
// wall into the bay, a bay closed on every side, stacked floor bays, the places no bay is made, and clearance under
// eaves, porch roofs, balconies and a joined plan's other blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBuilding, townBuildings, BUILDING_STYLES } from '@margoengine/procedural/building-rules';
import { generateBuildingPlan } from '@margoengine/procedural/building-plans';
import { buildingOptionsFromSettings } from '@margoengine/procedural/building-settings';

const SHAPES = ['box', 'canted-30', 'canted-45', 'bow'];
// A wide house with nothing else on its front above the ground floor.
const HOUSE = { style: 'japan-2011-house', width: 10.92, balcony: 0, overhang: 0.6, bayWindows: [0, 3] };

function triangles(b, names) {
  const out = [];
  for (const name of names) {
    const g = b.parts[name];
    if (!g) continue;
    const p = (i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
    for (let i = 0; i < g.indices.length; i += 3)
      out.push([name, p(g.indices[i]), p(g.indices[i + 1]), p(g.indices[i + 2])]);
  }
  return out;
}
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The first triangle a ray meets, either face of it (Moller and Trumbore 1997). */
function first(tris, from, dir) {
  let best = null;
  for (const [name, a, b, c] of tris) {
    const e1 = minus(b, a),
      e2 = minus(c, a),
      h = cross(dir, e2),
      det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = minus(from, a),
      u = dot(s, h) / det,
      q = cross(s, e1),
      v = dot(dir, q) / det,
      t = dot(e2, q) / det;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7 || t < 1e-6) continue;
    if (!best || t < best.t) best = { t, name };
  }
  return best;
}
/** The front bays' geometry: what a building has in front of its front wall that the same one without them has not. */
function added(options) {
  const key = (name, v) => `${name} ${v.map((x) => x.toFixed(4))}`,
    plain = generateBuilding({ ...options, bayWindows: [] }),
    made = generateBuilding(options),
    had = new Set();
  for (const [name, g] of Object.entries(plain.parts))
    for (let i = 0; i < g.positions.length; i += 3) had.add(key(name, [...g.positions.slice(i, i + 3)]));
  const points = [];
  for (const [name, g] of Object.entries(made.parts))
    for (let i = 0; i < g.positions.length; i += 3) {
      const v = [...g.positions.slice(i, i + 3)];
      if (!had.has(key(name, v))) points.push([name, v]);
    }
  return { b: made, points };
}
/** How much of a front bay's light faces the room: each light's width projected onto the wall. */
function seen(bay) {
  return bay.lights.reduce((sum, l) => {
    let best = Infinity,
      along = 0;
    for (let i = 0; i + 1 < bay.outline.length; i++) {
      const [ax, az] = bay.outline[i],
        [bx, bz] = bay.outline[i + 1],
        len = Math.hypot(bx - ax, bz - az),
        off = Math.abs((bx - ax) * (l.centre[2] - az) - (bz - az) * (l.centre[0] - ax)) / len;
      if (off < best) {
        best = off;
        along = Math.abs(bx - ax) / len;
      }
    }
    return sum + l.width * along;
  }, 0);
}

test('no bay window unless asked, and the options are checked by name', () => {
  for (const style of BUILDING_STYLES) assert.equal(generateBuilding({ style }).bayWindows.length, 0, style);
  for (const [name, value] of [
    ['bayWindows', [64]],
    ['bayWindowSides', [4]],
    ['bayWindowFloors', [1.5]],
    ['bayWindowShape', 'round'],
    ['bayWindowDepth', 2],
    ['bayWindowFrom', 'ground'],
  ])
    assert.throws(() => generateBuilding({ [name]: value }), new RegExp(name), name);
});

test('a bay hung from its sill at the default depth keeps the three conditions of 4-92-1a', () => {
  for (const shape of SHAPES) {
    const { b, points } = added({ ...HOUSE, bayWindowShape: shape });
    assert.equal(b.bayWindows.length, 4, shape);
    const face = b.options.depth / 2,
      out = Math.max(...points.map(([, v]) => v[2] - face));
    assert.ok(out < 0.5, `${shape}: ${out.toFixed(3)} m out with its trim and cap`);
    assert.ok(out > 0.4, `${shape}: it stands out`);
    for (const bay of b.bayWindows) {
      assert.ok(bay.ledge - b.floors[bay.floor] >= 0.3 - 1e-9, `${shape}: underside over the floor`);
      const mouth = b.openings.find(
        (o) => o.side === 0 && o.floor === bay.floor && Math.abs(o.centre[0] - bay.lights.at(0).centre[0]) < 1.2,
      );
      assert.equal(mouth.kind, 'window');
      assert.ok(seen(bay) * (bay.head - bay.sill) >= (mouth.width * mouth.height) / 2, `${shape}: half window`);
    }
  }
});

test('each shape has its plan: square sides, sides canted 30 or 45 degrees, five lights on an arc', () => {
  for (const shape of SHAPES) {
    const b = generateBuilding({ ...HOUSE, bayWindowShape: shape, bayWindowDepth: 0.4 }),
      bay = b.bayWindows[0],
      line = bay.outline,
      angle = (i) =>
        (Math.atan2(Math.abs(line[i + 1][1] - line[i][1]), Math.abs(line[i + 1][0] - line[i][0])) * 180) / Math.PI;
    if (shape === 'bow') {
      assert.equal(line.length, 6);
      assert.equal(bay.lights.length, 5);
      // A circle through both ends and the third point holds the others.
      const [a, c, e] = [line[0], line[2], line[5]],
        mid = (a[0] + e[0]) / 2,
        z = ((c[0] - mid) ** 2 + c[1] ** 2 - (a[0] - mid) ** 2 - a[1] ** 2) / (2 * (c[1] - a[1])),
        r = Math.hypot(a[0] - mid, a[1] - z);
      for (const p of line) assert.ok(Math.abs(Math.hypot(p[0] - mid, p[1] - z) - r) < 1e-6);
    } else {
      assert.equal(line.length, 4, shape);
      assert.equal(bay.lights.length, 3, shape);
      const want = { box: 90, 'canted-30': 30, 'canted-45': 45 }[shape];
      assert.ok(Math.abs(angle(0) - want) < 1e-6, `${shape} ${angle(0)}`);
      assert.ok(Math.abs(angle(2) - want) < 1e-6, `${shape} ${angle(2)}`);
      assert.ok(Math.abs(angle(1)) < 1e-6, shape);
    }
  }
  // A narrow facade bay keeps a 0.4 m front and stands out less.
  const narrow = generateBuilding({ ...HOUSE, width: 5.6, bayWidth: 1.4, bayWindowShape: 'canted-30' }).bayWindows[0];
  assert.ok(narrow.depth < 0.45, `${narrow.depth}`);
  assert.ok(Math.abs(narrow.outline[2][0] - narrow.outline[1][0]) >= 0.4 - 1e-6);
});

test('the room opens into the bay, and the bay is closed on every side', () => {
  const names = ['walls', 'interior', 'trim', 'frames', 'glass', 'base', 'roof'];
  for (const shape of SHAPES)
    for (const from of ['sill', 'floor']) {
      const b = generateBuilding({ ...HOUSE, bayWindowShape: shape, bayWindowFrom: from }),
        tris = triangles(b, names),
        face = b.options.depth / 2;
      for (const bay of b.bayWindows) {
        const x = (bay.outline[0][0] + bay.outline.at(-1)[0]) / 2 + 0.06,
          y = bay.sill + 0.17,
          label = `${shape} ${from} floor ${bay.floor}`;
        // Straight out from just inside the room: nothing before the bay's own front.
        const ahead = first(tris, [x, y, face - b.options.wall - 0.02], [0, 0, 1]),
          reach = ahead.t - b.options.wall - 0.02;
        assert.ok(reach > bay.depth - 0.16 && reach < bay.depth, `${label}: ${ahead.name} ${reach.toFixed(3)} out`);
        // From inside the bay, every direction meets it close by.
        const middle = [x, (bay.ledge + bay.head) / 2 + 0.09, face + bay.depth / 2];
        for (let i = 0; i < 200; i++) {
          // A spiral of directions, those back into the room left out.
          const v = 1 - (2 * i + 1) / 200,
            t = i * 2.399963,
            d = [Math.sqrt(1 - v * v) * Math.cos(t), v, Math.sqrt(1 - v * v) * Math.sin(t)];
          if (d[2] < -0.05) continue;
          const hit = first(tris, middle, d);
          assert.ok(hit && hit.t < 2.5, `${label}: open toward ${d.map((n) => n.toFixed(2))}`);
        }
      }
    }
});

test('floor bays stack into one, with a footing on the ground and brackets only where one hangs', () => {
  const b = generateBuilding({ ...HOUSE, bayWindows: [3], bayWindowFrom: 'floor' }),
    [upper, lower] = b.bayWindows.slice().sort((p, q) => q.floor - p.floor);
  assert.equal(b.bayWindows.length, 2);
  assert.equal(lower.ledge, b.floors[0]);
  assert.equal(upper.ledge, b.floors[1]);
  assert.equal(lower.top, upper.base);
  const low = (name) => {
    const g = b.parts[name];
    let y = Infinity;
    for (let i = 0; i < g.positions.length; i += 3)
      if (g.positions[i + 2] > b.options.depth / 2 + 0.2) y = Math.min(y, g.positions[i + 1]);
    return y;
  };
  assert.ok(Math.abs(low('base') + 0.3) < 1e-6, 'the footing goes into the ground');
  // On the first floor alone it hangs on brackets, under its own floor.
  const oriel = generateBuilding({ ...HOUSE, bayWindows: [3], bayWindowFrom: 'floor', bayWindowFloors: [1] });
  assert.equal(oriel.bayWindows.length, 1);
  const g = oriel.parts.trim,
    { base } = oriel.bayWindows[0];
  // Nothing else of the front stands this far under that floor, over the ground floor's window heads.
  let under = false;
  for (let i = 0; i < g.positions.length; i += 3)
    under ||=
      g.positions[i + 2] > oriel.options.depth / 2 + 0.001 &&
      g.positions[i + 1] > base - 0.34 &&
      g.positions[i + 1] < base - 0.2;
  assert.ok(under, 'brackets');
});

test('no bay takes a door, a shop window or a balcony', () => {
  const all = generateBuilding({ width: 10.92, balconyWidth: 0.5, bayWindows: [0, 1, 2, 3] }),
    door = all.openings.find((o) => o.kind === 'door');
  // Three beside the door downstairs, one at each end beside the balcony upstairs.
  assert.equal(all.bayWindows.length, 5);
  assert.equal(all.openings.filter((o) => o.kind === 'door').length, 1);
  for (const bay of all.bayWindows) {
    const xs = bay.outline.map((p) => p[0]);
    if (bay.floor === 0) assert.ok(door.centre[0] < xs[0] || door.centre[0] > xs.at(-1), 'a bay on the door');
    // The balcony covers the middle half of the front of floor 1.
    else assert.ok(xs.at(-1) <= -0.25 * 10.92 + 1e-6 || xs[0] >= 0.25 * 10.92 - 1e-6, `a bay on the balcony ${xs}`);
  }
  const shop = generateBuilding({ style: 'western-1910-brick', bayWindows: [-1] });
  assert.deepEqual(shop.bayWindows.map((w) => w.floor).sort(), [1, 2], 'the ground floor is shop windows');
});

test('the top bay stays under the eaves, and bays under a porch roof or a balcony clear them', () => {
  const wrong = [];
  for (const roof of ['hip', 'gable', 'hip-gable', 'shed'])
    for (const pitch of [10, 24.2, 40])
      for (const overhang of [0, 0.25, 0.6, 1.5])
        for (const bayWindowDepth of [0.45, 1.2])
          for (const bayWindowSides of [[0], [1]]) {
            const o = { ...HOUSE, roof, pitch, overhang, bayWindowDepth, bayWindowSides, detail: 'far' },
              b = generateBuilding(o);
            for (const bay of b.bayWindows.filter((w) => w.floor === 1)) {
              // The cap: 0.24 m over the head at the wall, 0.15 m at its edge.
              bay.outline.forEach(([x, z], i) => {
                const cap = bay.head + (i === 0 || i === bay.outline.length - 1 ? 0.24 : 0.15),
                  cover = b.roofHeight(x, z);
                if (Number.isFinite(cover) && cap > cover - 0.03)
                  wrong.push(`${roof} ${pitch} ${overhang} ${bayWindowDepth}: cap ${cap} under roof ${cover}`);
              });
              assert.ok(bay.head - bay.sill >= 0.5 - 1e-9);
            }
          }
  assert.deepEqual(wrong.slice(0, 5), []);
  const porch = generateBuilding({ style: 'western-1910-house', bayWindows: [0, 2], bayWindowFrom: 'floor' });
  for (const bay of porch.bayWindows) {
    if (bay.floor === 0) assert.equal(bay.from, 'floor');
    else {
      assert.equal(bay.from, 'sill', 'no floor bay through the porch roof');
      assert.ok(bay.base >= porch.floors[1] + 0.3, 'over the porch roof');
    }
    if (bay.floor === 0) assert.ok(bay.head + 0.24 <= porch.floors[1] - 0.05, 'under the porch roof');
  }
  assert.equal(porch.bayWindows.length, 4);
  // Under a balcony's slab (0.16 m below its floor).
  const under = generateBuilding({ width: 10.92, balconyWidth: 1, window: [1.69, 2.4], bayWindows: [0, 3] });
  for (const bay of under.bayWindows.filter((w) => w.floor === 0))
    assert.ok(bay.head + 0.24 <= under.floors[1] - 0.16, `${bay.head}`);
});

test('a joined plan makes a bay only where it stands clear of the other blocks', () => {
  let made = 0;
  const wrong = [];
  for (const plan of ['L', 'T', 'U', 'cross'])
    for (const tower of ['none', 'front-right'])
      for (const wingSide of ['front', 'back'])
        for (const width of [9.1, 12.3, 15.7]) {
          const o = {
              plan,
              tower,
              wingSide,
              width,
              balcony: 0,
              bayWindows: [0, 1, 2, 3, 4, 5],
              bayWindowSides: [0, 1, 2, 3],
              bayWindowDepth: 0.8,
              bayWindowShape: 'canted-45',
            },
            b = generateBuildingPlan(o);
          made += b.bayWindows.length;
          for (const bay of b.bayWindows)
            for (const [x, z] of bay.outline.slice(1, -1))
              for (const y of [bay.base, (bay.base + bay.head) / 2, bay.head])
                b.blocks.forEach((_, i) => {
                  if (b.insideBlock(i, x, y, z)) wrong.push(`${plan} ${tower} ${width}: a bay in block ${i}`);
                });
        }
  assert.deepEqual(wrong.slice(0, 5), []);
  // The plans still hold their bays: only the places another block takes go without.
  assert.ok(made > 600, `${made} bays`);
});

test('settings and town lots carry bay windows', () => {
  const o = buildingOptionsFromSettings({
    bayWindow: 'both',
    bayWindowSides: 'front-back',
    bayWindowFloors: 'upper',
    bayWindowShape: 'bow',
    bayWindowDepth: 0.6,
  });
  assert.deepEqual(o.bayWindows, [0, 63]);
  assert.deepEqual(o.bayWindowFloors, [1]);
  const b = generateBuilding({ ...o, balcony: 0 });
  assert.equal(b.bayWindows.length, 4);
  assert.ok(b.bayWindows.every((w) => w.floor === 1 && w.shape === 'bow'));
  assert.equal(
    generateBuilding(buildingOptionsFromSettings({ storeys: 1, bayWindow: 'left', bayWindowFloors: 'upper' }))
      .bayWindows.length,
    0,
  );
  // A lot keeps its margin beyond the bays.
  const lot = { centre: [0, 0], size: [10, 10], along: [1, 0], floor: 0 },
    [plain] = townBuildings([lot]),
    [bayed] = townBuildings([lot], { override: { bayWindows: [0], bayWindowSides: [0, 1], bayWindowDepth: 0.9 } });
  assert.ok(bayed.width + 2 * (1 + 0.93) <= 10 + 1e-9, `${bayed.width}`);
  assert.ok(bayed.depth + 2 * (1 + 0.93) <= 10 + 1e-9, `${bayed.depth}`);
  assert.ok(plain.width >= bayed.width);
});
