import assert from 'node:assert/strict';
import test from 'node:test';
import { VolumeDepthCapture } from '../src/volume-depth.ts';

test('a view no longer drawn releases its full-size depth capture at the next frame', (t) => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  t.after(() => {
    globalThis.GPUTextureUsage = usage;
  });
  const destroyed = new Set(),
    made = [];
  const device = {
    createTexture({ size, format }) {
      const texture = {
        width: size[0],
        height: size[1],
        format,
        createView: () => ({}),
        destroy() {
          destroyed.add(this);
        },
      };
      made.push(texture);
      return texture;
    },
  };
  const passes = [],
    engine = {
      backend: 'webgpu',
      gpu: device,
      use(p) {
        p.setup(this);
        p.registerPasses({ add: (pass) => passes.push(pass) });
      },
    };
  const capture = VolumeDepthCapture.attach(engine);
  capture.members.add({ visible: true });
  const begin = passes.find((p) => p.name.endsWith(':begin'));
  const draw = (id) =>
    begin.execute({
      backend: 'webgpu',
      device,
      width: 64,
      height: 32,
      format: 'rgba8unorm',
      descriptor: { depthStencil: { format: 'depth24plus' } },
      color: {},
      depth: {},
      view: { id, viewport: [0, 0, 64, 32], index: 0, count: 1 },
    });
  draw('removed');
  const removed = made.splice(0);
  assert.equal(removed.length, 2);
  capture.onPreUpdate(1 / 60);
  draw('kept');
  capture.onPreUpdate(1 / 60);
  draw('kept');
  capture.onPreUpdate(0);
  assert.ok(
    removed.every((t) => destroyed.has(t)),
    'the removed view no longer holds GPU memory',
  );
  assert.ok(made.every((t) => !destroyed.has(t)), 'the view still drawn keeps its capture');
  capture.dispose();
  assert.ok(made.every((t) => destroyed.has(t)));
});
