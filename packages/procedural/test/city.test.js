import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBuilding } from '../dist/building-rules.js';
import { CITY_SETTINGS, cityOptionsFromSettings, citySettingDefaults } from '../dist/building-settings.js';
import { buildCity, generateCity } from '../dist/city.js';

// Polygons out of generateCity are counter-clockwise from above, which is negative shoelace area in (x, z).
const area = (p) =>
  p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
/** How far a point is outside a convex polygon (0 or less inside). */
const outside = (p, q) => {
  const sign = Math.sign(area(p));
  let worst = -Infinity;
  p.forEach((a, i) => {
    const b = p[(i + 1) % p.length],
      l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    worst = Math.max(worst, (-sign * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]))) / l);
  });
  return worst;
};
/** Two convex polygons overlap by more than `slack` when no edge direction of either separates them. */
const overlap = (a, b, slack = 1e-4) =>
  ![a, b].some((p) =>
    p.some((s, i) => {
      const e = p[(i + 1) % p.length],
        n = [e[1] - s[1], s[0] - e[0]],
        l = Math.hypot(...n),
        range = (q) => q.map((v) => (v[0] * n[0] + v[1] * n[1]) / l),
        [x, y] = [range(a), range(b)];
      return Math.min(...x) >= Math.max(...y) - slack || Math.min(...y) >= Math.max(...x) - slack;
    }),
  );
const convex = (p) => {
  const sign = Math.sign(area(p));
  return p.every((a, i) => {
    const b = p[(i + 1) % p.length],
      c = p[(i + 2) % p.length];
    return sign * ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > -1e-4;
  });
};
const corners = ({ width, depth, origin, yaw }) =>
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => {
    const x = (sx * width) / 2,
      z = (sz * depth) / 2;
    return [origin[0] + x * Math.cos(yaw) + z * Math.sin(yaw), origin[2] - x * Math.sin(yaw) + z * Math.cos(yaw)];
  });

const CASES = {
  grid: {},
  'turned grid': { angle: 0.5, irregularity: 1, seed: 5 },
  organic: { layout: 'organic', irregularity: 1, seed: 3 },
  radial: { layout: 'radial', irregularity: 0.6, seed: 4 },
  'old town': { era: 'western-1910', width: 300, depth: 240, seed: 9 },
  'five sides': {
    layout: 'organic',
    outline: [
      [-180, -60],
      [-40, -190],
      [170, -90],
      [140, 130],
      [-110, 150],
    ],
  },
  'radial off centre': { layout: 'radial', centre: [60, -40], spokes: 5, width: 500, depth: 300 },
  'narrow lanes': { streetWidth: 4, sidewalk: 0, avenueEvery: 0, blockWidth: 40, blockDepth: 30, lotFrontage: 8 },
};

for (const [name, options] of Object.entries(CASES))
  test(`${name}: blocks, lots and footprints nest and never overlap`, () => {
    const city = generateCity(options);
    assert.ok(city.blocks.length >= 6, `blocks ${city.blocks.length}`);
    assert.ok(city.buildings.length >= city.blocks.length, `buildings ${city.buildings.length}`);
    for (const b of city.blocks) {
      assert.ok(convex(b.polygon) && convex(b.inner.length ? b.inner : b.polygon));
      assert.ok(area(b.polygon) < 0, 'counter-clockwise from above');
      assert.ok(Math.abs(-area(b.polygon) - b.area) < 1e-6 * b.area);
      for (const q of b.polygon) assert.ok(outside(city.edge, q) < -1.9, 'kerb inside the asphalt edge');
      for (const q of b.inner) assert.ok(outside(b.polygon, q) < 1e-4);
    }
    for (let i = 0; i < city.blocks.length; i++)
      for (let j = i + 1; j < city.blocks.length; j++)
        assert.ok(!overlap(city.blocks[i].polygon, city.blocks[j].polygon), `blocks ${i} and ${j} overlap`);
    for (const [i, lot] of city.lots.entries()) {
      for (const q of lot.polygon) assert.ok(outside(city.blocks[lot.block].inner, q) < 1e-4, `lot ${i} in its block`);
      for (let j = i + 1; j < city.lots.length; j++)
        if (city.lots[j].block === lot.block)
          assert.ok(!overlap(lot.polygon, city.lots[j].polygon), `lots ${i} and ${j} overlap`);
      assert.ok(Math.abs(Math.hypot(...lot.along) - 1) < 1e-9);
      assert.ok(Math.abs(lot.along[0] * lot.front[0] + lot.along[1] * lot.front[1]) < 1e-9);
    }
    for (const b of city.buildings) {
      const lot = city.lots[b.lot],
        c = corners(b.options);
      for (const q of c) assert.ok(outside(lot.polygon, q) < 1e-3, `footprint of lot ${b.lot} inside it`);
      // The front faces a street: walking out of the front leaves the block's inner polygon within the lot's reach.
      const { origin, yaw, depth } = b.options,
        front = [Math.sin(yaw), Math.cos(yaw)];
      assert.ok(Math.abs(front[0] - lot.front[0]) + Math.abs(front[1] - lot.front[1]) < 1e-9);
      let reach = depth / 2;
      while (outside(lot.polygon, [origin[0] + front[0] * reach, origin[2] + front[1] * reach]) < 0) reach += 0.05;
      const past = [origin[0] + front[0] * (reach + 0.1), origin[2] + front[1] * (reach + 0.1)];
      assert.ok(outside(city.blocks[lot.block].inner, past) > 0, `lot ${b.lot} fronts a street`);
    }
  });

for (const [name, options] of Object.entries(CASES))
  test(`${name}: the roads are one connected network round the blocks`, () => {
    const { nodes, roads, blocks, options: o } = generateCity(options);
    const next = nodes.map(() => []);
    const ids = new Set();
    for (const r of roads) {
      assert.ok(r.from !== r.to && nodes[r.from] && nodes[r.to]);
      assert.equal(r.width, r.kind === 'avenue' ? o.avenueWidth : o.streetWidth);
      const [a, b] = [nodes[r.from], nodes[r.to]];
      assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - r.length) < 1e-9);
      next[r.from].push(r.to);
      next[r.to].push(r.from);
      ids.add([r.from, r.to].sort((x, y) => x - y).join());
      // No road runs through a block (merged junctions may shift a line by less than half a street).
      for (const t of [0.25, 0.5, 0.75]) {
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        for (const block of blocks) assert.ok(outside(block.polygon, q) > -1e-3, `road ${r.from}-${r.to} in a block`);
      }
    }
    assert.equal(ids.size, roads.length, 'no road twice');
    const seen = new Set([0]),
      queue = [0];
    for (const k of queue)
      for (const j of next[k])
        if (!seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
    assert.equal(seen.size, nodes.length, 'every junction is reached');
  });

test('every part of every building stays on its own lot, porches, steps, balconies and eaves included', () => {
  for (const options of [
    { width: 240, depth: 200, seed: 2 },
    { width: 240, depth: 200, era: 'western-1910', seed: 8, layout: 'organic' },
    {
      width: 200,
      depth: 200,
      layout: 'radial',
      styles: {
        residential: { 'western-1910-false-front': 1, 'western-1910-depot': 1 },
        commercial: { 'western-1910-house': 1 },
      },
    },
  ]) {
    const city = generateCity(options);
    let checked = 0;
    for (const b of city.buildings) {
      const lot = city.lots[b.lot].polygon;
      for (const [name, part] of Object.entries(generateBuilding({ ...b.options, detail: 'near' }).parts)) {
        let worst = -Infinity;
        for (let i = 0; i < part.positions.length; i += 3)
          worst = Math.max(worst, outside(lot, [part.positions[i], part.positions[i + 2]]));
        assert.ok(worst < 0.02, `${b.options.style} ${name} reaches ${worst.toFixed(2)} m past its lot`);
      }
      checked++;
    }
    assert.ok(checked > 20);
  }
});

test('the same options give the same city and another seed another', () => {
  const a = generateCity({ layout: 'organic', seed: 12 });
  assert.deepEqual(generateCity({ layout: 'organic', seed: 12 }), a);
  assert.notDeepEqual(generateCity({ layout: 'organic', seed: 13 }).buildings, a.buildings);
});

test('land use and height follow the distance from the centre', () => {
  const city = generateCity({ width: 800, depth: 800, centre: [100, -50], parks: 0.1, maxStoreys: 40, seed: 6 }),
    R = city.options.downtownRadius,
    far = (c) => Math.hypot(c[0] - 100, c[1] + 50);
  for (const b of city.blocks) {
    if (b.use === 'downtown') assert.ok(far(b.centre) < R);
    if (b.use === 'residential') assert.ok(far(b.centre) >= 2 * R);
    if (b.use === 'industrial') assert.ok(far(b.centre) >= 1.5 * R);
  }
  assert.equal(city.blocks.filter((b) => b.use === 'park').length, Math.round(0.1 * city.blocks.length));
  for (const lot of city.lots) assert.notEqual(lot.use, 'park');
  const mean = (use) => {
    const list = city.buildings.filter((b) => b.use === use);
    return list.reduce((s, b) => s + b.options.storeys.length, 0) / list.length;
  };
  assert.ok(mean('downtown') > 2 * mean('commercial'), `${mean('downtown')} over ${mean('commercial')}`);
  const tallest = Math.max(...city.buildings.map((b) => b.options.storeys.length));
  assert.ok(tallest > 12 && tallest <= 40, `tallest ${tallest}`);
  const village = generateCity({ downtownRadius: 0, parks: 0, industry: 0 });
  assert.ok(village.blocks.every((b) => b.use === 'residential'));
  assert.ok(village.buildings.every((b) => b.options.storeys.length <= 2));
  const parkland = generateCity({ parks: 1 });
  assert.equal(parkland.buildings.length, 0);
  assert.ok(parkland.trees.length > 100);
});

test('trees and lamps stand on the pavement or in parks, clear of the road', () => {
  const city = generateCity({ layout: 'organic', origin: [1000, 5, -2000] });
  assert.ok(city.trees.length > 50 && city.lamps.length > 20);
  for (const { position, yaw } of [...city.trees, ...city.lamps]) {
    assert.equal(position[1], 5.15);
    assert.ok(Number.isFinite(yaw));
    assert.ok(
      city.blocks.some((b) => outside(b.polygon, [position[0], position[2]]) < -0.3),
      `prop at ${position} is on no block`,
    );
  }
  assert.equal(generateCity({ treeSpacing: 0, lampSpacing: 0 }).trees.length, 0);
});

test('origin moves the whole city', () => {
  const a = generateCity({ seed: 3 }),
    b = generateCity({ seed: 3, origin: [500, 20, -300] });
  for (const [i, building] of b.buildings.entries()) {
    const o = a.buildings[i].options.origin;
    assert.deepEqual(building.options.origin, [o[0] + 500, o[1] + 20, o[2] - 300]);
  }
  assert.deepEqual(b.nodes[0], [a.nodes[0][0] + 500, a.nodes[0][1] - 300]);
});

test('buildCity: ground faces up, indices in range, triangles counted, detail by distance, chunks hold their part', async () => {
  const city = generateCity({ width: 300, depth: 260, seed: 7 }),
    progress = [];
  const meshes = await buildCity(city, { chunk: 100, onProgress: (n, total) => progress.push([n, total]) });
  let triangles = 0;
  const names = new Set();
  for (const { name, geometry: g, chunk, material } of meshes.parts) {
    names.add(name);
    const vertices = g.positions.length / 3;
    assert.equal(g.normals.length, vertices * 3);
    assert.equal(g.uvs.length, vertices * 2);
    assert.equal(g.tangents.length, vertices * 4);
    assert.ok(g.indices.every((i) => i < vertices));
    assert.ok(g.positions.every(Number.isFinite));
    assert.ok(material.color.every((c) => c >= 0 && c <= 1));
    triangles += g.indices.length / 3;
    if (['road', 'pavement', 'paving', 'lawn', 'markings', 'centre-lines'].includes(name))
      for (let i = 0; i < g.indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => {
          const v = g.indices[i + k] * 3;
          return [g.positions[v], g.positions[v + 1], g.positions[v + 2]];
        });
        const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        assert.ok(up > -1e-6, `${name} triangle faces down`);
      }
    if (name === 'pavement' || name === 'lawn' || name === 'paving')
      for (let i = 0; i < vertices; i++) {
        assert.ok(Math.abs(g.positions[3 * i + 1] - 0.15) < 1e-6);
        // A block's ground is within one block of the chunk its middle is in.
        assert.ok(Math.abs(g.positions[3 * i] - (chunk[0] + 0.5) * 100) < 150);
      }
  }
  assert.equal(triangles, meshes.triangles);
  for (const name of [
    'road',
    'markings',
    'centre-lines',
    'kerb',
    'pavement',
    'walls',
    'roof',
    'glass',
    'trunk',
    'leaves',
    'lamp-post',
    'lamp-head',
  ])
    assert.ok(names.has(name), name);
  const { massing, far, mid, near } = meshes.buildings;
  assert.equal(massing + far + mid + near, city.buildings.length);
  assert.ok(near > 0 && mid > 0 && far > 0);
  assert.deepEqual(progress.at(-1), [city.buildings.length, city.buildings.length]);

  const distant = await buildCity(city, { focus: [5000, 0] });
  assert.equal(distant.buildings.massing, city.buildings.length);
  assert.ok(distant.triangles < meshes.triangles / 4, `${distant.triangles} against ${meshes.triangles}`);
  const plain = await buildCity(city, { detail: 'massing', markings: false });
  assert.ok(!plain.parts.some((p) => p.name === 'markings' || p.name === 'centre-lines'));
  const walls = (m) => new Set(m.parts.filter((p) => p.name === 'walls').map((p) => String(p.material.color))).size;
  assert.ok(walls(plain) > walls(await buildCity(city, { detail: 'massing', variants: 1 })));
});

test('massing stands on the same footprint and height as the detailed building', async () => {
  const city = generateCity({ width: 200, depth: 160, seed: 21, era: 'western-1910' });
  for (const b of city.buildings.slice(0, 20)) {
    const one = { ...city, blocks: [], roads: [], nodes: [], trees: [], lamps: [], buildings: [b] },
      meshes = await buildCity(one, { detail: 'massing', markings: false }),
      built = generateBuilding({ ...b.options, detail: 'far' });
    let top = 0;
    for (const p of meshes.parts.filter((p) => p.name !== 'road'))
      for (let i = 0; i < p.geometry.positions.length; i += 3) {
        top = Math.max(top, p.geometry.positions[i + 1] - b.options.origin[1]);
        const q = [p.geometry.positions[i], p.geometry.positions[i + 2]];
        assert.ok(outside(city.lots[b.lot].polygon, q) < 0.05);
      }
    assert.ok(top > built.eaves - 0.01 && top < built.top + 0.5, `${b.options.style}: ${top} against ${built.eaves}`);
    // Massing normals point away from the building.
    for (const p of meshes.parts.filter((p) => p.name !== 'road')) {
      const { positions: v, normals: n } = p.geometry;
      for (let i = 0; i < v.length; i += 3) {
        const out =
          n[i] * (v[i] - b.options.origin[0]) + n[i + 2] * (v[i + 2] - b.options.origin[2]) + Math.max(0, n[i + 1]);
        assert.ok(out > -1e-4, `${p.name} faces in`);
      }
    }
  }
});

test('large cities plan in full and past the limits refuse', () => {
  for (const layout of ['grid', 'organic', 'radial']) {
    const city = generateCity({ layout, width: 2000, depth: 2000 });
    assert.ok(city.blocks.length > 500 && city.buildings.length > 4000, `${layout} ${city.buildings.length}`);
  }
  assert.throws(
    () =>
      generateCity({
        width: 4000,
        depth: 4000,
        blockWidth: 30,
        blockDepth: 30,
        lotFrontage: 6,
        lotDepth: 8,
        streetWidth: 4,
        sidewalk: 0,
      }),
    { name: 'MargoError', code: 'failed', message: /at most 20000 blocks and 60000 lots/ },
  );
});

test('bad options and aborts are refused', async () => {
  for (const bad of [
    null,
    { width: 10 },
    { depth: Number.NaN },
    { layout: 'hex' },
    { spokes: 2 },
    { avenueWidth: 5, streetWidth: 8 },
    { treeSpacing: 0.5 },
    { lampSpacing: 0.5 },
    { maxStoreys: 1, minStoreys: 2 },
    { seed: 1.5 },
    { era: 'now' },
    { centre: [900, 0] },
    { origin: [0, 0] },
    { styles: { downtown: {} } },
    { styles: { park: { 'japan-2011-house': 1 } } },
    { styles: { downtown: { castle: 1 } } },
    {
      outline: [
        [0, 0],
        [100, 0],
        [50, 10],
        [100, 100],
        [0, 100],
      ],
    },
    {
      outline: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
    },
    {
      // A five point star turns one way at every corner but goes round twice.
      outline: [0, 2, 4, 1, 3].map((k) => [
        200 * Math.cos((k * 2 * Math.PI) / 5),
        200 * Math.sin((k * 2 * Math.PI) / 5),
      ]),
    },
  ])
    assert.throws(() => generateCity(bad), { name: 'MargoError', code: 'failed' }, JSON.stringify(bad));
  const stop = AbortSignal.abort(new Error('stop'));
  assert.throws(() => generateCity({ signal: stop }), /stop/);
  const city = generateCity({ width: 200, depth: 200 });
  for (const bad of [
    { detail: 'low' },
    { focus: [0] },
    { distances: [100, 50, 200] },
    { chunk: 5 },
    { variants: 0 },
    { maxTriangles: 0 },
  ])
    await assert.rejects(buildCity(city, bad), { name: 'MargoError' }, JSON.stringify(bad));
  await assert.rejects(buildCity({}), { name: 'MargoError' });
  await assert.rejects(buildCity(city, { maxTriangles: 1000 }), { message: /passes 1000 triangles/ });
  await assert.rejects(buildCity(city, { signal: stop }), /stop/);
  const abort = new AbortController();
  await assert.rejects(
    buildCity(city, { signal: abort.signal, onProgress: () => abort.abort(new Error('enough')) }),
    /enough/,
  );
});

test("the city sliders cover every numeric and choice option, with the generator's own defaults", () => {
  const defaults = citySettingDefaults(),
    city = generateCity();
  for (const [name, value] of Object.entries(defaults)) assert.equal(city.options[name], value, name);
  assert.deepEqual(generateCity(cityOptionsFromSettings(defaults)).buildings, city.buildings);
  for (const name of Object.keys(city.options))
    if (!['centre', 'origin', 'styles', 'setback', 'spacing'].includes(name))
      assert.ok(name in defaults, `${name} has no slider`);
  for (const row of CITY_SETTINGS)
    for (const value of row.choices ?? [row.min, row.max]) {
      const o = { [row.name]: value };
      // Pairs that must stay in order move together.
      if (row.name === 'streetWidth') o.avenueWidth = 60;
      if (row.name === 'avenueWidth') o.streetWidth = 4;
      if (row.name === 'maxStoreys') o.minStoreys = 1;
      if (row.name === 'minStoreys') o.maxStoreys = 60;
      assert.ok(generateCity(cityOptionsFromSettings(o)).blocks.length > 0, `${row.name} ${value}`);
    }
  assert.throws(() => cityOptionsFromSettings({ height: 3 }), TypeError);
  assert.throws(() => cityOptionsFromSettings({ parks: 2 }), RangeError);
});

test('trees and lamps are meshed where the city places them, coarser with distance and left out on request', async () => {
  const city = generateCity({ width: 200, depth: 160, seed: 4 }),
    only = { ...city, blocks: [], roads: [], nodes: [], buildings: [] },
    of = (m, name) => m.parts.filter((p) => p.name === name),
    count = (m, name) => of(m, name).reduce((s, p) => s + p.geometry.indices.length / 3, 0);
  const full = await buildCity(only, { detail: 'near' }),
    coarse = await buildCity(only, { detail: 'far' }),
    massing = await buildCity(only, { detail: 'massing' });
  assert.ok(count(full, 'leaves') > 4 * count(coarse, 'leaves'));
  assert.equal(count(massing, 'leaves'), 8 * city.trees.length);
  assert.equal(of(massing, 'lamp-post').length, 0);
  assert.ok(count(full, 'lamp-head') === 12 * city.lamps.length, `${count(full, 'lamp-head')}`);
  const away = await buildCity(only, { focus: [4000, 4000] });
  assert.equal(count(away, 'leaves'), 8 * city.trees.length);
  const none = await buildCity(only, { furniture: false });
  assert.deepEqual(
    none.parts.map((p) => p.name),
    ['road'],
  );
  // Every vertex stands within a crown's or an arm's reach of its own place.
  const props = [...city.trees, ...city.lamps];
  for (const part of full.parts.filter((p) => p.name !== 'road')) {
    const v = part.geometry.positions;
    for (let i = 0; i < v.length; i += 3 * 17)
      assert.ok(
        props.some((p) => Math.hypot(v[i] - p.position[0], v[i + 2] - p.position[2]) < 4.5),
        `${part.name} at ${v[i]}, ${v[i + 2]}`,
      );
  }
});
