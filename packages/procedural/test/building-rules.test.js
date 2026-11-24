// Building rules (sheet row 14): each style set meets its period building code and survey sizes, the roofs have the
// shapes their rules give (hip ridge L - d, gable apex at d/2 tan pitch, a gable in the hip-and-gable, a shed rising to
// the front), walls have thickness with glass set back by the reveal, false fronts clear the roof, chimneys clear the
// roof as IRC R1003.9 asks, steps keep IRC R311.7.5, balconies keep the Japanese 1.1 m railing, and town lots each get
// one building facing their street.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDING_STYLES,
  BUILDING_STYLE_SETS,
  generateBuilding,
  townBuildings,
} from '@margoengine/procedural/building-rules';

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
const deg = (d) => (d * Math.PI) / 180;
const FT = 0.3048,
  IN = 0.0254;

test('every style at every detail builds finite, indexed geometry with tangents', () => {
  for (const style of BUILDING_STYLES)
    for (const detail of ['far', 'mid', 'near']) {
      const b = generateBuilding({ style, detail });
      for (const [name, g] of Object.entries(b.parts)) {
        const n = g.positions.length / 3;
        assert.ok(g.indices.length > 0 && g.indices.length % 3 === 0, `${style} ${name}`);
        assert.ok(g.positions.every(Number.isFinite) && g.normals.every(Number.isFinite), `${style} ${name} finite`);
        assert.ok(g.indices.every((i) => i < n), `${style} ${name} indices`);
        assert.equal(g.tangents.length, n * 4);
        assert.equal(g.uvs.length, n * 2);
        for (let i = 0; i < g.normals.length; i += 3)
          assert.ok(Math.abs(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) - 1) < 1e-4);
      }
      for (const part of ['walls', 'interior', 'roof', 'glass', 'base']) assert.ok(b.parts[part], `${style} ${detail} ${part}`);
    }
  // More detail is more geometry.
  const count = (detail) => Object.values(generateBuilding({ detail }).parts).reduce((a, g) => a + g.indices.length, 0);
  assert.ok(count('far') < count('mid') && count('mid') < count('near'));
});

test('2011 Japanese wooden house: Building Standard Law floor, ceiling and railing; 910 mm module; tile pitch', () => {
  const b = generateBuilding({ style: 'japan-2011-house' }),
    s = BUILDING_STYLE_SETS['japan-2011-house'];
  // Order art. 22: a wooden ground floor at least 45 cm over the ground.
  assert.ok(b.floors[0] >= 0.45, `floor ${b.floors[0]}`);
  // Order art. 21: ceiling at least 2.1 m (storey less the 0.2 m floor slab); usual floor to floor 2.8 to 3.0 m.
  for (const h of s.storeys) {
    assert.ok(h - 0.2 >= 2.1);
    assert.ok(h >= 2.7 && h <= 3.1, `storey ${h}`);
  }
  // The plan on the 910 mm module.
  for (const v of [s.width, s.depth, s.bayWidth]) assert.ok(Math.abs(v / 0.91 - Math.round(v / 0.91)) < 1e-6, `${v}`);
  // Tile roofs at 4 sun (21.8 degrees) or steeper.
  assert.equal(s.roofing, 'tile');
  assert.ok(s.pitch >= 21.8 && s.pitch <= 30);
  // Order art. 126: a balcony railing at least 1.1 m; the balcony has a full height sash onto it.
  assert.ok(b.railings.length > 0 && b.railings.every((h) => h >= 1.1));
  assert.ok(b.openings.some((o) => o.kind === 'balcony-door' && o.floor === 1 && o.height >= 1.9));
  assert.ok(!b.parts.chimney);
  assert.ok(b.parts.gutters);
});

test('2011 Japanese concrete building and fish market shed: storey heights, strip windows, flat parapet roof', () => {
  const c = generateBuilding({ style: 'japan-2011-concrete' });
  for (const h of BUILDING_STYLE_SETS['japan-2011-concrete'].storeys) assert.ok(h >= 3.3 && h <= 4.0);
  assert.equal(c.top.toFixed(2), (c.eaves + 1.1).toFixed(2), 'a 1.1 m parapet');
  const strip = c.openings.filter((o) => o.kind === 'window' && o.side === 0);
  assert.ok(strip.length > 0 && strip.every((o) => o.width > 2 * o.height), 'strip windows are wide bands');
  const w = generateBuilding({ style: 'japan-2011-warehouse' });
  assert.ok(w.eaves >= 5.5, 'a tall single storey');
  const big = w.openings.filter((o) => o.kind === 'door');
  assert.equal(big.length, 2);
  assert.ok(big.every((d) => d.width >= 4 && d.height >= 4), 'roller doors a truck fits through');
});

test('1910 frame house: ceilings, pitch, porch steps per IRC R311.7.5 and a chimney per IRC R1003.9', () => {
  const b = generateBuilding({ style: 'western-1910-house' }),
    s = BUILDING_STYLE_SETS['western-1910-house'];
  // 8 1/2 to 9 ft ceilings plus a floor: 2.6 to 3.2 m floor to floor.
  for (const h of s.storeys) assert.ok(h >= 2.6 && h <= 3.2);
  // 6 in 12 to 12 in 12.
  assert.ok(Math.tan(deg(s.pitch)) >= 0.5 && Math.tan(deg(s.pitch)) <= 1);
  assert.ok(b.steps.length >= 1);
  for (const f of b.steps) {
    assert.ok(f.rise <= 7.75 * IN + 1e-9, `riser ${f.rise}`);
    assert.ok(f.tread >= 10 * IN, `tread ${f.tread}`);
    assert.ok(Math.abs(f.rise * f.count - b.floors[0]) < 1e-9, 'the flight climbs to the floor');
  }
  // The chimney: 3 ft above where it leaves the roof, 2 ft above any roof within 10 ft.
  const { top, at } = b.chimney;
  const pass = b.roofHeight(at[0], at[1]);
  assert.ok(top >= pass + 3 * FT, `top ${top} over ${pass}`);
  for (let a = 0; a < 2 * Math.PI; a += 0.1)
    for (let r = 0; r <= 10 * FT; r += 0.2) {
      const h = b.roofHeight(at[0] + r * Math.cos(a), at[1] + r * Math.sin(a));
      if (Number.isFinite(h)) assert.ok(top >= h + 2 * FT - 1e-6, `roof ${h} near the chimney`);
    }
  // Double-hung sash about twice as tall as wide.
  const sash = b.openings.filter((o) => o.kind === 'window');
  assert.ok(sash.every((o) => o.height / o.width >= 1.6));
});

test('1910 brick block and false front: commercial ground floor, storefronts, false front clears the roof', () => {
  const b = generateBuilding({ style: 'western-1910-brick' }),
    g = BUILDING_STYLE_SETS['western-1910-brick'].storeys[0];
  assert.ok(g >= 12 * FT && g <= 15 * FT, 'a 12 to 15 ft shop floor');
  assert.ok(b.openings.filter((o) => o.kind === 'shop').length >= 2);
  assert.ok(b.openings.some((o) => o.kind === 'transom'));
  const f = generateBuilding({ style: 'western-1910-false-front' }),
    front = f.roofHeight(0, f.options.depth / 2 - 1e-3);
  assert.ok(f.top >= front + 0.3, `false front ${f.top} over the roof at the front ${front}`);
  assert.ok(f.top >= f.roofHeight(0, 0) - 0.5, 'and stands about as high as the ridge');
  assert.ok(f.parts.awning);
  const stepped = generateBuilding({ style: 'western-1910-false-front', falseFrontShape: 'stepped' });
  assert.ok(stepped.top > f.top - 1e-9);
});

test('roof rules: hip ridge L - d, gable apex at d/2 tan pitch, a hip-and-gable gable, a shed rising to the front', () => {
  const base = { width: 12, depth: 8, overhang: 0, pitch: 30, detail: 'far', balcony: 0, gutters: false };
  const t = Math.tan(deg(30));
  const ridgeSpan = (b) => {
    const r = b.parts.roof,
      top = bounds(r).hi[1];
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < r.positions.length; i += 3)
      if (r.positions[i + 1] > top - 1e-4) {
        lo = Math.min(lo, r.positions[i]);
        hi = Math.max(hi, r.positions[i]);
      }
    return hi - lo;
  };
  const hip = generateBuilding({ ...base, roof: 'hip' }),
    gable = generateBuilding({ ...base, roof: 'gable' });
  // The covering (0.06 m tile) lies on the slope, so its ridge ends sit out along each hip by 0.06 sin(pitch).
  const cover = 2 * 0.06 * Math.sin(deg(30));
  assert.ok(Math.abs(ridgeSpan(hip) - (12 - 8 + cover)) < 1e-3, `hip ridge ${ridgeSpan(hip)}`);
  assert.ok(Math.abs(ridgeSpan(gable) - 12) < 1e-3);
  const apex = gable.eaves + 4 * t;
  assert.ok(Math.abs(gable.roofHeight(0, 0) - (apex + 0.06)) < 1e-6, 'covering on the ridge');
  assert.ok(Math.abs(hip.roofHeight(0, 0) - gable.roofHeight(0, 0)) < 1e-9);
  // Hips: the roof falls at the same pitch toward the end walls.
  assert.ok(Math.abs(hip.roofHeight(5, 0) - (hip.eaves + 1 * t + 0.06)) < 1e-6);
  // Gable walls: the end walls rise to the apex.
  assert.ok(Math.abs(bounds(gable.parts.walls).hi[1] - apex) < 1e-6);
  const irimoya = generateBuilding({ ...base, roof: 'hip-gable', gableInset: 0.5 });
  assert.ok(Math.abs(ridgeSpan(irimoya) - (12 - 4)) < 1e-3, 'ridge shortened by the inset at each end');
  assert.ok(bounds(irimoya.parts.walls).hi[1] > irimoya.eaves + 1, 'its small gables stand above the walls');
  const shed = generateBuilding({ ...base, roof: 'shed', ridge: 'x' });
  assert.ok(shed.roofHeight(0, 3.9) > shed.roofHeight(0, -3.9) + 7.8 * t - 1e-6, 'high side to the front');
  const flat = generateBuilding({ ...base, roof: 'flat', parapet: 0.9 });
  assert.ok(Math.abs(flat.top - (flat.eaves + 0.9)) < 1e-6);
});

test('walls have thickness and glass sits back by the reveal', () => {
  const wall = 0.3,
    reveal = 0.12,
    b = generateBuilding({ style: 'western-1910-brick', wall, reveal, detail: 'far', storefront: false }),
    D = b.options.depth;
  const inner = b.parts.interior,
    glass = b.parts.glass;
  let frontInner = -Infinity;
  for (let i = 0; i < inner.positions.length; i += 3)
    if (inner.normals[i + 2] < -0.99) frontInner = Math.max(frontInner, inner.positions[i + 2]);
  assert.ok(Math.abs(frontInner - (D / 2 - wall)) < 1e-5, `inner face ${frontInner}`);
  let frontGlass = -Infinity;
  for (let i = 0; i < glass.positions.length; i += 3)
    if (glass.normals[i + 2] > 0.99) frontGlass = Math.max(frontGlass, glass.positions[i + 2]);
  assert.ok(Math.abs(frontGlass - (D / 2 - reveal)) < 1e-5, `glass ${frontGlass}`);
  // No wall face crosses an opening: every window's middle is clear of the outer wall.
  for (const o of b.openings.filter((p) => p.side === 0)) {
    const w = b.parts.walls;
    for (let t = 0; t < w.indices.length; t += 3) {
      const a = w.indices[t] * 3;
      if (w.normals[a + 2] < 0.99 || Math.abs(w.positions[a + 2] - D / 2) > 1e-6) continue;
      const xs = [0, 1, 2].map((k) => w.positions[w.indices[t + k] * 3]),
        ys = [0, 1, 2].map((k) => w.positions[w.indices[t + k] * 3 + 1]);
      const inside = o.centre[0] > Math.min(...xs) + 1e-6 && o.centre[0] < Math.max(...xs) - 1e-6 && o.centre[1] > Math.min(...ys) + 1e-6 && o.centre[1] < Math.max(...ys) - 1e-6;
      assert.ok(!inside, 'a wall cell over an opening');
    }
  }
});

test('placement, determinism and option errors', () => {
  const a = generateBuilding({ seed: 4, detail: 'near' }),
    b = generateBuilding({ seed: 4, detail: 'near' });
  assert.deepEqual(a.parts.frames.positions, b.parts.frames.positions);
  const moved = generateBuilding({ origin: [100, 2, -50], yaw: Math.PI / 2 }),
    still = generateBuilding();
  // The front (+z) now faces +x.
  const door = moved.openings.find((o) => o.kind === 'door');
  assert.ok(door.centre[0] > 100 + 3 && Math.abs(door.centre[2] + 50) < 4);
  assert.ok(Math.abs(bounds(moved.parts.walls).lo[1] - (bounds(still.parts.walls).lo[1] + 2)) < 1e-5);
  assert.throws(() => generateBuilding({ width: 1 }), RangeError);
  assert.throws(() => generateBuilding({ roof: 'dome' }), RangeError);
  assert.throws(() => generateBuilding({ storeys: [] }), RangeError);
  assert.throws(() => generateBuilding({ style: 'castle' }), RangeError);
  assert.throws(() => generateBuilding({ pitch: '30' }), TypeError);
});

test('townBuildings: one building a lot, inside it, its door toward the street', () => {
  const lots = [];
  for (let i = 0; i < 12; i++)
    lots.push({ centre: [i * 16, 0], size: [14, 18], along: [1, 0], floor: 1 + i * 0.1, front: i % 2 ? [0, 1] : [0, -1] });
  const opts = townBuildings(lots, { styles: { 'japan-2011-house': 2, 'japan-2011-warehouse': 0, 'japan-2011-concrete': 1 }, margin: 1 });
  assert.equal(opts.length, lots.length);
  for (let i = 0; i < lots.length; i++) {
    const o = opts[i],
      lot = lots[i],
      b = generateBuilding(o);
    assert.notEqual(o.style, 'japan-2011-warehouse');
    for (const [x, z] of b.footprint) {
      assert.ok(Math.abs(x - lot.centre[0]) <= lot.size[0] / 2 - 1 + 1e-6, `lot ${i} x`);
      assert.ok(Math.abs(z - lot.centre[1]) <= lot.size[1] / 2 - 1 + 1e-6, `lot ${i} z`);
    }
    const door = b.openings.find((p) => p.kind === 'door');
    assert.ok((door.centre[2] - lot.centre[1]) * lot.front[1] > 0, `lot ${i} door faces its street`);
    assert.ok(Math.abs(bounds(b.parts.base).hi[1] - (lot.floor + b.options.plinth)) < 1e-5, 'floor on the pad');
  }
  assert.throws(() => townBuildings(lots, { styles: { castle: 1 } }), RangeError);
});
