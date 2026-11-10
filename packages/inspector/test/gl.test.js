import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { GLInspector, captureGLFrame } from '../dist/gl.js';
async function fixture(t, independent = false) {
  const dom = new JSDOM('<body><canvas width="200" height="160"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  let constant = 1;
  const values = new Map(),
    constants = new Map(),
    flags = new Set(),
    gl = new Proxy(
      { canvas },
      {
        get(target, key) {
          if (key in target) return target[key];
          if (/^[A-Z_0-9]+$/.test(key)) {
            if (!constants.has(key)) constants.set(key, constant++);
            return constants.get(key);
          }
          return (target[key] =
            key.startsWith('create') || key === 'getUniformLocation'
              ? () => ({})
              : key === 'getExtension'
                ? () => null
                : key === 'isContextLost'
                  ? () => false
                  : key === 'getShaderParameter' || key === 'getProgramParameter'
                    ? () => true
                    : key === 'getAttachedShaders'
                      ? () => []
                      : key === 'getParameter'
                        ? (name) => values.get(name) ?? null
                        : key === 'isEnabled'
                          ? (name) => flags.has(name)
                          : key === 'enable'
                            ? (name) => flags.add(name)
                            : key === 'disable'
                              ? (name) => flags.delete(name)
                              : key === 'useProgram'
                                ? (value) => values.set(gl.CURRENT_PROGRAM, value)
                                : key === 'bindVertexArray'
                                  ? (value) => values.set(gl.VERTEX_ARRAY_BINDING, value)
                                  : key === 'bindBuffer'
                                    ? (name, value) => {
                                        if (name === gl.ARRAY_BUFFER) values.set(gl.ARRAY_BUFFER_BINDING, value);
                                      }
                                    : key === 'viewport'
                                      ? (...value) => values.set(gl.VIEWPORT, value)
                                      : key === 'colorMask'
                                        ? (...value) => values.set(gl.COLOR_WRITEMASK, value)
                                        : key === 'depthMask'
                                          ? (value) => values.set(gl.DEPTH_WRITEMASK, value)
                                          : key === 'lineWidth'
                                            ? (value) => values.set(gl.LINE_WIDTH, value)
                                            : () => {});
        },
      },
    );
  gl.getError = () => gl.NO_ERROR;
  canvas.getContext = () => gl;
  values.set(gl.LINE_WIDTH, 1);
  values.set(gl.DEPTH_WRITEMASK, true);
  values.set(gl.COLOR_WRITEMASK, [true, true, true, true]);
  const renderer = webglRenderer(canvas);
  const target = independent ? canvas.cloneNode() : canvas;
  target.getContext = () => gl;
  const engine = new Engine(target, await TransformStore.create(16), renderer, undefined, null),
    mesh = engine.createMesh().setGeometry(box()),
    panel = GLInspector.attach(engine, { parent: dom.window.document.body });
  t.after(() => {
    panel.dispose();
    engine.dispose();
    dom.window.close();
  });
  return { engine, mesh, panel, gl };
}
test('GL captures existing passes, native draw arguments and CPU fallback; wrappers restore', async (t) => {
  const { engine, panel, gl } = await fixture(t),
    execute = engine.frameGraph.execute,
    draw = gl.drawArrays;
  for (const mode of ['wireframe', 'normals', 'bounds', 'lights']) panel.setDebug(mode, true);
  const report = await panel.capture();
  assert.equal(report.gpuTiming, false);
  assert.equal(report.drawCalls, 5);
  assert.equal(report.passes[0].name, 'main');
  assert.ok(report.passes.every((p) => p.cpuMilliseconds >= 0));
  assert.equal(report.passes[0].draws[0].method, 'drawElementsInstanced');
  assert.equal(report.passes[1].draws.length, 4);
  assert.equal(gl.drawArrays, draw);
  assert.equal(engine.frameGraph.execute, execute);
  assert.equal(gl.isEnabled(gl.DEPTH_TEST), true);
  assert.equal(gl.getParameter(gl.DEPTH_WRITEMASK), true);
});
test('failed frames, timeout, cancellation and reentrant captures unwind wrappers', async (t) => {
  const { engine, gl } = await fixture(t),
    original = gl.drawArrays;
  const abort = new AbortController(),
    pending = captureGLFrame(engine, { render: false, signal: abort.signal });
  await assert.rejects(captureGLFrame(engine), /Await the current/);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(gl.drawArrays, original);
  await assert.rejects(captureGLFrame(engine, { render: false, timeout: 5 }), /timed out/);
  assert.equal(gl.drawArrays, original);
  const remove = engine.frameGraph.add({
    name: 'failure',
    order: 40,
    execute() {
      throw new TypeError('test frame failure');
    },
  });
  await assert.rejects(captureGLFrame(engine), /test frame failure/);
  remove();
  assert.equal(gl.drawArrays, original);
  assert.ok((await captureGLFrame(engine)).drawCalls > 0);
});

test('GL inspector borrows the native canvas context without preview registry membership', async (t) => {
  const { panel } = await fixture(t, true);
  panel.setDebug('wireframe', true);
  assert.ok((await panel.capture()).drawCalls > 0);
});

test('debug shader failures release every shader and program and preserve GL state', async (t) => {
  for (const fail of ['compile', 'link']) {
    const { panel, gl } = await fixture(t);
    await panel.capture();
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    let shaders = 0,
      programs = 0;
    gl.deleteShader = () => shaders++;
    gl.deleteProgram = () => programs++;
    gl.getShaderParameter = () => fail !== 'compile';
    gl.getProgramParameter = () => fail !== 'link';
    panel.setDebug('wireframe', true);
    await assert.rejects(panel.capture(), { code: 'failed' });
    assert.equal(shaders, fail === 'compile' ? 1 : 2);
    assert.equal(programs, 1);
    assert.equal(gl.getParameter(gl.CURRENT_PROGRAM), program);
  }
});
