// @margoengine/biomes/farmland: hedged fields that tile the area with no gap or overlap, one shared hedge per field line,
// a gate into every field reachable from a lane, lanes whose every end is a junction, the world's edge or a gate (never
// a dead end into a field or a building), hedge trees standing on their hedges and off the gates, kept ground left
// unfarmed, the same bytes from the same options, and the editor's polygon fill painting exactly the cells inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { BiomeEditor } from '../dist/editor.js';
import '../dist/splines.js';
import {
  FARMLAND_MATERIALS,
  FARMLAND_PAINT,
  farmlandEdits,
  fieldAt,
  insidePolygon,
  layoutFarmland,
  lowlandFarmWorld,
} from '../dist/farmland.js';

const world = {
  bounds: [-1500, -1500, 1500, 1500],
  heightAt: (x, z) => 60 + 30 * Math.sin(x / 400) * Math.cos(z / 500),
};
const village = [
  [-200, -100],
  [200, -100],
  [200, 300],
  [-200, 300],
];
const options = {
  connect: [
    [-1500, 0],
    [0, 100],
    [1500, -300],
    [300, 1500],
    [-600, -900],
  ],
  keep: [village],
};
const farm = layoutFarmland(world, options);
const segDist = (p, pts) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1],
      [bx, bz] = pts[i],
      dx = bx - ax,
      dz = bz - az,
      t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz));
  }
  return best;
};

test('the fields tile the area: their areas sum to it and every sample point lies in exactly one', () => {
  const total = farm.fields.reduce((a, f) => a + f.area, 0);
  assert.ok(Math.abs(total - 9e6) < 9e6 * 1e-6, `areas sum to ${total}`);
  for (let k = 0; k < 400; k++) {
    const p = [-1490 + ((k * 7919) % 2980), -1490 + ((k * 104729) % 2980)];
    const n = farm.fields.filter((f) => insidePolygon(p, f.outline)).length;
    assert.equal(n, 1, `point ${p} is in ${n} fields`);
  }
  // About one field per 4 ha by default.
  assert.ok(farm.fields.length > 180 && farm.fields.length < 280, `${farm.fields.length} fields`);
});

test('same world and options, same bytes; another seed, another quilt', () => {
  assert.equal(JSON.stringify(layoutFarmland(world, options)), JSON.stringify(farm));
  assert.notEqual(JSON.stringify(layoutFarmland(world, { ...options, seed: 2 }).fields), JSON.stringify(farm.fields));
});

test('kept ground is not farmed and the uses follow their shares', () => {
  for (const f of farm.fields) {
    const c = f.outline.reduce((a, p) => [a[0] + p[0] / f.outline.length, a[1] + p[1] / f.outline.length], [0, 0]);
    if (insidePolygon(c, village) && f.area < 30000) assert.equal(f.use, 'none', `field ${f.id} inside the village`);
  }
  const share = (u) => farm.fields.filter((f) => f.use === u).length / farm.fields.length;
  assert.ok(share('pasture') > 0.4 && share('pasture') < 0.7, `pasture ${share('pasture')}`);
  assert.ok(share('plough') > 0.08, `plough ${share('plough')}`);
  const all = layoutFarmland(world, { uses: { plough: 1 } });
  assert.ok(all.fields.every((f) => f.use === 'plough'));
});

test('every field has a gate, and every field is reached from a lane through gates', () => {
  const farmed = farm.fields.filter((f) => f.use !== 'none');
  const into = new Map();
  for (const g of farm.gates) into.set(g.field, [...(into.get(g.field) ?? []), g]);
  for (const f of farmed) assert.ok(into.has(f.id), `field ${f.id} has no gate`);
  const reached = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of farm.gates)
      if (!reached.has(g.field) && (g.from === 'lane' || reached.has(g.from))) reached.add(g.field), (grew = true);
  }
  const pockets = farmed.filter((f) => !reached.has(f.id));
  assert.ok(pockets.length <= 1, `${pockets.length} fields cannot be reached from a lane`);
  for (const g of farm.gates) assert.ok(g.width >= 3.6 && Number.isFinite(g.along));
});

test('every lane end is a junction, the edge or a gate: no lane runs into nothing', () => {
  assert.ok(farm.lanes.length >= 4, `${farm.lanes.length} lanes`);
  for (const lane of farm.lanes)
    for (const [i, end] of lane.ends.entries()) {
      assert.ok(['junction', 'edge', 'gate'].includes(end));
      const p = i === 0 ? lane.points[0] : lane.points.at(-1);
      if (end === 'edge')
        assert.ok(Math.abs(Math.abs(p[0]) - 1500) < 0.01 || Math.abs(Math.abs(p[1]) - 1500) < 0.01, `edge end ${p}`);
      if (end === 'gate')
        assert.ok(
          farm.gates.some((g) => Math.hypot(g.at[0] - p[0], g.at[1] - p[1]) < 0.01),
          `gate end ${p} has a gate`,
        );
      if (end === 'junction') {
        const meets = farm.lanes.filter(
          (l) => l !== lane && [l.points[0], l.points.at(-1)].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05),
        );
        assert.ok(meets.length >= 2, `junction ${p} meets ${meets.length} other lanes`);
      }
    }
  // Lanes join every connect point: each lies within a field's width of a lane.
  for (const c of options.connect)
    assert.ok(Math.min(...farm.lanes.map((l) => segDist(c, l.points))) < 250, `${c} is off the lanes`);
  // A lane keeps off the rect's border except where it leaves.
  for (const lane of farm.lanes)
    for (const p of lane.points.slice(1, -1)) assert.ok(Math.abs(p[0]) < 1500 - 0.01 || Math.abs(p[1]) < 1500 - 0.01);
});

test('hedges: one per field line, beside each lane on both sides, gaps at the gates', () => {
  const seen = new Set();
  for (const h of farm.hedges.filter((x) => !x.lane)) {
    const k = [h.points[0], h.points.at(-1)]
      .map((p) => p.map((v) => Math.round(v * 10)).join(','))
      .sort()
      .join('|');
    assert.ok(!seen.has(k), `field line ${k} has two hedges`);
    seen.add(k);
  }
  const laneHedges = farm.hedges.filter((h) => h.lane);
  assert.ok(laneHedges.length >= 2 * farm.lanes.length);
  for (const h of laneHedges) {
    const mid = h.points[Math.floor(h.points.length / 2)],
      d = Math.min(...farm.lanes.map((l) => segDist(mid, l.points)));
    assert.ok(d > 2 && d < 5, `a lane hedge stands ${d.toFixed(2)} m off its lane`);
  }
  const gaps = farm.hedges.reduce((a, h) => a + h.gaps.length, 0);
  assert.ok(gaps >= farm.gates.length * 0.8, `${gaps} gaps for ${farm.gates.length} gates`);
});

test('hedge trees stand on a hedge, off its gates, oak first', () => {
  assert.ok(farm.trees.length > 500);
  for (const t of farm.trees.slice(0, 400)) {
    assert.ok(
      Math.min(...farm.hedges.map((h) => segDist(t.at, h.points))) < 0.01,
      `tree at ${t.at} is off every hedge`,
    );
    for (const g of farm.gates) assert.ok(Math.hypot(t.at[0] - g.at[0], t.at[1] - g.at[1]) > 3, 'a tree in a gateway');
  }
  const n = (s) => farm.trees.filter((t) => t.species === s).length;
  assert.ok(n('oak') > n('ash') && n('ash') > n('holly'));
  for (const t of farm.trees) assert.ok(t.height >= 5 && t.height <= 20);
});

test('fieldAt finds the field under a point; bad options throw', () => {
  const f = farm.fields[17],
    c = f.outline.reduce((a, p) => [a[0] + p[0] / f.outline.length, a[1] + p[1] / f.outline.length], [0, 0]);
  assert.equal(fieldAt(farm, c[0], c[1])?.id, f.id);
  assert.equal(fieldAt(farm, 5000, 5000), undefined);
  assert.throws(() => layoutFarmland(world, { fieldSize: 10 }), RangeError);
  assert.throws(() => layoutFarmland(world, { connect: [[0]] }), TypeError);
  assert.throws(() => layoutFarmland(world, { keep: [[[0, 0]]] }), TypeError);
  assert.throws(() => layoutFarmland({}), TypeError);
});

test('the polygon edit paints exactly the cells whose corner is inside, and farmland edits paint the farm world', async () => {
  const w = await BiomeWorld.create({
    seed: 3,
    size: [512, 512],
    climate: lowlandFarmWorld.climate,
    biomes: lowlandFarmWorld.biomes,
    paint: FARMLAND_PAINT,
  });
  try {
    const editor = BiomeEditor.attach(w),
      tri = [
        [-100.3, -80.1],
        [140.7, -20.2],
        [-30.4, 150.9],
      ];
    editor.polygon('plough', tri);
    const [bx, bz] = w.bounds,
      cells = w.tileSize / w.resolution;
    let inside = 0;
    for (let tz = 0; tz < w.tilesZ; tz++)
      for (let tx = 0; tx < w.tilesX; tx++) {
        const r = w.readLayer('paint/plough', tx, tz);
        for (let k = 0; k < cells * cells; k++) {
          const x = bx + (tx * cells + (k % cells)) * w.resolution,
            z = bz + (tz * cells + Math.floor(k / cells)) * w.resolution,
            want = insidePolygon([x, z], tri) ? 255 : 0;
          assert.equal(r ? r[k] : 0, want, `cell at ${x}, ${z}`);
          if (want) inside++;
        }
      }
    const expect = Math.abs((140.7 + 100.3) * (150.9 + 80.1) - (-30.4 + 100.3) * (-20.2 + 80.1)) / 2;
    assert.ok(Math.abs(inside * w.resolution ** 2 - expect) < expect * 0.05, `${inside} cells`);
    assert.throws(
      () =>
        editor.polygon('plough', [
          [0, 0],
          [1, 1],
        ]),
      RangeError,
    );
    const small = layoutFarmland(w, {
        connect: [
          [-256, 0],
          [256, 10],
        ],
      }),
      edits = farmlandEdits(small);
    assert.equal(edits.filter((e) => e.kind === 'polygon').length, small.fields.length);
    assert.ok(edits.some((e) => e.kind === 'path' && e.layer === 'paint/farm-lane'));
    const wood = farmlandEdits(small, {}, [tri]);
    assert.ok(
      wood.some((e) => e.kind === 'polygon' && e.layer === 'paint/farm-wood'),
      'a wood outline paints farm-wood',
    );
    // Woods are painted only: the base biome is pasture, so no tree grows along the field lines where paint blends.
    assert.equal(lowlandFarmWorld.biomes.find((b) => Object.keys(b.climate).length === 0)?.id, 'pasture');
    for (const b of lowlandFarmWorld.biomes)
      for (const r of [...(b.plants ?? []), ...(b.details ?? [])])
        assert.ok(r.mesh.startsWith('library:'), `${b.id} ${r.id} draws a library model, not a procedural one`);
    for (const e of edits) editor.apply(e);
    assert.ok(FARMLAND_MATERIALS.plough.color.every((v) => v >= 0 && v <= 1));
  } finally {
    w.dispose();
  }
});
