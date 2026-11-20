import assert from 'node:assert/strict';
import test from 'node:test';
import { BlendLayer, BlendSprite, blendBatches } from '../dist/blend.js';
import { gridMesh, SkeletalLayer, Skeleton2D, SkinnedMesh } from '../dist/skeletal.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
test('mode runs batch adjacent sprites and preserve z, y and insertion order', () => {
  const a = new BlendSprite({ blendMode: 'screen' }),
    b = new BlendSprite({ blendMode: 'screen' }),
    c = new BlendSprite({ blendMode: 'add', z: 1 });
  a.index = 0;
  b.index = 1;
  c.index = 2;
  assert.deepEqual(blendBatches([c, b, a]), [
    { mode: 'screen', first: 0, count: 2 },
    { mode: 'add', first: 2, count: 1 },
  ]);
  b.blendMode = 'normal';
  assert.equal(blendBatches([a, b, c]).length, 3);
  b.visible = false;
  assert.deepEqual(blendBatches([a, b, c]), [
    { mode: 'screen', first: 0, count: 1 },
    { mode: 'add', first: 1, count: 1 },
  ]);
  assert.throws(() => new BlendSprite({ blendMode: 'other' }), RangeError);
});
test('blend mode mutation retains sprite identity and layer ownership', () => {
  assert.throws(() => new BlendLayer(), /SpriteLayer needs an atlas.*errors#sprite-options/);
  const layer = new BlendLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } }),
    s = layer.addBlend({ blendMode: 'multiply' });
  assert.equal(s.blendMode, 'multiply');
  s.blendMode = 'screen';
  assert.equal(layer.sprites[0], s);
  assert.throws(() => new BlendLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } }).addBlend(s), {
    code: 'attached',
  });
  layer.dispose();
  assert.equal(s.owner, undefined);
  assert.throws(() => layer.addBlend(), { code: 'disposed' });
});

// Work counts of multiply (docs/limits.md, "Multiply sprites and skeletal triangles"): the W3C multiply formula over a
// destination that may be transparent needs two fixed-function blends, so each multiply sprite or triangle is two
// draws, in order, while other adjacent modes share one draw.
function frame(layer) {
  const h = optionalGPU(),
    counts = { draw: 0, indexed: 0, pipelines: 0 },
    pass = {
      setPipeline: () => counts.pipelines++,
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      draw: () => counts.draw++,
      drawIndexed: () => counts.indexed++,
      end() {},
    };
  h.engine.gpu.createPipelineLayout ??= (descriptor) => descriptor;
  let framePass;
  layer.setup({ backend: 'webgpu', frameGraph: { add: (p) => ((framePass = p), () => {}) } });
  layer.onPreUpdate(1 / 60);
  framePass.execute({
    backend: 'webgpu',
    device: h.engine.gpu,
    encoder: { beginRenderPass: () => pass },
    color: {},
    depth: {},
    format: 'rgba8unorm',
    descriptor: { multisample: { count: 1 } },
    width: 16,
    height: 16,
    camera: h.context.camera,
  });
  h.cleanup();
  return counts;
}
const atlas = () => ({ width: 4, height: 4, data: new Uint8Array(64).fill(255) });

test('work count: three multiply sprites draw twice each, four adjacent screen sprites share one draw', () => {
  const layer = new BlendLayer({ atlas: atlas() });
  for (let i = 0; i < 4; i++) layer.addBlend({ rect: [0, 0, 2, 2], blendMode: 'screen' });
  for (let i = 0; i < 3; i++) layer.addBlend({ rect: [0, 0, 2, 2], blendMode: 'multiply' });
  assert.equal(frame(layer).draw, 1 + 3 * 2);
});

test('work count: a multiply skeletal mesh draws each triangle twice, a normal one draws once', () => {
  for (const [mode, draws] of [
    ['normal', 1],
    ['multiply', 2 * 2],
  ]) {
    const layer = new SkeletalLayer({ atlas: atlas() }),
      mesh = new SkinnedMesh({
        skeleton: new Skeleton2D([{ name: 'root' }]),
        ...gridMesh([0, 0, 4, 4], 1, 1),
        joints: new Uint32Array(16),
        weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      });
    mesh.blendMode = mode;
    layer.add(mesh);
    assert.equal(frame(layer).indexed, draws, mode);
  }
});
