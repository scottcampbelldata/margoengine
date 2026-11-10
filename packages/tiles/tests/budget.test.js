import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer, modelGpuBytes, textureBytes } from '../dist/index.js';
import { boxGLB, memoryFetch, settle } from './generator.js';

const encoder = new TextEncoder();

test('budget: textureBytes counts every mip level of an rgba8 texture', () => {
  assert.equal(textureBytes(4, 2), 4 * 2 * 4 + 2 * 1 * 4 + 1 * 1 * 4);
  assert.equal(textureBytes(2048, 2048), (4 * (4 ** 12 - 1)) / 3); // 12 levels: 4 bytes x 4^k texels, k = 0..11
  assert.equal(textureBytes(1, 1), 4);
  assert.equal(textureBytes(8, 8, 1), 256);
});

/** A gltf-pro-shaped model: two primitives sharing one vertex array, two materials sharing one image. */
function model({ ktx2 = false } = {}) {
  const vertices = new Float32Array(20 * 3), // three 80-byte vertices
    a = new Uint32Array(3),
    b = new Uint32Array(6),
    image = ktx2 ? { ktx2: { mipmaps: [{ byteLength: 4096 }, { byteLength: 1024 }] } } : { width: 64, height: 32 };
  return {
    primitives: [
      { vertices, indices: a, material: { maps: [{ index: 0 }, undefined] } },
      { vertices, indices: b, uvs: new Float32Array(12), material: { maps: [{ index: 1 }, { index: 0 }] } },
    ],
    pointsAndLines: [],
    asset: { doc: { textures: [{ source: 0 }, { source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }] } },
    images: [image, undefined],
  };
}

test('budget: modelGpuBytes counts unique arrays once and each bound image once, as gltf-pro uploads them', () => {
  // vertices 240 + indices 12 + 24 + uvs 48, and one 64 x 32 image with its mips (texture 1's basisu is undecoded).
  assert.equal(modelGpuBytes(model()), 240 + 12 + 24 + 48 + textureBytes(64, 32));
  assert.equal(modelGpuBytes(model({ ktx2: true })), 240 + 12 + 24 + 48 + 4096 + 1024);
  assert.equal(modelGpuBytes({ root: {} }), undefined, 'a custom model without primitives is not measured');
});

async function oneTile(budget, loadModel) {
  const json = {
    asset: { version: '1.1' },
    geometricError: 10,
    root: {
      boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
      geometricError: 0,
      content: { uri: 'a.glb' },
    },
  };
  const glb = boxGLB(),
    memory = memoryFetch(
      new Map([
        ['tileset.json', encoder.encode(JSON.stringify(json))],
        ['a.glb', glb],
      ]),
    ),
    mesh = () => {
      const m = { visible: true, matrix: new Float32Array(16), check() {}, dispose() {} };
      m.setPosition = m.setQuaternion = m.setScale = () => m;
      return m;
    },
    engine = {
      camera: { position: [0, 0, 30], fov: 60, planes: new Float32Array(24) },
      canvas: { height: 600 },
      use(p) {
        p.setup?.(this);
      },
      hasPlugin: () => false,
      removePlugin() {},
    };
  const renderer = await TilesRenderer.load(engine, memory.url, {
    fetch: memory.fetch,
    loadModel: async () => ({ ...loadModel(), root: mesh(), dispose() {} }),
    ...(budget ? { budget } : {}),
  });
  for (let i = 0; i < 30 && renderer.tileset.progress.ready < 1; i++) {
    renderer.update();
    await settle(4);
  }
  return { renderer, file: glb.byteLength };
}

test("budget: the renderer counts a tile's GPU bytes by default, its file with budget 'content'", async () => {
  const gpu = await oneTile(undefined, () => model());
  assert.equal(gpu.renderer.tileset.progress.bytes, modelGpuBytes(model()));
  gpu.renderer.dispose();
  const content = await oneTile('content', () => model());
  assert.equal(content.renderer.tileset.progress.bytes, content.file);
  content.renderer.dispose();
  // A custom loadModel whose models have no primitives is counted by file size.
  const custom = await oneTile('gpu', () => ({}));
  assert.equal(custom.renderer.tileset.progress.bytes, custom.file);
  custom.renderer.dispose();
  await assert.rejects(
    oneTile('vram', () => ({})),
    /Invalid budget/,
  );
});

test('budget refreshes live geometry and decoration allocations before refinement, including grouped content', async () => {
  const made = model();
  const { renderer } = await oneTile(undefined, () => made);
  const before = renderer.tileset.bytes;
  const p = renderer.tileset.root.renderable;
  assert.ok(p.bytes > 0);
  made.primitives[0].vertices = new Float32Array(2000);
  renderer.update();
  assert.equal(renderer.tileset.bytes, before + 2000 * 4);
  assert.equal(renderer.tileset.root.renderable.bytes, renderer.tileset.bytes);
  renderer.dispose();
});
