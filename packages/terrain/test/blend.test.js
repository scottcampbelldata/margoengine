import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, meshRuntime } from '@margoengine/core/extension';
import { TerrainBlend } from '../dist/blend.js';
import { Terrain, TerrainColors } from '../dist/index.js';
import { TerrainVirtualTexture } from '../dist/rvt.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const block = 'let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;';
const colorOptions = {
  sand: [0.4, 0.3, 0.2],
  meadow: [
    [0.1, 0.2, 0.1],
    [0.2, 0.3, 0.1],
  ],
  stone: [0.3, 0.3, 0.3],
  shore: [0, 1],
  meadowHeight: [1, 10],
  stoneHeight: [10, 20],
  stoneNormal: [0.5, 0.8],
  wetHeight: [0, 0.6],
  wetDarkening: 0.55,
};
const balanced = (code) => {
  let depth = 0;
  for (const char of code)
    if (char === '{') depth++;
    else if (char === '}' && --depth < 0) return false;
  return depth === 0;
};
const terrainOptions = {
  origin: [-16, -8],
  size: [32, 16],
  heightScale: 2,
  heightOffset: -1,
  roughness: 0.8,
  layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
  textures: () => ({}),
};
// The engine, a terrain stand-in with a heightmap, and a virtual texture stand-in that reads like the real one (its
// declarations are the real WGSL) and records its entries.
async function rig() {
  const h = optionalGPU(),
    engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    views = [],
    heightmap = { createView: () => (views.push('heights'), { heights: true }) },
    terrain = { options: terrainOptions, heightmap },
    real = new TerrainVirtualTexture(new Terrain(terrainOptions)),
    rvt = {
      owner: engine,
      disposed: false,
      texture: { cache: 1 },
      declarations: (group, binding) => real.declarations(group, binding),
      entries: (binding) => (
        views.push('cache'),
        [
          { binding, resource: { cache: true } },
          { binding: binding + 1, resource: { sampler: true } },
          { binding: binding + 2, resource: { buffer: { frame: true } } },
        ]
      ),
    };
  const frame = (shader = wgsl, bindings = []) => {
    h.context.shader = shader;
    h.context.bindings = bindings;
    engine.frameGraph.execute(h.context);
    return h.context;
  };
  return { h, engine, terrain, rvt, views, frame };
}
const rows = (buffer) => new Float32Array(buffer.data);

test('options are checked at attachment and per mesh', async () => {
  const { h, engine, terrain, rvt } = await rig();
  try {
    for (const options of [
      { height: 0 },
      { height: -1 },
      { height: Number.NaN },
      { height: 1e39 },
      { noise: -0.1 },
      { noise: 1.5 },
      { normal: 2 },
      { height: '1' },
      null,
    ])
      assert.throws(() => TerrainBlend.attach(engine, terrain, rvt, options), RangeError, JSON.stringify(options));
    assert.throws(() => new TerrainBlend(undefined, rvt), TypeError);
    assert.throws(() => new TerrainBlend(terrain, {}), TypeError);
    const blend = TerrainBlend.attach(engine, terrain, rvt, { height: 2 }),
      mesh = engine.createMesh();
    assert.throws(() => blend.add(mesh, { noise: 3 }), RangeError);
    assert.equal(blend.has(mesh), false);
    blend.add(mesh);
    assert.equal(blend.has(mesh), true);
    assert.equal(blend.remove(mesh), true);
    assert.equal(blend.remove(mesh), false);
    blend.dispose();
    assert.throws(() => blend.add(mesh), /disposed/);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('a virtual texture of another engine is refused at attachment', async () => {
  const { h, engine, terrain, rvt } = await rig();
  try {
    assert.throws(() => TerrainBlend.attach(engine, terrain, { ...rvt, owner: {} }), /same engine/);
    assert.throws(() => TerrainBlend.attach(engine, terrain, { ...rvt, disposed: true }), /same engine/);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('the blend patches core shading once: the shared varying and block, the footprint first, a row per mesh id', async () => {
  const { h, engine, terrain, rvt, frame } = await rig();
  try {
    const blend = TerrainBlend.attach(engine, terrain, rvt, { height: 0.75, noise: 0.25, normal: 0.5 }),
      rock = engine.createMesh(),
      plain = engine.createMesh(),
      cliff = engine.createMesh();
    // No blended mesh yet: core's shader stays as it is, with no extra bindings.
    let c = frame();
    assert.equal(c.shader, wgsl);
    assert.equal(c.bindings.length, 0);
    blend.add(rock).add(cliff, { height: 3, normal: 1 });
    c = frame();
    const code = c.shader;
    assert.equal(code.match(/terrainId:f32/g)?.length, 1);
    assert.equal(code.split(block).length - 1, 1);
    assert.ok(balanced(code));
    // The footprint's derivatives come right at the top of the block, before any branch.
    const inside = code.slice(code.indexOf(block) + block.length);
    assert.ok(inside.startsWith('let terrainBlendFootprint=max(length(dpdx(i.position)),length(dpdy(i.position)));'));
    // The terrain's map, scales and roughness are compiled in; the ground is read as the vertex shader reads it.
    assert.match(code, /clamp\(\(position-vec2f\(-16\.0,-8\.0\)\)\/vec2f\(32\.0,16\.0\)/);
    assert.match(code, /\*2\.0\+-1\.0;/);
    assert.match(code, /i\.material\.x=mix\(i\.material\.x,0\.800000011920929,g\.weight\)/);
    assert.match(code, /fn terrainVirtualColor\(position:vec3f,footprint:f32\)->vec4f/);
    // Five contiguous group-0 bindings from 40: heights, mesh rows, then the virtual texture's three.
    assert.deepEqual(
      c.bindings.map((entry) => entry.binding),
      [40, 41, 42, 43, 44],
    );
    assert.match(code, /@group\(0\) @binding\(40\) var terrainBlendHeights:texture_2d<f32>;/);
    assert.match(code, /@group\(0\) @binding\(41\) var<storage,read> terrainBlendMeshes:array<vec4f>;/);
    assert.match(code, /@group\(0\) @binding\(42\) var terrainVirtualCache/);
    // Rows by mesh id: height, noise, normal; 0 for a mesh that is not blended.
    const data = rows(c.bindings[1].resource.buffer),
      row = (mesh) => [...data.slice(meshRuntime(mesh).id * 4, meshRuntime(mesh).id * 4 + 4)];
    assert.deepEqual(row(rock), [0.75, 0.25, 0.5, 0]);
    assert.deepEqual(row(cliff), [3, 0.25, 1, 0]);
    assert.deepEqual(row(plain), [0, 0, 0, 0]);
    blend.remove(rock);
    frame();
    assert.deepEqual(row(rock), [0, 0, 0, 0]);
    assert.deepEqual(row(cliff), [3, 0.25, 1, 0]);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('the patch and its bindings are cached; views are made again only when a texture is replaced', async () => {
  const { h, engine, terrain, rvt, views, frame } = await rig();
  try {
    const blend = TerrainBlend.attach(engine, terrain, rvt).add(engine.createMesh());
    const first = frame(),
      code = first.shader,
      entries = [...first.bindings];
    const second = frame();
    assert.equal(second.shader, code);
    second.bindings.forEach((entry, k) => assert.equal(entry, entries[k]));
    assert.deepEqual(views, ['heights', 'cache']);
    rvt.texture = { cache: 2 };
    frame();
    assert.deepEqual(views, ['heights', 'cache', 'heights', 'cache']);
    blend.dispose();
    const after = frame();
    assert.equal(after.shader, wgsl);
    assert.equal(after.bindings.length, 0);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('bindings skip numbers other patches already take, pushed or declared', async () => {
  const { h, engine, terrain, rvt, frame } = await rig();
  try {
    TerrainBlend.attach(engine, terrain, rvt).add(engine.createMesh());
    const declared = wgsl.replace(
      '@group(0) @binding(0) var<uniform> frame:Frame;',
      '@group(0) @binding(0) var<uniform> frame:Frame;\n@group(0) @binding(44) var other:texture_2d<f32>;',
    );
    const c = frame(declared, [{ binding: 41, resource: {} }]);
    assert.deepEqual(
      c.bindings.slice(1).map((entry) => entry.binding),
      [45, 46, 47, 48, 49],
    );
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('terrain colors and the blend share one varying and one block, in either order', async () => {
  for (const colorsFirst of [true, false]) {
    const { h, engine, terrain, rvt, frame } = await rig();
    try {
      const ground = engine.createMesh(),
        rock = engine.createMesh();
      const attachColors = () => engine.use(new TerrainColors(ground, colorOptions));
      if (colorsFirst) attachColors();
      TerrainBlend.attach(engine, terrain, rvt).add(rock);
      if (!colorsFirst) attachColors();
      const code = frame().shader;
      assert.equal(code.match(/terrainId:f32/g)?.length, 1);
      assert.equal(code.match(/o\.terrainId=/g)?.length, 1);
      assert.equal(code.split(block).length - 1, 1);
      assert.equal(code.match(/fn terrainNoise\(/g)?.length, 1);
      assert.ok(code.includes(`if(i.terrainId==${meshRuntime(ground).id + 1}.0)`));
      assert.ok(code.includes('let s=terrainBlendSettings(i.terrainId);'));
      assert.ok(balanced(code));
    } finally {
      engine.dispose();
      h.cleanup();
    }
  }
});

test('meshes draw as they were without the standard shader, the heightmap or a live virtual texture', async () => {
  const { h, engine, terrain, rvt, frame } = await rig();
  try {
    TerrainBlend.attach(engine, terrain, rvt).add(engine.createMesh());
    const foreign = 'o.color=i.color.rgb; // not the standard PBR shader';
    let c = frame(foreign);
    assert.equal(c.shader, foreign);
    assert.equal(c.bindings.length, 0);
    terrain.heightmap = undefined;
    c = frame();
    assert.equal(c.shader, wgsl);
    terrain.heightmap = { createView: () => ({}) };
    rvt.disposed = true;
    c = frame();
    assert.equal(c.shader, wgsl);
    assert.equal(c.bindings.length, 0);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('the mesh row buffer grows past its first 16 ids and keeps every row', async () => {
  const { h, engine, terrain, rvt, frame } = await rig();
  try {
    const blend = TerrainBlend.attach(engine, terrain, rvt),
      meshes = Array.from({ length: 40 }, () => engine.createMesh());
    blend.add(meshes[0], { height: 1 });
    const small = frame().bindings[1].resource.buffer;
    assert.equal(small.size, 16 * 16);
    blend.add(meshes[39], { height: 2 });
    const large = frame().bindings[1].resource.buffer;
    assert.notEqual(large, small);
    assert.ok(large.size >= (meshRuntime(meshes[39]).id + 1) * 16);
    const data = rows(large);
    assert.equal(data[meshRuntime(meshes[0]).id * 4], 1);
    assert.equal(data[meshRuntime(meshes[39]).id * 4], 2);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
