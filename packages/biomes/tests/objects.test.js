// The objects entry without a GPU: argument checks (its drawing is proved on a real GPU by objects-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import { BiomeObjects } from '../dist/objects.js';

test('BiomeObjects.attach checks its engine, placement, heightmap, bounds and distances', async () => {
  const engine = { camera: { position: [0, 0, 0] } },
    placement = { tile() {}, species: [], details: [], tileSize: 256 };
  await assert.rejects(BiomeObjects.attach(engine, {}, {}), TypeError);
  await assert.rejects(BiomeObjects.attach(engine, placement, { bounds: [0, 0, 1, 1] }), TypeError);
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], radius: 0 }),
    RangeError,
  );
});

test('detail maps have a byte budget and the device texture limit, checked before anything is allocated (bug 64)', async () => {
  const { detailFits, DETAIL_BUDGET } = await import('../dist/objects.js'),
    engine = { camera: { position: [0, 0, 0] }, gpu: { limits: { maxTextureDimension2D: 8192 } } },
    details = [{ id: 'grass' }, { id: 'fern' }, { id: 'reeds' }],
    placement = { tile() {}, species: [], details, tileSize: 256 },
    heightmap = () => undefined;
  assert.equal(DETAIL_BUDGET, 128 * 1024 * 1024);
  // The zero-config world (4 km, 2 m texels, five detail species) fits.
  assert.ok(detailFits([-2049, -2049, 2049, 2049], 2, 5, 8192));
  // A 1,000 km world at 1 cm would ask for 10^16 bytes per species: refused with the coded error, at once.
  const cpu = cpuTimer();
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap, bounds: [0, 0, 1e6, 1e6], detailResolution: 0.01 }),
    (error) => error.code === 'unsupported' && /detailBudget/.test(error.message),
  );
  assert.ok(cpu() < 100, 'no allocation before the check');
  // Within the texture limit but over the default budget; a raised budget lets it through the check.
  const bounds = [0, 0, 8000, 8000];
  assert.ok(!detailFits(bounds, 1, 3, 8192));
  assert.ok(detailFits(bounds, 1, 3, 8192, 3 * 8000 * 8000));
  // Past the device's largest texture no budget helps.
  assert.ok(!detailFits([0, 0, 20000, 20000], 2, 1, 8192, 1e12));
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap, bounds: [0, 0, 20000, 20000], detailBudget: 1e12 }),
    { code: 'unsupported' },
  );
  await assert.rejects(BiomeObjects.attach(engine, placement, { heightmap, bounds, detailBudget: 0 }), RangeError);
  await assert.rejects(BiomeObjects.attach(engine, placement, { heightmap, bounds: [10, 0, 0, 10] }), RangeError);
});

// Biome look round 2 (landing D). Before it every species part drew its full mesh in all three LOD rings (a broadleaf
// canopy is 6,240 triangles at 1,000 m), in one colour per part, so a forest read as one smooth green blob and shot 01
// of the zero-configuration world took 53 ms a frame with shadows on the RTX A6000 (9.0 ms with this chain). The engine
// below only collects the scatters BiomeObjects attaches (Scatter.attach calls engine.use), so the wiring is read
// without a GPU; objects-check.mjs and objects-frame-check.mjs prove the look and the frame time on one.
test('each tree, shrub and rock part gets its LOD mesh chain, per-instance tint and leaf clusters', async () => {
  const procedural = await import('@margoengine/procedural'),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    species = ['broadleaf', 'birch', 'conifer', 'palm', 'acacia', 'shrub', 'tundra-shrub', 'rock'].map((mesh, i) => ({
      key: mesh,
      mesh: `procedural:${mesh}`,
      // Layer 1 is the canopy: drawn within the full radius, the rest within 300 m.
      layer: i < 5 ? 1 : 0,
    })),
    placement = { tile() {}, species, details: [], tileSize: 256 },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [-2048, -2048, 2048, 2048],
    }),
    triangles = (scatter) => scatter.geometries.map((g) => g.indices.length / 3),
    // Parts in attach order: each species' trunk then canopy (one part for shrubs and rocks), then the snags.
    parts = objects.casters;
  assert.equal(parts.length, attached.length);
  const byMesh = new Map();
  let k = 0;
  for (const s of species) {
    const n = ['shrub', 'tundra-shrub', 'rock'].includes(s.key) ? 1 : 2;
    byMesh.set(s.key, parts.slice(k, k + n));
    k += n;
  }
  const levels = (make) => [2, 1, 0].map(make);
  const tree = (kind, make) => {
    const [trunk, canopy] = byMesh.get(kind),
      meshes = levels(make);
    assert.deepEqual(
      triangles(trunk),
      meshes.map((m) => m.trunk.indices.length / 3),
      `${kind} trunk: detail 2, 1, 0 in the near, middle and far rings`,
    );
    assert.deepEqual(
      triangles(canopy),
      meshes.map((m) => m.canopy.indices.length / 3),
      `${kind} canopy: detail 2, 1, 0 in the near, middle and far rings`,
    );
    return { trunk, canopy };
  };
  const broadleaf = tree('broadleaf', (detail) => procedural.generateTreeMesh('broadleaf', { detail })),
    birch = tree('birch', (detail) => procedural.generateBirchMesh({ detail })),
    conifer = tree('conifer', (detail) => procedural.generateTreeMesh('conifer', { detail }));
  tree('palm', (detail) => procedural.generatePalmMesh({ detail }));
  tree('acacia', (detail) => procedural.generateAcaciaMesh({ detail }));
  assert.deepEqual(triangles(broadleaf.canopy), [6240, 3180, 400]);
  assert.deepEqual(
    triangles(byMesh.get('shrub')[0]),
    levels((detail) => procedural.generateShrubMesh({ detail }).indices.length / 3),
  );
  assert.deepEqual(
    triangles(byMesh.get('tundra-shrub')[0]),
    levels((detail) => procedural.generateTundraShrubMesh({ detail }).indices.length / 3),
  );
  // The rock mesh has no detail levels (180 triangles): one mesh in every ring.
  const rock = byMesh.get('rock')[0];
  assert.equal(new Set(rock.geometries).size, 1);
  // Rings at 150, 400 and 1,000 m for canopy trees (45, 120 and 300 m for the rest), switched hard: a dithered fade
  // between the meshes cost 1.2 ms at shot 01 and 5.6 ms at shot 02 with shadows on the A6000 (limit 0.5 ms).
  assert.deepEqual(broadleaf.trunk.options.lod, [150, 400, 1000]);
  assert.deepEqual(rock.options.lod, [45, 120, 300]);
  for (const part of parts) assert.equal(part.options.lodFade, 0);
  // Foliage tints and shades as leaf clusters; bark and stone vary a little and stay smooth.
  for (const part of [broadleaf.canopy, birch.canopy, conifer.canopy, byMesh.get('shrub')[0]]) {
    assert.deepEqual(part.options.variation, { hue: 0.06, value: 0.15 });
    assert.equal(part.options.clusters, 0.6);
  }
  for (const part of [broadleaf.trunk, birch.trunk, conifer.trunk, rock]) {
    assert.deepEqual(part.options.variation, { hue: 0.02, value: 0.1 });
    assert.equal(part.options.clusters, undefined);
  }
  // Each canopy tree its own green (the palette of the biomes look round 1, kept under the variation), each brighter
  // than its colour before that round: one leaf green (0.08, 0.2, 0.05; luma 0.162) and the needles (0.05, 0.14, 0.06;
  // luma 0.115).
  const color = (part) => [...part.options.material.data.slice(0, 3)].map((c) => +c.toFixed(4)),
    luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
    greens = [broadleaf, birch, conifer].map((t) => color(t.canopy));
  assert.deepEqual(greens, [
    [0.14, 0.3, 0.05],
    [0.26, 0.36, 0.07],
    [0.04, 0.17, 0.07],
  ]);
  assert.ok(luma(greens[0]) > 0.162 && luma(greens[1]) > 0.162 && luma(greens[2]) > 0.115, `brighter: ${greens}`);
  objects.dispose();
});

test('seasons tint the foliage of seasonal species only, follow seasons.set, and leave the rest as it was', async () => {
  const { BiomeWorld } = await import('../dist/index.js'),
    { presets } = await import('../dist/presets.js'),
    { BiomeSeasons } = await import('../dist/seasons.js'),
    [first, ...rest] = presets.temperate.plants,
    forest = { ...presets.temperate, plants: [{ ...first, color: { seasonal: true } }, ...rest] },
    world = await BiomeWorld.create({ size: [256, 256], biomes: [forest], height: { field: () => 1000 } }),
    seasons = BiomeSeasons.attach(world, { dayOfYear: 20 }),
    engine = { camera: { position: [0, 0, 0] }, use() {} },
    species = [
      { key: 'temperate/a', id: first.id, biome: 'temperate', mesh: 'procedural:broadleaf', layer: 1 },
      { key: 'temperate/b', id: 'not-seasonal', biome: 'temperate', mesh: 'procedural:broadleaf', layer: 1 },
    ],
    placement = { tile() {}, species, details: [], tileSize: 256 },
    bounds = [-128, -128, 128, 128],
    color = (part) => [...part.options.material.data.slice(0, 3)],
    near = (a, b) => a.every((c, i) => Math.abs(c - b[i]) < 1e-6),
    leaf = [0.14, 0.3, 0.05];
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds, seasons: {} }),
    TypeError,
  );
  const plain = await BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds }),
    tinted = await BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds, seasons });
  // [a trunk, a canopy, b trunk, b canopy, snag trunk, ...]: only the seasonal canopy moves.
  const [pa, pc, pb, pd] = plain.casters,
    [ta, tc, tb, td] = tinted.casters;
  assert.equal(plain.seasonalMaterials.length, 0);
  assert.equal(tinted.seasonalMaterials.length, 1);
  assert.ok(near(color(pc), leaf));
  assert.ok(near(color(tc), seasons.colorAt(leaf, 0, 0)) && !near(color(tc), leaf), `winter ${color(tc)}`);
  for (const [p, t] of [
    [pa, ta],
    [pb, tb],
    [pd, td],
  ])
    assert.deepEqual(color(t), color(p));
  const winter = color(tc);
  seasons.set({ dayOfYear: 200 });
  assert.ok(near(color(tc), seasons.colorAt(leaf, 0, 0)) && !near(color(tc), winter), `summer ${color(tc)}`);
  tinted.dispose();
  seasons.set({ dayOfYear: 20 });
  assert.ok(!near(color(tc), winter), 'a disposed BiomeObjects no longer follows the seasons');
  plain.dispose();
});
