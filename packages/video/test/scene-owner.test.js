import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Video } from '../dist/index.js';

async function fixture(t) {
  const h = optionalGPU();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  class Frame {
    displayWidth = 8;
    closed = false;
    close() {
      this.closed = true;
    }
  }
  globalThis.VideoFrame = Frame;
  const source = new Frame();
  const engine = new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, await TransformStore.create(32), {
    backend: 'webgl2',
    gpu: h.engine.gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  t.after(() => {
    engine.dispose();
    if (descriptor) Object.defineProperty(globalThis, 'VideoFrame', descriptor);
    else delete globalThis.VideoFrame;
  });
  return { engine, source, resources: h.resources };
}

for (const target of ['default', 'secondary'])
  for (const mode of ['direct', 'owner', 'scene', 'engine']) {
    if (target === 'default' && mode === 'scene') continue;
    test(`Video ${target} ${mode} disposal releases its registration and only its resources`, async (t) => {
      const { engine, source, resources } = await fixture(t);
      const scene = target === 'default' ? engine.scene : engine.createScene('video-owner');
      const video = new Video(source);
      scene.use(video);
      const sentinel = { name: video.name, setup() {} };
      if (target === 'secondary') engine.use(sentinel);
      video.onDeviceRestored(engine);
      if (mode === 'direct') video.dispose();
      else if (mode === 'owner') scene.removePlugin(video.name);
      else if (mode === 'scene') scene.dispose();
      else engine.dispose();
      assert.equal(engine.sceneOf(video)?.name, undefined);
      assert.equal(source.closed, false);
      assert.ok(resources.every((r) => r.destroyed));
      if (target === 'secondary' && mode !== 'engine')
        assert.equal(engine.scene.plugins.get(video.name) === sentinel, true);
      if (mode === 'direct' || mode === 'owner') {
        const replacement = { name: video.name, setup() {} };
        scene.use(replacement);
        video.dispose();
        assert.equal(scene.plugins.get(video.name) === replacement, true);
        const next = engine.createScene('next');
        assert.throws(() => next.use(video), { code: 'disposed' });
        assert.equal(engine.sceneOf(video)?.name, undefined);
      }
    });
  }
