import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Stand-ins for the lines and labels plugins count what the axes leave in the scene.
const live = { lines: new Set(), labels: new Set() };
mock.module('@margoengine/lines', {
  namedExports: {
    Line: class {
      constructor(options) {
        this.options = options;
      }
      setPositions() {}
    },
    Lines: {
      attach: () => ({
        add: (line) => (live.lines.add(line), line),
        remove: (line) => live.lines.delete(line),
      }),
    },
  },
});
mock.module('@margoengine/labels', {
  namedExports: {
    LabelRenderer: {
      attach: () => ({
        name: 'labels',
        layout: null,
        add(element) {
          const label = { element, remove: () => live.labels.delete(label) };
          live.labels.add(label);
          return label;
        },
      }),
    },
  },
});
const core = await import('@margoengine/core');
const { Figure } = await import('@margoengine/sciviz');

test('a figure disposed while its axes load leaves no axis line or label behind, whenever it lands', async () => {
  const dom = new JSDOM('<canvas></canvas>');
  globalThis.document = dom.window.document;
  try {
    // Dispose after 0, 1, 2 ... queued microtasks, so one run lands in every await of the axis update.
    for (let delay = 0; delay < 40; delay++) {
      const engine = {
          canvas: dom.window.document.querySelector('canvas'),
          camera: new core.Camera(),
          scene: {},
          use() {},
          onFrame: () => () => {},
          sceneOf: () => ({ removePlugin() {} }),
        },
        renderer = { device: {}, ready: async () => {}, add() {}, remove() {}, dispose() {} },
        fig = new Figure(engine, {}, renderer);
      const update = fig.setAxes({}).catch(() => {});
      let n = 0;
      await new Promise((resolve) => {
        const spin = () => (n++ === delay ? (fig.dispose(), resolve()) : queueMicrotask(spin));
        queueMicrotask(spin);
      });
      await update;
      for (let i = 0; i < 50; i++) await null;
      assert.equal(live.lines.size, 0, `axis lines left after dispose at microtask ${delay}`);
      assert.equal(live.labels.size, 0, `axis labels left after dispose at microtask ${delay}`);
    }
  } finally {
    delete globalThis.document;
    dom.window.close();
  }
});
