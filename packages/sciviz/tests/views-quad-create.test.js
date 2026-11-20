import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { JSDOM } from 'jsdom';

// The quad's annotations are not under test here; a stub keeps the figures minimal.
mock.module('@margoengine/sciviz/annotate', {
  namedExports: { annotate: () => ({ restore() {}, render() {} }) },
});
const { VolumeQuad } = await import('../dist/views.js');

test('a quad whose first crosshair fails releases its resize observer, click and signal listeners', async () => {
  const dom = new JSDOM('<div id="views"></div>');
  const saved = {
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    AbortController: globalThis.AbortController,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = dom.window.document;
  // jsdom listeners accept only its own AbortSignal.
  globalThis.AbortController = dom.window.AbortController;
  const observers = [];
  globalThis.ResizeObserver = class {
    observed = 0;
    disconnected = 0;
    constructor() {
      observers.push(this);
    }
    observe() {
      this.observed++;
    }
    disconnect() {
      this.disconnected++;
    }
  };
  try {
    const container = document.querySelector('#views'),
      canvases = [];
    let heatmaps = 0;
    const createFigure = async (canvas) => {
      canvases.push(canvas);
      return {
        engine: { camera: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } },
        model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        volume: () => ({ range: [0, 1], slice: () => ({ position: 0 }) }),
        heatmap: async () => {
          heatmaps++;
          throw new Error('heatmap failure');
        },
        remove() {},
        ready: async () => {},
        dispose() {},
      };
    };
    const abort = new AbortController(),
      volume = { data: new Float32Array(8), dims: [2, 2, 2], bounds: [0, 1, 0, 1, 0, 1] };
    await assert.rejects(
      VolumeQuad.create(container, volume, { createFigure, signal: abort.signal }),
      /heatmap failure/,
    );
    assert.equal(observers.length, 1);
    assert.equal(observers[0].observed, 3);
    assert.equal(observers[0].disconnected, 1, 'resize observer disconnected');
    const before = heatmaps;
    for (const canvas of canvases.slice(0, 3))
      canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 1, clientY: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(heatmaps, before, 'clicks on a failed quad start no crosshair work');
    abort.abort();
  } finally {
    globalThis.document = saved.document;
    globalThis.ResizeObserver = saved.ResizeObserver;
    globalThis.AbortController = saved.AbortController;
    globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
    dom.window.close();
  }
});
