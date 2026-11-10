import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { GeometryStats } from '../dist/geometry.js';
import { Stats } from '../dist/index.js';
import { statsReport } from '../dist/report.js';

function encoder() {
  const calls = [];
  const pass = Object.fromEntries(
    ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'setPipeline', 'executeBundles'].map((name) => [
      name,
      function (...args) {
        assert.equal(this, pass);
        calls.push([name, ...args]);
      },
    ]),
  );
  return { calls, pass };
}
function makeEncoder() {
  const result = encoder();
  result.beginRenderPass = function () {
    assert.equal(this, result);
    return result.pass;
  };
  return result;
}

test('counts submitted triangle-list, strip, points, lines, indexed and instanced draws, with zero work excluded', () => {
  const counter = new GeometryStats(),
    e = makeEncoder(),
    pipeline = {};
  counter.pipeline(pipeline, 'triangle-strip');
  counter.track(e);
  counter.track(e);
  const p = e.beginRenderPass({});
  p.draw(6, 2);
  p.drawIndexed(9, 3, 5, -2, 7);
  p.draw(0, 10);
  p.draw(3, 0);
  p.setPipeline(pipeline);
  p.draw(5, 2);
  assert.deepEqual(counter.toJSON(), { triangles: 19, vertices: 49, instances: 7, drawCalls: 5, unknownDraws: 0 });
  counter.pipeline(pipeline, 'line-list');
  p.setPipeline(pipeline);
  p.draw(4);
  counter.pipeline(pipeline, 'point-list');
  p.setPipeline(pipeline);
  p.drawIndexed(2);
  assert.equal(counter.triangles, 19);
  assert.equal(counter.vertices, 55);
  assert.deepEqual(e.calls[1], ['drawIndexed', 9, 3, 5, -2, 7]);
  counter.beginFrame();
  assert.equal(counter.vertices, 0);
  assert.equal(counter.drawCalls, 0);
  counter.dispose();
  p.draw(3);
  assert.equal(counter.vertices, 0);
  assert.throws(() => counter.beginFrame(), /disposed/);
});

test('captures sync and async pipeline topology and reports opaque commands honestly', async () => {
  const device = {
      createRenderPipeline() {
        return {};
      },
      async createRenderPipelineAsync() {
        return {};
      },
    },
    create = device.createRenderPipeline,
    counter = new GeometryStats({
      indirect: (_buffer, offset, indexed) => (offset === 4 && indexed ? { count: 12, instances: 2 } : undefined),
    });
  counter.trackDevice(device);
  const pipeline = await device.createRenderPipelineAsync({ primitive: { topology: 'triangle-strip' } }),
    e = makeEncoder();
  counter.track(e);
  const p = e.beginRenderPass({});
  p.setPipeline(pipeline);
  p.draw(4);
  p.drawIndirect({}, 0);
  p.drawIndexedIndirect({}, 4);
  p.executeBundles([{}]);
  assert.deepEqual(counter.toJSON(), { triangles: 22, vertices: 28, instances: 3, drawCalls: 3, unknownDraws: 2 });
  const line = device.createRenderPipeline({ primitive: { topology: 'line-list' } });
  p.setPipeline(line);
  p.draw(6);
  assert.equal(counter.triangles, 22);
  counter.dispose();
  assert.equal(device.createRenderPipeline, create);
});

test('WebGL arrays/elements/ranges and instance counts preserve receivers and disposal', () => {
  let calls = 0;
  const gl = Object.fromEntries(
      ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced'].map((key) => [
        key,
        function () {
          assert.equal(this, gl);
          calls++;
        },
      ]),
    ),
    raw = gl.drawArrays,
    counter = new GeometryStats();
  counter.trackGL(gl);
  counter.trackGL(gl);
  gl.drawArrays(4, 0, 6);
  gl.drawElements(4, 3, 5123, 0);
  gl.drawRangeElements(5, 0, 3, 4, 5123, 0);
  gl.drawArraysInstanced(6, 0, 5, 2);
  gl.drawElementsInstanced(1, 4, 5123, 0, 3);
  assert.deepEqual(counter.toJSON(), { triangles: 11, vertices: 35, instances: 8, drawCalls: 5, unknownDraws: 0 });
  assert.equal(calls, 5);
  counter.dispose();
  assert.equal(gl.drawArrays, raw);
});

test('geometry panel and report compose with Stats command wrappers in either order', () => {
  const dom = new JSDOM('<body/>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  try {
    for (const first of [true, false]) {
      const stats = new Stats({ parent: dom.window.document.body }),
        geometry = new GeometryStats(),
        e = makeEncoder();
      e.beginComputePass = () => ({});
      e.finish = () => ({});
      try {
        if (first) {
          geometry.track(e);
          stats.track(e);
        } else {
          stats.track(e);
          geometry.track(e);
        }
        e.beginRenderPass({}).drawIndexed(36, 4);
        geometry.view(stats);
        stats.tick(16);
        assert.equal(stats.drawCalls, 1);
        assert.equal(geometry.triangles, 48);
        assert.match(stats.element.textContent, /48 triangles.*144 vertices.*4 instances/);
        assert.deepEqual(statsReport(stats, undefined, geometry).geometry, geometry.toJSON());
      } finally {
        geometry.dispose();
        stats.dispose();
      }
    }
  } finally {
    dom.window.close();
  }
});

test('engine graph accumulates multiple views in a task and starts clean next frame', async () => {
  const geometry = new GeometryStats(),
    passes = [];
  geometry.registerPasses({
    add(pass) {
      passes.push(pass);
    },
  });
  for (let i = 0; i < 2; i++) {
    const e = makeEncoder();
    passes[0].execute({ backend: 'webgpu', encoder: e });
    e.beginRenderPass({}).draw(3);
  }
  assert.equal(geometry.triangles, 2);
  await Promise.resolve();
  const e = makeEncoder();
  passes[0].execute({ backend: 'webgpu', encoder: e });
  e.beginRenderPass({}).draw(3);
  assert.equal(geometry.triangles, 1);
  geometry.dispose();
});
