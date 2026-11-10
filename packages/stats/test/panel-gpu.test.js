import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsPanels } from '../dist/panels.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { JSDOM } from 'jsdom';

globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
globalThis.GPUMapMode = { READ: 1 };

function harness() {
  const descriptors = [],
    buffers = [];
  const device = {
    queue: { submit() {} },
    createCommandEncoder() {},
    features: new Set(['timestamp-query']),
    createQuerySet() {
      return { destroy() {} };
    },
    createBuffer() {
      const bytes = new BigUint64Array([1000n, 2000n, 3000n, 6000n]).buffer;
      const buffer = {
        async mapAsync() {},
        getMappedRange(_offset, size) {
          return bytes.slice(0, size);
        },
        unmap() {},
        destroy() {},
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  const encoder = () => {
    const result = {
      beginRenderPass(descriptor) {
        assert.equal(this, result);
        descriptors.push(descriptor);
        return {};
      },
      beginComputePass(descriptor) {
        assert.equal(this, result);
        descriptors.push(descriptor);
        return {};
      },
      resolveQuerySet() {
        assert.equal(this, result);
      },
      copyBufferToBuffer() {
        assert.equal(this, result);
      },
      finish() {
        assert.equal(this, result);
        return {};
      },
    };
    return result;
  };
  return { device, descriptors, buffers, encoder };
}

function overlay(h) {
  const dom = new JSDOM('<body/>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const panels = new StatsPanels({ parent: dom.window.document.body }),
    errors = [],
    graph = new FrameGraph();
  const engine = {
    gpu: h.device,
    onFrame() {
      return () => {};
    },
    store: { tick() {} },
    sceneOf() {},
    onError(e) {
      errors.push(e);
    },
  };
  panels.setup(engine);
  panels.registerPasses(graph);
  return {
    panels,
    errors,
    run(draw) {
      const e = h.encoder();
      panels.onPreUpdate();
      graph.execute({ backend: 'webgpu', encoder: e, delta: 0.016, draw: () => draw?.(e) });
      e.finish();
      return e;
    },
    close() {
      panels.dispose();
      dom.window.close();
    },
  };
}

test('named WebGPU results keep labels paired with their completed query slots, skipping foreign timestamps', async () => {
  const h = harness(),
    view = overlay(h);
  try {
    for (let i = 0; i < 14; i++) view.run();
    const foreign = { querySet: {}, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    view.run((e) => {
      e.beginRenderPass({ label: 'shadow', colorAttachments: [] });
      e.beginRenderPass({ label: 'foreign', timestampWrites: foreign });
      e.beginComputePass({ label: 'particles' });
    });
    await new Promise(setImmediate);
    assert.equal(h.descriptors[1].timestampWrites, foreign);
    view.run();
    await new Promise(setImmediate);
    assert.equal(view.panels.toJSON().gpuMilliseconds.at(-1), 0.004);
    assert.deepEqual(view.panels.toJSON().passes, [
      { name: 'shadow', milliseconds: 0.001 },
      { name: 'particles', milliseconds: 0.003 },
    ]);
    assert.deepEqual(view.errors, []);
  } finally {
    view.close();
  }
});

test('unsupported devices allocate no timestamp resources and leave native recording intact', () => {
  const h = harness();
  h.device.features.clear();
  h.device.createBuffer = () => assert.fail('unsupported allocation');
  const view = overlay(h);
  try {
    for (let i = 0; i < 30; i++) {
      view.run((e) => e.beginRenderPass({ colorAttachments: [] }));
    }
    assert.equal(h.buffers.length, 0);
    assert.ok(h.descriptors.every((d) => !d.timestampWrites));
  } finally {
    view.close();
  }
});
