import { speedBudget } from '../../../scripts/speed/budgets.mjs';
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
  speedBudget('biomes-object-allocation', { cpu });
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
    // Parts in attach order: each species' trunk (a shrub's stems) then canopy (one part for rocks), then the snags.
    parts = objects.casters;
  assert.equal(parts.length, attached.length);
  const byMesh = new Map();
  let k = 0;
  for (const s of species) {
    const n = s.key === 'rock' ? 1 : 2;
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
  for (const [key, wood, leaves] of [
    ['shrub', 'generateShrubStemsMesh', 'generateShrubMesh'],
    ['tundra-shrub', 'generateTundraShrubStemsMesh', 'generateTundraShrubMesh'],
  ])
    for (const [part, make] of [wood, leaves].entries())
      assert.deepEqual(
        triangles(byMesh.get(key)[part]),
        levels((detail) => procedural[make]({ detail }).indices.length / 3),
        `${key} part ${part}`,
      );
  // The rock is subdivided finer near (film look 2026-11-28: a 180-triangle stone a metre or two from the lens showed
  // its facets along the outline): 2,880, 720 and 180 triangles in the near, middle and far rings.
  const rock = byMesh.get('rock')[0];
  assert.deepEqual(triangles(rock), [2880, 720, 180]);
  // Rings at 150, 400 and 1,000 m for canopy trees (45, 120 and 300 m for the rest), switched hard: a dithered fade
  // between the meshes cost 1.2 ms at shot 01 and 5.6 ms at shot 02 with shadows on the A6000 (limit 0.5 ms).
  assert.deepEqual(broadleaf.trunk.options.lod, [150, 400, 1000]);
  assert.deepEqual(rock.options.lod, [45, 120, 300]);
  for (const part of parts) assert.equal(part.options.lodFade, 0);
  // Foliage tints and shades as leaf clusters; bark and stone vary a little and stay smooth.
  for (const part of [broadleaf.canopy, birch.canopy, conifer.canopy, byMesh.get('shrub')[1]]) {
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
    changes = new Set(),
    placement = {
      tile() {},
      species,
      details: [],
      tileSize: 256,
      world,
      onChange(listener) {
        const off = world.onChange(listener);
        changes.add(off);
        return () => {
          changes.delete(off);
          off();
        };
      },
    },
    bounds = [-128, -128, 128, 128],
    color = (part) => [...part.options.material.data.slice(0, 3)],
    near = (a, b) => a.every((c, i) => Math.abs(c - b[i]) < 1e-6),
    leaf = [0.14, 0.3, 0.05],
    other = await BiomeWorld.create({ size: [256, 256], biomes: [forest], height: { field: () => 1000 } });
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds, seasons: {} }),
    TypeError,
  );
  await assert.rejects(
    BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds,
      seasons: BiomeSeasons.attach(other, { dayOfYear: 20 }),
    }),
    { name: 'TypeError', message: /placement's world/ },
  );
  other.dispose();
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
  // A colder world re-tints the foliage without seasons.set.
  const summer = color(tc);
  world.update({ climate: { equatorTemperature: -5, poleTemperature: -40 } });
  assert.ok(near(color(tc), seasons.colorAt(leaf, 0, 0)) && !near(color(tc), summer), `colder ${color(tc)}`);
  const colder = color(tc);
  tinted.dispose();
  assert.equal(changes.size, 0, 'dispose removes the world listener');
  world.update({ climate: {} });
  seasons.set({ dayOfYear: 200 });
  assert.ok(!near(seasons.colorAt(leaf, 0, 0), colder), 'the world and seasons moved on');
  assert.ok(near(color(tc), colder), 'a disposed BiomeObjects no longer follows the seasons');
  plain.dispose();
});

// KB-OWN-BIOMES3: a device restore gives the engine a new GPUDevice, and WebGPU objects are valid only with the device
// that made them (W3C WebGPU, section 3.2.1). The detail and far-forest density maps were made once and kept, so after
// a restore scatter bound the lost device's texture at binding 7 of its cull pass. Each fake object names its device.
const fakeDevice = () => {
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    createTexture: (d) => ({
      device,
      format: d.format,
      usage: d.usage,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    }),
    queue: {
      writes: 0,
      writeTexture() {
        this.writes++;
      },
    },
  };
  return device;
};

test('detail and far-forest density maps are made on the device drawing them, also after a device restore', async () => {
  const { BiomeWorld } = await import('../dist/index.js');
  const first = fakeDevice(),
    second = fakeDevice(),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (plugin) => attached.push(plugin), gpu: first },
    world = await BiomeWorld.create({ size: [512, 512], workers: 0 }),
    placement = {
      tile() {},
      species: [],
      details: [{ id: 'grass', mesh: 'procedural:grass', density: 40 }],
      tileSize: 256,
    },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: world.bounds,
      far: { radius: 2500, world },
    }),
    maps = attached.filter((p) => p.options?.densityMap).map((p) => p.options.densityMap);
  assert.ok(maps.length >= 2, `a detail map and at least one far-forest kind: ${maps.length}`);
  const before = maps.map((read) => read());
  for (const t of before) assert.equal(t.device, first);
  assert.deepEqual(
    maps.map((read) => read()),
    before,
    'the same texture while the device stays',
  );
  // The restore: the engine draws with a new device.
  engine.gpu = second;
  const after = maps.map((read) => read());
  for (const t of after) assert.equal(t.device, second, 'made again on the restored device');
  for (const t of before) assert.ok(t.destroyed, "the lost device's copy is destroyed");
  // The grass detail's near layer reads its field's map (KB-BIOMES-SPARSEGRASS1): one copy, one write.
  assert.ok(second.queue.writes >= new Set(after).size, 'each new copy is filled from the CPU data');
  objects.dispose();
  for (const t of after) assert.ok(t.destroyed);
  world.dispose();
});

// The mesh registry (M8 seam, scenes plan push 13): a key in `meshes` draws its own parts in place of the procedural
// mesh of that key, so a library model (a scanned rock, a fir made by an artist) drops in by name. Before it every key
// drew a procedural mesh and an unknown key drew a shrub, so a library plant could not be drawn by a biome at all.
test('meshes draws a registry mesh by key in place of the procedural one, snags included', async () => {
  const quad = (y) => ({
      positions: [0, 0, 0, 1, 0, 0, 0, y, 0, 1, y, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 2, 1, 3],
    }),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    species = [
      { key: 'fir', mesh: 'library:fir', layer: 1 },
      { key: 'rock', mesh: 'procedural:rock', layer: 0 },
    ],
    placement = { tile() {}, species, details: [{ id: 'grass', mesh: 'library:grass', density: 10 }], tileSize: 256 },
    meshes = {
      'library:fir': [
        { geometry: [quad(3), quad(2), quad(1)], color: [0.2, 0.15, 0.1], kind: 'bark' },
        { geometry: quad(4), color: [0.05, 0.12, 0.05], kind: 'foliage' },
      ],
      'procedural:rock': [{ geometry: quad(0.5), color: [0.3, 0.3, 0.3], kind: 'stone' }],
      'procedural:snag': [{ geometry: quad(6), color: [0.25, 0.2, 0.18], kind: 'bark' }],
      'library:grass': [{ geometry: quad(0.3), color: [0.3, 0.3, 0.1], kind: 'foliage' }],
    },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [0, 0, 512, 512],
      meshes,
    }),
    tops = (scatter) => scatter.geometries.map((g) => +(g.bounds[1] * 2).toFixed(3));
  // fir bark (three rings), fir foliage, rock and snag (the grass detail is not a caster).
  assert.equal(objects.casters.length, 4);
  const [bark, foliage, rock, snag] = objects.casters;
  assert.deepEqual(tops(bark), [3, 2, 1], 'the fir bark draws its three rings, finest first');
  assert.deepEqual(tops(foliage), [4, 4, 4], 'one mesh serves every ring');
  assert.deepEqual(tops(rock), [0.5, 0.5, 0.5], 'procedural:rock is replaced by the library rock');
  assert.deepEqual(tops(snag), [6, 6, 6], 'the snag is replaced too');
  assert.deepEqual(
    Array.from(bark.options.material.data.slice(0, 3), (v) => +v.toFixed(3)),
    [0.2, 0.15, 0.1],
    'the part colour',
  );
  assert.equal(foliage.options.clusters, 0.6, 'foliage takes the foliage look');
  assert.equal(rock.options.wind, undefined, 'stone does not sway');
  // swaying: the scatters with a wind, for TAA's velocity passes (KB-SCENES-TVTAA1).
  const swaying = objects.swaying;
  assert.ok(swaying.includes(bark) && swaying.includes(foliage), 'the fir sways');
  assert.ok(!swaying.includes(rock), 'stone does not');
  assert.ok(swaying.length > 0 && swaying.every((s) => !!s.options.wind), 'each one has a wind');
  objects.dispose();
  assert.deepEqual(objects.swaying, [], 'none after dispose');
});

test('meshes is checked before anything is built', async () => {
  const engine = { camera: { position: [0, 0, 0] }, use() {} },
    placement = { tile() {}, species: [], details: [], tileSize: 256 },
    at = (meshes) =>
      BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], meshes }),
    tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] };
  await assert.rejects(at([]), TypeError);
  await assert.rejects(at({ a: [] }), TypeError);
  await assert.rejects(at({ a: [{ geometry: tri, color: [0, 0, 0], kind: 'leaf' }] }), TypeError);
  await assert.rejects(at({ a: [{ geometry: tri, color: [0, 2, 0], kind: 'stone' }] }), RangeError);
  await assert.rejects(at({ a: [{ geometry: [tri, tri], color: [0, 0, 0], kind: 'stone' }] }), TypeError);
  await assert.rejects(
    at({ a: [{ geometry: { ...tri, indices: [0, 1, 3] }, color: [0, 0, 0], kind: 'stone' }] }),
    RangeError,
  );
  await assert.rejects(
    at({ a: [{ geometry: { ...tri, normals: [0, 1, 0] }, color: [0, 0, 0], kind: 'stone' }] }),
    RangeError,
  );
});

// KB-SCATTER-TEX1: a registry part with texture maps (a scanned fir's needle cards) draws them: its uvs and maps reach
// the part's ScatterTiles, and a malformed one is refused. Before, a part was one flat colour and its maps were dropped.
test('meshes parts carry their texture maps to the scatter', async () => {
  const quad = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 2, 1, 3],
    },
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    placement = { tile() {}, species: [{ key: 'fir', mesh: 'library:fir', layer: 1 }], details: [], tileSize: 256 },
    baseColor = { width: 1, height: 1, data: new Uint8Array([40, 90, 40, 255]) },
    textures = { uvs: [0, 1, 1, 1, 0, 0, 1, 0], baseColor, alphaCutoff: 0.4 },
    meshes = { 'library:fir': [{ geometry: quad, color: [1, 1, 1], kind: 'foliage', textures }] },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [0, 0, 512, 512],
      meshes,
    });
  const [needles] = objects.casters;
  assert.equal(needles.options.textures, textures, 'the maps reach the scatter');
  objects.dispose();
  const at = (t) =>
    BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [0, 0, 512, 512],
      meshes: { 'library:fir': [{ geometry: quad, color: [1, 1, 1], kind: 'foliage', textures: t }] },
    });
  await assert.rejects(at('needles.png'), TypeError);
  await assert.rejects(at({ uvs: [0, 1], baseColor }), RangeError);
});

// Burnt and flooded plants: `states` gives each part its plant state response by key and kind, details included.
test('states hands each part its plant state response, by mesh key and kind, and is checked', async () => {
  const { PlantStates } = await import('@margoengine/scatter/states'),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    map = PlantStates.create({}, { bounds: [0, 0, 512, 512], resolution: 8 }),
    trunks = map.plant({ crownBase: 100, trunkRadius: 1000 }),
    crowns = map.plant({ crownBase: 4 }),
    grass = map.plant({ stiffness: 0.02 }),
    asked = [],
    species = [
      { key: 'conifer', mesh: 'procedural:conifer', layer: 1 },
      { key: 'rock', mesh: 'procedural:rock', layer: 0 },
    ],
    placement = {
      tile() {},
      species,
      details: [{ id: 'grass', mesh: 'procedural:grass', density: 10 }],
      tileSize: 256,
    },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [0, 0, 512, 512],
      states: (key, kind) => {
        asked.push(`${key}:${kind}`);
        return key === 'procedural:grass' ? grass : kind === 'stone' ? undefined : kind === 'bark' ? trunks : crowns;
      },
    });
  const [bark, foliage, rock] = objects.casters;
  assert.equal(bark.options.states, trunks, 'the conifer trunk takes the bark response');
  assert.equal(foliage.options.states, crowns, 'its canopy the foliage response');
  assert.equal(rock.options.states, undefined, 'stone is left as it is');
  assert.ok(
    attached.some((e) => e.options?.states === grass),
    'the grass detail takes its own',
  );
  assert.ok(asked.includes('procedural:conifer:bark') && asked.includes('procedural:rock:stone'), asked.join());
  objects.dispose();
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], states: {} }),
    TypeError,
  );
  map.dispose();
});

// Scenes plan M8: the northern Rockies conifer keys draw their species meshes (@margoengine/procedural/conifers): the
// near and middle meshes and, for a live tree, the imposter cards in the far ring with the baked cut-out image; dead
// trees draw a bare stem. Before, every rockies tree was the one generic procedural:conifer.
test('conifer species keys draw their species meshes, imposters in the far ring, swaying and with their bark', async () => {
  const conifers = await import('@margoengine/procedural/conifers'),
    attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    species = [
      { key: 'fir', mesh: 'procedural:douglas-fir/pole', layer: 1 },
      { key: 'larch', mesh: 'procedural:western-larch', layer: 1 },
      { key: 'dead', mesh: 'procedural:grand-fir/burnt', layer: 1 },
    ],
    placement = { tile() {}, species, details: [], tileSize: 256 },
    objects = await BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 512, 512] }),
    tris = (s) => s.geometries.map((g) => g.indices.length / 3),
    [firBark, firNeedles, larchBark, larchNeedles, deadBark, snag] = objects.casters;
  assert.equal(objects.casters.length, 6, 'two parts per live tree, one for the burnt tree, then the snags');
  const fir = conifers.coniferLevels('douglas-fir', { age: 'pole' });
  assert.deepEqual(
    tris(firNeedles),
    fir.canopy.map((g) => g.indices.length / 3),
    'near, middle and imposter cards',
  );
  assert.deepEqual(
    tris(firBark).slice(0, 2),
    fir.trunk.slice(0, 2).map((g) => g.indices.length / 3),
  );
  assert.equal(tris(firBark)[2], 1, 'the far stem is in the imposter');
  assert.equal(firNeedles.options.textures.baseColor.width, 256, 'the needles draw the baked image');
  assert.equal(firNeedles.options.textures.uvs.length, 3);
  assert.deepEqual(
    Array.from(firNeedles.options.material.data.slice(0, 3)),
    [1, 1, 1],
    'needle colour comes from the image',
  );
  assert.deepEqual(
    Array.from(firBark.options.material.data.slice(0, 3), (v) => +v.toFixed(3)),
    conifers.CONIFER_SPECIES['douglas-fir'].bark.map((v) => +v.toFixed(3)),
  );
  assert.ok(firNeedles.options.wind && firBark.options.wind, 'needles and stems take the wind');
  assert.ok(larchNeedles.options.textures && larchBark.options.wind);
  assert.equal(deadBark.options.textures, undefined, 'a burnt tree is a bare stem');
  assert.ok(
    Array.from(deadBark.options.material.data.slice(0, 3)).every((v) => v < 0.05),
    'charred bark',
  );
  assert.ok(snag);
  objects.dispose();
});

// Fauld handoff 5, root cause 1: hedges thinned to bare hedge trees past 300 m, because every species off the canopy
// layer (hedge shrubs among them) was drawn within a fixed 300 m. A countryside seen from a hill or a drone draws its
// hedge shrubs out to `nearRadius`; the default stays 300 m.
test('nearRadius draws shrubs past 300 m when asked, and the default keeps them within 300 m', async () => {
  const species = [{ key: 'hawthorn', mesh: 'procedural:shrub', layer: 2 }],
    placement = { tile() {}, species, details: [], tileSize: 256 },
    instances = new Uint8Array(8),
    // One live hawthorn record (species 0, age 0) in a tile 1,000 m from the camera.
    tile = { x: 4, z: 0, origin: [1024, 0], size: 256, count: 1, instances, species: ['hawthorn'], density: [] },
    drawn = async (options) => {
      const engine = { camera: { position: [0, 0, 0] }, use() {} },
        objects = await BiomeObjects.attach(engine, placement, {
          heightmap: () => undefined,
          bounds: [-2048, -2048, 2048, 2048],
          radius: 2500,
          ...options,
        });
      objects.add(tile, 1000);
      const [shrub] = objects.casters,
        out = { held: shrub.size, lod: shrub.options.lod };
      objects.dispose();
      return out;
    };
  assert.deepEqual(await drawn({}), { held: 0, lod: [45, 120, 300] });
  assert.deepEqual(await drawn({ nearRadius: 1500 }), { held: 1, lod: [225, 600, 1500] });
  // Never past the view's radius.
  assert.deepEqual((await drawn({ radius: 800, nearRadius: 1500 })).lod, [120, 320, 800]);
  const engine = { camera: { position: [0, 0, 0] } };
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], nearRadius: 0 }),
    RangeError,
  );
});

// KB-LOOK-MASKOCCLUDE1: SceneTargets, SSR and LightBounce take BiomeObjects as one capture model. Before it the masks
// drew the ground through the grass and the trees (they could not add the objects at all), so a shaded patch under a
// fern counted as shaded ground. Here every lit child scatter shares the hook at its first capture and draws into it;
// the GPU side (a captured plant hides the ground and is not ground) is proved by post scene-targets-scatter-browser.
test('setCapture shares the hook with every lit part and detail scatter, releases it and runs onDispose once', async () => {
  const attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (p) => attached.push(p) },
    placement = {
      tile() {},
      species: [{ key: 'shrub', mesh: 'procedural:shrub', layer: 0 }],
      details: [{ id: 'grass', mesh: 'procedural:grass', density: 40 }],
      tileSize: 256,
    },
    objects = await BiomeObjects.attach(engine, placement, {
      heightmap: () => undefined,
      bounds: [-512, -512, 512, 512],
    });
  const key = Symbol.for('margoengine.capture'),
    hook = { targets: [{ format: 'r8unorm' }], declarations: (code) => `// mine ${code}`, begin() {} },
    drawn = [];
  for (const bad of [undefined, {}, { declarations() {}, begin() {} }, { targets: [], begin() {} }])
    assert.throws(() => objects.setCapture(bad), TypeError);
  assert.throws(() => objects.onDispose(1), TypeError);
  // Every lit scatter the objects attached: the shrub's part and the grass.
  const lit = attached.filter((s) => s.options?.material);
  assert.ok(lit.length >= 2 && lit.some((s) => !objects.casters.includes(s)), 'a species part and a detail scatter');
  objects.draw({}, 'capture');
  for (const s of lit) assert.equal(s[key], undefined, 'no hook: no part takes one');
  const stop = objects.setCapture(hook);
  objects.draw({}, 'capture');
  for (const s of lit) {
    assert.ok(s[key], 'each part shares the hook after its first capture');
    assert.equal(s.capture.declarations('x'), '// mine x', 'and its hook forwards to the objects hook');
  }
  // A part's own draw is reached through drawCapture with the hook current.
  for (const s of lit) s.draw = (c, mode) => drawn.push(mode);
  objects.draw({}, 'capture');
  assert.equal(drawn.length, lit.length, 'every species part and the grass draw once');
  assert.ok(drawn.every((mode) => mode === 'capture'));
  stop();
  for (const s of lit) assert.equal(s[key], undefined, 'the remover gives every part its hook back');
  drawn.length = 0;
  objects.draw({}, 'capture');
  assert.equal(drawn.length, 0, 'no hook: nothing drawn');
  objects.setCapture(hook);
  objects.draw({}, 'capture');
  // A part disposed under the objects (a tile streamed out) gives its share back at the next capture.
  const grass = lit.find((s) => !objects.casters.includes(s));
  assert.ok(grass[key]);
  grass.dispose();
  objects.draw({}, 'capture');
  assert.equal(grass[key], undefined, 'a disposed part is not kept');
  let calls = 0;
  objects.onDispose(() => calls++);
  objects.onDispose(() => calls++)();
  objects.dispose();
  objects.dispose();
  assert.equal(calls, 1);
  for (const s of lit) assert.equal(s[key], undefined);
  assert.throws(() => objects.setCapture(hook), TypeError);
});

// Film look 2026-11-28 ("Above the Treeline"): a meadow's `procedural:grass` detail drew in a saturated (0.2, 0.4,
// 0.06), twice the measured green and half the blue, which read as bright cut-out cards from 5 m to 50 m. It now takes
// measured leaf green (ECOSTRESS VH350 and VH352).
test('grass details take measured leaf green', async () => {
  const attached = [],
    engine = { camera: { position: [0, 0, 0] }, use: (effect) => attached.push(effect) },
    placement = {
      tile() {},
      species: [],
      details: [{ id: 'bunchgrass', mesh: 'procedural:grass', density: 18 }],
      tileSize: 256,
    };
  await BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [-512, -512, 512, 512] });
  const grass = attached.at(-1);
  assert.deepEqual([...grass.options.material.data.slice(0, 3)].map((v) => +v.toFixed(4)), [0.1617, 0.2024, 0.0917]);
});
