import test from 'node:test';
import assert from 'node:assert/strict';
import { GLStats } from '../dist/gl.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';

function fake(supported = true) {
  const queries = [],
    ext = { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 };
  let active = null,
    lost = false,
    disjoint = false;
  const gl = {
    CURRENT_QUERY: 1,
    QUERY_RESULT_AVAILABLE: 2,
    QUERY_RESULT: 3,
    canvas: new EventTarget(),
    getExtension() {
      return supported ? ext : null;
    },
    isContextLost() {
      return lost;
    },
    getQuery() {
      return active;
    },
    getParameter() {
      return disjoint;
    },
    createQuery() {
      const q = { ready: false, result: 1e6, deleted: 0 };
      queries.push(q);
      return q;
    },
    beginQuery(_target, query) {
      assert.equal(active, null, 'no nested elapsed queries');
      active = query;
    },
    endQuery() {
      assert.ok(active);
      active = null;
    },
    getQueryParameter(q, key) {
      if (key === 2) return q.ready;
      assert.ok(q.ready, 'never read a result before availability');
      return q.result;
    },
    deleteQuery(q) {
      q.deleted++;
    },
  };
  for (const key of ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced'])
    gl[key] = function () {
      assert.equal(this, gl);
    };
  return {
    gl,
    queries,
    ready() {
      for (const q of queries) q.ready = true;
    },
    disjoint(value) {
      disjoint = value;
    },
    external(value) {
      active = value;
    },
    lose() {
      lost = true;
      gl.canvas.dispatchEvent(new Event('webglcontextlost'));
    },
    restore() {
      lost = false;
      gl.canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
}

test('WebGL frame is sum of disjoint GPU segments, named passes separate, nanoseconds converted to milliseconds', () => {
  const f = fake(),
    stats = new GLStats();
  stats.beginFrame(f.gl);
  stats.pass('shadows', () => f.gl.drawArrays(4, 0, 3));
  stats.pass('main', () => {
    f.gl.drawElements(4, 3, 5123, 0);
    f.gl.drawArraysInstanced(4, 0, 3, 2);
  });
  stats.endFrame();
  assert.equal(stats.poll(), false);
  assert.equal(stats.frameMilliseconds, null);
  f.ready();
  assert.equal(stats.poll(), true);
  assert.equal(stats.frameMilliseconds, 5);
  assert.equal(stats.drawCalls, 3);
  assert.deepEqual(stats.passes, [
    { name: 'shadows', milliseconds: 1 },
    { name: 'main', milliseconds: 1 },
  ]);
  assert.equal(stats.sampleId, 1);
  const size = f.queries.length;
  stats.beginFrame();
  stats.pass('main', () => {});
  stats.endFrame();
  stats.poll();
  assert.equal(f.queries.length, size, 'queries reused');
  assert.equal(stats.sampleId, 2);
  stats.dispose();
  assert.ok(f.queries.every((q) => q.deleted === 1));
});

test('disjoint, invalid and overflowing samples clear timings atomically; counters continue when unsupported or busy', () => {
  const f = fake(),
    stats = new GLStats({ maxPasses: 1, maxPendingFrames: 1 });
  stats.beginFrame(f.gl);
  stats.endFrame();
  assert.equal(stats.beginFrame(), false);
  f.gl.drawArrays(4, 0, 3);
  stats.endFrame();
  assert.equal(stats.drawCalls, 1);
  assert.equal(stats.droppedFrames, 1);
  f.ready();
  stats.poll();
  assert.equal(stats.frameMilliseconds, 1);
  stats.beginFrame();
  stats.pass('a', () => {});
  stats.pass('b', () => {});
  stats.endFrame();
  f.ready();
  stats.poll();
  assert.equal(stats.frameMilliseconds, null);
  assert.deepEqual(stats.passes, []);
  stats.beginFrame();
  stats.endFrame();
  f.ready();
  stats.poll();
  assert.notEqual(stats.frameMilliseconds, null);
  stats.beginFrame();
  stats.endFrame();
  f.disjoint(true);
  stats.poll();
  assert.equal(stats.frameMilliseconds, null);
  assert.deepEqual(stats.passes, []);
  stats.dispose();
  const no = fake(false),
    raw = no.gl.drawArrays,
    unsupported = new GLStats();
  assert.equal(unsupported.beginFrame(no.gl), false);
  no.gl.drawArrays(4, 0, 3);
  unsupported.endFrame();
  assert.equal(unsupported.drawCalls, 1);
  assert.equal(no.queries.length, 0);
  unsupported.dispose();
  assert.equal(no.gl.drawArrays, raw);
});

test('external queries are preserved; context loss discards samples and restoration reacquires timers', () => {
  const f = fake(),
    stats = new GLStats(),
    external = {};
  f.external(external);
  assert.equal(stats.beginFrame(f.gl), false);
  stats.endFrame();
  assert.equal(f.gl.getQuery(), external);
  assert.equal(f.queries.length, 0);
  f.external(null);
  stats.beginFrame();
  stats.endFrame();
  f.lose();
  assert.equal(stats.supported, false);
  assert.equal(stats.frameMilliseconds, null);
  f.restore();
  assert.equal(stats.supported, true);
  stats.beginFrame();
  stats.endFrame();
  f.ready();
  stats.poll();
  assert.equal(stats.sampleId, 1);
  stats.dispose();
  stats.dispose();
  assert.throws(() => stats.poll(), /disposed/);
});

test('query allocation failure leaves the profiler ready for a new frame', () => {
  const f = fake(),
    stats = new GLStats(),
    create = f.gl.createQuery;
  f.gl.createQuery = () => null;
  assert.throws(() => stats.beginFrame(f.gl), /Cannot allocate/);
  f.gl.createQuery = create;
  assert.equal(stats.beginFrame(), true);
  stats.endFrame();
  f.ready();
  assert.equal(stats.poll(), true);
  stats.dispose();
});

test('automatic graph timing counts main and future named passes across multiple views; thrown work releases its pass', async () => {
  const f = fake(),
    stats = new GLStats(),
    graph = new FrameGraph(),
    execute = graph.execute,
    add = graph.add;
  stats.registerPasses(graph);
  graph.add({ name: 'post', order: 2, execute: () => f.gl.drawArrays(4, 0, 3) });
  const context = { backend: 'webgl2', gl: f.gl, draw: () => f.gl.drawElements(4, 3, 5123, 0) },
    draw = context.draw;
  graph.execute(context);
  graph.execute(context);
  assert.equal(stats.drawCalls, 4);
  assert.equal(context.draw, draw);
  await Promise.resolve();
  f.ready();
  stats.poll();
  assert.deepEqual(
    stats.passes.map((p) => p.name),
    ['main', 'post', 'main', 'post'],
  );
  assert.equal(stats.frameMilliseconds, 9);
  stats.beginFrame();
  assert.throws(
    () =>
      stats.pass('throws', () => {
        throw new Error('test');
      }),
    /test/,
  );
  stats.endFrame();
  stats.dispose();
  assert.equal(graph.execute, execute);
  assert.equal(graph.add, add);
});

test('JSON and panel show completed GPU times and draw counts, and disposal removes the row', () => {
  const dom = new JSDOM('<body/>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const panel = new Stats({ parent: dom.window.document.body }),
    f = fake(),
    stats = new GLStats();
  try {
    stats.beginFrame(f.gl);
    stats.pass('main', () => f.gl.drawArrays(4, 0, 3));
    stats.endFrame();
    f.ready();
    stats.poll();
    stats.view(panel);
    assert.match(panel.element.textContent, /WebGL2 1 draws GPU 3.00 ms\nmain: 1.00 ms/);
    assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats.toJSON());
    stats.dispose();
    assert.doesNotMatch(panel.element.textContent, /WebGL2/);
  } finally {
    stats.dispose();
    panel.dispose();
    dom.window.close();
  }
});
