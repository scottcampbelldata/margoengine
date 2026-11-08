// /splines: roads and paths. Settings are checked with messages that name the fix; polylines, Catmull-Rom and B-spline
// curves sample in integers through (or from) their points; a carved height flattens or cuts the ground under a path and
// leaves the rest alone; painting goes through the editor (exact undo, replay, any order); placement keeps off the
// paths; every sample depends on its own position only, so tiles meet without seams, worker replicas give the page's
// bytes and saved worlds load back; golden digests lock the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomeEditor } from '../dist/editor.js';
import { loadWorld, saveWorld } from '../dist/io.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets } from '../dist/presets.js';
import { heightsOf } from '../dist/region.js';
import { createRelief } from '../dist/relief.js';
import { carvePaths, definePath, paintPaths, pathEdits, pathExclusions } from '../dist/splines.js';
import { takeLoaded, ThreadWebWorker } from './thread-worker.js';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';

const golden = JSON.parse(readFileSync(new URL('./golden/splines.json', import.meta.url), 'utf8'));
const sha = (...arrays) => {
  const hash = createHash('sha256');
  for (const a of arrays) hash.update(a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(1));
  return hash.digest('hex');
};
const road = {
    points: [
      [-230, -60],
      [-60, 30],
      [80, -20],
      [230, 50],
    ],
    curve: 'catmull-rom',
    width: 6,
    edge: 4,
    biome: 'road',
    mask: 'roads',
    carve: { grade: 40, depth: 0.3 },
  },
  track = {
    points: [
      [-100, 200],
      [0, -200],
      [120, -180],
    ],
    curve: 'b-spline',
    width: 3,
    edge: 2,
    falloff: 'linear',
    mask: 'roads',
    carve: { mode: 'cut', depth: 1.5 },
  },
  lane = {
    points: [
      [-240, 120],
      [240, 140],
    ],
    width: 2.5,
    edge: 1,
    biome: 'road',
    strength: 0.6,
  };
const roadBiome = defineBiome({
  id: 'road',
  climate: { custom: { 'mask/road-only': [0.5, null] } },
  ground: [{ material: 'gravel' }],
});
const biomes = [presets.temperate, presets.alpine, presets.wetland, presets.boreal, roadBiome];
const base = { seed: 9, size: [512, 512], workers: false, ecotone: 0, biomes };
const tiles = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];
const digests = async (world) => Promise.all(tiles.map(([x, z]) => world.digest(x, z)));
const rasters = (world, name) => tiles.map(([x, z]) => world.readLayer(name, x, z));

test('path settings are checked, with messages that name the fix', () => {
  const ok = {
    points: [
      [0, 0],
      [10, 0],
    ],
  };
  assert.throws(() => definePath(null), TypeError);
  for (const points of [
    undefined,
    [[0, 0]],
    [[0, 0], [1]],
    [
      [0, 0],
      [NaN, 1],
    ],
    [
      [0, 0],
      [2e6, 0],
    ],
  ])
    assert.throws(() => definePath({ points }), /2 to 65,536 points/);
  const cases = [
    [{ curve: 'bezier' }, /curve is 'polyline'/],
    [{ closed: 1 }, /closed option is true or false/],
    [{ step: 0.1 }, /step is the spacing/],
    [{ width: 0 }, /width is a number of metres, 0.1..2,000/],
    [{ width: 2001 }, /width is a number/],
    [{ edge: -1 }, /edge is a number of metres/],
    [{ falloff: 'hard' }, /falloff is 'smooth'/],
    [{ strength: 2 }, /strength is a number 0..1/],
    [{ biome: 'Road' }, /biome is a biome id/],
    [{ mask: 'a b' }, /mask is a name/],
    [{ carve: { mode: 'raise' } }, /carve is \{ mode/],
    [{ carve: { depth: 101 } }, /carve is \{ mode/],
    [{ carve: { grade: -1 } }, /carve is \{ mode/],
    [{ carve: null }, /carve is \{ mode/],
  ];
  for (const [bad, message] of cases) assert.throws(() => definePath({ ...ok, ...bad }), message, JSON.stringify(bad));
  assert.throws(() => definePath({ ...ok, closed: 1 }), TypeError);
  // Too many samples: 300 spans of 1,024 samples each.
  const far = Array.from({ length: 300 }, (_, i) => [i * 2000 - 300000, (i & 1) * 500]);
  assert.throws(() => definePath({ points: far, curve: 'catmull-rom', step: 0.25 }), /over 262,144 points; use fewer/);
  assert.throws(() => carvePaths('road'), /carvePaths takes an array/);
  assert.throws(() => pathExclusions({}), /pathExclusions takes an array/);
  assert.throws(() => pathEdits(), /pathEdits takes an array/);
  assert.throws(() => paintPaths({}, []), /paintPaths takes a BiomeEditor/);
  // The settings come back frozen with every default, as plain data.
  const p = definePath({ ...ok, mask: 'mask/roads' });
  assert.deepEqual(JSON.parse(JSON.stringify(p.options)), {
    points: [
      [0, 0],
      [10, 0],
    ],
    curve: 'polyline',
    closed: false,
    step: 2,
    width: 4,
    edge: 2,
    falloff: 'smooth',
    strength: 1,
    mask: 'roads',
    carve: { mode: 'flatten', depth: 0, grade: 24 },
  });
  assert.ok(Object.isFrozen(p.options) && Object.isFrozen(p.options.points[0]) && Object.isFrozen(p.options.carve));
});

test('lines: polylines and Catmull-Rom curves pass through their points, B-splines start and end at theirs', () => {
  const pts = [
      [0, 0],
      [40.5, 12],
      [90, -30],
      [130, 5],
    ],
    has = (line, [x, z]) => {
      for (let i = 0; i < line.length; i += 2) if (line[i] === x * 1000 && line[i + 1] === z * 1000) return true;
      return false;
    };
  const poly = definePath({ points: pts });
  assert.deepEqual(
    [...poly.line],
    pts.flatMap(([x, z]) => [x * 1000, z * 1000]),
  );
  const cr = definePath({ points: pts, curve: 'catmull-rom', step: 1 });
  for (const p of pts) assert.ok(has(cr.line, p), `catmull-rom passes ${p}`);
  assert.ok(cr.length > poly.length && cr.length < poly.length * 1.2, `${cr.length} vs ${poly.length}`);
  const bs = definePath({ points: pts, curve: 'b-spline' });
  assert.ok(has(bs.line, pts[0]) && has(bs.line, pts[3]));
  assert.ok(!has(bs.line, pts[1]), 'a B-spline smooths past its inner points');
  // Closed curves come back to their start.
  for (const curve of ['polyline', 'catmull-rom', 'b-spline']) {
    const l = definePath({ points: pts, curve, closed: true }).line;
    assert.deepEqual([l[0], l[1]], [l[l.length - 2], l[l.length - 1]], curve);
  }
  // Repeated points and zero-length pieces are dropped; a path of one repeated point is a disc of one segment.
  assert.deepEqual(
    [
      ...definePath({
        points: [
          [1, 1],
          [1, 1],
          [5, 1],
          [5, 1],
        ],
      }).line,
    ],
    [1000, 1000, 5000, 1000],
  );
  assert.deepEqual(
    [
      ...definePath({
        points: [
          [3, 4],
          [3, 4],
          [3, 4],
        ],
        curve: 'catmull-rom',
      }).line,
    ],
    [3000, 4000, 3000, 4000],
  );
  // No piece over 256 m: a 1 km straight is four.
  assert.deepEqual(
    [
      ...definePath({
        points: [
          [0, 0],
          [1000, 0],
        ],
      }).line,
    ],
    [0, 0, 250000, 0, 500000, 0, 750000, 0, 1000000, 0],
  );
  // Every sample is an integer and every neighbour distinct.
  for (const l of [cr.line, bs.line])
    for (let i = 2; i < l.length; i += 2) assert.ok(l[i] !== l[i - 2] || l[i + 1] !== l[i - 1]);
});

test('carving: no paths changes nothing; flatten levels the ground across a path; cut lowers it by its depth', async () => {
  const plain = await BiomeWorld.create(base),
    none = await BiomeWorld.create({ ...base, height: carvePaths([]) });
  assert.deepEqual(await digests(none), await digests(plain), 'an empty carve is the plain world');
  const straight = {
      points: [
        [-250, 10],
        [250, 10],
      ],
      width: 8,
      edge: 6,
    },
    flat = await BiomeWorld.create({ ...base, height: carvePaths([straight]) }),
    cut = await BiomeWorld.create({ ...base, height: carvePaths([{ ...straight, carve: { mode: 'cut', depth: 2 } }]) });
  const h = async (w, x, z) =>
    (await w.tile(x >= 256 ? 1 : 0, z >= 256 ? 1 : 0)).layer('height').data[(z & 255) * 256 + (x & 255)];
  for (const i of [20, 200, 300, 480]) {
    // Cells 7..13 m north of the world's centre line z = 0 are the cells within the 4 m half width of z = 10.
    const row = [];
    for (let j = 262; j <= 270; j++) row.push(await h(flat, i, j));
    assert.ok(
      row.every((v) => v === row[0]),
      `flat across the road at x cell ${i}: ${row}`,
    );
    for (let j = 262; j <= 270; j++) assert.equal(await h(cut, i, j), (await h(plain, i, j)) - 2000);
    // Far from the road, the ground is the plain ground.
    assert.equal(await h(flat, i, 100), await h(plain, i, 100));
    assert.equal(await h(cut, i, 400), await h(plain, i, 400));
  }
  // heightAt stands on the carved ground too.
  assert.equal(flat.heightAt(1, 10), (await h(flat, 257, 266)) / 1000);
  // The edge blends: between the bed and the ground, never beyond either.
  for (const j of [271, 272, 273, 274, 275]) {
    const v = await h(cut, 300, j),
      g = await h(plain, 300, j);
    assert.ok(v <= g && v >= g - 2000, `${j}: ${v} within ${g - 2000}..${g}`);
  }
});

test('seams: a carved height is a function of position, so tiles and any grid of it agree', async () => {
  const paths = [road, track],
    heights = heightsOf(carvePaths(paths), [-256000, -256000], [512000, 512000], 9, createRelief),
    a = await BiomeWorld.create({ ...base, height: carvePaths(paths) }),
    b = await BiomeWorld.create({ ...base, height: carvePaths(paths) });
  // Tiles in opposite orders.
  const first = [];
  for (const [x, z] of tiles) first.push(await a.digest(x, z));
  const second = [];
  for (const [x, z] of [...tiles].reverse()) second.unshift(await b.digest(x, z));
  assert.deepEqual(second, first);
  // A grid across the tile border (both paths cross it) equals the two tiles' cells.
  const left = (await a.tile(0, 0)).layer('height').data,
    right = (await a.tile(1, 0)).layer('height').data,
    span = heights.grid(240, 0, 32, 256, 1000);
  for (let j = 0; j < 256; j++)
    for (let i = 0; i < 32; i++)
      assert.equal(span[j * 32 + i], i < 16 ? left[j * 256 + 240 + i] : right[j * 256 + i - 16], `${i}, ${j}`);
  // Coarse grids sample the same function: the region corners are every 16th cell.
  const coarse = heights.grid(0, 0, 17, 17, 16000);
  for (const [i, j] of [
    [3, 4],
    [8, 8],
    [15, 2],
  ])
    assert.equal(coarse[j * 17 + i], left[j * 16 * 256 + i * 16]);
});

test('order: paths in any order carve and paint the same bytes', async () => {
  const paths = [road, track, lane],
    shuffled = [lane, road, track],
    a = await BiomeWorld.create({ ...base, height: carvePaths(paths) }),
    b = await BiomeWorld.create({ ...base, height: carvePaths(shuffled) });
  assert.deepEqual(await digests(b), await digests(a));
  paintPaths(BiomeEditor.attach(a), paths);
  const eb = BiomeEditor.attach(b);
  for (const e of pathEdits(shuffled).reverse()) eb.apply(e);
  for (const name of ['paint/road', 'mask/roads']) assert.deepEqual(rasters(b, name), rasters(a, name), name);
  assert.deepEqual(await digests(b), await digests(a));
});

test('painting: one undo step, exact undo and redo, replay from data in another world, nothing for no paths', async () => {
  const world = await BiomeWorld.create(base),
    editor = BiomeEditor.attach(world),
    before = await digests(world);
  paintPaths(editor, []);
  assert.equal(editor.canUndo, false, 'no paths, no step');
  paintPaths(editor, [road, track, lane]);
  assert.equal(editor.edits.length, 4, 'road paints a biome and a mask, the track a mask, the lane a biome');
  assert.ok(editor.edits.every((e) => e.kind === 'path' && e.mode === 'max' && Object.isFrozen(e.path)));
  const after = rasters(world, 'mask/roads'),
    painted = await digests(world);
  assert.notDeepEqual(painted, before);
  // The mask is 255 on the paths and 0 far from them; the lane paints its 0.6 strength.
  const mask = world.readLayer('mask/roads', 0, 1);
  assert.ok(mask.some((v) => v === 255) && mask.some((v) => v === 0));
  assert.ok(Math.max(...world.readLayer('paint/road', 0, 1)) === 255);
  assert.equal(Math.max(...world.readLayer('paint/road', 1, 1).filter((_, k) => k >= 120 * 256 && k < 160 * 256)), 153);
  editor.undo();
  assert.deepEqual(rasters(world, 'mask/roads'), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(await digests(world), before);
  editor.redo();
  assert.deepEqual(rasters(world, 'mask/roads'), after);
  assert.deepEqual(await digests(world), painted);
  // Edits are plain data: through JSON and into a fresh world, the same bytes.
  const copy = await BiomeWorld.create(base),
    replay = BiomeEditor.attach(copy);
  for (const e of JSON.parse(JSON.stringify(editor.edits))) replay.apply(e);
  assert.deepEqual(await digests(copy), painted);
  // A path edit is checked like any edit.
  assert.throws(() => replay.apply({ ...editor.edits[0], path: { points: [] } }), /2 to 65,536 points/);
  assert.throws(() => replay.apply({ ...editor.edits[0], layer: 'paint/none' }), /biome edit layer/);
  // The golden bytes of the painted rasters.
  assert.equal(sha(...rasters(world, 'paint/road'), ...after), golden.painted);
});

test('placement keeps off paths: no stored object stands inside a path width', async () => {
  const world = await BiomeWorld.create({ ...base, ecotone: 24 }),
    exclusions = pathExclusions([road, track, lane]);
  assert.equal(exclusions.length, 3);
  // The 480 m lane comes as two pieces of 240 m.
  assert.deepEqual(exclusions[2], {
    kind: 'line',
    points: [
      [-240, 120],
      [0, 130],
      [240, 140],
    ],
    width: 2.5,
    verge: 1,
  });
  const placement = BiomePlacement.attach(world, { exclusions }),
    lines = [road, track, lane].map((p) => definePath(p));
  let checked = 0;
  for (const [x, z] of tiles) {
    const tile = await placement.tile(x, z);
    tile.forEachInstance((o) => {
      checked++;
      for (const { line, options } of lines)
        for (let i = 0; i + 2 < line.length; i += 2) {
          const ax = line[i] / 1000,
            az = line[i + 1] / 1000,
            dx = line[i + 2] / 1000 - ax,
            dz = line[i + 3] / 1000 - az,
            t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / (dx * dx + dz * dz || 1))),
            d = Math.hypot(o.x - ax - t * dx, o.z - az - t * dz);
          assert.ok(d >= options.width / 2 - 0.02, `object ${o.key} at ${o.x}, ${o.z} is ${d} m from a path`);
        }
    });
  }
  assert.ok(checked > 1000, `${checked} objects`);
  assert.equal(
    sha(...(await Promise.all(tiles.map(async ([x, z]) => (await placement.tile(x, z)).exclusion.data)))),
    golden.exclusion,
  );
});

test('placement exclusions read only nearby segments and give the bytes of a check against every segment', async () => {
  // A wandering line of 3,000 pieces over one tile; the exclusion raster against a brute-force test of every piece.
  const points = [];
  let x = -250,
    z = -250;
  for (let i = 0; i <= 3000; i++) {
    points.push([x, z]);
    const turn = Math.sin(i * 0.37) * 3 + Math.cos(i * 0.11) * 4;
    x = Math.max(-255, Math.min(-2, x + 2 + Math.round(turn)));
    z = Math.max(-255, Math.min(-2, z + ((i * 7919) % 5) - 1.6));
  }
  const world = await BiomeWorld.create(base),
    exclusion = { kind: 'line', points, width: 1.2 },
    tile = await BiomePlacement.attach(world, { exclusions: [exclusion] }).tile(0, 0),
    TICK = 256,
    t = (p) => [Math.round((p[0] + 256) * TICK), Math.round((p[1] + 256) * TICK)],
    half = Math.round(0.6 * TICK),
    seg = points.slice(1).map((p, i) => [...t(points[i]), ...t(p)]);
  let inside = 0;
  for (let j = 0; j < 256; j++)
    for (let i = 0; i < 256; i++) {
      const px = i * TICK + TICK / 2,
        pz = j * TICK + TICK / 2;
      let hit = false;
      for (const [ax, az, bx, bz] of seg) {
        const dx = bx - ax,
          dz = bz - az,
          len = dx * dx + dz * dz,
          dot = (px - ax) * dx + (pz - az) * dz;
        let d2;
        if (dot <= 0 || !len) d2 = (px - ax) ** 2 + (pz - az) ** 2;
        else if (dot >= len) d2 = (px - bx) ** 2 + (pz - bz) ** 2;
        else {
          const cross = (px - ax) * dz - (pz - az) * dx;
          d2 = Math.floor((cross * cross) / len);
        }
        if (d2 < half * half) {
          hit = true;
          break;
        }
      }
      assert.equal(tile.exclusion.data[j * 256 + i], hit ? 255 : 0, `${i}, ${j}`);
      if (hit) inside++;
    }
  assert.ok(inside > 1000, `${inside} cells`);
});

test('edge cases: self-crossing, huge widths, paths outside the world, thousands of segments', async () => {
  const world = await BiomeWorld.create(base),
    editor = BiomeEditor.attach(world);
  // A figure eight paints the union of its two loops, whichever way it is drawn.
  const eight = {
    points: [
      [-60, -60],
      [60, 60],
      [60, -60],
      [-60, 60],
      [-60, -60],
    ],
    curve: 'catmull-rom',
    width: 4,
    mask: 'eight',
  };
  paintPaths(editor, [eight]);
  const forward = rasters(world, 'mask/eight');
  editor.undo();
  paintPaths(editor, [{ ...eight, points: [...eight.points].reverse() }]);
  // A reversed Catmull-Rom curve runs the same points back to front; its samples round the other way, within a cell.
  const back = rasters(world, 'mask/eight');
  let differ = 0;
  for (let t = 0; t < 4; t++) for (let k = 0; k < 65536; k++) if (forward[t][k] !== back[t][k]) differ++;
  assert.ok(differ < 400, `${differ} cells differ`);
  editor.undo();
  // A polyline back to front is the same segments: the same bytes.
  paintPaths(editor, [{ ...eight, curve: 'polyline' }]);
  const poly = rasters(world, 'mask/eight');
  editor.undo();
  paintPaths(editor, [{ ...eight, curve: 'polyline', points: [...eight.points].reverse() }]);
  assert.deepEqual(rasters(world, 'mask/eight'), poly);
  editor.undo();
  // A 2 km wide road covers the world at full strength, quickly.
  // CPU time of this thread (the worlds here run with `workers: false`), so a busy machine cannot fail the budgets.
  let cpu = cpuTimer();
  paintPaths(editor, [
    {
      points: [
        [-400, 0],
        [400, 0],
      ],
      width: 2000,
      edge: 1000,
      mask: 'wide',
    },
  ]);
  assert.ok(rasters(world, 'mask/wide').every((r) => r.every((v) => v === 255)));
  let ms = cpu();
  assert.ok(ms < 200, `${ms} ms of CPU`);
  // A path outside the world writes nothing and carves nothing.
  const outside = {
    points: [
      [1000, 1000],
      [2000, 1500],
    ],
    width: 50,
    mask: 'outside',
  };
  paintPaths(editor, [outside]);
  assert.deepEqual(rasters(world, 'mask/outside'), [undefined, undefined, undefined, undefined]);
  const carvedOut = await BiomeWorld.create({ ...base, height: carvePaths([outside]) });
  assert.deepEqual(await digests(carvedOut), await digests(await BiomeWorld.create(base)));
  // Thousands of segments: a 4,000-point wander, carved and painted; each segment's weight is the same as the path's.
  const points = [];
  for (let i = 0; i < 4000; i++)
    points.push([-240 + (i % 400) * 1.2, -240 + Math.floor(i / 400) * 48 + Math.sin(i) * 3]);
  const wander = { points, width: 2, edge: 1, mask: 'wander' };
  assert.ok(definePath(wander).line.length / 2 >= 4000);
  cpu = cpuTimer();
  const carved = await BiomeWorld.create({ ...base, height: carvePaths([wander]) });
  await digests(carved);
  paintPaths(editor, [wander]);
  ms = cpu();
  assert.ok(ms < 800, `${ms} ms of CPU`);
  const whole = rasters(world, 'mask/wander');
  editor.undo();
  // The same line drawn as one two-point path per piece, painted with 'max': the same bytes.
  const line = definePath(wander).line,
    pieces = [];
  for (let i = 0; i + 2 < line.length; i += 2)
    pieces.push({
      ...wander,
      points: [
        [line[i] / 1000, line[i + 1] / 1000],
        [line[i + 2] / 1000, line[i + 3] / 1000],
      ],
    });
  paintPaths(editor, pieces.slice(0, 1200));
  paintPaths(editor, pieces.slice(1200));
  assert.deepEqual(rasters(world, 'mask/wander'), whole);
});

test('workers: 1 and 4 worker replicas carve and paint the bytes of the page', async () => {
  const options = { ...base, height: carvePaths([road, track]) },
    page = await BiomeWorld.create(options),
    one = await BiomeWorld.create({ ...options, workers: 1, createWorker: () => new ThreadWebWorker() }),
    four = await BiomeWorld.create({ ...options, workers: 4, createWorker: () => new ThreadWebWorker() });
  takeLoaded();
  try {
    assert.equal(four.workers.size, 4);
    for (const w of [page, one, four]) paintPaths(BiomeEditor.attach(w), [road, track, lane]);
    const expected = await digests(page);
    assert.deepEqual(await digests(one), expected);
    assert.deepEqual(await digests(four), expected);
    // A carve sent by update reaches the replicas too.
    for (const w of [page, four]) w.update({ height: carvePaths([lane]) });
    assert.deepEqual(await digests(four), await digests(page));
    assert.deepEqual(
      [...new Set(takeLoaded())],
      ['biomes-splines.js'],
      'the workers ran the splines part, from its own file',
    );
  } finally {
    one.dispose();
    four.dispose();
  }
});

test('save and load: carved paths and painted roads come back with the same digests', async () => {
  const samples = new Float32Array(33 * 33).map((_, i) => 100 + (i % 33) * 0.7 + Math.floor(i / 33) * 0.3),
    worlds = [
      await BiomeWorld.create({ ...base, height: carvePaths([road, track]) }),
      await BiomeWorld.create({ ...base, height: carvePaths([road], { samples, width: 33, depth: 33 }) }),
    ];
  for (const world of worlds) {
    paintPaths(BiomeEditor.attach(world), [road, lane]);
    const text = JSON.stringify(saveWorld(world)),
      back = await loadWorld(text, { workers: false });
    assert.deepEqual(await digests(back), await digests(world));
    assert.equal(JSON.parse(text).version, 1, 'carved heights fit the version 1 format');
  }
  const field = await BiomeWorld.create({ ...base, height: carvePaths([road], { field: () => 5 }) });
  assert.throws(() => saveWorld(field), /cannot save a height function/);
});

test('golden: carved world tiles are locked', async () => {
  const world = await BiomeWorld.create({ ...base, height: carvePaths([road, track, lane]) });
  assert.deepEqual(await digests(world), golden.carved);
});

test('the entry loads only when used: the root, the region entry and the editor never import it', () => {
  for (const entry of ['index', 'region', 'editor']) {
    const seen = new Set(),
      walk = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(new URL(file, import.meta.url), 'utf8');
        for (const [, name] of text.matchAll(/^import .*?from "\.\/([^"]+)"/gm)) walk('../dist/' + name);
      };
    walk(`../dist/${entry}.js`);
    assert.ok(![...seen].some((f) => /splines\.js$/.test(f)), [...seen].join(' '));
  }
  // Without it, a carved height and a path edit say what to import.
  const script = `
    const { heightsOf } = await import('./dist/region.js');
    const { BiomeEditor } = await import('./dist/editor.js');
    const { BiomeWorld } = await import('./dist/index.js');
    const out = [];
    try { heightsOf({ carve: [] }, [0, 0], [256000, 256000], 1); } catch (e) { out.push(e.message); }
    const world = await BiomeWorld.create({ size: [256, 256], workers: false });
    try { BiomeEditor.attach(world).apply({ kind: 'path', layer: 'mask/a', path: { points: [[0, 0], [1, 1]] }, strength: 1, mode: 'max', falloff: 'smooth' }); } catch (e) { out.push(e.message); }
    console.log(JSON.stringify(out));`;
  const out = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    }),
  );
  assert.match(out[0], /carved height needs the splines entry/);
  assert.match(out[1], /path edit needs the splines entry/);
});
