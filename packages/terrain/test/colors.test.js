import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, meshRuntime } from '@margoengine/core/extension';
import { TerrainColors } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const options = {
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
// The block terrain colors open after core's shading normal; it shadows `i` and `n` with per-pixel copies.
const block = 'let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;';
const balanced = (code) => {
  let depth = 0;
  for (const char of code)
    if (char === '{') depth++;
    else if (char === '}' && --depth < 0) return false;
  return depth === 0;
};
const webgl = async () =>
  new Engine({ width: 10, height: 10 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

test('multiple wet terrains share the mesh ID varying and keep distinct textures and wetness functions', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const meshes = [engine.createMesh(), engine.createMesh()];
  const effects = meshes.map(
    (mesh, i) =>
      new TerrainColors(mesh, { ...options, wetness: { texture: () => undefined, origin: [i * 4, 0], size: [4, 4] } }),
  );
  for (const effect of effects) engine.use(effect);
  try {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
    const code = h.context.shader,
      bindings = h.context.bindings.map((e) => e.binding);
    assert.equal(new Set(bindings).size, 2);
    assert.equal(code.match(/terrainId:f32/g)?.length, 1);
    assert.equal(code.match(/o.terrainId=i.factors.w\+1.0/g)?.length, 1);
    const functions = [...code.matchAll(/fn (terrainWet\w*)\(/g)].map((m) => m[1]);
    assert.equal(new Set(functions).size, 2);
    for (const mesh of meshes) assert.match(code, new RegExp(`if\\(i.terrainId==${meshRuntime(mesh).id + 1}\\.0\\)`));
    // Both meshes share one per-pixel block that closes with the fragment.
    assert.equal(code.split(block).length - 1, 1);
    assert.equal(code.match(/struct TerrainSurface /g)?.length, 1);
    assert.ok(balanced(code));
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
test('terrain colors shade one mesh per pixel inside core lighting and cache the patch', async () => {
  const engine = await webgl();
  const mesh = engine.createMesh(),
    other = engine.createMesh(),
    colors = new TerrainColors(mesh, options);
  engine.use(colors);
  const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
  engine.frameGraph.execute(c);
  const id = meshRuntime(mesh).id;
  assert.ok(c.shader.includes(`if(i.terrainId==${id + 1}.0){let s=terrainSurface_${id}(i.position,n);`));
  assert.ok(!c.shader.includes(`terrainSurface_${meshRuntime(other).id}(`));
  // Bands are evaluated per pixel from the interpolated height and normal, not in the vertex stage.
  assert.ok(c.shader.includes(`fn terrainSurface_${id}(p:vec3f,n:vec3f)->TerrainSurface`));
  assert.doesNotMatch(c.shader, /o\.color=mix/);
  assert.ok(c.shader.includes('let linear=direct*'));
  assert.ok(balanced(c.shader));
  const patched = c.shader;
  c.shader = wgsl;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, patched);
  assert.throws(() => new TerrainColors(mesh, { ...options, wetDarkening: 2 }), /wetness/);
  assert.throws(() => new TerrainColors(mesh, { ...options, shore: [1, 1] }), /range/);
  // Without core's standard shader the mesh keeps its material color.
  const foreign = 'o.color=i.color.rgb; // not the standard PBR shader';
  c.shader = foreign;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, foreign);
  colors.dispose();
  c.shader = wgsl;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, wgsl);
  engine.dispose();
});

test('the per-pixel block keeps the anchors later core patches use and survives their rewrites', async () => {
  const engine = await webgl(),
    mesh = engine.createMesh();
  engine.use(new TerrainColors(mesh, { ...options, variation: 0.1 }));
  const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
  engine.frameGraph.execute(c);
  const code = c.shader;
  for (const anchor of [
    'o.color=i.color.rgb;',
    '@location(3) material:vec4f',
    '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f',
    'let facing=',
    'let n=normalize(i.normal)',
    'let v=normalize(frame.eye.xyz-i.position)',
    'let linear=direct*',
    'i.color*(1.0-i.material.y)*frame.radiance.w',
    'let mapped=linear/(1.0+linear);',
  ])
    assert.equal(code.split(anchor).length - 1, 1, anchor);
  assert.equal(code.match(/fn terrainNoise\(/g)?.length, 1);
  // Core's GPU pick keeps the fragment only up to the shading normal: the block goes with the rest.
  const pick = code
    .replace('->@location(0) vec4f {', '->@location(0) u32 {')
    .replace(/let n=normalize\(i.normal\)[\s\S]*$/, 'return i.id;\n}');
  assert.ok(balanced(pick));
  assert.doesNotMatch(pick, /terrainSource/);
  // HDR capture (bloom, post stack) and the SSAO/SSR replays rewrite the tail inside the block, after the terrain call.
  const hdr = code.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');
  assert.ok(hdr !== code && balanced(hdr));
  const ambient = code.replace(/let direct=[\s\S]*return vec4f\([^\n]+\);/, 'return vec4f(i.color,1);');
  assert.ok(balanced(ambient));
  assert.ok(ambient.indexOf('return vec4f(i.color,1);') > ambient.indexOf('i.color=s.color;'));
  // Without variation there is no noise to evaluate.
  const plain = await webgl();
  plain.use(new TerrainColors(plain.createMesh(), options));
  c.shader = wgsl;
  plain.frameGraph.execute(c);
  assert.doesNotMatch(c.shader, /terrainNoise/);
  plain.dispose();
  engine.dispose();
});

test('wet sand borrows depth through a stable view without moving terrain colors or other meshes', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const mesh = engine.createMesh(),
    textures = [0, 1].map(() =>
      h.engine.gpu.createTexture({ size: [4, 4], format: 'rgba32float', usage: GPUTextureUsage.COPY_SRC }),
    );
  let texture;
  const colors = new TerrainColors(mesh, {
    ...options,
    wetness: { texture: () => texture, origin: [-2, -2], size: [4, 4] },
  });
  engine.use(colors);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
  };
  try {
    frame();
    assert.equal(h.context.bindings[0].resource.texture.format, 'r32float');
    assert.match(h.context.shader, /o.terrainId=i.factors.w\+1.0/);
    assert.match(h.context.shader, new RegExp(`if\\(i.terrainId==${meshRuntime(mesh).id + 1}\\.0\\)`));
    // The wet band darkens (and smooths) the sand albedo per pixel instead of scaling the lit result.
    const id = meshRuntime(mesh).id;
    assert.ok(h.context.shader.includes(`let wet=terrainWet_${id}(p);`));
    assert.match(h.context.shader, /i\.color=s\.color;i\.material\.x\*=s\.rough;n=s\.normal;/);
    assert.doesNotMatch(h.context.shader, /terrainScale/);
    texture = textures[0];
    frame();
    const entry = h.context.bindings[0],
      allocated = { ...h.counts },
      source = colors.wetSource,
      target = colors.wetTarget,
      size = colors.wetSize;
    for (let i = 0; i < 100; i++) {
      texture = textures[i % 2];
      frame();
      assert.equal(h.context.bindings[0], entry);
      assert.equal(colors.wetSource, source);
      assert.equal(colors.wetTarget, target);
      assert.equal(colors.wetSize, size);
    }
    for (const key of ['textures', 'views', 'buffers', 'groups']) assert.equal(h.counts[key], allocated[key]);
    const snapshot = entry.resource.texture;
    colors.onDeviceRestored(engine);
    assert.ok(snapshot.destroyed);
    frame();
    assert.notEqual(h.context.bindings[0].resource.texture, snapshot);
    for (const mutate of [
      (t) => (t.sampleCount = 4),
      (t) => (t.format = 'rgba8unorm'),
      (t) => (t.usage = GPUTextureUsage.TEXTURE_BINDING),
    ]) {
      const bad = { ...textures[0] };
      mutate(bad);
      texture = bad;
      assert.throws(frame, /copyable water-depth/);
    }
    for (const invalid of [null, 0, false]) {
      texture = invalid;
      assert.throws(frame, /copyable water-depth/);
    }
    for (const wetness of [
      null,
      { texture: 0, origin: [0, 0], size: [1, 1] },
      { texture() {}, origin: [NaN, 0], size: [1, 1] },
      { texture() {}, origin: [0, 0], size: [0, 1] },
    ])
      assert.throws(() => new TerrainColors(mesh, { ...options, wetness }), /wetness map/);
  } finally {
    engine.dispose();
    for (const texture of textures) {
      assert.equal(texture.destroyed, false);
      texture.destroy();
    }
    assert.ok(h.resources.every((r) => r.destroyed));
  }
});
