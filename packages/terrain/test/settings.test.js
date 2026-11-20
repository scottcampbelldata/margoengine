// The settings table of @margoengine/terrain/settings: every row is live (the look sits in one uniform), the defaults
// written leave TerrainColors as it is without them, ranges are enforced, the named looks are only row values, and
// writing every row each frame creates no GPU object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { TerrainColors, heightfield } from '../dist/index.js';
import {
  TERRAIN_LIVE_SETTINGS,
  TERRAIN_LOOKS,
  TERRAIN_SETTINGS,
  applyTerrainSettings,
  terrainSettingDefaults,
} from '../dist/settings.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const harness = async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    mesh = engine.createMesh();
  mesh.setGeometry(heightfield((x, z) => x + z, { size: [10, 10], origin: [-1, -1], resolution: 2 }));
  return { h, engine, mesh };
};
const look = (colors) => Array.from(colors.look);

test('every row is well formed, unique and live', () => {
  const names = new Set();
  for (const s of TERRAIN_SETTINGS) {
    assert.ok(!names.has(s.name), s.name);
    names.add(s.name);
    assert.equal(s.live, true, s.name);
    assert.ok(['number', 'color'].includes(s.kind), s.name);
    assert.ok(s.about.length > 10 && typeof s.unit === 'string', s.name);
    if (s.default === null) assert.equal(s.nullable, true, s.name);
    else if (s.kind === 'number') assert.ok(s.default >= s.min && s.default <= s.max, s.name);
  }
  assert.equal(TERRAIN_LIVE_SETTINGS.length, TERRAIN_SETTINGS.length);
  assert.equal(TERRAIN_SETTINGS.find((s) => s.name === 'sand.windDirection').weather, 'windDirection');
});

test('the defaults written leave the look as TerrainColors has it without them', async () => {
  const { engine, mesh } = await harness();
  const plain = new TerrainColors(mesh),
    written = new TerrainColors(mesh, {
      sand: [1, 0, 0],
      wetDarkening: 0.2,
      sandSurface: { ripples: 2 },
      shore: [0, 1],
    });
  assert.notDeepEqual(look(written), look(plain));
  applyTerrainSettings(written);
  assert.deepEqual(look(written), look(plain));
  assert.deepEqual(
    Object.keys(terrainSettingDefaults()),
    TERRAIN_SETTINGS.map((s) => s.name),
  );
  engine.dispose();
});

test('values land on the uniform: colours, ranges, wetness and the sand surface', async () => {
  const { engine, mesh } = await harness(),
    colors = new TerrainColors(mesh);
  applyTerrainSettings(colors, {
    'sand.color': [0.9, 0.8, 0.7],
    'sand.windDirection': 90,
    'sand.ripple': 0.2,
    'sand.ripples': 2,
    'sand.broad': 0.5,
    'shore.end': 3,
    'wet.darkening': 0.3,
    'stone.heightStart': 30,
    'stone.heightEnd': 40,
  });
  const v = look(colors),
    near = (a, b) => Math.abs(a - b) < 1e-5;
  assert.deepEqual(
    v.slice(0, 4).map((x) => Math.round(x * 100) / 100),
    [0.9, 0.8, 0.7, 0.3],
  );
  assert.ok(near(v[32], 0) && near(v[33], 1), 'wind toward +z');
  assert.ok(near(v[34], 0.2) && near(v[35], 2) && near(v[39], 0.15));
  assert.ok(near(v[17], 3));
  assert.ok(near(v[22], 30) && near(v[23], 40));
  // null puts a height range back to the mesh's own: the stone starts above its highest point.
  applyTerrainSettings(colors, {});
  assert.ok(v[22] !== look(colors)[22]);
  engine.dispose();
});

test('values are checked against their rows: unknown names throw TypeError, bad values RangeError', async () => {
  const { engine, mesh } = await harness(),
    colors = new TerrainColors(mesh);
  assert.throws(() => applyTerrainSettings(colors, { 'sand.nope': 1 }), TypeError);
  for (const s of TERRAIN_SETTINGS) {
    if (s.kind === 'number') {
      assert.throws(() => applyTerrainSettings(colors, { [s.name]: s.max + 1 }), RangeError, s.name);
      assert.throws(() => applyTerrainSettings(colors, { [s.name]: s.min - 1 }), RangeError, s.name);
      assert.throws(() => applyTerrainSettings(colors, { [s.name]: 'x' }), RangeError, s.name);
    } else {
      assert.throws(() => applyTerrainSettings(colors, { [s.name]: [s.max + 1, 0, 0] }), RangeError, s.name);
      assert.throws(() => applyTerrainSettings(colors, { [s.name]: [0, 0] }), RangeError, s.name);
    }
    if (!s.nullable) assert.throws(() => applyTerrainSettings(colors, { [s.name]: null }), RangeError, s.name);
    else assert.doesNotThrow(() => applyTerrainSettings(colors, { [s.name]: null }), s.name);
  }
  // A range whose start is not below its end is refused by TerrainColors itself.
  assert.throws(() => applyTerrainSettings(colors, { 'shore.start': 5, 'shore.end': 1 }), RangeError);
  engine.dispose();
});

test('a sand row on a TerrainColors built without a sand surface is a TypeError; the defaults still apply', async () => {
  const { engine, mesh } = await harness(),
    colors = new TerrainColors(mesh, { sandSurface: false });
  applyTerrainSettings(colors, { 'sand.color': [0.7, 0.6, 0.5] });
  assert.throws(() => applyTerrainSettings(colors, { 'sand.ripples': 2 }), TypeError);
  engine.dispose();
});

test('the named looks are only row values, all in range', async () => {
  const { engine, mesh } = await harness(),
    colors = new TerrainColors(mesh),
    names = new Set(TERRAIN_SETTINGS.map((s) => s.name));
  for (const [name, values] of Object.entries(TERRAIN_LOOKS)) {
    for (const key of Object.keys(values)) assert.ok(names.has(key), `${name}: ${key}`);
    assert.doesNotThrow(() => applyTerrainSettings(colors, values), name);
  }
  engine.dispose();
});

test('writing every live row each frame for 60 frames creates no GPU object and writes the new look', async () => {
  const { h, engine, mesh } = await harness(),
    colors = new TerrainColors(mesh);
  engine.use(colors);
  // The range starts stay put so each range stays in order while its end moves.
  const fixed = new Set(['shore.start', 'wet.heightStart', 'stone.normalStart']);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
  };
  try {
    frame();
    const before = { ...h.counts },
      entry = h.context.bindings.at(-1);
    let writes = 0;
    const write = h.engine.gpu.queue.writeBuffer;
    h.engine.gpu.queue.writeBuffer = (...args) => {
      writes++;
      return write(...args);
    };
    for (let i = 0; i < 60; i++) {
      const t = i / 59,
        values = {};
      for (const s of TERRAIN_LIVE_SETTINGS) {
        if (s.kind === 'color') values[s.name] = s.default.map((x) => x * (0.5 + 0.5 * t));
        else if (s.default === null || fixed.has(s.name)) continue;
        else values[s.name] = s.default + (Math.min(s.max, s.default + (s.max - s.default) * 0.1) - s.default) * t;
      }
      // Keep each pair of range rows in order while they move.
      values['shore.end'] = 1.5 + t;
      values['wet.heightEnd'] = 0.4 + t;
      values['stone.normalEnd'] = 0.85 + 0.1 * t;
      applyTerrainSettings(colors, values);
      frame();
      assert.equal(h.context.bindings.at(-1), entry, 'one stable binding entry');
    }
    h.engine.gpu.queue.writeBuffer = write;
    assert.deepEqual(h.counts, before);
    assert.equal(writes, 60);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
