import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { StatsPanels } from '../dist/panels.js';
import { GeometryStats } from '../dist/geometry.js';

// Minimal WebGL2 context with EXT_disjoint_timer_query_webgl2: each elapsed query reports 1 ms once made ready.
function webgl2() {
  const queries = [];
  let active = null;
  const gl = {
    CURRENT_QUERY: 1,
    QUERY_RESULT_AVAILABLE: 2,
    QUERY_RESULT: 3,
    canvas: new EventTarget(),
    getExtension: () => ({ TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }),
    isContextLost: () => false,
    getQuery: () => active,
    getParameter: () => false,
    createQuery() {
      const q = { ready: false };
      queries.push(q);
      return q;
    },
    beginQuery(_target, q) {
      active = q;
    },
    endQuery() {
      active = null;
    },
    getQueryParameter: (q, key) => (key === 2 ? q.ready : 1e6),
    deleteQuery() {},
    drawArrays() {},
    drawElements() {},
    drawRangeElements() {},
    drawArraysInstanced() {},
    drawElementsInstanced() {},
  };
  return { gl, ready: () => queries.forEach((q) => (q.ready = true)) };
}

// The small preview has backend webgl2 and no GPU device. These owners are its real routes, not silent skips:
// GeometryStats counts WebGL2 draws and StatsPanels times named passes with WebGL2 timer queries (GLStats).
test('StatsPanels and GeometryStats measure the small WebGL2 preview through its GL context', async () => {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const engine = new Engine({ width: 8, height: 8 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const { gl, ready } = webgl2(),
    context = { backend: 'webgl2', gl, draw: () => gl.drawArrays(4, 0, 6) };
  let panels, geometry;
  try {
    panels = StatsPanels.attach(engine, { parent: dom.window.document.body });
    geometry = GeometryStats.attach(engine);
    engine.frameGraph.execute(context);
    assert.equal(geometry.triangles, 2, 'one preview draw of 6 vertices counted');
    assert.equal(geometry.drawCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ready();
    engine.frameGraph.execute(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const report = panels.toJSON();
    assert.ok(
      report.passes.some((pass) => pass.name === 'main' && pass.milliseconds === 1),
      `GL timer queries reached the panel: ${JSON.stringify(report.passes)}`,
    );
    assert.ok(report.gpuMilliseconds.at(-1) > 0, `a GL frame time was sampled: ${report.gpuMilliseconds}`);
  } finally {
    panels?.dispose();
    geometry?.dispose();
    engine.dispose();
    dom.window.close();
  }
});
