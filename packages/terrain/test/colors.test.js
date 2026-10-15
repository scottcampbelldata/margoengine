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
test('terrain colors target a mesh ID and retain shader lighting while caching the patch', async () => {
  const engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const mesh = engine.createMesh(),
    other = engine.createMesh(),
    colors = new TerrainColors(mesh, options);
  engine.use(colors);
  const source = 'o.color=i.color.rgb; // PBR and shadows stay here',
    c = { backend: 'webgpu', shader: source, draw() {} };
  engine.frameGraph.execute(c);
  assert.ok(c.shader.includes(`if(i.factors.w==${meshRuntime(mesh).id}.0)`));
  assert.ok(!c.shader.includes(`if(i.factors.w==${meshRuntime(other).id}.0)`));
  assert.ok(c.shader.includes('PBR and shadows stay here'));
  const patched = c.shader;
  c.shader = source;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, patched);
  assert.throws(() => new TerrainColors(mesh, { ...options, wetDarkening: 2 }), /wetness/);
  assert.throws(() => new TerrainColors(mesh, { ...options, shore: [1, 1] }), /range/);
  colors.dispose();
  c.shader = source;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, source);
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
    assert.match(h.context.shader, /let h=p.y/);
    assert.match(h.context.shader, /o.color=mix\([^;]+\*variation;/);
    assert.doesNotMatch(h.context.shader, /o.color=[^;]+\*wet;/);
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
