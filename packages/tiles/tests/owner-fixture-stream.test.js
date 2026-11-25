// Regression for the owner/lifetime fixture: it waited a fixed 40 timer turns for the root tile, so a first model load
// slower than that (the cold import() of the glTF loader on a busy machine) failed the full check. It now waits on the
// load itself, and reports a tile's own error.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { fixtures } from './owner-lifetime.fixture.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
if (!globalThis.navigator?.gpu)
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: { getPreferredCanvasFormat: () => 'bgra8unorm' },
    configurable: true,
  });

/** The TilesRenderer.glb fixture, its content request answered by `content`. */
async function glbFixture(content) {
  const list = await fixtures(async (entry) => {
    const module = await import(entry);
    if (!entry.endsWith('generator.js')) return module;
    return {
      ...module,
      memoryFetch: (files, options) =>
        module.memoryFetch(files, {
          ...options,
          ...content,
        }),
    };
  });
  return list.find((fixture) => fixture.name === 'TilesRenderer.glb');
}

async function created(fixture) {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 16, height: 16 },
      await TransformStore.create(4),
      { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
      {},
      null,
    );
  try {
    const made = await fixture.create({ engine, scene: engine.scene });
    const meshes = engine.scene.meshes.size;
    made.dispose();
    return meshes;
  } finally {
    engine.dispose();
    h.cleanup();
  }
}

test('regression: the fixture waits for a root tile that arrives after many timer turns', async () => {
  // 1.5 s is far past the 40 turns the fixture used to allow.
  const late = (path) => new Promise((resolve) => setTimeout(resolve, path.endsWith('.glb') ? 1500 : 0));
  assert.ok((await created(await glbFixture({ gate: late }))) > 0);
});

test("regression: a root tile that fails to load is reported with the tile's own error", async () => {
  const fixture = await glbFixture({ fail: (path) => (path.endsWith('.glb') ? 500 : undefined) });
  await assert.rejects(created(fixture), /root\.glb/);
});
